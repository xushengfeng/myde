/**
 * WaylandServer：连接生命周期（socket 监听、建连）、协议模块装配，
 * 以及**对外的 server 级 API**（见 PLAN.md §1）：
 *
 * - 事件 fan-in：订阅每个 client 的事件，分配全局 `WinHandle` 后以 `window.*` 等域事件转发
 * - 全局窗口表 `handle → (client, winId, renderId)`：跨客户端聚合、断线清理由 server 统一兜
 * - 查询 `windows.*` / `cursor.*`，命令 `notify`，请求-应答 `request` / `respond`
 *
 * 单个连接的全部职责在 ./client.ts；`server.clients` 保留给连接生命周期与
 * remote/调试等明确要 client 对象的场景。
 */

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const usocket = require("myde-unix-socket") as typeof import("myde-unix-socket");

import type { UServer, USocket } from "myde-unix-socket";
import { EventEmitter } from "../../event-emitter/event-emitter";
import { uniqueSocketName } from "../../socket-name";
import type {
    Client,
    ClipboardOffer,
    CursorState,
    DesktopClipboard,
    OutputInfo,
    ServerEvents,
    ServerNotifyMap,
    ServerRequests,
    WindowInfo,
    WinHandle,
} from "../api";
import type { ActionArgs, TransferApi, WaylandWinId } from "../module";
import { assertModuleConflicts } from "../protocols/index";
import type { renderTools } from "../render_tools";
import type { WaylandName } from "../utils/wayland-binary";
import { WaylandProtocols, waylandProtocolsNameMap } from "../utils/wayland-proto";
import { type ClientHost, WaylandClient } from "./client";
import { DndHub } from "./dnd_hub";

export { WaylandServer };

/** 全局窗口表的一条：handle 是服务端身份，(client, winId) 是它反查到的内部位置 */
interface WindowEntry {
    client: WaylandClient;
    winId: WaylandWinId;
    /** 创建时缓存，`renderId` 只在 windowCreated 那一刻可得 */
    renderId: string;
}

/**
 * 当前 selection 只记录「谁、有哪些 mime」，不记录字节。
 * 客户端源由 server 直接转发 fd；桌面源在 receive 时按需向桌面要。
 */
type ClipboardState =
    | {
          kind: "client";
          token: string;
          seat: string;
          clientId: string;
          sourceId: number;
          mimes: string[];
          time: number;
      }
    | {
          kind: "desktop";
          token: string;
          seat: string;
          desktopId: string;
          mimes: string[];
          time: number;
      };

/** 桌面没按期提供数据时关闭 fd，避免焦点客户端的粘贴永久挂起 */
const DESKTOP_DATA_TIMEOUT_MS = 3000;

function waylandName(name: number): WaylandName {
    return name as WaylandName;
}

/** 未配置输出前的默认值，保持与旧行为一致（1x、1920×1080、120Hz）。 */
const DEFAULT_OUTPUT: OutputInfo = {
    name: "output0",
    description: "Output 0",
    mode: { width: 1920, height: 1080, refresh: 120000 },
    scale: 1,
    transform: "normal",
};

function normalizeOutput(output: OutputInfo): OutputInfo {
    const scale = Number.isFinite(output.scale) && output.scale > 0 ? output.scale : 1;
    const width = Number.isFinite(output.mode.width) ? Math.max(1, Math.round(output.mode.width)) : 1920;
    const height = Number.isFinite(output.mode.height) ? Math.max(1, Math.round(output.mode.height)) : 1080;
    const refresh = Number.isFinite(output.mode.refresh) ? Math.max(0, Math.round(output.mode.refresh)) : 120000;
    return {
        name: output.name || DEFAULT_OUTPUT.name,
        description: output.description || output.name || DEFAULT_OUTPUT.description,
        mode: { width, height, refresh },
        scale,
        transform: output.transform ?? "normal",
        ...(output.physicalSize
            ? {
                  physicalSize: {
                      width: Math.max(0, Math.round(output.physicalSize.width)),
                      height: Math.max(0, Math.round(output.physicalSize.height)),
                  },
              }
            : {}),
    };
}

