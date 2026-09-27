import type { USocket } from "myde-unix-socket";
import type { Client, ClientLogConfig, CursorState, Rect } from "../api";
import type {
    ActionArgs,
    ActionFn,
    ActionKey,
    ActionMsg,
    DataOf,
    DomainInit,
    ErrorCode,
    HitTestResult,
    ModuleCtx,
    RequestMsg,
    WaylandClientEventMap,
    WaylandDomainRegistry,
    WaylandObjectId2,
    WaylandWinId,
} from "../module";
import { protocolModules } from "../protocols/index";
import { type WaylandEventObj, WaylandEventOpcode, type WaylandInterfaces } from "../protocols/wayland-types";
import type { renderTools } from "../render_tools";
import type { WaylandObjectId, WaylandOp, WaylandProtocol } from "../utils/wayland-binary";
import { WaylandArgType } from "../utils/wayland-binary";
import { WaylandDecoder } from "../utils/wayland-decoder";
import { WaylandEncoder } from "../utils/wayland-encoder";
import { getEnumValue, WaylandProtocols, waylandObjectId, waylandProtocolsNameMap } from "../utils/wayland-proto";
import { CursorStore } from "./cursor_store";

const fs = require("node:fs") as typeof import("node:fs");

/**
 * 逐 key 写 `ctx.domain`：`domain` 是 `{[K]?: (ctx) => V[K]}` 映射类型，
 * 只有把 `K` 保持成泛型参数 TS 才允许写入（写进 union key 会报错），断言收在这一处。
 */
function initDomain<K extends keyof WaylandDomainRegistry>(
    domain: WaylandDomainRegistry,
    key: K,
    init: DomainInit<K>,
    ctx: ModuleCtx,
): void {
    domain[key] = init(ctx);
}

/**
 * 单个 wayland 连接：对象表、解码分发、ModuleCtx 构造，以及窗口/输入的执行面。
 *
 * 协议请求在 protocols/** 里，这里只剩 host 职责；
 * 连接生命周期（监听、建连）在 WaylandServer。
 */

type ParsedMessage = { id: WaylandObjectId; proto: WaylandProtocol; op: WaylandOp; args: Record<string, any> };

type WaylandObjectX<T extends WaylandInterfaces> = {
    protocol: WaylandProtocol;
    data: DataOf<T>;
};

const globalsByInterface = new Map(protocolModules.flatMap((m) => m.globals.map((g) => [g.name, g] as const)));

/**
 * 各模块声明的 surface 钩子。core 不 import 扩展，靠这里聚合后触发——
 * 这是 core → 扩展唯一的反向通道（正向依赖走 ctx.core）。
 */
const commitHooks = protocolModules.flatMap((m) => (m.hooks.onCommit ? [m.hooks.onCommit] : []));
const frameHooks = protocolModules.flatMap((m) => (m.hooks.onFrame ? [m.hooks.onFrame] : []));
const destroyHooks = protocolModules.flatMap((m) => (m.hooks.onDestroy ? [m.hooks.onDestroy] : []));
const focusHooks = protocolModules.flatMap((m) => (m.hooks.onFocus ? [m.hooks.onFocus] : []));
const textInputHooks = protocolModules.flatMap((m) => (m.hooks.onTextInput ? [m.hooks.onTextInput] : []));

/** 桌面命令（`server.notify`）→ 协议模块的 `actions`，与请求分发表同构 */
const actionHandlers = new Map<ActionKey, ActionFn>(protocolModules.flatMap((m) => [...m.actions]));

/**
 * server 注入的宿主能力。client 只认识这两条，fan-in / handle 分配全在 server（见 host/server.ts）。
 */
export interface ClientHost {
    /** 桌面提供的可用空间（同步；xdg_surface.get_toplevel 要填 configure_bounds） */
    surfaceBounds(): { width: number; height: number } | undefined;
    /** 光标状态变化，server 转成 `cursor.changed` 事件 */
    cursorChanged(state: CursorState): void;
}

