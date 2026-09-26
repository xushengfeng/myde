const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { sharedTexture } = require("electron") as typeof import("electron");

const usocket = require("myde-unix-socket") as typeof import("myde-unix-socket");

import type { UServer, USocket } from "myde-unix-socket";
import {
    type WaylandEventObj,
    WaylandEventOpcode,
    type WaylandInterfaces,
    type WaylandRequestObj,
} from "./protocols/wayland-types";
import {
    WaylandArgType,
    type WaylandName,
    type WaylandObjectId,
    type WaylandOp,
    type WaylandProtocol,
} from "./utils/wayland-binary";
import { WaylandDecoder } from "./utils/wayland-decoder";


import { buildXkb } from "myde-xcb";

import { InputEventCodes } from "../input_codes/types";
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
} from "./module";
import { assertModuleConflicts, protocolModules } from "./protocols/index";
import type { renderTools } from "./render_tools";
import { CursorStore } from "./state/cursor_store";
import { SeatStore } from "./state/seat_store";
import { type WindowRecord, WindowsStore } from "./state/windows_store";
import { createFormatTableBuffer, DRM_FORMAT } from "./utils/dma-buf";
import { WaylandEncoder } from "./utils/wayland-encoder";
import {
    getEnumName,
    getEnumValue,
    tryX,
    waylandObjectId,
    WaylandProtocols,
} from "./utils/wayland-proto";
import { getRectKeyPoint } from "./utils/xdg";

export { WaylandClient, WaylandServer };

type ParsedMessage = { id: WaylandObjectId; proto: WaylandProtocol; op: WaylandOp; args: Record<string, any> };

/** zwp_text_input_v3 的状态，双缓冲（pending -> commit -> current） */
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

/**
 * v1/v3是竞争协议，按协议（manager）一侧仲裁、后激活者胜出：
 * zwp_text_input_v1.activate / zwp_text_input_v3.enable 后到者抢占，文本只发给持有对象
 */
type WaylandObjectX<T extends WaylandInterfaces> = {
    protocol: WaylandProtocol;
    data: DataOf<T>;
};

interface WaylandServerEventMap {
    newClient: (client: WaylandClient, clientId: string) => void;
    clientClose: (client: WaylandClient, clientId: string) => void;
}

function waylandName(name: number): WaylandName {
    return name as WaylandName;
}

const waylandProtocolsNameMap = new Map<WaylandName, WaylandProtocol>();

class WaylandServer {
    private events: { [K in keyof WaylandServerEventMap]?: WaylandServerEventMap[K][] } = {};

    socketDir = "/tmp";
    socketName = "my-wayland-server-0";
    private socketPath: string;
    private server: UServer | null = null;
    private render: renderTools;
    clients: Map<string, WaylandClient>;
    constructor(op: {
        socketDir?: string;
        socketName?: string;
        render: renderTools;
    }) {
        this.socketDir = op.socketDir || this.socketDir;
        this.socketName = op.socketName || this.socketName;
        this.render = op.render;

        this.socketPath = path.join(this.socketDir, this.socketName);
        this.clients = new Map(); // 存储连接的客户端

        initWaylandProtocols();
        assertModuleConflicts();

        console.log("Support protocols:", Object.keys(WaylandProtocols));

        this.setupSocket();
    }
    public on<K extends keyof WaylandServerEventMap>(event: K, handler: WaylandServerEventMap[K]): void {
        if (!this.events[event]) this.events[event] = [];
        // biome-ignore lint/style/noNonNullAssertion: 上面已经保证
        this.events[event]!.push(handler);
    }

    protected emit<K extends keyof WaylandServerEventMap>(
        event: K,
        ...args: Parameters<WaylandServerEventMap[K]>
    ): void {
        const handlers = this.events[event];
        if (handlers) {
            for (const fn of handlers) {
                // @ts-expect-error
                fn(...args);
            }
        }
    }

    setupSocket() {
        // 清理可能存在的旧套接字文件
        if (fs.existsSync(this.socketPath)) {
            fs.unlinkSync(this.socketPath);
        }

        // 创建服务器
        this.server = new usocket.UServer();
        this.server.on("connection", (socket) => {
            this.handleNewConnection(socket);
        });

        this.server.listen(this.socketPath, () => {
            console.log(`Wayland server listening on ${this.socketPath}`);

            // 设置合适的权限
            fs.chmod(this.socketPath, 0o700, (err) => {
                if (err) console.error("Failed to set socket permissions:", err);
            });
        });

        this.server.on("error", (err) => {
            console.error("Server error:", err);
        });
    }

    private handleNewConnection(socket: USocket) {
        const clientId = crypto.randomUUID().slice(0, 8);
        console.log(`New client connected: ${clientId}`);

        const client = new WaylandClient({ id: clientId, socket, render: this.render });
        this.clients.set(clientId, client);

        this.emit("newClient", client, clientId);

        client.on("close", () => {
            this.clients.delete(clientId);
            this.emit("clientClose", client, clientId);
        });
    }

    isProtocolSupported(protocol: string): boolean {
        return protocol in WaylandProtocols;
    }
}

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

