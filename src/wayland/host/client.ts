import type { USocket } from "myde-unix-socket";
import type { Client, ClientLogConfig, ClipboardOffer, CursorState, OutputInfo, Rect, TextInputState } from "../api";
import type {
    ActionArgs,
    ActionFn,
    ActionKey,
    ActionMsg,
    DataOf,
    DndHubApi,
    DomainInit,
    ErrorCode,
    ModuleCtx,
    RequestMsg,
    TransferApi,
    WaylandClientEventMap,
    WaylandDomainRegistry,
    WaylandObjectId2,
    WaylandWinId,
} from "../module";
import { protocolModules } from "../protocols/index";
import { type WaylandEventObj, WaylandEventOpcode, type WaylandInterfaces } from "../protocols/wayland-types";
import type { renderTools } from "../render_tools";
import { FdRegistry, newFd } from "../utils/fd";
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
    version: number;
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
const outputHooks = protocolModules.flatMap((m) => (m.hooks.onOutput ? [m.hooks.onOutput] : []));

/** 桌面命令（`server.notify`）→ 协议模块的 `actions`，与请求分发表同构 */
const actionHandlers = new Map<ActionKey, ActionFn>(protocolModules.flatMap((m) => [...m.actions]));

/** 读取客户端 data source 时等待首字节 / 稳定的上限（没有可靠 EOF，只能按「不再增长」收尾） */
const FD_FIRST_BYTE_MS = 600;
const FD_IDLE_MS = 120;
const FD_MAX_BYTES = 64 * 1024 * 1024;

async function waitForFdData(fd: number): Promise<number> {
    const start = Date.now();
    let last = 0;
    let lastChange = 0;
    for (;;) {
        await new Promise((r) => setTimeout(r, 20));
        let size = 0;
        try {
            size = Number(fs.fstatSync(fd).size) || 0;
        } catch {
            return 0;
        }
        if (size > 0 && size !== last) {
            last = size;
            lastChange = Date.now();
        }
        if (last > 0 && Date.now() - lastChange >= FD_IDLE_MS) return Math.min(last, FD_MAX_BYTES);
        if (last > FD_MAX_BYTES) return FD_MAX_BYTES;
        if (last === 0 && Date.now() - start > FD_FIRST_BYTE_MS) return 0;
        if (Date.now() - start > 3000) return Math.min(last, FD_MAX_BYTES);
    }
}

/**
 * server 注入的宿主能力。client 只认识这几条，fan-in / handle 分配全在 server（见 host/server.ts）。
 */
export interface ClientHost {
    /** 桌面提供的可用空间（同步；xdg_surface.get_toplevel 要填 configure_bounds） */
    surfaceBounds(): { width: number; height: number } | undefined;
    /** 当前输出配置（桌面调用 `server.outputs.set` 写入） */
    output(): OutputInfo;
    /** 光标状态变化，server 转成 `cursor.changed` 事件 */
    cursorChanged(state: CursorState): void;
    /** 数据中转：剪贴板 / 拖拽的 fd 与字节出口（实现在 server） */
    transfer: TransferApi;
    /** 跨客户端拖拽会话（实现在 host/dnd_hub） */
    dnd: DndHubApi;
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
    private objects: Map<WaylandObjectId, { protocol: WaylandProtocol; data: any; version: number }>; // 客户端拥有的对象
    private toSend: { objectId: WaylandObjectId; opcode: number; args: Record<string, any> }[] = [];
    private nextObjectId: number = 0xff000000;
    private render: renderTools;
    /** 光标的唯一写入点（见 host/cursor_store.ts）：唯一由 host 持有的语义状态 */
    private cursor: CursorStore;
    /** 协议模块看到的 host 能力面 —— module.ts 契约的真实实现 */
    public readonly ctx: ModuleCtx;
    /** 每个 data source 的读取串行队列（见 `readDataSource`） */
    private dataSourceReads = new Map<number, Promise<Uint8Array | null>>();
    /** 本连接持有的客户端 fd（dma-buf plane、wl_shm pool），按引用计数关 */
    private readonly fds = new FdRegistry();
    // 事件存储
    private events: { [K in keyof WaylandClientEventMap]?: WaylandClientEventMap[K][] } = {};