export class WaylandClient implements Client {
    logConfig: ClientLogConfig = {
        receive: true,
        send: true,
    };

    readonly id: string;
    private socket: USocket;
    readonly pid: number | undefined;
    private decodeRestCache: { data: Uint8Array; fds: number[] } = { data: new Uint8Array(0), fds: [] };
    private opa = this.newOp();
    private displayId = waylandObjectId(1, "wl_display");
    private objects: Map<WaylandObjectId, { protocol: WaylandProtocol; data: any }>; // 客户端拥有的对象
    private protoVersions: Map<string, number> = new Map();
    private toSend: { objectId: WaylandObjectId; opcode: number; args: Record<string, any> }[] = [];
    private nextObjectId: number = 0xff000000;
    private render: renderTools;
    /** 光标的唯一写入点（见 host/cursor_store.ts）：唯一由 host 持有的语义状态 */
    private cursor: CursorStore;
    /** 协议模块看到的 host 能力面 —— module.ts 契约的真实实现 */
    public readonly ctx: ModuleCtx;
    // 事件存储
    private events: { [K in keyof WaylandClientEventMap]?: WaylandClientEventMap[K][] } = {};

    /** server 注入的宿主能力（可用空间、光标状态出口） */
    private host: ClientHost;

    constructor({
        id,
        socket,
        render,
        host,
    }: {
        id: string;
        socket: USocket;
        render: renderTools;
        host: ClientHost;
    }) {
        this.id = id;
        this.socket = socket;
        this.pid = socket.pid;
        this.objects = new Map();
        this.host = host;
        this.render = render;
        this.cursor = new CursorStore(render, (state) => host.cursorChanged(state));
        // 域状态（surface / subsurface / xdgSurface / seat / windows）由协议模块在装配时自己 new，host 不持有
        this.ctx = this.buildCtx();
        socket.on("data", (data, fds) => {
            this.handleClientMessage(data, fds);
        });

        socket.on("close", () => {
            console.log(`Client ${this.id} disconnected`);
            this.emit("close");
            this.close();
        });

        socket.on("error", (err) => {
            console.error(`Client ${this.id} error:`, err);
            this.emit("close");
            this.close();
        });
    }

    private receiveLog(...data: unknown[]) {
        if (this.logConfig.receive === true) {
            console.log(...data);
        }
    }
    private sendLog(...data: unknown[]) {
        if (this.logConfig.send === true) {
            console.log(...data);
        }
    }
    setLogConfig(op: typeof this.logConfig) {
        this.logConfig = op;
    }

    private allocateObjectId(): WaylandObjectId {
        const id = this.nextObjectId++ as WaylandObjectId;
        return id;
    }

    // 注册事件
    public on<K extends keyof WaylandClientEventMap>(event: K, handler: WaylandClientEventMap[K]): void {
        if (!this.events[event]) this.events[event] = [];
        // biome-ignore lint/style/noNonNullAssertion: 上面已经保证
        this.events[event]!.push(handler);
    }

    // 触发事件
    protected emit<K extends keyof WaylandClientEventMap>(
        event: K,
        ...args: Parameters<WaylandClientEventMap[K]>
    ): void {
        const handlers = this.events[event];
        if (handlers) {
            for (const fn of handlers) {
                // @ts-expect-error
                fn(...args);
            }
            // 特殊处理：close事件触发后移除所有close监听器
            if (event === "close") {
                this.events.close = [];
            }
        }
    }

