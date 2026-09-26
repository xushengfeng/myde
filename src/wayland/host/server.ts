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
import type {
    Client,
    CursorState,
    PointerCommand,
    ScrollCommand,
    ServerEvents,
    ServerNotifyMap,
    ServerRequests,
    Size,
    WindowInfo,
    WinHandle,
} from "../api";
import type { WaylandWinId } from "../module";
import { assertModuleConflicts } from "../protocols/index";
import type { renderTools } from "../render_tools";
import type { WaylandName } from "../utils/wayland-binary";
import { WaylandProtocols, waylandProtocolsNameMap } from "../utils/wayland-proto";
import { type ClientHost, WaylandClient } from "./client";

export { WaylandServer };

/** 全局窗口表的一条：handle 是服务端身份，(client, winId) 是它反查到的内部位置 */
interface WindowEntry {
    client: WaylandClient;
    winId: WaylandWinId;
    /** 创建时缓存，`renderId` 只在 windowCreated 那一刻可得 */
    renderId: string;
}

function waylandName(name: number): WaylandName {
    return name as WaylandName;
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
    socketName = "my-wayland-server-0";
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
    };

    cursor = {
        get: (clientId: string): CursorState | undefined => this.rawClients.get(clientId)?.cursorState(),
    };

    constructor(op: { socketDir?: string; socketName?: string; render: renderTools }) {
        this.socketDir = op.socketDir || this.socketDir;
        this.socketName = op.socketName || this.socketName;
        this.render = op.render;
        this.clients = this.rawClients;

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
        this.dispatchNotify(key as keyof ServerNotifyMap, args as unknown[]);
    }

    private dispatchNotify(key: keyof ServerNotifyMap, args: unknown[]): void {
        if (key === "clipboard.paste") {
            // 剪贴板是 client 级的，直接用事件带下来的 clientId
            const [clientId, text] = args as [string, string];
            this.rawClients.get(clientId)?.paste(text);
            return;
        }
        const handle = args[0] as WinHandle;
        const entry = this.windowTable.get(handle);
        if (entry === undefined) {
            console.warn(`notify ${String(key)}: unknown window handle`, handle);
            return;
        }
        const { client, winId } = entry;
        switch (key) {
            case "window.focus":
                client.focusWindow(winId);
                break;
            case "window.blur":
                client.blurWindow(winId);
                break;
            case "window.close":
                client.closeWindow(winId);
                break;
            case "window.setBox":
                client.setWindowBox(winId, args[1] as Size);
                break;
            case "window.setSize": {
                const size = args[1] as Size;
                client.setWindowSize(winId, size.width, size.height);
                break;
            }
            case "window.maximize": {
                const size = args[1] as Size | undefined;
                client.maximizeWindow(winId, size?.width, size?.height);
                break;
            }
            case "window.unmaximize": {
                const size = args[1] as Size | undefined;
                client.unmaximizeWindow(winId, size?.width, size?.height);
                break;
            }
            case "window.minimize":
                client.minimizeWindow(winId);
                break;
            case "input.pointer":
                client.sendPointerToWindow(winId, args[1] as PointerCommand);
                break;
            case "input.scroll":
                client.sendScroll(args[1] as ScrollCommand);
                break;
            case "input.key":
                client.keyboard.sendKey(args[1] as number, args[2] as "pressed" | "released");
                break;
            case "input.text":
                client.keyboard.sendText(args[1] as string, args[2] as boolean);
                break;
            case "clipboard.offer":
                client.offerTo();
                break;
        }
    }

    // ───────────────────────── 窗口表与快照 ─────────────────────────

    private windowInfo(handle: WinHandle): WindowInfo | undefined {
        const entry = this.windowTable.get(handle);
        if (entry === undefined) return undefined;
        const record = entry.client.getWindows().get(entry.winId);
        return {
            handle,
            clientId: entry.client.id,
            appid: entry.client.getAppid() ?? "",
            title: record?.title ?? "",
            rect: entry.client.windowRect(entry.winId) ?? { x: 0, y: 0, w: 0, h: 0 },
            states: {
                activated: record?.actived ?? false,
                maximized: record?.maximized ?? false,
                minimized: record?.minimized ?? false,
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

        const host: ClientHost = {
            surfaceBounds: () => this.requestSync("surfaceBounds.request"),
            cursorChanged: (state) => this.emitEvent("cursor.changed", clientId, state),
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
        // setTitle 是「先发事件再改记录」，payload 里的 title 必须用事件带下来的值
        client.on("title", (winId, title) => this.emitChanged(clientId, winId, (info) => ({ ...info, title })));
        // appid 是 client 级的：该客户端的每个窗口都要通知一次
        client.on("appid", () => {
            const handles = this.handlesByClient.get(clientId);
            if (handles === undefined) return;
            for (const handle of [...handles]) {
                const info = this.windowInfo(handle);
                if (info) this.emitEvent("window.changed", info);
            }
        });
        client.on("copy", (text) => this.emitEvent("clipboard.copy", clientId, text));
        client.on("paste", () => this.emitEvent("clipboard.pasteRequested", clientId));
    }

    /** 断开：先补发该客户端全部窗口的关闭，再报 client.closed —— 残留窗口由 server 兜底 */
    private dropClient(clientId: string) {
        const handles = this.handlesByClient.get(clientId);
        if (handles !== undefined) {
            for (const handle of [...handles]) this.closeHandle(handle);
            this.handlesByClient.delete(clientId);
        }
        this.rawClients.delete(clientId);
        this.emitEvent("client.closed", clientId);
    }

    isProtocolSupported(protocol: string): boolean {
        return protocol in WaylandProtocols;
    }
}

/** 接口名 → 该模块声明的 global（绑定时初始化），由 protocolModules 聚合 */

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