    /** server 注入的宿主能力（可用空间、光标状态出口） */
    private host: ClientHost;

    /** close 可能被 socket close/error 两条路径各调一次，渲染清理只做一次 */
    private cleanedUp = false;

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
            this.handleDisconnect("disconnected");
        });

        socket.on("end", () => {
            // myde-unix-socket 的 USocket 在对端断开时只发 end（close 还要本地先 shutdown），
            // 不能只监听 close，否则客户端进程退出后连接和窗口会一直挂在 server 里
            this.handleDisconnect("peer end");
        });

        socket.on("error", (err) => {
            console.error(`Client ${this.id} error:`, err);
            this.handleDisconnect("error");
        });
    }

    /** 连接断开只处理一次：socket 可能先后发 end/close/error */
    private handleDisconnect(reason: string): void {
        if (this.cleanedUp) return;
        console.log(`Client ${this.id} ${reason}`);
        this.emit("close");
        this.close();
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
                create: (iface, version) => {
                    const id = this.allocateObjectId();
                    this.objects.set(id, {
                        protocol: WaylandProtocols[iface],
                        data: undefined,
                        // 不知道父对象版本时按接口最大版本建，事件过滤仍以调用方给的版本为准
                        version: version ?? WaylandProtocols[iface].version,
                    });
                    return id as WaylandObjectId2<typeof iface>;
                },
                delete: (id) => this.deleteObj(id),
                entries: () => this.objects.entries(),
                has: (id) => this.objects.has(id),
                bind: (msg) => {
                    this.objects.set(msg.id, {
                        protocol: msg.protocol,
                        data: undefined,
                        version: msg.version > 0 ? msg.version : msg.protocol.version,
                    });
                },
            },
            /** 入队，本批消息处理完统一 flush */
            send: (target, event, args) => this.sendMessageX(target, event, args),
            /** 立即写 socket */
            sendNow: (target, event, args) => this.sendMessageImm(target, event, args),
            postError: (iface, id, code, message) => this.postError(iface, id, code, message),
            fds: {
                retain: (fd) => this.fds.retain(fd),
                release: (fd) => this.fds.release(fd),
            },
            // host 只能先给 `registry`（跨模块 `globals` 聚合）；surface/subsurface 是占位，
            // 由下面的装配循环按 `mod.core` 回填（`undefined!` = 装配前不存在，装配后即为完整对象）
            core: {
                // biome-ignore lint/style/noNonNullAssertion: 占位，buildCtx 结尾的装配循环按 mod.core 回填
                surface: undefined!,
                // biome-ignore lint/style/noNonNullAssertion: 同上
                subsurface: undefined!,
                // biome-ignore lint/style/noNonNullAssertion: 占位，buildCtx 结尾的装配循环按 mod.core 回填
                focusKeyboard: undefined!,
                // biome-ignore lint/style/noNonNullAssertion: 同上（grab 收尾在 core 模块）
                forcePointerGrab: undefined!,
                // biome-ignore lint/style/noNonNullAssertion: 同上（pointer leave 在 core 模块）
                leavePointer: undefined!,
                // biome-ignore lint/style/noNonNullAssertion: 同上（scroll/gesture 补 pointer enter）
                ensurePointerFocus: undefined!,
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
                focus: (seat, surfaceId) => {
                    for (const h of focusHooks) h(seat, surfaceId, this.ctx);
                },
                textInput: (seat, text, preedit) => {
                    for (const h of textInputHooks) h(seat, text, preedit, this.ctx);
                },
            },
            cursor: this.cursor,
            client: {
                id: this.id,
                displayId: this.displayId,
                emit: this.emit.bind(this),
                surfaceBounds: () => this.host.surfaceBounds(),
                output: () => this.host.output(),
            },
            transfer: this.host.transfer,
            dnd: this.host.dnd.forClient(this.id),
            scene: this.render,
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
        // 跨客户端拖拽：域状态装配完后再注册，peer 的查询方法此时都能用
        this.host.dnd.attach({
            clientId: this.id,
            objects: ctx.objects,
            sendNow: (id, event, args) => this.sendMessageImm(id as never, event as never, args as never),
            dataDevices: (seat) => [...(ctx.domain.dataDevice.devices?.get(seat) ?? [])],
            nextSerial: () => ctx.domain.serial.next(),
            hitTest: (winId, p) => ctx.domain.xdgSurface.hitTest(winId, p),
            sendDataSource: (sourceId, mime, fd) => this.sendDataSource(sourceId, mime, fd),
            readDataSource: (sourceId, mime) => this.readDataSource(sourceId, mime),
            detachLocalDrag: () => this.detachDataDrag(),
            endLocalDrag: () => this.endDataDrag(),
        });
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

    /** 输出配置变化（桌面 `server.outputs.set`）：扇出给各协议模块重发输出相关事件。 */
    applyOutput(): void {
        for (const hook of outputHooks) hook(this.ctx);
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
                    this.objects.set(id, {
                        protocol: _interface,
                        data: undefined,
                        // 新对象版本继承请求的目标对象（与 libwayland 客户端创建代理时一致）
                        version: Math.min(
                            objectVersion(this.objects, header.objectId) ?? _interface.version,
                            _interface.version,
                        ),
                    });

                    this.receiveLog(`Client ${this.id} created ${v.interface} with id ${id}`);
                }
            }

            const x = { proto: _x.proto, op: _x.op, args, id: header.objectId };
            const useOp = this.opa.isOp(x);

            if (x.op.isDestructor) {
                // 客户端创建的 id 才需要回 delete_id；服务端 new_id（0xff...）由 server 分配，
                // 客户端销毁后只删本地对象，不能再给它发 delete_id，否则会收到 unknown id 协议错误
                // 服务端 new_id 从 0xff000000 开始
                if (x.id < 0xff000000) this.deleteObj(x.id);
                else this.objects.delete(x.id);
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

        // 事件只能发到对象自己的版本范围：客户端 bind 得低（或从低版本对象继承）时
        // 发更高 `since` 的事件，libwayland 客户端会当作错误直接断开。
        const version = objectVersion(this.objects, objectId) ?? p.proto.version;
        if (op.since && version < op.since) {
            console.warn(`Protocol version mismatch for ${p.proto.name}.${p.op.name}: ${version} < ${op.since}`);
            return;
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

    /**
     * 窗口的 text-input 状态。
     *
     * `supported` 看该连接是否创建过 text-input 对象；`enabled` 还要求仲裁持有者确实拿到了
     * 该窗口的文本焦点（v3: entered + enabled + seat 焦点 surface 命中；v1: activate 后的 focus）。
     * 光标矩形是 surface 局部坐标，v1 没有可靠来源，返回 null。
     */
    textInputState(winId: WaylandWinId): TextInputState {
        const supported = this.ctx.domain.textInputV3.m.size > 0 || this.ctx.domain.textInputV1.m.size > 0;
        const owner = this.ctx.domain.textInput.owner;
        if (!owner) return { supported, enabled: false, cursorRect: null };

        if (owner.protocol === "v3") {
            const t = this.ctx.domain.textInputV3.m.get(owner.id);
            if (!t) return { supported, enabled: false, cursorRect: null };
            const xdgSurfaceId = this.windowXdgSurface(winId);
            const surface =
                xdgSurfaceId === undefined ? undefined : this.ctx.domain.xdgSurface.getXdgSurface(xdgSurfaceId).surface;
            const focused = surface !== undefined && [...this.ctx.domain.textInputV3.focus.values()].includes(surface);
            const enabled = t.entered && t.current.enabled && focused;
            const caret = t.current.cursorRect;
            return {
                supported: true,
                protocol: "v3",
                enabled,
                cursorRect: enabled && caret ? { x: caret.x, y: caret.y, w: caret.width, h: caret.height } : null,
            };
        }

        const t = this.ctx.domain.textInputV1.m.get(owner.id);
        return { supported: true, protocol: "v1", enabled: t?.focus === true, cursorRect: null };
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

    /**
     * 命中检测：p 相对窗口元素左上角（几何原点）。
     * 走 xdg 域的完整几何（主 surface + popup 树 + subsurface + input region），
     * popup 超出顶层窗口范围时也能命中。
     */
    windowHitTest(winId: WaylandWinId, p: { x: number; y: number }): boolean {
        if (this.windowXdgSurface(winId) === undefined) return false;
        return this.ctx.domain.xdgSurface.hitTest(winId, p) !== undefined;
    }

    windowTitle(winId: WaylandWinId): string {
        return this.ctx.domain.windows.get(winId)?.title ?? "";
    }

    windowPreview(winId: WaylandWinId): OffscreenCanvas | undefined {
        const xdgSurfaceId = this.windowXdgSurface(winId);
        if (xdgSurfaceId === undefined) return undefined;
        const rootSurface = this.ctx.domain.xdgSurface.getXdgSurface(xdgSurfaceId).surface;
        const root = this.ctx.core.surface.getWlSurface(rootSurface).frame ?? this.getObject(rootSurface).data.canvas;
        // 子表面在 DOM 里由独立的 canvas 叠上去，缩略图必须自己合成；
        // 只看根 surface 会得到 Firefox 那种「shadow 有、内容没有」的空窗口。
        const children = this.ctx.core.subsurface.getChildrenDeep(rootSurface);
        const drawables = children.flatMap(({ id, offsetRect }) => {
            const frame = this.ctx.core.surface.getWlSurface(id).frame;
            return frame === undefined ? [] : [{ frame, x: offsetRect.x, y: offsetRect.y }];
        });
        if (drawables.length === 0) return root;

        let minX = 0;
        let minY = 0;
        let maxX = root.width;
        let maxY = root.height;
        for (const d of drawables) {
            minX = Math.min(minX, d.x);
            minY = Math.min(minY, d.y);
            maxX = Math.max(maxX, d.x + d.frame.width);
            maxY = Math.max(maxY, d.y + d.frame.height);
        }
        const canvas = new OffscreenCanvas(Math.max(1, maxX - minX), Math.max(1, maxY - minY));
        const c2d = canvas.getContext("2d");
        if (!c2d) return root;
        c2d.drawImage(root, -minX, -minY);
        for (const d of drawables) c2d.drawImage(d.frame, d.x - minX, d.y - minY);
        return canvas;
    }

    async ping() {
        const ps: Promise<void>[] = [];
        for (const id of this.ctx.domain.xdg.wmBase) {
            const p = Promise.withResolvers<void>();
            ps.push(p.promise);
            const serial = this.ctx.domain.serial.next();
            this.sendMessageImm(id, "xdg_wm_base.ping", { serial });
            this.getObject(id).data.pingSerials.set(serial, p.resolve);
        }
        await Promise.all(ps);
    }

    /**
     * 把当前 selection 的 mimes offer 给本连接（server 在 selection 变化 / 焦点进入时调用）。
     * 协议组包在 core 的 `clipboard.offer` action，这里只负责跨连接入口。
     */
    offerClipboard(selection: ClipboardOffer | null, seat?: string): void {
        this.runAction("clipboard.offer", 0 as WaylandWinId, [selection ?? undefined, seat]);
    }

    /** 把 fd 交给本连接的 wl_data_source（跨连接剪贴板转发的落点） */
    sendDataSource(sourceId: number, mime: string, fd: number): boolean {
        const id = sourceId as WaylandObjectId2<"wl_data_source">;
        if (!this.getObjectOption(id)) return false;
        this.sendMessageImm(id, "wl_data_source.send", { mime_type: mime, fd });
        return true;
    }

    /** 通知客户端 source 不再被需要 */
    cancelDataSource(sourceId: number): void {
        const id = sourceId as WaylandObjectId2<"wl_data_source">;
        if (this.getObjectOption(id)) this.sendMessageImm(id, "wl_data_source.cancelled", {});
    }

    /** 桌面开始驱动拖拽目标：撤掉本连接自己的同 client 目标，避免双份 enter/drop */
    detachDataDrag(): void {
        this.runAction("dnd.detachLocal", 0 as WaylandWinId, []);
    }

    /** 会话结束：清掉本连接的本地拖拽状态（源已收到 finished/cancelled） */
    endDataDrag(): void {
        this.runAction("dnd.endLocal", 0 as WaylandWinId, []);
    }

    /**
     * 读一次客户端 data source 的 mime；同一 source 的读取串行化
     * （部分客户端不接受并发 `wl_data_source.send`）。无数据/源已消失返回 null。
     */
    readDataSource(sourceId: number, mime: string): Promise<Uint8Array | null> {
        const id = sourceId as WaylandObjectId2<"wl_data_source">;
        if (!this.getObjectOption(id)) return Promise.resolve(null);
        const prev = this.dataSourceReads.get(sourceId);
        const next = (prev ? prev.catch(() => undefined) : Promise.resolve()).then(() =>
            this.readDataSourceNow(id, mime),
        );
        this.dataSourceReads.set(sourceId, next);
        return next.finally(() => {
            if (this.dataSourceReads.get(sourceId) === next) this.dataSourceReads.delete(sourceId);
        });
    }

    private async readDataSourceNow(
        sourceId: WaylandObjectId2<"wl_data_source">,
        mime: string,
    ): Promise<Uint8Array | null> {
        const { fd } = newFd("");
        try {
            this.sendMessageImm(sourceId, "wl_data_source.send", { mime_type: mime, fd });
            const size = await waitForFdData(fd);
            if (size <= 0) return null;
            const out = new Uint8Array(size);
            let off = 0;
            while (off < size) {
                const n = fs.readSync(fd, out, off, size - off, off);
                if (n <= 0) break;
                off += n;
            }
            return off === size ? out : out.subarray(0, off);
        } catch (err) {
            console.error("readDataSource failed:", err);
            return null;
        } finally {
            try {
                fs.closeSync(fd);
            } catch {
                // ignore
            }
        }
    }
    /**
     * 连接断开兜底：客户端不会再发 wl_surface.destroy / xdg destroy，
     * 这里直接撤掉元素与画布，避免软件已退出但 canvas DOM 还留在屏幕上。
     */
    private cleanupRender(): void {
        if (this.cleanedUp) return;
        this.cleanedUp = true;
        this.host.dnd.detach(this.id);
        this.ctx.domain.xdgSurface.destroyAll();
        for (const [id, obj] of this.objects) {
            if (obj.protocol.name !== "wl_surface") continue;
            const surfaceId = id as WaylandObjectId2<"wl_surface">;
            if (this.cursor.isCursorSurface(surfaceId)) this.cursor.hide(surfaceId);
            this.ctx.core.surface.destroyWlSurface(surfaceId);
        }
        this.cursor.hide();
    }
    close() {
        this.cleanupRender();
        // 客户端不会再 destroy 剩下的对象了：把还登记着的 fd（dma-buf plane、shm pool）
        // 一次关掉，否则它们会一直钉住显存；半条消息里缓存的 fd 同样要清。
        this.fds.closeAll();
        for (const fd of this.decodeRestCache.fds) {
            try {
                fs.closeSync(fd);
            } catch {
                // ignore
            }
        }
        this.decodeRestCache.fds = [];
        this.socket.end();
        this.socket.destroy();
    }
}

/** 对象自己的协议版本。`wl_display`（id 1）不在对象表里，恒为版本 1；没有记录时返回 undefined */
function objectVersion(objects: Map<WaylandObjectId, { version: number }>, id: WaylandObjectId): number | undefined {
    if (id === 1) return 1;
    return objects.get(id)?.version;
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