    /** 把 module.ts 的空契约接上真实实现；协议模块只认这里，不接触 WaylandClient 本身 */
    private buildCtx(): ModuleCtx {
        const ctx: ModuleCtx = {
            objects: {
                get: (id) => this.getObject(id),
                getOption: (id) => this.getObjectOption(id),
                getData: (id) => this.getObject(id).data,
                setData: (id, data) => {
                    this.getObject(id).data = data;
                },
                create: (iface) => {
                    const id = this.allocateObjectId();
                    this.objects.set(id, { protocol: WaylandProtocols[iface], data: undefined });
                    return id as WaylandObjectId2<typeof iface>;
                },
                delete: (id) => this.deleteObj(id),
                entries: () => this.objects.entries(),
                has: (id) => this.objects.has(id),
                bind: (msg) => {
                    this.objects.set(msg.id, { protocol: msg.protocol, data: undefined });
                },
            },
            /** 入队，本批消息处理完统一 flush */
            send: (target, event, args) => this.sendMessageX(target, event, args),
            /** 立即写 socket */
            sendNow: (target, event, args) => this.sendMessageImm(target, event, args),
            postError: (iface, id, code, message) => this.postError(iface, id, code, message),
            // host 只能先给 `registry`（跨模块 `globals` 聚合）；surface/subsurface 是占位，
            // 由下面的装配循环按 `mod.core` 回填（`undefined!` = 装配前不存在，装配后即为完整对象）
            core: {
                // biome-ignore lint/style/noNonNullAssertion: 占位，buildCtx 结尾的装配循环按 mod.core 回填
                surface: undefined!,
                // biome-ignore lint/style/noNonNullAssertion: 同上
                subsurface: undefined!,
                registry: {
                    globals: () =>
                        (function* () {
                            for (const [name, protocol] of waylandProtocolsNameMap) yield { name, protocol };
                        })(),
                    byName: (name) => waylandProtocolsNameMap.get(name),
                    globalOf: (iface) => globalsByInterface.get(iface),
                },
            },
            /** 协议域状态，装配循环按 `protocolModules` 顺序回填 */
            domain: {} as WaylandDomainRegistry,
            notify: {
                commit: (surfaceId, sizeChanged) => {
                    for (const h of commitHooks) h(surfaceId, sizeChanged, this.ctx);
                },
                frame: (surfaceId, canvas, pending) => {
                    let out = canvas;
                    for (const h of frameHooks) out = h(surfaceId, out, pending, this.ctx) ?? out;
                    return out;
                },
                destroy: (surfaceId) => {
                    for (const h of destroyHooks) h(surfaceId, this.ctx);
                },
                focus: (surfaceId) => {
                    for (const h of focusHooks) h(surfaceId, this.ctx);
                },
                textInput: (text, preedit) => {
                    for (const h of textInputHooks) h(text, preedit, this.ctx);
                },
            },
            cursor: this.cursor,
            client: {
                id: this.id,
                displayId: this.displayId,
                protoVersions: this.protoVersions,
                emit: this.emit.bind(this),
                surfaceBounds: () => this.host.surfaceBounds(),
            },
            scene: this.render,
            hitTest: (winId, p) => this.hitTest(winId, p),
        };

        // 装配：先跑完全部 `core`（两趟跑，不依赖模块清单顺序），再跑 `domain`——
        // 域状态的 `new` 都在协议文件里，host 只有这份执行清单。
        for (const mod of protocolModules) {
            const coreSlice = mod.core?.(ctx);
            if (coreSlice) Object.assign(ctx.core, coreSlice);
        }
        for (const mod of protocolModules) {
            for (const key of Object.keys(mod.domain) as (keyof WaylandDomainRegistry)[]) {
                const init = mod.domain[key];
                if (init) initDomain(ctx.domain, key, init, ctx);
            }
        }
        return ctx;
    }

    private getObject<T extends WaylandInterfaces>(id: WaylandObjectId2<T>): WaylandObjectX<T> {
        const obj = this.objects.get(id);
        if (!obj) {
            this.postError("wl_display", this.displayId, "invalid_object", `Object id ${id} does not exist`);
            throw new Error(`Wayland object not found: ${id}`);
        }
        return obj as WaylandObjectX<T>;
    }
    private getObjectOption<T extends WaylandInterfaces>(
        id: WaylandObjectId2<T> | undefined,
    ): WaylandObjectX<T> | undefined {
        if (typeof id === "undefined") return undefined;
        const obj = this.objects.get(id);
        if (!obj) return undefined;
        return obj as WaylandObjectX<T>;
    }