class WaylandClient {
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
                },
                buffer: { get: (id) => this.getObjectOption(id)?.data },
                seat: { focus: () => this.seat.focus(), nextSerial: () => this.seat.nextSerial() },
            },
            domain: { xdgSurface: this.dataManager.xdgSurface },
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

        isOp("wl_display.sync", (x) => {
            const callbackId = x.args.callback;
            this.sendMessageImm(this.displayId, "wl_display.delete_id", { id: callbackId });

            this.sendMessageX(callbackId, "wl_callback.done", { callback_data: 0 });
        });
        isOp("wl_display.get_registry", (x) => {
            const registryId = x.args.registry;
            for (const [i, proto] of waylandProtocolsNameMap) {
                this.sendMessageX(registryId, "wl_registry.global", {
                    name: i,
                    interface: proto.name,
                    version: proto.version,
                });
            }
        });
        isOp("wl_registry.bind", (x) => {
            const name = x.args.name as WaylandName;
            const _id = x.args.id;
            const proto = waylandProtocolsNameMap.get(name);
            if (!proto) {
                console.warn(`Unknown global name: ${name}`);
                return;
            }
            this.objects.set(_id, { protocol: proto, data: undefined });
            this.protoVersions.set(proto.name, x.args._version);
            console.log(`Client ${this.id} bound ${proto.name} to id ${_id}`);

            // todo 添加自定义

            if (proto.name === "wl_shm") {
                const id = _id as WaylandObjectId2<"wl_shm">;
                this.sendMessageX(id, "wl_shm.format", {
                    format: getEnumValue("wl_shm.format", "argb8888"),
                });
                this.sendMessageX(id, "wl_shm.format", {
                    format: getEnumValue("wl_shm.format", "xrgb8888"),
                });
            }
            if (proto.name === "wl_seat") {
                const id = _id as WaylandObjectId2<"wl_seat">;
                this.seat.addSeat(id);
                this.sendMessageX(id, "wl_seat.name", { name: "seat0" });
                this.sendMessageX(id, "wl_seat.capabilities", {
                    capabilities: getEnumValue("wl_seat.capability", ["pointer", "keyboard"]),
                });
            }
            if (proto.name === "wl_output") {
                const id = _id as WaylandObjectId2<"wl_output">;
                this.sendMessageX(id, "wl_output.name", { name: "output0" });
                this.sendMessageX(id, "wl_output.description", { description: "Output 0" });
                this.sendMessageX(id, "wl_output.mode", {
                    width: 1920,
                    height: 1080,
                    refresh: 60000,
                    flags: getEnumValue("wl_output.mode", "current"),
                });
                this.sendMessageX(id, "wl_output.geometry", {
                    x: 0,
                    y: 0,
                    physical_width: 344,
                    physical_height: 194,
                    make: "",
                    model: "",
                    subpixel: getEnumValue("wl_output.subpixel", "unknown"),
                    transform: getEnumValue("wl_output.transform", "normal"),
                });
                this.sendMessageX(id, "wl_output.done", {});
            }
            if (proto.name === "xdg_wm_base") {
                const id = _id as WaylandObjectId2<"xdg_wm_base">;
                this.obj2.xdg_wm_base.add(id);
                this.getObject(id).data = { pingSerials: new Map() };
            }
        });
        isOp("wl_shm.create_pool", (x) => {
            const fd = x.args.fd;
            this.getObject(x.args.id).data = { fd };
        });
        isOp("wl_compositor.create_surface", (x) => {
            const surfaceId = x.args.id;
            const surface = this.getObject(surfaceId);
            surface.data = { canvas: new OffscreenCanvas(1, 1), current: {}, pending: {} };
            this.wlSurface.addWlSurface(surfaceId);
        });
        isOp("wl_shm_pool.create_buffer", (x) => {
            const thisObj = this.getObject(x.id);
            const buffer = this.getObject(x.args.id);
            const imageData = new ImageData(x.args.width, x.args.height);
            buffer.data = {
                type: "shm",
                fd: thisObj.data.fd,
                offset: x.args.offset,
                stride: x.args.stride,
                imageData: imageData,
            };
        });
        isOp("wl_surface.attach", (x) => {
            const surface = this.getObject(x.id);
            const bufferId = waylandObjectId(x.args.buffer, "wl_buffer");
            // todo attach(null)应该unmap，commit后视为无内容（如隐藏光标surface）
            if (!bufferId) return;
            surface.data.pending.buffer = { id: bufferId };
        });
        isOp("wl_surface.damage", (x) => {
            const surface = this.getObject(x.id);
            const damageList = surface.data.pending.damageList || [];
            damageList.push({
                x: x.args.x,
                y: x.args.y,
                width: x.args.width,
                height: x.args.height,
            });
            surface.data.pending.damageList = damageList;
        });
        isOp("wl_surface.damage_buffer", (x) => {
            const surface = this.getObject(x.id);
            const damageBufferList = surface.data.pending.damageBufferList || [];
            damageBufferList.push({
                x: x.args.x,
                y: x.args.y,
                width: x.args.width,
                height: x.args.height,
            });
            surface.data.pending.damageBufferList = damageBufferList;
        });
        isOp("wl_surface.frame", (x) => {
            const callbackId = x.args.callback;
            const surface = this.getObject(x.id);
            surface.data.pending.callback = callbackId;
        });
        isOp("wl_surface.commit", async (x) => {
            const surfaceId = x.id;
            const surface = this.getObject(surfaceId);
            const data = surface.data.pending;
            surface.data.current = Object.assign({}, surface.data.current, data);
            surface.data.pending = {};
            const canvas = surface.data.canvas;
            // biome-ignore lint/style/noNonNullAssertion: 忽略小概率
            const ctx = canvas.getContext("2d")!;
            const buffer = data.buffer;
            const bufferId = buffer?.id;
            const bufferObj = this.getObjectOption(bufferId)?.data;
            if (!bufferObj) {
            } else {
                let image: ImageData | VideoFrame;
                if (bufferObj.type === "shm") {
                    image = bufferObj.imageData;

                    const buffern = new Uint8ClampedArray(bufferObj.stride * image.height);
                    try {
                        fs.readSync(bufferObj.fd, buffern, 0, buffern.length, bufferObj.offset);
                    } catch (error) {
                        console.error("Error reading shm buffer:", error);
                    }
                    // todo 模块读取
                    const rgba = new Uint8ClampedArray(image.width * image.height * 4);
                    for (let y = 0; y < image.height; y++) {
                        for (let x = 0; x < image.width; x++) {
                            const ri = y * bufferObj.stride + x * 4;
                            const i = (y * image.width + x) * 4;
                            rgba[i] = buffern[ri + 2];
                            rgba[i + 1] = buffern[ri + 1];
                            rgba[i + 2] = buffern[ri];
                            rgba[i + 3] = buffern[ri + 3];
                        }
                    }

                    image.data.set(rgba);
                } else {
                    const modifierX = bufferObj.planes[0];
                    const modifier = (modifierX.modifier_hi << 32) | modifierX.modifier_lo;

                    const format =
                        bufferObj.format === DRM_FORMAT.DRM_FORMAT_ARGB8888
                            ? "bgra"
                            : bufferObj.format === DRM_FORMAT.DRM_FORMAT_ABGR8888
                              ? "rgba"
                              : bufferObj.format === DRM_FORMAT.DRM_FORMAT_NV12
                                ? "nv12"
                                : bufferObj.format === DRM_FORMAT.DRM_FORMAT_NV16
                                  ? "nv16"
                                  : bufferObj.format === DRM_FORMAT.DRM_FORMAT_P010
                                    ? "p010le"
                                    : "bgra";

                    const t = await importSharedTexture({
                        textureInfo: {
                            handle: {
                                nativePixmap: {
                                    planes: bufferObj.planes.map((p) => ({
                                        stride: p.stride,
                                        offset: p.offset,
                                        size: p.stride * bufferObj.height,
                                        fd: p.fd,
                                    })),
                                    modifier: modifier.toString(),
                                    supportsZeroCopyWebGpuImport: true,
                                },
                            },
                            codedSize: { height: bufferObj.height, width: bufferObj.width },
                            pixelFormat: format,
                        },
                    });

                    image = t.getVideoFrame();
                    t.release();
                }
                let width = 0,
                    height = 0;
                if (image instanceof VideoFrame) {
                    width = image.codedWidth;
                    height = image.codedHeight;
                } else {
                    width = image.width;
                    height = image.height;
                }
                if (width !== canvas.width || height !== canvas.height) {
                    canvas.width = width;
                    canvas.height = height;
                    this.wlSurface.updateWlSurfaceSize(surfaceId, width, height);
                    // for (const [id, p] of this.objects) {
                    //     if (p.protocol.name === "xdg_toplevel") {
                    // this.sendMessage(id, 0, {
                    //     width: canvas.width,
                    //     height: canvas.height,
                    //     states: new Uint8Array([
                    //         WaylandProtocols.xdg_toplevel.enum![2].enum.resizing,
                    //         WaylandProtocols.xdg_toplevel.enum![2].enum.activated,
                    //     ]),
                    // });
                    // todo 考虑实际窗口的几何，否则有外边框的会变大
                    //     }
                    // }
                    for (const [id, p] of this.objects) {
                        if (p.protocol.name === "xdg_surface") {
                            this.sendMessageX(id as WaylandObjectId2<"xdg_surface">, "xdg_surface.configure", {
                                serial: 1,
                            });
                        }
                    }
                }

                const damageList = [...(data.damageList || []), ...(data.damageBufferList || [])];
                // todo 有区别，但现在先不处理
                if (damageList.length) {
                    for (const damage of damageList) {
                        const dw = Math.min(canvas.width, damage.width);
                        const dh = Math.min(canvas.height, damage.height);
                        if (image instanceof VideoFrame) {
                            ctx.clearRect(damage.x, damage.y, dw, dh);
                            ctx.drawImage(image, damage.x, damage.y, dw, dh, damage.x, damage.y, dw, dh);
                        } else ctx.putImageData(image, 0, 0, damage.x, damage.y, dw, dh);
                    }
                } else {
                    if (image instanceof VideoFrame) {
                        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                    } else ctx.putImageData(image, 0, 0);
                }
                if (image instanceof VideoFrame) {
                    image.close();
                }
                let fcanvas = canvas;
                if (data.viewport && (data.viewport.destination || data.viewport.source)) {
                    const source = data.viewport.source;
                    const destination = data.viewport.destination;
                    let dwidth = 1;
                    let dheight = 1;
                    if (!destination && source) {
                        dwidth = source.width;
                        dheight = source.height;
                    } else if (destination) {
                        dwidth = destination.width;
                        dheight = destination.height;
                    }
                    const ncanvas = new OffscreenCanvas(dwidth, dheight);
                    const sctx = ncanvas.getContext("2d");
                    if (source) {
                        sctx?.drawImage(canvas, source.x, source.y, source.width, source.height, 0, 0, dwidth, dheight);
                    } else {
                        sctx?.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, dwidth, dheight);
                    }
                    fcanvas = ncanvas;
                }
                this.wlSurface.renderWlSurface(surfaceId, fcanvas);

                // 只有当前光标surface才推送光标，隐藏后commit不应重新显示
                this.cursor.updateFrame(surfaceId, fcanvas);
            }

            requestAnimationFrame(() => {
                const bufferId = data.buffer?.id;
                if (bufferId) {
                    this.sendMessageImm(bufferId, "wl_buffer.release", {});
                }
                const x = data.callback;
                if (x) {
                    this.sendMessageImm(x, "wl_callback.done", { callback_data: Date.now() });
                    this.sendMessageImm(this.displayId, "wl_display.delete_id", {
                        id: x,
                    });
                }
            });
        });
        isOp("wl_surface.destroy", (x) => {
            const surfaceId = x.id;
            // 光标surface销毁后隐藏光标
            this.cursor.hide(surfaceId);
            this.wlSurface.destroyWlSurface(surfaceId);
            // todo 相关的如subsurface、xdgsurface等
        });
        isOp("wl_surface.set_input_region", (x) => {
            const surface = this.getObject(x.id);
            console.error("re", x.args);
            const region = this.getObjectOption(waylandObjectId(x.args.region, "wl_region"));
            surface.data.pending.inputRegion = region?.data.rects;
        });
        isOp("wl_surface.offset", (x) => {
            this.wlSurface.setWlSurfaceOffset(x.id, x.args.x, x.args.y);
        });
        isOp("wl_subcompositor.get_subsurface", (x) => {
            const r = this.dataManager.wlSubSurface.setWlSubSurface(
                x.args.id,
                waylandObjectId(x.args.parent, "wl_surface"),
                waylandObjectId(x.args.surface, "wl_surface"),
            );

            if (r === "bad_surface")
                this.postError("wl_subcompositor", x.id, "bad_surface", "Surface already has a role");
            else if (r === "bad_parent")
                this.postError("wl_subcompositor", x.id, "bad_parent", "Parent cannot be itself");
            if (r !== true) return;
        });
        isOp("wl_subsurface.set_position", (x) => {
            this.dataManager.wlSubSurface.setPosition(x.id, x.args.x, x.args.y);
        });
        isOp("wl_subsurface.destroy", (x) => {
            this.dataManager.wlSubSurface.destroySubSurface(x.id);
        });

        isOp("wl_seat.get_pointer", (x) => {
            const pointerId = x.args.id;
            const seat = this.seat.get(x.id);
            if (!seat) {
                console.warn(`Seat ${x.id} not found for get_pointer`);
                return;
            }
            seat.pointer = pointerId;
        });
        isOp("wl_seat.get_keyboard", (x) => {
            const keyboardId = x.args.id;
            const seat = this.seat.get(x.id);
            if (!seat) {
                console.warn(`Seat ${x.id} not found for get_keyboard`);
                return;
            }
            seat.keyboard = keyboardId;
            this.sendMessageX(keyboardId, "wl_keyboard.repeat_info", {
                rate: 25,
                delay: 600,
            });

            const keymapStr = buildXkb();
            const { fd, size } = newFd(keymapStr);

            this.sendMessageX(keyboardId, "wl_keyboard.keymap", {
                format: getEnumValue("wl_keyboard.keymap_format", "xkb_v1"),
                fd: fd,
                size: size,
            });
        });
        isOp("wl_pointer.set_cursor", (x) => {
            // todo serial
            // todo wlsurface.offset
            const surfaceId = x.args.surface;
            if (!surfaceId) {
                // surface为null时隐藏光标
                this.cursor.hide();
                return;
            }
            // 校验 surface 存在（无效 id 走 postError）
            this.getObject(surfaceId);
            const [roleError] = tryX(() => {
                this.wlSurface.setWlSurfaceRole(surfaceId, "cursor");
            });
            if (roleError instanceof WaylandSurfaceRoleError) {
                this.postError("wl_pointer", x.id, "role", "Surface already has another role");
                return;
            }
            this.cursor.setSurface(
                surfaceId,
                { x: x.args.hotspot_x, y: x.args.hotspot_y },
                this.wlSurface.getWlSurface(surfaceId).frame,
            );
        });
        isOp("wl_data_device_manager.create_data_source", (x) => {
            const src = this.getObject(x.args.id);
            src.data = { offers: [] };
        });
        isOp("wl_data_device_manager.get_data_device", (x) => {
            const ddId = x.args.id;
            const dataDevices = this.obj2.dataDevices || new Set();
            dataDevices.add(ddId);
            this.obj2.dataDevices = dataDevices;
        });
        isOp("wl_data_source.offer", (x) => {
            const src = this.getObject(x.id);
            if (!src) return;
            src.data.offers.push(x.args.mime_type);
            console.log(`wl_data_source#${x.id} offer ${x.args.mime_type}`);
        });

        // 客户端想要从 compositor 接收数据（粘贴）
        isOp("wl_data_offer.receive", (x) => {
            const offerId = x.id;
            const mime = x.args.mime_type;
            const fd = x.args.fd;

            // fallback: compositor-local paste flow – keep pendingPaste and emit paste for external handler
            if (this.obj2.pendingPaste) {
                console.warn("Existing pending paste request - rejecting previous");
                try {
                    fs.closeSync(this.obj2.pendingPaste.fd);
                } catch {
                    // ignore
                }
                clearTimeout(this.obj2.pendingPaste.timeout);
                this.obj2.pendingPaste = undefined;
            }

            const timeout = setTimeout(() => {
                if (!this.obj2.pendingPaste) return;
                console.warn("paste request timed out");
                try {
                    fs.closeSync(this.obj2.pendingPaste.fd);
                } catch {
                    // ignore
                }
                this.obj2.pendingPaste = undefined;
            }, 10000);

            this.obj2.pendingPaste = { offerId, fd, mime, timeout };
            this.emit("paste");
        });
        isOp("wl_data_device.set_selection", (x) => {
            const srcId = waylandObjectId(x.args.source, "wl_data_source");
            if (!srcId) {
                console.log("Selection cleared");
                return;
            }

            const src = this.getObject(srcId);
            if (!src) {
                console.warn(`Selection source ${srcId} not found`);
                return;
            }

            const offers = src.data.offers;
            // 优先尝试 text/plain;charset=utf-8，然后 text/plain
            let mime = offers.find((m: string) => /text\/plain.*utf-?8/i.test(m));
            if (!mime) mime = offers.find((m: string) => /^text\/plain($|;)/i.test(m));
            if (!mime) {
                // 回退到第一个 offer
                mime = offers[0];
            }

            if (!mime) {
                console.log(`No offered mime types from source ${srcId}`);
                return;
            }

            // 创建一个临时 fd 传给客户端，让客户端往里面写入数据
            const { fd } = newFd("");

            try {
                // 发送请求，要求客户端把 mime 类型的数据写入我们提供的 fd
                this.sendMessageImm(srcId, "wl_data_source.send", { mime_type: mime, fd: fd });

                // TODO: 使用基于 EOF 的读取更优雅，但客户端行为差异导致未能稳定工作，
                // 先回退到简单的延时读取（不优雅），以后再改进为可靠的 EOF/poll 检测。
                setTimeout(() => {
                    try {
                        const st = fs.fstatSync(fd);
                        const len = Number(st.size) || 0;
                        if (len === 0) {
                            // 若 size 为 0，尝试读取最多 64KB 的数据
                            const tryBuf = new Uint8Array(65536);
                            let read = 0;
                            try {
                                read = fs.readSync(fd, tryBuf, 0, tryBuf.length, 0);
                            } catch {
                                // ignore
                            }
                            const content = Buffer.from(tryBuf.buffer, tryBuf.byteOffset, read).toString("utf8");
                            console.log(`Clipboard (from ${srcId}) [len=${read}]:`, content);
                        } else {
                            const arr = new Uint8Array(len);
                            fs.readSync(fd, arr, 0, len, 0);
                            const content = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("utf8");
                            console.log(`Clipboard (from ${srcId}) [len=${len}]:`, content);
                            this.emit("copy", content);
                        }
                    } catch (err) {
                        console.error("Error reading selection fd:", err);
                    } finally {
                        try {
                            fs.closeSync(fd);
                        } catch {
                            // ignore
                        }
                    }
                }, 200);
            } catch (err) {
                console.error("Error sending wl_data_source.send:", err);
                try {
                    fs.closeSync(fd);
                } catch {
                    // ignore
                }
            }
        });

        isOp("xdg_wm_base.get_xdg_surface", (x) => {
            const surfaceId = waylandObjectId(x.args.surface, "wl_surface");
            this.dataManager.xdgSurface.addXdgSurface(x.args.id, surfaceId);
        });
        isOp("xdg_wm_base.create_positioner", (x) => {
            const thisObj = this.getObject(x.args.id);
            thisObj.data = {
                size: { width: 0, height: 0 },
                anchor_rect: { x: 0, y: 0, width: 0, height: 0 },
                anchor: getEnumValue("xdg_positioner.anchor", "none"),
                gravity: getEnumValue("xdg_positioner.gravity", "none"),
                constraint_adjustment: getEnumValue("xdg_positioner.constraint_adjustment", "none"),
                offset: { x: 0, y: 0 },
                parent_size: { parent_width: 0, parent_height: 0 },
                reactive: false,
            };
        });
        isOp("xdg_wm_base.pong", (x) => {
            const thisObj = this.getObject(x.id);
            const p = thisObj.data.pingSerials.get(x.args.serial);
            p?.();
            thisObj.data.pingSerials.delete(x.args.serial);
        });
        isOp("xdg_wm_base.destroy", (x) => {
            this.obj2.xdg_wm_base.delete(x.id);
        });

        isOp("xdg_positioner.set_size", (x) => {
            const pData = this.getObject(x.id).data;
            pData.size = x.args;
        });
        isOp("xdg_positioner.set_anchor_rect", (x) => {
            const pData = this.getObject(x.id).data;
            pData.anchor_rect = x.args;
        });
        isOp("xdg_positioner.set_anchor", (x) => {
            const pData = this.getObject(x.id).data;
            pData.anchor = x.args.anchor;
        });
        isOp("xdg_positioner.set_gravity", (x) => {
            const pData = this.getObject(x.id).data;
            pData.gravity = x.args.gravity;
        });
        isOp("xdg_positioner.set_constraint_adjustment", (x) => {
            const pData = this.getObject(x.id).data;
            pData.constraint_adjustment = x.args.constraint_adjustment;
        });
        isOp("xdg_positioner.set_offset", (x) => {
            const pData = this.getObject(x.id).data;
            pData.offset = x.args;
        });
        isOp("xdg_positioner.set_parent_size", (x) => {
            const pData = this.getObject(x.id).data;
            pData.parent_size = x.args;
        });
        isOp("xdg_positioner.set_reactive", (x) => {
            const pData = this.getObject(x.id).data;
            pData.reactive = true;
        });
        isOp("xdg_surface.get_toplevel", (x) => {
            const xid = x.id;
            const toplevelId = x.args.id;
            this.sendMessageImm(toplevelId, "xdg_toplevel.wm_capabilities", {
                capabilities: new Uint32Array([
                    getEnumValue("xdg_toplevel.wm_capabilities", "minimize"),
                    getEnumValue("xdg_toplevel.wm_capabilities", "maximize"),
                ]),
            });
            const outerBounds = this.emitSync("windowBound") || { width: 800, height: 600 };
            this.sendMessageX(toplevelId, "xdg_toplevel.configure_bounds", {
                width: outerBounds.width,
                height: outerBounds.height,
            });
            this.sendMessageX(x.id, "xdg_surface.configure", { serial: 1 });
            this.dataManager.xdgSurface.setAsToplevel(xid, toplevelId);
            this.windows.created(toplevelId, this.wlSurface.idScope(xid));
        });
        isOp("xdg_surface.set_window_geometry", (x) => {
            const thisXdgSurface = this.dataManager.xdgSurface.getXdgSurface(x.id);
            this.dataManager.xdgSurface.setXdgSurfaceSize(x.id, x.args.x, x.args.y, x.args.width, x.args.height);
            if (thisXdgSurface.xdg_role) {
                this.windows.resized(
                    thisXdgSurface.xdg_role as WaylandObjectId2<"xdg_toplevel">, // todo check
                    x.args.width,
                    x.args.height,
                );
            }
        });
        isOp("xdg_surface.get_popup", (x) => {
            const xid = x.id;
            const popupId = x.args.id;
            const parentXdgSurfaceId = waylandObjectId(x.args.parent, "xdg_surface");
            if (!parentXdgSurfaceId) {
                console.error("No parent for popup");
                return;
            }

            const positioner = this.getObject(waylandObjectId(x.args.positioner, "xdg_positioner"));
            const positionerData = positioner.data;

            const anchor = positionerData.anchor;
            const anchorPoint = getRectKeyPoint(
                positionerData.anchor_rect,
                (
                    {
                        [getEnumValue("xdg_positioner.anchor", "none")]: "none",
                        [getEnumValue("xdg_positioner.anchor", "top")]: "top",
                        [getEnumValue("xdg_positioner.anchor", "bottom")]: "bottom",
                        [getEnumValue("xdg_positioner.anchor", "left")]: "left",
                        [getEnumValue("xdg_positioner.anchor", "right")]: "right",
                        [getEnumValue("xdg_positioner.anchor", "top_left")]: "top_left",
                        [getEnumValue("xdg_positioner.anchor", "top_right")]: "top_right",
                        [getEnumValue("xdg_positioner.anchor", "bottom_left")]: "bottom_left",
                        [getEnumValue("xdg_positioner.anchor", "bottom_right")]: "bottom_right",
                    } as const
                )[anchor],
            );
            const popupPoint = getRectKeyPoint(
                { x: 0, y: 0, width: positionerData.size.width, height: positionerData.size.height },
                (
                    {
                        [getEnumValue("xdg_positioner.gravity", "none")]: "none",
                        [getEnumValue("xdg_positioner.gravity", "top")]: "bottom",
                        [getEnumValue("xdg_positioner.gravity", "bottom")]: "top",
                        [getEnumValue("xdg_positioner.gravity", "left")]: "right",
                        [getEnumValue("xdg_positioner.gravity", "right")]: "left",
                        [getEnumValue("xdg_positioner.gravity", "top_left")]: "bottom_right",
                        [getEnumValue("xdg_positioner.gravity", "top_right")]: "bottom_left",
                        [getEnumValue("xdg_positioner.gravity", "bottom_left")]: "top_right",
                        [getEnumValue("xdg_positioner.gravity", "bottom_right")]: "top_left",
                    } as const
                )[positionerData.gravity],
            );

            // todo offset
            // todo constraint_adjustment
            const nx = anchorPoint.x - popupPoint.x;
            const ny = anchorPoint.y - popupPoint.y;

            const xdgSurfaceM = this.dataManager.xdgSurface;
            xdgSurfaceM.setAsPopup(xid, popupId, parentXdgSurfaceId);
            xdgSurfaceM.setOffset(xid, nx, ny);

            // todo 给定外部处理的接口

            this.sendMessageX(x.args.id, "xdg_popup.configure", {
                x: Math.floor(nx),
                y: Math.floor(ny),
                width: positionerData.size.width,
                height: positionerData.size.height,
            });
            this.sendMessageX(x.id, "xdg_surface.configure", { serial: 0 });
        });
        isOp("xdg_popup.destroy", (x) => {
            const xid = x.id;
            const xdgSurfaceId = this.dataManager.xdgSurface.getXdgSurfaceByPopup(xid);
            if (xdgSurfaceId === undefined) return;
            this.dataManager.xdgSurface.popupDestroyed(xid);
            this.sendMessageX(x.id, "xdg_popup.popup_done", {});
        });
        isOp("xdg_toplevel.set_app_id", (x) => {
            if (!this.obj2.appid) {
                this.obj2.appid = x.args.app_id;
                this.emit("appid", x.args.app_id);
            }
        });
        isOp("xdg_toplevel.set_title", (x) => {
            this.windows.setTitle(x.id, x.args.title);
        });
        isOp("xdg_toplevel.move", (x) => {
            this.windows.startMove(x.id);
        });
        isOp("xdg_toplevel.set_maximized", (x) => {
            this.windows.setMaximized(x.id, true);
        });
        isOp("xdg_toplevel.unset_maximized", (x) => {
            this.windows.setMaximized(x.id, false);
        });

        isOp("xdg_toplevel.destroy", (x) => {
            const xdgSurfaceId = this.dataManager.xdgSurface.getXdgSurfaceByToplevel(x.id);
            if (xdgSurfaceId === undefined) return;
            // 顺序对桌面可见：记录删除 → onToplevelRemove → windowClosed
            this.windows.remove(x.id);
            this.dataManager.xdgSurface.toplevelDestroyed(x.id);
            this.windows.notifyClosed(x.id);
        });

        isOp("zwp_linux_dmabuf_v1.create_params", (x) => {
            const params = this.getObject(x.args.params_id);
            params.data = { planes: [] };
        });
        isOp("zwp_linux_dmabuf_v1.get_surface_feedback", (x) => {
            const feedbackId = x.args.id;
            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.done", {});
        });
        isOp("zwp_linux_dmabuf_v1.get_default_feedback", (x) => {
            const feedbackId = x.args.id;

            const formatTable = createFormatTableBuffer([
                { format: DRM_FORMAT.DRM_FORMAT_ARGB8888, modifier: 0n },
                { format: DRM_FORMAT.DRM_FORMAT_ABGR8888, modifier: 0n },
                { format: DRM_FORMAT.DRM_FORMAT_NV12, modifier: 0n },
                { format: DRM_FORMAT.DRM_FORMAT_NV16, modifier: 0n },
                { format: DRM_FORMAT.DRM_FORMAT_P010, modifier: 0n },
            ]);
            const { fd } = newFd(new Uint8Array(formatTable.buffer));
            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.format_table", {
                fd: fd,
                size: formatTable.byteLength,
            });

            const r = fs.statSync("/dev/dri/renderD128"); // todo
            const buffer = Buffer.alloc(8);
            buffer.writeBigUInt64LE(BigInt(r.rdev));
            const a = new Uint8Array(buffer.buffer);
            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.main_device", { device: a });

            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.tranche_target_device", {
                device: a,
            });
            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.tranche_formats", {
                indices: new Uint16Array([0, 1, 2, 3, 4]),
            });
            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.tranche_flags", {
                flags: getEnumValue("zwp_linux_dmabuf_feedback_v1.tranche_flags", []),
            });
            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.tranche_done", {});

            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.done", {});
        });
        isOp("zwp_linux_buffer_params_v1.add", (x) => {
            const params = this.getObject(x.id);
            params.data.planes[x.args.plane_idx] = {
                fd: x.args.fd,
                plane_idx: x.args.plane_idx,
                offset: x.args.offset,
                stride: x.args.stride,
                modifier_hi: x.args.modifier_hi,
                modifier_lo: x.args.modifier_lo,
            };
        });
        isOp("zwp_linux_buffer_params_v1.create_immed", (x) => {
            const params = this.getObject(x.id);
            if (!params.data) {
                console.error("No planes data for create_immed");
                return;
            }
            const planes = params.data.planes;
            const bufferId = x.args.buffer_id;
            const buffer = this.getObject(bufferId);
            buffer.data = { type: "dmabuf", planes, width: x.args.width, height: x.args.height, format: x.args.format };
        });

        isOp("wp_viewporter.get_viewport", (x) => {
            const viewportId = x.args.id;
            const surfaceId = x.args.surface;
            const surface = this.getObject(surfaceId);
            if (!surface) {
                console.error(`Surface ${surfaceId} not found for get_viewport`);
                return;
            }
            if (surface.data.current.viewport) {
                if (surface.data.current.viewport.source || surface.data.current.viewport.destination) {
                    this.postError("wp_viewporter", x.id, "viewport_exists", "Surface already has a viewport");
                    return;
                }
            }
            surface.data.pending.viewport = {};
            const viewport = this.getObject(viewportId);
            viewport.data = { surface: surfaceId };
        });
        isOp("wp_viewport.set_source", (x) => {
            const viewport = this.getObject(x.id);
            const surfaceId = viewport.data.surface;
            const surface = this.getObject(surfaceId);
            const viewportData = surface.data.pending.viewport;
            if (viewportData) {
                if (x.args.width === -1 && x.args.height === -1 && x.args.x === -1 && x.args.y === -1) {
                    viewportData.source = undefined;
                    return;
                } else if (x.args.width <= 0 || x.args.height <= 0 || x.args.x < 0 || x.args.y < 0) {
                    this.postError("wp_viewport", x.id, "bad_value", "Invalid source rectangle");
                    return;
                } else if (
                    x.args.x + x.args.width > surface.data.canvas.width ||
                    x.args.y + x.args.height > surface.data.canvas.height
                ) {
                    this.postError(
                        "wp_viewport",
                        x.id,
                        "out_of_buffer",
                        "Source rectangle exceeds surface buffer bounds",
                    );
                    return;
                }
                viewportData.source = {
                    x: x.args.x,
                    y: x.args.y,
                    width: x.args.width,
                    height: x.args.height,
                };
            }
        });
        isOp("wp_viewport.set_destination", (x) => {
            const viewport = this.getObject(x.id);
            const surfaceId = viewport.data.surface;
            const surface = this.getObject(surfaceId);
            const viewportData = surface.data.pending.viewport;
            if (viewportData) {
                if (x.args.width === -1 && x.args.height === -1) {
                    viewportData.destination = undefined;
                    return;
                } else if (x.args.width <= 0 || x.args.height <= 0) {
                    this.postError("wp_viewport", x.id, "bad_value", "Invalid destination rectangle");
                    return;
                } else if (
                    Number.isSafeInteger(x.args.width) === false ||
                    Number.isSafeInteger(x.args.height) === false
                ) {
                    this.postError("wp_viewport", x.id, "bad_size", "Width or height is not a safe integer");
                    return;
                }
                viewportData.destination = {
                    width: x.args.width,
                    height: x.args.height,
                };
            }
        });
        isOp("wp_viewport.destroy", (x) => {
            const viewport = this.getObject(x.id);
            const surfaceId = viewport.data.surface;
            const surface = this.getObject(surfaceId);
            if (surface) {
                delete surface.data.pending.viewport;
            }
        });

        // todo wp_cursor_shape_manager_v1.get_tablet_tool_v2 暂不实现，平板工具支持后再加
        isOp("wp_cursor_shape_manager_v1.get_pointer", (x) => {
            this.getObject(x.args.cursor_shape_device).data = { pointer: x.args.pointer };
        });
        isOp("wp_cursor_shape_device_v1.set_shape", (x) => {
            // todo serial 校验wl_pointer.enter的serial，不匹配时忽略
            const shape = getEnumName("wp_cursor_shape_device_v1.shape", x.args.shape);
            if (!shape) {
                this.postError("wp_cursor_shape_device_v1", x.id, "invalid_shape", `Invalid shape ${x.args.shape}`);
                return;
            }
            // 语义光标替换之前的surface光标（与wl_pointer.set_cursor混用，后到者生效）
            this.cursor.setShape(shape);
        });

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

