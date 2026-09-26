import type { USocket } from "myde-unix-socket";
import { InputEventCodes } from "../../input_codes/types";
import type {
    ClientState,
    DataOf,
    ErrorCode,
    ModuleCtx,
    RequestMsg,
    TextInputV3Data,
    TextInputV3State,
    WaylandClientEventMap,
    WaylandClientSyncEventMap,
    WaylandObjectId2,
    WaylandObjectId3,
    WaylandWinId,
} from "../module";
import { protocolModules } from "../protocols/index";
import {
    type WaylandEventObj,
    WaylandEventOpcode,
    type WaylandInterfaces,
    type WaylandRequestObj,
} from "../protocols/wayland-types";
import type { renderTools } from "../render_tools";
import { CursorStore } from "../state/cursor_store";
import { SeatStore } from "../state/seat_store";
import { type WindowRecord, WindowsStore } from "../state/windows_store";
import type { WaylandObjectId, WaylandOp, WaylandProtocol } from "../utils/wayland-binary";
import { WaylandArgType } from "../utils/wayland-binary";
import { WaylandDecoder } from "../utils/wayland-decoder";
import { WaylandEncoder } from "../utils/wayland-encoder";
import {
    getEnumName,
    getEnumValue,
    tryX,
    WaylandProtocols,
    waylandObjectId,
    waylandProtocolsNameMap,
} from "../utils/wayland-proto";

const fs = require("node:fs") as typeof import("node:fs");

/**
 * 单个 wayland 连接：对象表、解码分发、ModuleCtx 构造，以及对桌面暴露的窗口/输入门面。
 *
 * 由 server.ts 拆出（Phase 3）。协议请求本身已在 protocols/** 里，这里只剩 host 职责；
 * 连接生命周期（监听、建连）仍在 WaylandServer。
 */

type ParsedMessage = { id: WaylandObjectId; proto: WaylandProtocol; op: WaylandOp; args: Record<string, any> };

function newTextInputV3State(): TextInputV3State {
    return {
        enabled: false,
        surroundingText: { text: "", cursor: 0, anchor: 0 },
        textChangeCause: "input_method",
        contentHint: 0,
        contentPurpose: 0,
        cursorRect: null,
    };
}

type WaylandObjectX<T extends WaylandInterfaces> = {
    protocol: WaylandProtocol;
    data: DataOf<T>;
};

class WaylandSurfaceRoleError extends Error {}

class wlSurfaceData {
    private wl_surface: Record<
        WaylandObjectId2<"wl_surface">,
        {
            role: "subsurface" | "toplevel" | "popup" | "cursor" | undefined;
            size: { w: number; h: number };
            // 最近一次合成输出的画布，可能与surface画布共用，取用时需要复制
            frame?: OffscreenCanvas;
        }
    > = {};

    render: renderTools;
    idScope: (id: unknown) => string;

    constructor(render: renderTools) {
        this.render = render;
        this.idScope = render.idScope();
    }

    addWlSurface(id: WaylandObjectId2<"wl_surface">) {
        this.wl_surface[id] = { role: undefined, size: { w: 0, h: 0 } };
        this.render.bindCanvas(this.idScope(id));
    }
    getWlSurface(id: WaylandObjectId2<"wl_surface">) {
        return this.wl_surface[id];
    }
    renderWlSurface(id: WaylandObjectId2<"wl_surface">, canvas: OffscreenCanvas) {
        this.wl_surface[id].frame = canvas;
        this.render.renderCanvas(canvas, this.idScope(id));
    }
    destroyWlSurface(id: WaylandObjectId2<"wl_surface">) {
        delete this.wl_surface[id];
        this.render.destroyCanvas(this.idScope(id));
    }

    setWlSurfaceRole(id: WaylandObjectId2<"wl_surface">, role: "subsurface" | "toplevel" | "popup" | "cursor") {
        const oldRole = this.wl_surface[id].role;
        if (oldRole !== undefined && oldRole !== role) {
            throw new WaylandSurfaceRoleError();
        }
        this.wl_surface[id].role = role;
    }
    updateWlSurfaceSize(id: WaylandObjectId2<"wl_surface">, w: number, h: number) {
        this.wl_surface[id].size = { w, h };
    }
    setWlSurfaceOffset(id: WaylandObjectId2<"wl_surface">, x: number, y: number) {
        this.render.setBufferOffset(this.idScope(id), x, y);
    }
}

class wlSubSurfaceData {
    wl_surface: wlSurfaceData;
    wl_subsurface: Record<
        WaylandObjectId2<"wl_subsurface">,
        {
            parent: WaylandObjectId2<"wl_surface">;
            child: WaylandObjectId2<"wl_surface">;
            posi: { x: number; y: number };
        }
    > = {};
    parentChildren = new Map<WaylandObjectId2<"wl_surface">, WaylandObjectId2<"wl_subsurface">[]>();
    private surface2subsurface = new Map<WaylandObjectId2<"wl_surface">, WaylandObjectId2<"wl_subsurface">>();
    private render: renderTools;
    private idScope: (id: unknown) => string;
    constructor(wl: wlSurfaceData) {
        this.wl_surface = wl;
        this.render = wl.render;
        this.idScope = wl.idScope;
    }