    private newOp() {
        const m = new Map<string, (x: ParsedMessage & { args: any }) => void>();

        // 客户端想要从 compositor 接收数据（粘贴）

        // todo wp_cursor_shape_manager_v1.get_tablet_tool_v2 暂不实现，平板工具支持后再加

        // 协议模块的请求并入同一张分发表。
        // 模块 handler 与 isOp 的接收形状同构（id/proto/op/args），差别只在 brand 与 args 泛型，此处桥接。
        for (const mod of protocolModules) {
            for (const [key, raw] of mod.requests) {
                // 几百个 handler 类型的联合签名会把参数收成交集，先折成单一签名再调
                const handler = raw as unknown as (msg: RequestMsg, ctx: ModuleCtx) => void;
                m.set(key, (x) => handler(x as unknown as RequestMsg, this.ctx));
            }
        }

        return {
            isOp: (x: ParsedMessage) => {
                const f = m.get(`${x.proto.name}.${x.op.name}`);
                if (f) {
                    f(x);
                    return true;
                }
                return false;
            },
        };
    }

    /**
     * 桌面命令派发：`server.notify` → handle 反查（server）→ 这里 → 协议模块的 `actions`。
     * host 只做路由，组包 / serial / 状态维护都在协议文件里。
     *
     * `args` 是去掉 handle 之后的部分，类型由 `key` 推导——调用方写错参数编译期报错。
     */
    runAction<K extends ActionKey>(key: K, winId: WaylandWinId, args: ActionArgs<K>): void {
        const handler = actionHandlers.get(key);
        if (handler === undefined) {
            console.warn(`no action handler for ${key}`);
            return;
        }
        handler({ winId, args } as unknown as ActionMsg<ActionKey>, this.ctx);
    }

    private handleClientMessage(data: Buffer, fds: number[] = []) {
        const newData = new Uint8Array(data.buffer.byteLength + this.decodeRestCache.data.byteLength);
        newData.set(this.decodeRestCache.data, 0);
        newData.set(new Uint8Array(data.buffer), this.decodeRestCache.data.byteLength);
        const newFds = [...this.decodeRestCache.fds, ...fds];
        this.decodeRestCache.data = new Uint8Array(0);
        this.decodeRestCache.fds = [];
        // 解析并处理客户端消息
        const decoder = new WaylandDecoder(newData.buffer, newFds);

        this.receiveLog(`Parsed data from client ${this.id}:`, newData.buffer, newFds);
        this.toSend = [];
        while (decoder.getRemainingBytes() > 0) {
            const header = decoder.readHeader();
            if (!header) {
                console.log(
                    `there are ${decoder.getRemainingBytes()} bytes remaining but cannot read header, cache them for next time`,
                );

                const rest = decoder.final();

                this.decodeRestCache.data = rest.data;
                this.decodeRestCache.fds = rest.fds;
                return;
            }
            const _x = getX(this.objects, "request", header.objectId, header.opcode);
            if (!_x) {
                console.warn(`Unknown objectId/opcode: ${header.objectId}/${header.opcode}`, newData.buffer);
                return;
            }
            const args = parseArgs(decoder, _x.op.args);
            this.receiveLog(
                `Parsed args for ${_x.proto.name}#${header.objectId}.${_x.op.name}:`,
                args,
                Object.fromEntries(_x.op.args.filter((a) => a.interface).map((i) => [i.name, i.interface])),
            );

            for (const v of Object.values(_x.op.args)) {
                if (v.type === WaylandArgType.NEW_ID) {
                    const id = args[v.name] as WaylandObjectId;
                    if (v.interface === undefined) continue;
                    const _interface = WaylandProtocols[v.interface];
                    if (!id) {
                        console.error("NEW_ID argument is missing or invalid:", args);
                        continue;
                    }
                    if (!_interface) {
                        console.error("NEW_ID argument has unknown interface:", v.interface);
                        continue;
                    }
                    this.objects.set(id, { protocol: _interface, data: undefined });

                    const parentObjVer = this.protoVersions.get(_x.proto.name);
                    const thisObjVer = this.protoVersions.get(v.interface);
                    if (parentObjVer && !thisObjVer) {
                        this.protoVersions.set(v.interface, parentObjVer);
                        console.log(`${v.interface} version inherited ${parentObjVer}`);
                    }

                    this.receiveLog(`Client ${this.id} created ${v.interface} with id ${id}`);
                }
            }

            const x = { proto: _x.proto, op: _x.op, args, id: header.objectId };
            const useOp = this.opa.isOp(x);

            if (x.op.isDestructor) {
                this.deleteObj(x.id);
            }

            if (!useOp && !x.op.isDestructor) {
                console.warn("No matching operation found", `${x.proto.name}.${x.op.name}`, x);
            }
        }

        for (const m of this.toSend) {
            this.sendMessage(m.objectId, m.opcode, m.args);
        }
        this.toSend = [];
    }