/**
 * 命令去掉首参 handle（反查完就没用了），回到 `ActionArgs<K>`。
 * 元组从 `ServerNotifyMap[K]` 里截断推不出来，这是 host 里唯一的一处断言。
 */
function stripHandle<K extends keyof ServerNotifyMap>(args: ServerNotifyMap[K]): ActionArgs<K> {
    return (args as unknown as [unknown, ...unknown[]]).slice(1) as ActionArgs<K>;
}

class WaylandServer {
    /** 服务端 → 桌面 的事件；桌面侧只拿得到 `on/off/once`，`emit` 不公开 */
    private events = new EventEmitter<ServerEvents, ServerRequests>();
    /**
     * `EventEmitter.request` 是异步的（Promise），而 `xdg_surface.get_toplevel`
     * 必须在同步 handler 里填 `configure_bounds`，所以 `respond` 注册的 handler
     * 另存一份同步副本，`surfaceBounds` 走这条。
     */
    // biome-ignore lint/suspicious/noExplicitAny: 各键的 args/result 不同，同步副本表里只能抹平
    private syncResponders = new Map<keyof ServerRequests, (...args: any[]) => any>();

    socketDir = "/tmp";
    socketName = uniqueSocketName("my-wayland-server");
    private socketPath: string;
    private server: UServer | null = null;
    private render: renderTools;
    private rawClients = new Map<string, WaylandClient>();
    /** 桌面看到的连接：只暴露 `Client` 接口（日志开关等底层入口） */
    clients: ReadonlyMap<string, Client>;
    /** 全局窗口表：handle → (client, winId, renderId) */
    private windowTable = new Map<WinHandle, WindowEntry>();
    private handlesByClient = new Map<string, Set<WinHandle>>();
    private nextHandle = 1;
    /** 当前输出配置（单屏；多屏时扩展为列表） */
    private output: OutputInfo = DEFAULT_OUTPUT;
    /** seat → 当前 selection（只有元数据，字节在客户端或桌面） */
    private clipboard = new Map<string, ClipboardState>();
    /** token → selection；旧 token 在 selection 替换/清除时删除 */
    private clipboardTokens = new Map<string, ClipboardState>();
    /** 跨客户端拖拽会话 */
    private dnd: DndHub;

    /**
     * 输出配置。桌面启动、分辨率或缩放变化时调用 `set`；
     * server 会把 `wl_output.scale` / `preferred_buffer_scale` / fractional 的
     * `preferred_scale` 重发给客户端，并按新 scale 重设窗口 DOM 尺寸。
     */
    outputs = {
        get: (): OutputInfo => this.output,
        set: (output: OutputInfo): void => {
            const next = normalizeOutput(output);
            this.output = next;
            this.render.setScale?.(next.scale);
            for (const client of this.rawClients.values()) client.applyOutput();
            // 窗口的逻辑 rect 不变，但显示尺寸变了；桌面需要更新输入换算和窗口 chrome
            for (const handle of this.windowTable.keys()) {
                const info = this.windowInfo(handle);
                if (info) this.emitEvent("window.changed", info);
            }
        },
    };

    /** 全部窗口的快照 */
    windows = {
        list: (): WindowInfo[] => {
            const out: WindowInfo[] = [];
            for (const handle of this.windowTable.keys()) {
                const info = this.windowInfo(handle);
                if (info) out.push(info);
            }
            return out;
        },
        get: (handle: WinHandle): WindowInfo | undefined => this.windowInfo(handle),
        /** 窗口最近一帧（缩略图、测试采样用）；还没画过时 undefined */
        preview: (handle: WinHandle): OffscreenCanvas | undefined => {
            const entry = this.windowTable.get(handle);
            if (entry === undefined) return undefined;
            return entry.client.windowPreview(entry.winId);
        },
        /**
         * 指针命中检测：p 相对窗口元素左上角（几何原点）。
         * 包含主 surface、popup 树、subsurface 与 input region，popup 超出窗口范围也能命中；
         * 桌面据此决定是否把 `input.pointer` / `input.scroll` / `input.gesture` 发给该窗口。
         */
        hitTest: (handle: WinHandle, p: { x: number; y: number }): boolean => {
            const entry = this.windowTable.get(handle);
            if (entry === undefined) return false;
            return entry.client.windowHitTest(entry.winId, p);
        },
    };