function initWaylandProtocols() {
    let name = 1;
    for (const [_, proto] of Object.entries(WaylandProtocols)) {
        if (proto.name === "wl_display" || proto.name === "wl_registry" || proto.name === "wl_callback") {
            continue;
        }
        if (proto.version === 0) continue;
        waylandProtocolsNameMap.set(waylandName(name), proto);
        name++;
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

function newFd(data: string | Uint8Array): { fd: number; size: number } {
    const tmpPath = `/dev/shm/wl-fd-${crypto.randomUUID()}`;
    const fd = fs.openSync(tmpPath, "w+");
    if (typeof data === "string") {
        fs.writeFileSync(fd, data);
    } else {
        fs.writeFileSync(fd, data);
    }
    fs.unlinkSync(tmpPath); // unlink but keep fd open
    return {
        fd,
        size: typeof data === "string" ? Buffer.byteLength(data) : data.length,
    };
}

let sharedTextureCounter = 1;
const sharedTextureCbMap = new Map<number, (cb: ReturnType<typeof sharedTexture.importSharedTexture>) => void>();
async function importSharedTexture(
    options: Parameters<typeof sharedTexture.importSharedTexture>[0],
): Promise<ReturnType<typeof sharedTexture.importSharedTexture>> {
    const id = sharedTextureCounter++;
    const { promise, resolve } = Promise.withResolvers<ReturnType<typeof sharedTexture.importSharedTexture>>();
    sharedTextureCbMap.set(id, resolve);
    const fds = options.textureInfo.handle.nativePixmap?.planes.map((p) => p.fd);

    if (fds !== undefined) ipc.write({ data: Buffer.from(JSON.stringify({ id, options })), fds }, () => {});
    return promise;
}

sharedTexture.setSharedTextureReceiver(async (cb, id) => {
    const receiver = sharedTextureCbMap.get(id);
    if (receiver) {
        receiver(cb.importedSharedTexture);
        sharedTextureCbMap.delete(id);
    } else {
        console.error(`No receiver found for shared texture id ${id}`);
    }
});

const ipc = new usocket.USocket({ path: "/tmp/myde.sock" });