    private sendMessageImm<i extends WaylandInterfaces, T extends keyof WaylandEventObj & `${i}.${string}`>(
        objectId: WaylandObjectId2<i>,
        op: T,
        args: WaylandEventObj[T],
    ) {
        this.sendMessage(objectId, WaylandEventOpcode[op.replace(".", "__")], args);
    }
    private sendMessageX<i extends WaylandInterfaces, T extends keyof WaylandEventObj & `${i}.${string}`>(
        objectId: WaylandObjectId2<i>,
        op: T,
        args: WaylandEventObj[T],
    ) {
        this.toSend.push({ objectId, opcode: WaylandEventOpcode[op.replace(".", "__")], args });
    }
    private sendMessage(objectId: WaylandObjectId, opcode: number, args: Record<string, any>) {
        const p = getX(this.objects, "event", objectId, opcode);
        if (!p) {
            console.error("Cannot find protocol for sending message", objectId, opcode);
            return;
        }
        const { op } = p;

        const protoVersion = this.protoVersions.get(p.proto.name);
        if (protoVersion) {
            if (p.op.since && protoVersion < p.op.since) {
                console.warn(
                    `Protocol version mismatch for ${p.proto.name}.${p.op.name}: ${protoVersion} < ${p.op.since}`,
                );
                return;
            }
        }

        if (op.isDestructor) {
            this.objects.delete(objectId);
        }

        const fds: number[] = [];

        const encoder = new WaylandEncoder();
        encoder.writeHeader(objectId, opcode);
        for (const a of op.args) {
            const argValue = args[a.name];
            if (argValue === undefined) {
                console.warn(`${a.name} value is undefined`);
            }
            switch (a.type) {
                case WaylandArgType.INT:
                    encoder.writeInt(argValue);
                    break;
                case WaylandArgType.UINT:
                    encoder.writeUint(argValue);
                    break;
                case WaylandArgType.FIXED:
                    encoder.writeFixed(argValue);
                    break;
                case WaylandArgType.STRING:
                    encoder.writeString(argValue);
                    break;
                case WaylandArgType.OBJECT:
                    encoder.writeObject(argValue);
                    break;
                case WaylandArgType.NEW_ID:
                    encoder.writeNewId(argValue);
                    break;
                case WaylandArgType.ARRAY:
                    encoder.writeArray(new Uint8Array((argValue as ArrayBufferView).buffer));
                    break;
                case WaylandArgType.FD:
                    fds.push(argValue);
                    break;
                default:
                    break;
            }
        }
        const x = encoder.finalizeMessage();

        this.sendLog(`-> ${this.id}:`, {
            p: `${p.proto.name}#${objectId}.${p.op.name}`,
            args,
            fds,
            data: x.data,
        });

        this.socket.write({
            data: Buffer.from(x.data),
            fds: fds || [],
        });
    }
    private deleteObj(id: WaylandObjectId) {
        this.sendMessageX(this.displayId, "wl_display.delete_id", { id });
        this.objects.delete(id);
    }
    private postError<t extends WaylandInterfaces>(
        interface_: t,
        id: WaylandObjectId2<t>,
        code: ErrorCode<t>,
        message: string = `${interface_} ${code} error`,
    ) {
        this.sendMessageX(this.displayId, "wl_display.error", {
            object_id: id,
            // @ts-expect-error 枚举名由接口名运行期拼出，类型侧无法证明
            code: getEnumValue(`${interface_}.error`, code),
            message,
        });
    }