    cursor = {
        get: (clientId: string): CursorState | undefined => this.rawClients.get(clientId)?.cursorState(),
    };

    constructor(op: { socketDir?: string; socketName?: string; render: renderTools }) {
        this.socketDir = op.socketDir || this.socketDir;
        this.socketName = op.socketName || this.socketName;
        this.render = op.render;
        this.clients = this.rawClients;

        this.dnd = new DndHub({
            started: (info) => this.emitEvent("dnd.started", info),
            finished: (token, reason) => this.emitEvent("dnd.finished", token, reason),
            requestData: (id, mime) => this.requestDndData(id, mime),
        });

        this.socketPath = path.join(this.socketDir, this.socketName);

        initWaylandProtocols();
        assertModuleConflicts();

        // server 自己应答的查询；桌面也可用 `await server.request(...)` 走同一条路
        this.respond("window.get", (handle) => {
            const info = this.windowInfo(handle);
            if (info === undefined) throw new Error(`unknown window handle: ${handle}`);
            return info;
        });
        this.respond("window.getBounds", (handle) => {
            const info = this.windowInfo(handle);
            if (info === undefined) throw new Error(`unknown window handle: ${handle}`);
            return info.rect;
        });
        this.respond("textInput.get", (handle) => {
            const entry = this.windowTable.get(handle);
            if (entry === undefined) throw new Error(`unknown window handle: ${handle}`);
            return entry.client.textInputState(entry.winId);
        });
        // 桌面读客户端 selection；异步结果由 EventEmitter 的 thenable 展开
        this.events.respond("clipboard.read", ((token: string, mime: string) =>
            this.readClipboard(token, mime)) as unknown as (token: string, mime: string) => Uint8Array | null);
        this.events.respond("dnd.read", ((token: string, mime: string) => this.dnd.read(token, mime)) as unknown as (
            token: string,
            mime: string,
        ) => Uint8Array | null);
        this.respond("dnd.start", (item, actions) => {
            const names = actions ?? ["copy"];
            let mask = 0;
            for (const name of names) mask |= name === "move" ? 2 : 1;
            return this.dnd.startDesktop(item.id, item.mimes, mask);
        });

        console.log("Support protocols:", Object.keys(WaylandProtocols));

        this.setupSocket();
    }

    // ───────────────────────── 事件（服务端 → 桌面） ─────────────────────────

    on<K extends keyof ServerEvents>(event: K, handler: (...args: ServerEvents[K]) => void): () => void {
        return this.events.on(event, handler);
    }

    once<K extends keyof ServerEvents>(event: K, handler: (...args: ServerEvents[K]) => void): () => void {
        return this.events.once(event, handler);
    }

    off<K extends keyof ServerEvents>(event: K, handler: (...args: ServerEvents[K]) => void): void {
        this.events.off(event, handler);
    }

    private emitEvent<K extends keyof ServerEvents>(event: K, ...args: ServerEvents[K]): void {
        this.events.emit(event, ...args);
    }

    // ───────────────────────── 请求-应答 ─────────────────────────

    /** 桌面注册应答者（如 `surfaceBounds.request`），返回取消注册的函数 */
    respond<K extends keyof ServerRequests>(
        event: K,
        handler: (...args: ServerRequests[K]["args"]) => ServerRequests[K]["result"],
    ): () => void {
        // biome-ignore lint/suspicious/noExplicitAny: 同上，异构应答者抹平
        this.syncResponders.set(event, handler as (...args: any[]) => any);
        const off = this.events.respond(event, handler);
        return () => {
            off();
            // biome-ignore lint/suspicious/noExplicitAny: 同上
            if (this.syncResponders.get(event) === (handler as (...args: any[]) => any)) {
                this.syncResponders.delete(event);
            }
        };
    }

    /** 查询（`window.get` / `window.getBounds` 由 server 应答，`surfaceBounds.request` 由桌面应答） */
    request<K extends keyof ServerRequests>(
        event: K,
        ...args: ServerRequests[K]["args"]
    ): Promise<ServerRequests[K]["result"]> {
        return this.events.request(event, ...args).then((results) => {
            if (results.length === 0) throw new Error(`no responder registered for ${String(event)}`);
            return results[0];
        });
    }