    setWlSubSurface(
        subRelationId: WaylandObjectId2<"wl_subsurface">,
        parent: WaylandObjectId2<"wl_surface">,
        child: WaylandObjectId2<"wl_surface">,
    ) {
        const [roleerror] = tryX(() => {
            this.wl_surface.setWlSurfaceRole(child, "subsurface");
        });
        if (roleerror instanceof WaylandSurfaceRoleError) {
            return "bad_surface";
        }
        if (parent === child) {
            return "bad_parent";
        }
        for (const c of this.getChildrenDeep(child)) {
            if (c.id === parent) {
                return "bad_parent";
            }
        }
        const oldRelationId = this.getSubSurfaceBySurface(child);
        if (oldRelationId) {
            // 已经有父子关系了，先删除旧关系
            const oldRelation = this.wl_subsurface[oldRelationId];
            // biome-ignore lint/style/noNonNullAssertion: 关系与parentchildren应该是同步的
            const oldTree = this.parentChildren.get(oldRelation.parent)!;
            this.parentChildren.set(
                oldRelation.parent,
                oldTree.filter((c) => c !== oldRelationId),
            );
        }

        this.wl_subsurface[subRelationId] = { parent, child, posi: { x: 0, y: 0 } };
        const parentData = this.parentChildren.get(parent) ?? [];
        parentData.push(subRelationId);
        this.parentChildren.set(parent, parentData);
        this.surface2subsurface.set(child, subRelationId);

        this.render.setCanvasAnchor(this.idScope(child), this.idScope(parent));

        return true;
    }
    private getSubSurfaceBySurface(child: WaylandObjectId2<"wl_surface">) {
        return this.surface2subsurface.get(child);
    }
    getParentChildren(parent: WaylandObjectId2<"wl_surface">) {
        const subs = Array.from(this.parentChildren.get(parent) ?? []);
        return subs.map((s) => this.wl_subsurface[s].child);
    }
    getParentChildrenWithRect(parent: WaylandObjectId2<"wl_surface">) {
        const subs = Array.from(this.parentChildren.get(parent) ?? []);
        return subs.map((s) => ({
            id: this.wl_subsurface[s].child,
            offsetRect: {
                x: this.wl_subsurface[s].posi.x,
                y: this.wl_subsurface[s].posi.y,
                w: this.wl_surface.getWlSurface(this.wl_subsurface[s].child).size.w,
                h: this.wl_surface.getWlSurface(this.wl_subsurface[s].child).size.h,
            },
        }));
    }
    setPosition(id: WaylandObjectId2<"wl_subsurface">, x: number, y: number) {
        const sub = this.wl_subsurface[id];
        sub.posi.x = x;
        sub.posi.y = y;

        this.render.setCanvasOffset(this.idScope(sub.child), x, y);
    }
    getSubSurface(id: WaylandObjectId2<"wl_subsurface">) {
        return {
            parent: this.wl_subsurface[id].parent,
            surface: this.wl_subsurface[id].child,
            posi: this.wl_subsurface[id].posi,
        };
    }
    getChildrenDeep(parent: WaylandObjectId2<"wl_surface">) {
        const surfaces: {
            id: WaylandObjectId2<"wl_surface">;
            offsetRect: { x: number; y: number; w: number; h: number };
        }[] = [];

        // todo 遍历树，offset相加
        surfaces.push(...this.getParentChildrenWithRect(parent));
        return surfaces;
    }
    destroySubSurface(id: WaylandObjectId2<"wl_subsurface">) {
        const relation = this.wl_subsurface[id];
        const parent = relation.parent;
        const child = relation.child;
        const parentData = this.parentChildren.get(parent);
        if (parentData) {
            this.parentChildren.set(
                parent,
                parentData.filter((c) => c !== id),
            );
        }
        this.surface2subsurface.delete(child);
        delete this.wl_subsurface[id];
    }
}

class xdgSurfaceData {
    wl_surface: wlSurfaceData;

    xdg_surface: Record<
        WaylandObjectId2<"xdg_surface">,
        {
            surface: WaylandObjectId2<"wl_surface">;
            winGeo?: { x: number; y: number; w: number; h: number };
            offset: { x: number; y: number }; // 一般popup的才有
            xdg_role?: WaylandObjectId2<"xdg_toplevel" | "xdg_popup">;
            parent: WaylandObjectId2<"xdg_surface"> | undefined;
            children: WaylandObjectId2<"xdg_surface">[];
        }
    > = {};
    xdg_popup = new Map<WaylandObjectId2<"xdg_popup">, WaylandObjectId2<"xdg_surface">>();
    xdg_toplevel = new Map<WaylandObjectId2<"xdg_toplevel">, WaylandObjectId2<"xdg_surface">>();
    private render: renderTools;
    private idScope: (id: unknown) => string;
    constructor(wl: wlSurfaceData) {
        this.wl_surface = wl;
        this.render = wl.render;
        this.idScope = wl.idScope;
    }