    getAppid() {
        return this.ctx.domain.xdg.appid;
    }
    /** 当前光标状态（server 的 `cursor.get(clientId)` 走这条） */
    cursorState(): CursorState {
        return this.cursor.state;
    }
    getWindows() {
        return this.ctx.domain.windows.wins;
    }
    /** xdg_surface（窗口元素）id；窗口不存在时 undefined */
    private windowXdgSurface(winId: WaylandWinId): WaylandObjectId2<"xdg_surface"> | undefined {
        return this.ctx.domain.xdgSurface.getXdgSurfaceByToplevel(winId);
    }

    /**
     * 窗口几何：客户端 `xdg_surface.set_window_geometry` 声明的尺寸（未设置时为 surface 尺寸）。
     * x/y 是 surface 局部偏移，**不是屏幕位置**——详见 api.ts 的 WindowInfo.rect。
     */
    windowRect(winId: WaylandWinId): Rect | undefined {
        const xdgSurfaceId = this.windowXdgSurface(winId);
        if (xdgSurfaceId === undefined) return undefined;
        const geo = this.ctx.domain.xdgSurface.getXdgSurface(xdgSurfaceId).winGeo;
        if (geo) return { x: geo.x, y: geo.y, w: geo.w, h: geo.h };
        const size = this.ctx.domain.xdgSurface.getReRect(xdgSurfaceId);
        return { x: 0, y: 0, w: size.w, h: size.h };
    }

    /** 命中检测：p 相对窗口元素左上角（几何原点） */
    windowInBounds(winId: WaylandWinId, p: { x: number; y: number }): boolean {
        const xdgSurfaceId = this.windowXdgSurface(winId);
        if (xdgSurfaceId === undefined) return false;
        const rel = this.ctx.domain.xdgSurface.getReRect(xdgSurfaceId);
        // todo popup
        if (p.x < 0 || p.x >= rel.w || p.y < 0 || p.y >= rel.h) return false;
        return true; // todo
    }

    windowTitle(winId: WaylandWinId): string {
        return this.ctx.domain.windows.get(winId)?.title ?? "";
    }

    windowPreview(winId: WaylandWinId): OffscreenCanvas | undefined {
        const xdgSurfaceId = this.windowXdgSurface(winId);
        if (xdgSurfaceId === undefined) return undefined;
        const rootSurface = this.ctx.domain.xdgSurface.getXdgSurface(xdgSurfaceId).surface;
        return this.getObject(rootSurface).data.canvas;
    }