    /** 同步取值：协议的同步 handler 用（`EventEmitter.request` 来不及） */
    private requestSync<K extends keyof ServerRequests>(
        event: K,
        ...args: ServerRequests[K]["args"]
    ): ServerRequests[K]["result"] | undefined {
        const handler = this.syncResponders.get(event);
        if (handler === undefined) return undefined;
        try {
            return handler(...args);
        } catch (err) {
            console.error("respond handler error for", String(event), err);
            return undefined;
        }
    }

    // ───────────────────────── 命令（桌面 → server → client） ─────────────────────────

    /** 内部按 handle 反查 `(client, winId)`，桌面不接触 Wayland 对象 id */
    notify<K extends keyof ServerNotifyMap>(key: K, ...args: ServerNotifyMap[K]): void {
        this.dispatchNotify(key, args);
    }

    private dispatchNotify<K extends keyof ServerNotifyMap>(key: K, args: ServerNotifyMap[K]): void {
        if (key === "clipboard.set") {
            // 剪贴板是 client 级 / server 级，没有 window handle
            this.setDesktopClipboard(args[0] as DesktopClipboard | null);
            return;
        }
        if (key === "clipboard.clear") {
            this.setDesktopClipboard(null);
            return;
        }
        if (key === "clipboard.offer") {
            const [handle, explicit] = args as unknown as [WinHandle, ClipboardOffer | undefined];
            const entry = this.windowTable.get(handle);
            if (entry === undefined) {
                console.warn("notify clipboard.offer: unknown window handle", handle);
                return;
            }
            entry.client.offerClipboard(explicit ?? this.clipboardOffer("seat0"), "seat0");
            return;
        }
        if (key === "dnd.cancel") {
            const [token] = args as unknown as [string];
            this.dnd.cancel(token);
            return;
        }
        if (key === "dnd.move" || key === "dnd.drop") {
            const [token, target] = args as unknown as [string, { handle: WinHandle; x: number; y: number } | null];
            const resolved = target ? this.resolveDndTarget(target.handle, target.x, target.y) : null;
            if (key === "dnd.move") this.dnd.move(token, resolved);
            else this.dnd.drop(token, resolved);
            return;
        }
        const handle = args[0] as WinHandle;
        const entry = this.windowTable.get(handle);
        if (entry === undefined) {
            console.warn(`notify ${String(key)}: unknown window handle`, handle);
            return;
        }
        // host 只做 handle 反查与派发，命令语义在协议模块的 `actions` 里
        const { client, winId } = entry;
        client.runAction(key, winId, stripHandle(args));
    }

    private resolveDndTarget(handle: WinHandle, x: number, y: number) {
        const entry = this.windowTable.get(handle);
        if (entry === undefined) return null;
        return { clientId: entry.client.id, winId: entry.winId, x, y };
    }

    // ───────────────────────── 窗口表与快照 ─────────────────────────

    private windowInfo(handle: WinHandle): WindowInfo | undefined {
        const entry = this.windowTable.get(handle);
        if (entry === undefined) return undefined;
        const record = entry.client.getWindows().get(entry.winId);
        return {
            handle,
            clientId: entry.client.id,
            appid: record?.appid ?? "",
            decorated: record?.decorated ?? false,
            title: record?.title ?? "",
            rect: entry.client.windowRect(entry.winId) ?? { x: 0, y: 0, w: 0, h: 0 },
            scale: this.output.scale,
            states: {
                activated: record?.actived ?? false,
                maximized: record?.maximized ?? false,
                minimized: record?.minimized ?? false,
                fullscreen: record?.fullscreen ?? false,
            },
            renderId: entry.renderId,
        };
    }

    private handleOf(clientId: string, winId: WaylandWinId): WinHandle | undefined {
        const handles = this.handlesByClient.get(clientId);
        if (handles === undefined) return undefined;
        for (const handle of handles) {
            if (this.windowTable.get(handle)?.winId === winId) return handle;
        }
        return undefined;
    }

    /** client 级事件 → 自包含的 window.changed；`patch` 用来带上还没落进记录的字段（title） */
    private emitChanged(clientId: string, winId: WaylandWinId, patch?: (info: WindowInfo) => WindowInfo): void {
        const handle = this.handleOf(clientId, winId);
        if (handle === undefined) return;
        const info = this.windowInfo(handle);
        if (info === undefined) return;
        this.emitEvent("window.changed", patch ? patch(info) : info);
    }