    addXdgSurface(id: WaylandObjectId2<"xdg_surface">, wlSurface: WaylandObjectId2<"wl_surface">) {
        this.xdg_surface[id] = { surface: wlSurface, parent: undefined, children: [], offset: { x: 0, y: 0 } };

        this.render.createXdgSurfaceEle(this.idScope(id), this.idScope(wlSurface));
    }
    getXdgSurface(id: WaylandObjectId2<"xdg_surface">) {
        return this.xdg_surface[id];
    }
    setXdgSurfaceSize(id: WaylandObjectId2<"xdg_surface">, x: number, y: number, w: number, h: number) {
        this.xdg_surface[id].winGeo = { x, y, w, h };

        this.render.setXdgSurfaceGeo(this.idScope(id), w, h, x, y);
    }
    getXdgSurfaceByToplevel(id: WaylandObjectId2<"xdg_toplevel">) {
        return this.xdg_toplevel.get(id);
    }
    getXdgSurfaceByPopup(id: WaylandObjectId2<"xdg_popup">) {
        return this.xdg_popup.get(id);
    }
    setRelation(parent: WaylandObjectId2<"xdg_surface">, child: WaylandObjectId2<"xdg_surface">) {
        this.xdg_surface[child].parent = parent;
        this.xdg_surface[parent].children.push(child);
    }
    rmRelation(parent: WaylandObjectId2<"xdg_surface">, child: WaylandObjectId2<"xdg_surface">) {
        this.xdg_surface[child].parent = undefined;
        this.xdg_surface[parent].children = this.xdg_surface[parent].children.filter((c) => c !== child);
    }
    getMainSurfaceRect(id: WaylandObjectId2<"xdg_surface">) {
        const xdgSurface = this.getXdgSurface(id);
        const mainWlSurface = this.wl_surface.getWlSurface(xdgSurface.surface);
        const size = mainWlSurface.size;
        // todo subsurface 需要考虑吗
        return { w: size.w, h: size.h };
    }
    /** 获取xdgsurface窗口大小 */
    getReRect(id: WaylandObjectId2<"xdg_surface">) {
        const xdgSurface = this.getXdgSurface(id);
        const mainWlSurface = this.wl_surface.getWlSurface(xdgSurface.surface);
        const size = xdgSurface.winGeo ?? mainWlSurface.size;
        // todo subsurface
        return { w: size.w, h: size.h };
    }
    setAsToplevel(id: WaylandObjectId2<"xdg_surface">, toplevelId: WaylandObjectId2<"xdg_toplevel">) {
        this.wl_surface.setWlSurfaceRole(this.getXdgSurface(id).surface, "toplevel");
        this.xdg_toplevel.set(toplevelId, id);
        this.xdg_surface[id].xdg_role = toplevelId;

        this.render.asToplevel(this.idScope(id));
    }
    setAsPopup(
        id: WaylandObjectId2<"xdg_surface">,
        popupId: WaylandObjectId2<"xdg_popup">,
        parent: WaylandObjectId2<"xdg_surface">,
    ) {
        this.wl_surface.setWlSurfaceRole(this.getXdgSurface(id).surface, "popup");
        this.xdg_popup.set(popupId, id);
        this.xdg_surface[id].xdg_role = popupId;
        this.setRelation(parent, id);

        this.render.addPopupToXdgSurface(this.idScope(id), this.idScope(parent));
    }
    setOffset(id: WaylandObjectId2<"xdg_surface">, x: number, y: number) {
        this.getXdgSurface(id).offset.x = x;
        this.getXdgSurface(id).offset.y = y;

        this.render.setPopupPosi(this.idScope(id), x, y);
    }
    xdgSurfaceDestroyed(xdgSurfaceId: WaylandObjectId2<"xdg_surface">, type: "toplevel" | "popup") {
        delete this.xdg_surface[xdgSurfaceId];

        this.render.destroyXdgSurfaceEle(this.idScope(xdgSurfaceId), type);
    }
    popupDestroyed(popupId: WaylandObjectId2<"xdg_popup">) {
        const id = this.xdg_popup.get(popupId);
        if (id === undefined) {
            return;
        }
        const xdgSurface = this.getXdgSurface(id);
        const parent = xdgSurface.parent;
        if (parent) {
            this.rmRelation(parent, id);
        }
        this.xdgSurfaceDestroyed(id, "popup");
        this.xdg_popup.delete(popupId);
    }
    toplevelDestroyed(toplevelId: WaylandObjectId2<"xdg_toplevel">) {
        const id = this.xdg_toplevel.get(toplevelId);
        if (id === undefined) {
            return;
        }
        const xdgSurface = this.getXdgSurface(id);
        const parent = xdgSurface.parent;
        if (parent) {
            this.rmRelation(parent, id);
        }
        this.xdgSurfaceDestroyed(id, "toplevel");
        this.xdg_toplevel.delete(toplevelId);
    }
    getChildenDeepOnlyPopup(parent: WaylandObjectId2<"xdg_surface">) {
        const children: {
            id: WaylandObjectId2<"xdg_surface">;
            offset: { x: number; y: number };
            size: { w: number; h: number };
        }[] = [];
        // todo tree walk
        children.push(
            ...this.xdg_surface[parent].children
                .filter((c) => this.wl_surface.getWlSurface(this.getXdgSurface(c).surface).role === "popup")
                .map((i) => ({
                    id: i,
                    offset: this.getXdgSurface(i).offset, // todo 合并父偏移
                    size: this.getReRect(i),
                })),
        );
        return children;
    }
}

const globalsByInterface = new Map(protocolModules.flatMap((m) => m.globals.map((g) => [g.name, g] as const)));

/**
 * 各模块声明的 surface 钩子。core 不 import 扩展，靠这里聚合后触发——
 * 这是 core → 扩展唯一的反向通道（正向依赖走 ctx.core）。
 */
const commitHooks = protocolModules.flatMap((m) => (m.hooks.onCommit ? [m.hooks.onCommit] : []));
const frameHooks = protocolModules.flatMap((m) => (m.hooks.onFrame ? [m.hooks.onFrame] : []));
const destroyHooks = protocolModules.flatMap((m) => (m.hooks.onDestroy ? [m.hooks.onDestroy] : []));
const focusHooks = protocolModules.flatMap((m) => (m.hooks.onFocus ? [m.hooks.onFocus] : []));