    /**
     * 指针命中检测（`ctx.hitTest` 的实现）：xdg 几何 + popup 树 + subsurface + input region。
     * 只做几何；焦点转移与 enter/leave 的协议动作在 `protocols/core/wayland.ts` 的 `input.pointer`。
     * 没命中任何 surface 时返回 undefined —— 此时**不发 leave**（见下方 todo）。
     */
    hitTest(winId: WaylandWinId, p: { x: number; y: number }): HitTestResult | undefined {
        const xdgSurfaceId = this.windowXdgSurface(winId);
        if (xdgSurfaceId === undefined) return undefined;
        const { x, y } = p;
        // 获取在哪个xdgsurface上，并区分surface还是popup
        let inXdgSurface: WaylandObjectId2<"xdg_surface"> | undefined;
        /** 相对于主xdgsurface坐标，适用于popup */
        const xdgSurfaceOffset = { x: 0, y: 0 };
        let reasonSurfaceType: "main" | "popup" | null = null;
        const xdgM = this.ctx.domain.xdgSurface;
        for (const { id: p, offset, size } of xdgM.getChildenDeepOnlyPopup(xdgSurfaceId).toReversed()) {
            const offsetX = offset.x;
            const offsetY = offset.y;
            const offsetX1 = offset.x + size.w;
            const offsetY1 = offset.y + size.h;
            if (x >= offsetX && x < offsetX1 && y >= offsetY && y < offsetY1) {
                console.log(`pointer in popup surface ${p}`);
                inXdgSurface = p;
                xdgSurfaceOffset.x = offset.x;
                xdgSurfaceOffset.y = offset.y;
                reasonSurfaceType = "popup";
                break;
            }
        }
        if (!inXdgSurface) {
            if (0 < x && x < xdgM.getReRect(xdgSurfaceId).w && 0 < y && y < xdgM.getReRect(xdgSurfaceId).h) {
                inXdgSurface = xdgSurfaceId;
                xdgSurfaceOffset.x = 0;
                xdgSurfaceOffset.y = 0;
                reasonSurfaceType = "main";
            } else {
                return undefined;
            }
        }
        // 获取与xdgsurface相关的所有surface，比如子表面
        const surfaces: {
            id: WaylandObjectId2<"wl_surface">;
            /** 相对于主surface坐标 */
            offsetRect: { x: number; y: number; w: number; h: number };
        }[] = [];
        const mainSurfaceId = xdgM.getXdgSurface(inXdgSurface).surface;
        // 主 surface 尺寸（xdg 域的 getMainSurfaceRect）：手边已有 surface id，直接问 core 的 surface 域
        const rel = this.ctx.core.surface.getWlSurface(mainSurfaceId).size;
        const { winGeo: selfOffset = { x: 0, y: 0 } } = xdgM.getXdgSurface(inXdgSurface);
        surfaces.push({ id: mainSurfaceId, offsetRect: { x: 0, y: 0, w: rel.w, h: rel.h } });
        surfaces.push(...this.ctx.core.subsurface.getChildrenDeep(mainSurfaceId));

        let inSurface: { id: WaylandObjectId2<"wl_surface">; x: number; y: number } | undefined;
        let canSend = false;
        for (const { id: s, offsetRect } of surfaces.toReversed()) {
            const offsetX = offsetRect.x - selfOffset.x + xdgSurfaceOffset.x;
            const offsetY = offsetRect.y - selfOffset.y + xdgSurfaceOffset.y;
            const offsetX1 = offsetRect.x + offsetRect.w - selfOffset.x + xdgSurfaceOffset.x;
            const offsetY1 = offsetRect.y + offsetRect.h - selfOffset.y + xdgSurfaceOffset.y;
            if (x >= offsetX && x < offsetX1 && y >= offsetY && y < offsetY1) {
                const nx = x - offsetX;
                const ny = y - offsetY;

                const surfaceInputRegion = this.getObject<"wl_surface">(s).data.current.inputRegion;
                if (surfaceInputRegion) {
                    for (const r of surfaceInputRegion) {
                        if (nx >= r.x && nx < r.x + r.width && ny >= r.y && ny < r.y + r.height) {
                            if (r.type === "+") {
                                canSend = true;
                            } else {
                                canSend = false;
                                break;
                            }
                        }
                    }
                } else canSend = true;

                if (canSend) {
                    console.log(`pointer in surface ${s}`);
                    inSurface = { id: s, x: nx, y: ny };
                    break;
                }
            }
        }

        if (inSurface) {
            return { surface: inSurface.id, x: inSurface.x, y: inSurface.y, role: reasonSurfaceType ?? "main" };
        }
        // todo 指针不在任何surface上时应发送wl_pointer.leave并清除指针焦点
        //  现在焦点悬挂：客户端收不到leave（hover状态卡住），重新进来也不发enter、客户端不重发光标
        //  还需给桌面新增sendPointerLeave()入口（移出窗口时调用，幂等），覆盖移出所有窗口、跨客户端窗口
        return undefined;
    }