    private closeHandle(handle: WinHandle): void {
        const entry = this.windowTable.get(handle);
        if (entry !== undefined) this.handlesByClient.get(entry.client.id)?.delete(handle);
        this.windowTable.delete(handle);
        this.emitEvent("window.closed", handle);
    }

    // ───────────────────────── 连接生命周期 ─────────────────────────

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

        const transfer: TransferApi = {
            selectionChanged: (seat, sourceId, mimes) => this.clientSelectionChanged(clientId, seat, sourceId, mimes),
            clearSelection: (seat) => this.clearClipboard(seat, "cleared"),
            sourceDestroyed: (sourceId) => this.clientSourceDestroyed(clientId, sourceId),
            forward: (token, mime, fd) => this.forwardClipboard(token, mime, fd),
            dragStarted: (seat, sourceId, mimes, actions) => {
                let mask = 0;
                for (const a of actions) mask |= a === "move" ? 2 : 1;
                const appid = this.rawClients.get(clientId)?.getAppid() ?? "";
                this.dnd.startClient(clientId, appid, seat, sourceId, mimes, mask);
            },
            dragFinished: (sourceId, reason) => this.dnd.sourceFinished(clientId, sourceId, reason),
        };
        const host: ClientHost = {
            surfaceBounds: () => this.requestSync("surfaceBounds.request"),
            output: () => this.output,
            cursorChanged: (state) => this.emitEvent("cursor.changed", clientId, state),
            transfer,
            dnd: this.dnd,
        };
        const client = new WaylandClient({ id: clientId, socket, render: this.render, host });
        this.rawClients.set(clientId, client);
        this.bindClient(clientId, client);
        this.emitEvent("client.opened", clientId);