export class WaylandClient {
    logConfig = {
        receive: true,
        send: true,
    } as {
        receive: true | string[];
        send: true | string[];
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
    /** 光标的唯一写入点（见 state/cursor_store.ts） */
    private cursor: CursorStore;
    /** 协议模块看到的 host 能力面 —— module.ts 契约的真实实现 */
    public readonly ctx: ModuleCtx;
    /** 输入设备侧状态（见 state/seat_store.ts） */
    private seat: SeatStore;
    /** 窗口记录与窗口事件的唯一持有者（见 state/windows_store.ts） */
    private windows: WindowsStore;
    /** 客户端级状态；形状定义在 module.ts 的 ClientState（原 obj2 内联类型） */
    private obj2: ClientState;
    private wlSurface: wlSurfaceData;
    private dataManager: {
        wlSubSurface: wlSubSurfaceData;
        xdgSurface: xdgSurfaceData;
    };
    // 事件存储
    private events: { [K in keyof WaylandClientEventMap]?: WaylandClientEventMap[K][] } = {};

    private syncHandlers: { [K in keyof WaylandClientSyncEventMap]?: WaylandClientSyncEventMap[K] } = {};

    public onSync<K extends keyof WaylandClientSyncEventMap>(
        event: K,
        handler: NonNullable<WaylandClientSyncEventMap[K]>,
    ): () => void {
        this.syncHandlers[event] = handler;
        return () => {
            if (this.syncHandlers[event] === handler) this.syncHandlers[event] = undefined;
        };
    }

    public emitSync<K extends keyof WaylandClientSyncEventMap>(
        event: K,
        ...args: Parameters<NonNullable<WaylandClientSyncEventMap[K]>>
    ): ReturnType<NonNullable<WaylandClientSyncEventMap[K]>> | undefined {
        const h = this.syncHandlers[event];
        if (!h) return undefined;
        try {
            return (h as any)(...(args as any));
        } catch (err) {
            console.error("sync handler error for", String(event), err);
            return undefined;
        }
    }

    constructor({ id, socket, render }: { id: string; socket: USocket; render: renderTools }) {
        this.id = id;
        this.socket = socket;
        this.pid = socket.pid;
        this.objects = new Map();
        this.obj2 = {
            textInputV3: { focus: null, m: new Map() },
            textInputOwner: null,
            appid: undefined,
            xdg_wm_base: new Set(),
        };
        this.render = render;
        this.cursor = new CursorStore(render);
        this.seat = new SeatStore();
        // 窗口事件的对外出口：Phase 2 仍是 client 级，Phase 6 只改这里
        this.windows = new WindowsStore({
            created: (wid, renderId) => this.emit("windowCreated", wid, renderId),
            closed: (wid) => this.emit("windowClosed", wid),
            resized: (wid, width, height) => this.emit("windowResized", wid, width, height),
            startMove: (wid) => this.emit("windowStartMove", wid),
            maximized: (wid) => this.emit("windowMaximized", wid),
            unmaximized: (wid) => this.emit("windowUnMaximized", wid),
            titleChanged: (wid, title) => this.emit("title", wid, title),
        });
        this.wlSurface = new wlSurfaceData(render);
        this.dataManager = {
            wlSubSurface: new wlSubSurfaceData(this.wlSurface),
            xdgSurface: new xdgSurfaceData(this.wlSurface),
        };
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
        return {
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
            core: {
                surface: {
                    addWlSurface: (id) => this.wlSurface.addWlSurface(id),
                    getWlSurface: (id) => this.wlSurface.getWlSurface(id),
                    getRole: (id) => this.wlSurface.getWlSurface(id).role,
                    setRole: (id, role) => {
                        try {
                            this.wlSurface.setWlSurfaceRole(id, role);
                            return true;
                        } catch (e) {
                            if (e instanceof WaylandSurfaceRoleError) return false;
                            throw e;
                        }
                    },
                    getSize: (id) => this.wlSurface.getWlSurface(id).size,
                    getFrame: (id) => this.wlSurface.getWlSurface(id).frame,
                    updateWlSurfaceSize: (id, w, h) => this.wlSurface.updateWlSurfaceSize(id, w, h),
                    setWlSurfaceOffset: (id, x, y) => this.wlSurface.setWlSurfaceOffset(id, x, y),
                    renderWlSurface: (id, canvas) => this.wlSurface.renderWlSurface(id, canvas),
                    destroyWlSurface: (id) => this.wlSurface.destroyWlSurface(id),
                    idScope: (id) => this.wlSurface.idScope(id),
                },
                subsurface: {
                    setWlSubSurface: (sub, parent, child) =>
                        this.dataManager.wlSubSurface.setWlSubSurface(sub, parent, child),
                    setPosition: (id, x, y) => this.dataManager.wlSubSurface.setPosition(id, x, y),
                    destroySubSurface: (id) => this.dataManager.wlSubSurface.destroySubSurface(id),
                    getChildrenDeep: (parent) => this.dataManager.wlSubSurface.getChildrenDeep(parent),
                },
                registry: {
                    globals: () =>
                        (function* () {
                            for (const [name, protocol] of waylandProtocolsNameMap) yield { name, protocol };
                        })(),
                    byName: (name) => waylandProtocolsNameMap.get(name),
                    globalOf: (iface) => globalsByInterface.get(iface),
                },
                buffer: { get: (id) => this.getObjectOption(id)?.data },
                seat: { focus: () => this.seat.focus(), nextSerial: () => this.seat.nextSerial() },
            },
            domain: { xdgSurface: this.dataManager.xdgSurface },
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
            },
            state: { windows: this.windows, cursor: this.cursor, seat: this.seat },
            client: {
                id: this.id,
                displayId: this.displayId,
                protoVersions: this.protoVersions,
                state: this.obj2,
                emit: this.emit.bind(this),
                emitSync: this.emitSync.bind(this),
            },
            scene: this.render,
        };
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
        type ExtractInterface<T extends string> = T extends `${infer I}.${string}` ? I : never;
        function isOp<T extends keyof WaylandRequestObj>(
            op: T,
            f: (x: ParsedMessage & { args: WaylandRequestObj[T]; id: WaylandObjectId2<ExtractInterface<T>> }) => void,
        ) {
            // @ts-expect-error
            m.set(op, f);
        }

        // 客户端想要从 compositor 接收数据（粘贴）

        // todo wp_cursor_shape_manager_v1.get_tablet_tool_v2 暂不实现，平板工具支持后再加

        isOp("zwp_text_input_manager_v1.create_text_input", (x) => {
            const textInputId = x.args.id;
            if (!this.obj2.textInputV1) this.obj2.textInputV1 = { focus: null, m: new Map() };
            this.obj2.textInputV1.m.set(textInputId, { focus: false, serial: 1 });
        });
        isOp("zwp_text_input_v1.activate", (x) => {
            this.sendMessageX(x.id, "zwp_text_input_v1.enter", { surface: x.args.surface });
            // v1/v3竞争仲裁：后激活者胜出
            this.obj2.textInputOwner = { protocol: "v1", id: x.id };
            if (!this.obj2.textInputV1) return;
            for (const [k, v] of this.obj2.textInputV1.m) {
                if (k !== x.id && v.focus) {
                    this.sendMessageX(k, "zwp_text_input_v1.leave", {});
                    v.focus = false;
                }
                if (k === x.id) {
                    v.focus = true;
                }
            }
        });
        isOp("zwp_text_input_v1.deactivate", (x) => {
            if (this.obj2.textInputV1?.m.get(x.id)?.focus !== true) {
                return;
            }
            this.sendMessageX(x.id, "zwp_text_input_v1.leave", {});
            if (!this.obj2.textInputV1) return;
            const t = this.obj2.textInputV1.m.get(x.id);
            if (t) t.focus = false;
            if (this.obj2.textInputOwner?.id === x.id) this.obj2.textInputOwner = null;
        });
        isOp("zwp_text_input_v1.commit_state", (x) => {
            const xx = this.obj2.textInputV1?.m.get(x.id);
            if (xx) {
                xx.serial = x.args.serial;
            }
        });

        isOp("zwp_text_input_manager_v3.get_text_input", (x) => {
            const textInputId = x.args.id;
            // todo seat参数，目前只有单seat
            const data: TextInputV3Data = {
                entered: false,
                commitCount: 0,
                current: newTextInputV3State(),
                pending: newTextInputV3State(),
            };
            this.obj2.textInputV3.m.set(textInputId, data);
            // 对象创建晚于焦点变化时补发enter
            const focus = this.obj2.textInputV3.focus;
            if (focus !== null) {
                data.entered = true;
                this.sendMessageImm(textInputId, "zwp_text_input_v3.enter", { surface: focus });
            }
        });
        isOp("zwp_text_input_v3.destroy", (x) => {
            this.obj2.textInputV3.m.delete(x.id);
            if (this.obj2.textInputOwner?.id === x.id) this.obj2.textInputOwner = null;
        });
        isOp("zwp_text_input_v3.enable", (x) => {
            const t = this.obj2.textInputV3.m.get(x.id);
            if (!t) return;
            // enable会重置所有状态，客户端需重新提交
            t.pending = newTextInputV3State();
            t.pending.enabled = true;
            // v1/v3竞争仲裁：后激活者胜出
            this.obj2.textInputOwner = { protocol: "v3", id: x.id };
        });
        isOp("zwp_text_input_v3.disable", (x) => {
            const t = this.obj2.textInputV3.m.get(x.id);
            if (!t) return;
            // disable同样使状态失效
            t.pending = newTextInputV3State();
            if (this.obj2.textInputOwner?.id === x.id) this.obj2.textInputOwner = null;
        });
        isOp("zwp_text_input_v3.set_surrounding_text", (x) => {
            const t = this.obj2.textInputV3.m.get(x.id);
            if (!t) return;
            t.pending.surroundingText = { text: x.args.text, cursor: x.args.cursor, anchor: x.args.anchor };
        });
        isOp("zwp_text_input_v3.set_text_change_cause", (x) => {
            const t = this.obj2.textInputV3.m.get(x.id);
            if (!t) return;
            const cause = getEnumName("zwp_text_input_v3.change_cause", x.args.cause);
            t.pending.textChangeCause = cause === "other" ? "other" : "input_method";
        });
        isOp("zwp_text_input_v3.set_content_type", (x) => {
            const t = this.obj2.textInputV3.m.get(x.id);
            if (!t) return;
            t.pending.contentHint = x.args.hint;
            t.pending.contentPurpose = x.args.purpose;
        });
        isOp("zwp_text_input_v3.set_cursor_rectangle", (x) => {
            const t = this.obj2.textInputV3.m.get(x.id);
            if (!t) return;
            t.pending.cursorRect = { x: x.args.x, y: x.args.y, width: x.args.width, height: x.args.height };
        });
        isOp("zwp_text_input_v3.commit", (x) => {
            const t = this.obj2.textInputV3.m.get(x.id);
            if (!t) return;
            t.current = { ...t.pending };
            // change_cause只作用于本次commit，应用后重置
            t.pending.textChangeCause = "input_method";
            t.commitCount++;
            this.sendMessageImm(x.id, "zwp_text_input_v3.done", { serial: t.commitCount });
        });

        // 协议模块的请求并入同一张分发表（Phase 3 起迁出的协议都走这里）。
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

    public offerTo() {
        const dd = this.obj2.dataDevices || new Set();
        if (!this.obj2.dataDevices) {
            console.error("No data devices to offer to");
        }
        for (const ddId of dd) {
            const dataOfferId = this.allocateObjectId() as WaylandObjectId3<"wl_data_offer">;
            this.objects.set(dataOfferId, { protocol: WaylandProtocols.wl_data_offer, data: {} });

            this.sendMessageImm(ddId, "wl_data_device.data_offer", { id: dataOfferId });
            this.sendMessageImm(dataOfferId, "wl_data_offer.offer", { mime_type: "text/plain;charset=utf-8" });
            this.sendMessageImm(dataOfferId, "wl_data_offer.offer", { mime_type: "text/plain" });
            this.sendMessageImm(ddId, "wl_data_device.selection", { id: dataOfferId });
        }
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
        return this.obj2.appid;
    }
    getWindows() {
        return this.windows.wins;
    }
    private configureWin(winid: WaylandWinId, win: WindowRecord) {
        const s: number[] = [];
        if (win.actived) s.push(getEnumValue("xdg_toplevel.state", "activated"));
        this.sendMessageImm(winid, "xdg_toplevel.configure", {
            width: win.box.width,
            height: win.box.height,
            states: new Uint32Array(s),
        });
        const xdgSurfaceId = this.dataManager.xdgSurface.getXdgSurfaceByToplevel(winid);
        if (xdgSurfaceId === undefined) return;
        this.sendMessageImm(xdgSurfaceId, "xdg_surface.configure", { serial: 1 });
    }
    private getPointers() {
        return Array.from(this.seat.all())
            .map((s) => s.pointer)
            .filter((p) => p !== undefined);
    }
    private getKeyboards() {
        return Array.from(this.seat.all())
            .map((s) => s.keyboard)
            .filter((k) => k !== undefined);
    }
    win(id: WaylandWinId) {
        const win = this.windows.get(id);
        if (win === undefined) return undefined;
        const xdgSurfaceId = this.dataManager.xdgSurface.getXdgSurfaceByToplevel(id);
        if (xdgSurfaceId === undefined) return undefined;
        const winObj = {
            setWinBoxData: (box: { width: number; height: number }) => {
                win.box = box;
            },
            focus: () => {
                if (win.actived) return false;
                win.actived = true;
                this.configureWin(id, win);
                return true;
            },
            blur: () => {
                if (!win.actived) return;
                win.actived = false;
                this.configureWin(id, win);
            },
            setSize: (w: number, h: number) => {
                win.box.width = w;
                win.box.height = h;
                this.configureWin(id, win);
            },
            maximize: (width: number, height: number) => {
                win.actived = true;
                win.box.width = width;
                win.box.height = height;

                this.sendMessageImm(id, "xdg_toplevel.configure", {
                    width,
                    height,
                    states: new Uint32Array([
                        getEnumValue("xdg_toplevel.state", "activated"),
                        getEnumValue("xdg_toplevel.state", "maximized"),
                    ]),
                });
                this.sendMessageImm(xdgSurfaceId, "xdg_surface.configure", { serial: 1 });
            },
            unmaximize: (width: number, height: number) => {
                win.box.width = width;
                win.box.height = height;
                this.configureWin(id, win);
            },
            minimize: () => {
                win.actived = false;
                this.configureWin(id, win);
            },
            close: () => {
                this.sendMessageImm(id, "xdg_toplevel.close", {});
            },
            point: {
                renderId: () => this.wlSurface.idScope(xdgSurfaceId),
                inWin: (p: { x: number; y: number }) => {
                    const rel = this.dataManager.xdgSurface.getReRect(xdgSurfaceId);
                    // todo popup
                    if (p.x < 0 || p.x >= rel.w || p.y < 0 || p.y >= rel.h) return false;
                    return true; // todo
                },
                updatePointerFocus: (p: { x: number; y: number }) => {
                    const { x, y } = p;
                    // 获取在哪个xdgsurface上，并区分surface还是popup
                    let inXdgSurface: WaylandObjectId2<"xdg_surface"> | undefined;
                    /** 相对于主xdgsurface坐标，适用于popup */
                    const xdgSurfaceOffset = { x: 0, y: 0 };
                    let reasonSurfaceType: "main" | "popup" | null = null;
                    const xdgM = this.dataManager.xdgSurface;
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
                        if (
                            0 < x &&
                            x < xdgM.getReRect(xdgSurfaceId).w &&
                            0 < y &&
                            y < xdgM.getReRect(xdgSurfaceId).h
                        ) {
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
                    const rel = xdgM.getMainSurfaceRect(inXdgSurface);
                    const { winGeo: selfOffset = { x: 0, y: 0 } } = xdgM.getXdgSurface(inXdgSurface);
                    surfaces.push({ id: mainSurfaceId, offsetRect: { x: 0, y: 0, w: rel.w, h: rel.h } });
                    surfaces.push(...this.dataManager.wlSubSurface.getChildrenDeep(mainSurfaceId));

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
                        const { id: s, x: nx, y: ny } = inSurface;
                        const prevFocus = this.seat.focus();
                        const prevFocusType = this.seat.focusType();
                        if (prevFocus !== s) {
                            if (prevFocus && this.objects.has(prevFocus)) {
                                for (const p of this.getPointers())
                                    this.sendMessageImm(p, "wl_pointer.leave", {
                                        serial: 0,
                                        surface: prevFocus,
                                    });
                                if (prevFocusType === "main" && reasonSurfaceType === "main")
                                    this.keyboard.blurSurface(prevFocus); // todo popup
                            }
                            for (const p of this.getPointers()) {
                                this.sendMessageImm(p, "wl_pointer.enter", {
                                    serial: 0,
                                    surface: s,
                                    surface_x: nx,
                                    surface_y: ny,
                                });
                                this.sendMessageImm(p, "wl_pointer.frame", {});
                            }
                            if ((prevFocusType === "main" || !prevFocusType) && reasonSurfaceType === "main")
                                this.keyboard.focusSurface(s);
                            this.seat.setFocus(s, reasonSurfaceType);
                        }
                        return { x: nx, y: ny };
                    }
                    // todo 指针不在任何surface上时应发送wl_pointer.leave并清除指针焦点
                    //  现在焦点悬挂：客户端收不到leave（hover状态卡住），重新进来也不发enter、客户端不重发光标
                    //  还需给桌面新增point.sendPointerLeave()入口（移出窗口时调用，幂等），覆盖移出所有窗口、跨客户端窗口
                    return undefined;
                },
                sendPointerEvent: (type: "move" | "down" | "up", p: { x: number; y: number; button: number }) => {
                    // px py已经相对主xdg surface了
                    const pos = winObj.point.updatePointerFocus({ x: p.x, y: p.y });
                    if (!pos) return;
                    const { x: nx, y: ny } = pos;
                    if (type === "move") {
                        for (const p of this.getPointers()) {
                            this.sendMessageImm(p, "wl_pointer.motion", {
                                time: Date.now(),
                                surface_x: nx,
                                surface_y: ny,
                            });
                            this.sendMessageImm(p, "wl_pointer.frame", {});
                        }
                    }
                    if (type === "down") {
                        for (const pointer of this.getPointers()) {
                            this.sendMessageImm(pointer, "wl_pointer.button", {
                                serial: 0,
                                time: Date.now(),
                                button:
                                    p.button === 0
                                        ? InputEventCodes.BTN_LEFT
                                        : p.button === 1
                                          ? InputEventCodes.BTN_MIDDLE
                                          : p.button === 2
                                            ? InputEventCodes.BTN_RIGHT
                                            : InputEventCodes.BTN_LEFT,
                                state: getEnumValue("wl_pointer.button_state", "pressed"),
                            });
                            this.sendMessageImm(pointer, "wl_pointer.frame", {});
                        }
                    }
                    if (type === "up") {
                        for (const pointer of this.getPointers()) {
                            this.sendMessageImm(pointer, "wl_pointer.button", {
                                serial: 0,
                                time: Date.now(),
                                button:
                                    p.button === 0
                                        ? InputEventCodes.BTN_LEFT
                                        : p.button === 1
                                          ? InputEventCodes.BTN_MIDDLE
                                          : p.button === 2
                                            ? InputEventCodes.BTN_RIGHT
                                            : InputEventCodes.BTN_LEFT,
                                state: getEnumValue("wl_pointer.button_state", "released"),
                            });
                            this.sendMessageImm(pointer, "wl_pointer.frame", {});
                        }
                    }
                },
                sendScrollEvent: (op: { p: { deltaX: number; deltaY: number; deltaZ: number } }) => {
                    const { p } = op;
                    // todo region
                    const { deltaX, deltaY } = p;
                    if (deltaX !== 0) {
                        for (const pointer of this.getPointers())
                            this.sendMessageImm(pointer, "wl_pointer.axis", {
                                time: Date.now(),
                                axis: getEnumValue("wl_pointer.axis", "horizontal_scroll"),
                                value: deltaX,
                            });
                    }
                    if (deltaY !== 0) {
                        for (const pointer of this.getPointers())
                            this.sendMessageImm(pointer, "wl_pointer.axis", {
                                time: Date.now(),
                                axis: getEnumValue("wl_pointer.axis", "vertical_scroll"),
                                value: deltaY,
                            });
                    }
                    for (const pointer of this.getPointers()) this.sendMessageImm(pointer, "wl_pointer.frame", {});
                },
            },
            getPreview: () => {
                const rootSurface = this.dataManager.xdgSurface.getXdgSurface(xdgSurfaceId).surface;
                const cs = this.getObject(rootSurface).data.canvas;
                return cs;
            },
            getTitle: () => {
                return win.title;
            },
        };
        return winObj;
    }
    async ping() {
        const ps: Promise<void>[] = [];
        for (const id of this.obj2.xdg_wm_base) {
            const p = Promise.withResolvers<void>();
            ps.push(p.promise);
            const serial = Math.floor(Math.random() * 1000000);
            this.sendMessageImm(id, "xdg_wm_base.ping", { serial: serial });
            this.getObject(id).data.pingSerials.set(serial, p.resolve);
        }
        await Promise.all(ps);
    }
    keyboard = {
        // todo Surface管理
        focusSurface: (id: WaylandObjectId2<"wl_surface">) => {
            for (const k of this.getKeyboards()) {
                this.sendMessageImm(k, "wl_keyboard.enter", { serial: 0, surface: id, keys: new Uint32Array([]) });
                this.sendMessageImm(k, "wl_keyboard.modifiers", {
                    serial: 0,
                    mods_depressed: 0,
                    mods_latched: 0,
                    mods_locked: 0,
                    group: 0,
                });
            }
            this.textInputV3Focus(id);
        },
        blurSurface: (id: WaylandObjectId2<"wl_surface">) => {
            for (const k of this.getKeyboards())
                this.sendMessageImm(k, "wl_keyboard.leave", { serial: 0, surface: id });
            this.textInputV3Blur(id);
        },
        sendKey: (key: number, state: "pressed" | "released") => {
            const s = this.seat.nextSerial();
            for (const k of this.getKeyboards())
                this.sendMessageImm(k, "wl_keyboard.key", {
                    serial: s,
                    time: Date.now(),
                    key: key,
                    state: getEnumValue("wl_keyboard.key_state", state), // todo repeat
                });

            const isPressed = state === "pressed";
            const modKeyToBit: { [k: number]: number } = {
                [InputEventCodes.KEY_LEFTSHIFT]: 0, // Shift -> bit 0
                [InputEventCodes.KEY_RIGHTSHIFT]: 0,
                [InputEventCodes.KEY_CAPSLOCK]: 1, // CapsLock -> bit 1
                [InputEventCodes.KEY_LEFTCTRL]: 2, // Ctrl -> bit 2
                [InputEventCodes.KEY_RIGHTCTRL]: 2,
                [InputEventCodes.KEY_LEFTALT]: 3, // Alt -> bit 3
                [InputEventCodes.KEY_RIGHTALT]: 3,
                [InputEventCodes.KEY_LEFTMETA]: 4, // Meta/Super -> bit 4
                [InputEventCodes.KEY_RIGHTMETA]: 4,
            };

            const bit = modKeyToBit[key];
            if (bit !== undefined) {
                if (isPressed) this.seat.addModifier(bit);
                else this.seat.removeModifier(bit);

                const mods_depressed = this.seat.modifierMask();
                const mods_latched = 0; // todo not tracking latched in this implementation
                const mods_locked = 0; // todo not tracking locked separately here

                for (const k of this.getKeyboards()) {
                    this.sendMessageImm(k, "wl_keyboard.modifiers", {
                        serial: s,
                        mods_depressed,
                        mods_latched,
                        mods_locked,
                        group: 0,
                    });
                }
            }
        },
        sendText: (text: string, preedit: boolean) => {
            // 输入法文本统一走该路径；v1/v3是竞争协议，仲裁后只发给持有对象（后激活者胜出）
            const owner = this.obj2.textInputOwner;
            if (owner?.protocol === "v3") {
                const t = this.obj2.textInputV3.m.get(owner.id);
                // 未enter或未enable的对象按协议忽略
                if (t?.entered && t.current.enabled) {
                    if (preedit) {
                        // 光标置于preedit末尾（cursor_*为字节偏移）
                        const cursor = new TextEncoder().encode(text).length;
                        this.sendMessageImm(owner.id, "zwp_text_input_v3.preedit_string", {
                            text,
                            cursor_begin: cursor,
                            cursor_end: cursor,
                        });
                    } else {
                        this.sendMessageImm(owner.id, "zwp_text_input_v3.commit_string", { text });
                        this.sendMessageImm(owner.id, "zwp_text_input_v3.preedit_string", {
                            text: "",
                            cursor_begin: 0,
                            cursor_end: 0,
                        });
                    }
                    // 双缓冲事件在done时生效，serial为客户端commit计数
                    this.sendMessageImm(owner.id, "zwp_text_input_v3.done", { serial: t.commitCount });
                }
                return;
            }
            const input1 = this.obj2.textInputV1;
            console.log(text, preedit, input1);
            if (input1 && owner?.protocol === "v1") {
                const id = Array.from(input1.m).find((i) => i[0] === owner.id && i[1].focus === true);
                if (!id) return;
                if (preedit) {
                    this.sendMessageImm(id[0], "zwp_text_input_v1.preedit_cursor", {
                        index: text.length,
                    });
                    this.sendMessageImm(id[0], "zwp_text_input_v1.preedit_string", {
                        text: text,
                        commit: text,
                        serial: id[1].serial,
                    });
                } else {
                    this.sendMessageImm(id[0], "zwp_text_input_v1.commit_string", {
                        serial: id[1].serial,
                        text: text,
                    });
                    this.sendMessageImm(id[0], "zwp_text_input_v1.preedit_string", {
                        text: "",
                        commit: "",
                        serial: id[1].serial,
                    });
                }
            }
        },
    };

    /** text-input-v3焦点跟随键盘焦点 */
    private textInputV3Focus(surface: WaylandObjectId2<"wl_surface">) {
        const ti = this.obj2.textInputV3;
        if (ti.focus === surface) return;
        if (ti.focus !== null) this.textInputV3Blur(ti.focus);
        ti.focus = surface;
        // 协议要求enter发给所有text_input对象
        for (const [id, t] of ti.m) {
            t.entered = true;
            this.sendMessageImm(id, "zwp_text_input_v3.enter", { surface });
        }
    }
    private textInputV3Blur(surface: WaylandObjectId2<"wl_surface">) {
        const ti = this.obj2.textInputV3;
        if (ti.focus !== surface) return;
        for (const [id, t] of ti.m) {
            if (!t.entered) continue;
            t.entered = false;
            this.sendMessageImm(id, "zwp_text_input_v3.leave", { surface });
            // leave后状态失效，客户端需重新enable并提交
            t.current = newTextInputV3State();
            t.pending = newTextInputV3State();
        }
        ti.focus = null;
    }

    paste: (text: string) => void = (text: string) => {
        if (!this.obj2.pendingPaste) {
            console.warn("No pending paste request");
            return;
        }
        const p = this.obj2.pendingPaste;
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
            this.obj2.pendingPaste = undefined;
        }
    };
    close() {
        for (const obj of this.objects.values()) {
            if (obj.protocol.name === "wl_shm_pool") {
                fs.closeSync(obj.data.fd);
            }
        }
        for (const _win of this.windows.wins.values()) {
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