    async ping() {
        const ps: Promise<void>[] = [];
        for (const id of this.ctx.domain.xdg.wmBase) {
            const p = Promise.withResolvers<void>();
            ps.push(p.promise);
            const serial = Math.floor(Math.random() * 1000000);
            this.sendMessageImm(id, "xdg_wm_base.ping", { serial: serial });
            this.getObject(id).data.pingSerials.set(serial, p.resolve);
        }
        await Promise.all(ps);
    }

    paste: (text: string) => void = (text: string) => {
        if (!this.ctx.domain.dataDevice.pendingPaste) {
            console.warn("No pending paste request");
            return;
        }
        const p = this.ctx.domain.dataDevice.pendingPaste;
        try {
            // write text into fd
            try {
                const u8 = new Uint8Array(Buffer.from(text, "utf8").buffer);
                fs.writeSync(p.fd, u8 as any, 0, u8.length, 0);
            } catch (_e) {
                // some fds may not support position; fallback to writeFileSync via fd
                try {
                    fs.writeFileSync(p.fd, text, { encoding: "utf8" as any });
                } catch (_e2) {
                    console.error("Failed to write paste text to fd:", _e2);
                }
            }
        } catch (err) {
            console.error("Error during paste():", err);
        } finally {
            clearTimeout(p.timeout);
            try {
                fs.closeSync(p.fd);
            } catch {
                // ignore
            }
            this.ctx.domain.dataDevice.pendingPaste = undefined;
        }
    };
    close() {
        for (const obj of this.objects.values()) {
            if (obj.protocol.name === "wl_shm_pool") {
                fs.closeSync(obj.data.fd);
            }
        }
        for (const _win of this.ctx.domain.windows.wins.values()) {
            // todo close win
        }
        this.socket.end();
        this.socket.destroy();
    }
}

function getX(map: WaylandClient["objects"], type: "request" | "event", objectId: WaylandObjectId, opcode: number) {
    const proto = objectId === 1 ? WaylandProtocols.wl_display : map.get(objectId)?.protocol;
    if (!proto) return null;
    if (!proto[type]) return null;
    const op = proto[type][opcode];
    if (!op) return null;
    return { proto, op };
}

function parseArgs(decoder: WaylandDecoder, args: WaylandOp["args"]) {
    const parsed: Record<string, any> = {};
    for (const arg of args) {
        switch (arg.type) {
            case WaylandArgType.INT:
                parsed[arg.name] = decoder.readInt();
                break;
            case WaylandArgType.UINT:
                parsed[arg.name] = decoder.readUint();
                break;
            case WaylandArgType.FIXED:
                parsed[arg.name] = decoder.readFixed();
                break;
            case WaylandArgType.STRING:
                parsed[arg.name] = decoder.readString();
                break;
            case WaylandArgType.OBJECT:
                parsed[arg.name] = decoder.readObject();
                break;
            case WaylandArgType.NEW_ID:
                if (arg.interface === undefined) {
                    parsed._name = decoder.readString();
                    parsed._version = decoder.readUint();
                }
                parsed[arg.name] = decoder.readNewId();
                break;
            case WaylandArgType.ARRAY:
                {
                    // 这里假设数组是一个字节数组
                    const length = decoder.readUint();
                    const arrayData = new Uint8Array(length);
                    for (let i = 0; i < length; i++) {
                        arrayData[i] = decoder.readUint() & 0xff; // 读取每个字节
                    }
                    parsed[arg.name] = arrayData;
                }
                break;
            case WaylandArgType.FD:
                parsed[arg.name] = decoder.readFileDescriptor();
                break;
            default:
                throw new Error(`Unknown argument type: ${arg.type}`);
        }
    }
    return parsed;
}