        client.on("close", () => {
            this.dropClient(clientId);
        });
    }

    /** fan-in：把 client 级的平铺事件转成 server 级、handle 化、自包含的域事件 */
    private bindClient(clientId: string, client: WaylandClient) {
        client.on("windowCreated", (winId, renderId) => {
            const entry: WindowEntry = { client, winId, renderId };
            const handle: WinHandle = `w${this.nextHandle++}`;
            this.windowTable.set(handle, entry);
            let set = this.handlesByClient.get(clientId);
            if (set === undefined) {
                set = new Set();
                this.handlesByClient.set(clientId, set);
            }
            set.add(handle);
            const info = this.windowInfo(handle);
            if (info) this.emitEvent("window.created", info);
        });
        client.on("windowClosed", (winId) => {
            const handle = this.handleOf(clientId, winId);
            if (handle !== undefined) this.closeHandle(handle);
        });
        client.on("windowResized", (winId, width, height) => {
            this.emitChanged(clientId, winId, (info) => ({ ...info, rect: { ...info.rect, w: width, h: height } }));
        });
        client.on("windowStartMove", (winId) => {
            const handle = this.handleOf(clientId, winId);
            if (handle !== undefined) this.emitEvent("window.startMove", handle);
        });
        client.on("windowMaximized", (winId) => this.emitChanged(clientId, winId));
        client.on("windowUnMaximized", (winId) => this.emitChanged(clientId, winId));
        client.on("windowFullscreen", (winId) => this.emitChanged(clientId, winId));
        client.on("windowUnFullscreen", (winId) => this.emitChanged(clientId, winId));
        // setTitle 是「先发事件再改记录」，payload 里的 title 必须用事件带下来的值
        client.on("title", (winId, title) => this.emitChanged(clientId, winId, (info) => ({ ...info, title })));
        // app_id 按 toplevel 变化：同一连接里可以有多个应用（xwayland-satellite）
        client.on("windowAppid", (winId) => this.emitChanged(clientId, winId));
        // 服务端装饰协商结果变化：桌面据此挂上/摘掉标题栏
        client.on("windowDecorated", (winId) => this.emitChanged(clientId, winId));
    }

    /** 断开：先补发该客户端全部窗口的关闭，再报 client.closed —— 残留窗口由 server 兜底 */
    private dropClient(clientId: string) {
        const handles = this.handlesByClient.get(clientId);
        if (handles !== undefined) {
            for (const handle of [...handles]) this.closeHandle(handle);
            this.handlesByClient.delete(clientId);
        }
        this.rawClients.delete(clientId);
        // 该客户端持有的 selection 没有源了；桌面若要保留内容，收到 sourceGone 后自己 clipboard.set 回去
        for (const seat of [...this.clipboard.keys()]) {
            const state = this.clipboard.get(seat);
            if (state?.kind === "client" && state.clientId === clientId) this.clearClipboard(seat, "sourceGone");
        }
        // 进行中的拖拽也结束，让中转站清掉拖拽态
        this.dnd.detach(clientId);
        this.emitEvent("client.closed", clientId);
    }

    // ───────────────────────── 剪贴板数据中转 ─────────────────────────

    /** 当前 seat 的 offer 描述；桌面调用 `clipboard.offer` 时由 server 填入 */
    private clipboardOffer(seat: string): ClipboardOffer | null {
        const state = this.clipboard.get(seat);
        return state ? { token: state.token, mimes: [...state.mimes] } : null;
    }

    /** 桌面把历史条目放回剪贴板；字节仍在桌面，receive 时通过 `clipboard.requestData` 取 */
    private setDesktopClipboard(selection: DesktopClipboard | null): void {
        const seat = selection?.seat ?? "seat0";
        this.replaceSelection(seat, null);
        if (!selection || selection.mimes.length === 0) {
            this.broadcastClipboard(null, seat);
            return;
        }
        const token = `cb-desktop-${crypto.randomUUID()}`;
        const state: ClipboardState = {
            kind: "desktop",
            token,
            seat,
            desktopId: selection.id,
            mimes: [...selection.mimes],
            time: Date.now(),
        };
        this.clipboard.set(seat, state);
        this.clipboardTokens.set(token, state);
        this.broadcastClipboard({ token, mimes: state.mimes }, seat);
    }

    /** 客户端 `set_selection`：替换该 seat 的 selection、通知桌面、推给焦点客户端 */
    private clientSelectionChanged(clientId: string, seat: string, sourceId: number, mimes: string[]): void {
        if (mimes.length === 0) {
            this.clearClipboard(seat, "cleared");
            return;
        }
        this.replaceSelection(seat, { clientId, sourceId });
        const token = `cb-${crypto.randomUUID()}`;
        const state: ClipboardState = {
            kind: "client",
            token,
            seat,
            clientId,
            sourceId,
            mimes: [...mimes],
            time: Date.now(),
        };
        this.clipboard.set(seat, state);
        this.clipboardTokens.set(token, state);
        this.broadcastClipboard({ token, mimes: state.mimes }, seat);
        this.emitEvent("clipboard.changed", {
            token,
            seat,
            mimes: [...mimes],
            appid: this.rawClients.get(clientId)?.getAppid() ?? "",
            clientId,
            time: state.time,
        });
    }

    private clearClipboard(seat: string, reason: "cleared" | "sourceGone"): void {
        if (!this.clipboard.has(seat)) return;
        this.replaceSelection(seat, null);
        this.broadcastClipboard(null, seat);
        this.emitEvent("clipboard.changed", null, reason, seat);
    }

    /** 删除旧 selection：source 客户端还在就发 `cancelled`，token 立即失效 */
    private replaceSelection(seat: string, keep: { clientId: string; sourceId: number } | null): void {
        const prev = this.clipboard.get(seat);
        if (!prev) return;
        this.clipboard.delete(seat);
        this.clipboardTokens.delete(prev.token);
        const same =
            keep !== null &&
            prev.kind === "client" &&
            prev.clientId === keep.clientId &&
            prev.sourceId === keep.sourceId;
        if (prev.kind === "client" && !same) this.rawClients.get(prev.clientId)?.cancelDataSource(prev.sourceId);
    }

    private broadcastClipboard(selection: ClipboardOffer | null, seat: string): void {
        for (const client of this.rawClients.values()) client.offerClipboard(selection, seat);
    }

    private clientSourceDestroyed(clientId: string, sourceId: number): void {
        for (const [seat, state] of this.clipboard) {
            if (state.kind === "client" && state.clientId === clientId && state.sourceId === sourceId) {
                this.clearClipboard(seat, "sourceGone");
                return;
            }
        }
    }

    private readClipboard(token: string, mime: string): Promise<Uint8Array | null> {
        const state = this.clipboardTokens.get(token);
        if (state?.kind !== "client" || !state.mimes.includes(mime)) return Promise.resolve(null);
        const client = this.rawClients.get(state.clientId);
        if (!client) return Promise.resolve(null);
        return client.readDataSource(state.sourceId, mime);
    }

    // ───────────────────────── 拖拽中转 ─────────────────────────

    /** 桌面作为拖拽源时，目标 receive 后向桌面要数据 */
    private async requestDndData(id: string, mime: string): Promise<Uint8Array | null> {
        try {
            const results = await Promise.race([
                this.events.request("dnd.requestData", id, mime),
                new Promise<never>((_, reject) => {
                    const t = setTimeout(() => reject(new Error("timeout")), DESKTOP_DATA_TIMEOUT_MS);
                    (t as { unref?: () => void }).unref?.();
                }),
            ]);
            return results[0] ?? null;
        } catch (err) {
            console.warn("dnd requestData failed:", err);
            return null;
        }
    }

    /** offer 的 fd → 真正的数据源；调用后 fd 由本方法关闭 */
    private forwardClipboard(token: string, mime: string, fd: number): void {
        const state = this.clipboardTokens.get(token);
        if (!state || !state.mimes.includes(mime)) {
            this.closeFd(fd);
            return;
        }
        if (state.kind === "client") {
            const client = this.rawClients.get(state.clientId);
            const ok = client?.sendDataSource(state.sourceId, mime, fd) ?? false;
            // sendMessageImm 已把 fd dup 进 socket；本地这份可以关了
            this.closeFd(fd);
            if (!ok) console.warn(`clipboard forward: source ${state.sourceId} is gone`);
            return;
        }
        void this.requestDesktopData(state.desktopId, mime)
            .then((bytes) => {
                if (bytes && bytes.length > 0) fs.writeFileSync(fd, bytes);
            })
            .catch((err) => console.error("clipboard forward: write fd failed", err))
            .finally(() => this.closeFd(fd));
    }

    /** 向桌面要数据；桌面没注册 responder / 超时都按 null 处理 */
    private async requestDesktopData(id: string, mime: string): Promise<Uint8Array | null> {
        try {
            const results = await Promise.race([
                this.events.request("clipboard.requestData", id, mime),
                new Promise<never>((_, reject) => {
                    const t = setTimeout(() => reject(new Error("timeout")), DESKTOP_DATA_TIMEOUT_MS);
                    (t as { unref?: () => void }).unref?.();
                }),
            ]);
            return results[0] ?? null;
        } catch (err) {
            console.warn("clipboard requestData failed:", err);
            return null;
        }
    }

    private closeFd(fd: number): void {
        try {
            fs.closeSync(fd);
        } catch {
            // ignore
        }
    }

    isProtocolSupported(protocol: string): boolean {
        return protocol in WaylandProtocols;
    }
}

/** 接口名 → 该模块声明的 global（绑定时初始化），由 protocolModules 聚合 */

/** 导出仅供测试：`waylandProtocolsNameMap` 是模块级单例，重复调用幂等（名字从 1 重新分配） */
export function initWaylandProtocols() {
    let name = 1;
    for (const [_, proto] of Object.entries(WaylandProtocols)) {
        if (proto.name === "wl_display" || proto.name === "wl_registry" || proto.name === "wl_callback") {
            continue;
        }
        if (proto.version === 0) continue;
        waylandProtocolsNameMap.set(waylandName(name), proto);
        name++;
        // 多 seat：**必须一次性广播齐**——Firefox/GTK 不认运行中新增的 seat（Chromium 则忽略第二个），
        // 所以从客户端连上起就注册两把。名字（seat0/seat1）由 `wl_seat.onBind` 按
        // 「本协议广播的第几个 global」算，客户端 bind 哪个都能对上号。
        if (proto.name === "wl_seat") {
            waylandProtocolsNameMap.set(waylandName(name), proto);
            name++;
        }
    }
}
