import type { InputManager } from "myde-input";
import type { DesktopApi } from "../../src/desktop-api";
import { EventEmitter } from "../../src/event-emitter/event-emitter";
import { absPosMapping, absRange, absRatio } from "../../src/input_map/abs";
import type { Item } from "../../src/sys_api/app_control";
import type { tray } from "../../src/sys_api/appIndicator";
import type { blue } from "../../src/sys_api/blue";
import type { display, Rect, Transform } from "../../src/sys_api/display";
import { inputSim } from "../../src/sys_api/input_sim";
import type { MenuItem } from "../../src/sys_api/menu";
import type { MprisEvents, mpris } from "../../src/sys_api/mpris";
import type { network } from "../../src/sys_api/network";
import type { NotificationData, NotificationEvents, notification } from "../../src/sys_api/notification";
import type { power } from "../../src/sys_api/power";
import type { renderTools, renderToolsOn } from "../../src/wayland/render_tools";
import type { MockRenderTools } from "./render-tools";
import type { MockVolumeManager } from "./volume-mock";
import { createMockVolume } from "./volume-mock";

/**
 * 提取类的公共成员（排除构造函数和private成员）
 * TypeScript的keyof自动排除private成员，所以Omit<T, 'constructor'>即可
 */
type MockType<T> = Omit<T, "constructor">;

let globalRenderTools: MockRenderTools | null = null;

export function setGlobalRenderTools(renderTools: MockRenderTools): void {
    globalRenderTools = renderTools;
}

export function getGlobalRenderTools(): MockRenderTools | null {
    return globalRenderTools;
}

export interface MockWaylandWindow {
    focus(): boolean;
    blur(): void;
    setWinBoxData(data: { width: number; height: number }): void;
    setSize(w: number, h: number): void;
    maximize(width: number, height: number): void;
    unmaximize(width: number, height: number): void;
    minimize(): void;
    close(): void;
    point: {
        renderId(): string;
        inWin(p: { x: number; y: number }): boolean;
        updatePointerFocus(p: { x: number; y: number }): { x: number; y: number } | undefined;
        sendPointerEvent(type: "move" | "down" | "up", p: { x: number; y: number; button: number }): void;
        sendScrollEvent(op: { p: { deltaX: number; deltaY: number; deltaZ: number } }): void;
    };
    getPreview(): OffscreenCanvas;
    getTitle(): string;
}

/** 与 `src/wayland/api.ts` 的 WindowInfo 同形 */
export interface MockWindowInfo {
    handle: string;
    clientId: string;
    appid: string;
    title: string;
    rect: { x: number; y: number; w: number; h: number };
    states: { activated: boolean; maximized: boolean; minimized: boolean };
    renderId: string;
}

/**
 * 应用侧（被模拟的 wayland client）。桌面拿不到它 —— 桌面只通过
 * `server.on/notify/windows.*` 与之交互，client 只负责把语义事实抛给 server。
 */
export interface MockWaylandClient {
    id: string;
    getWindows(): Map<string, MockWaylandWindow>;
    getAppid(): string;
    setAppid(appid: string): void;
    setLogConfig(config: { receive: boolean | string[]; send: boolean | string[] }): void;
    on(event: string, cb: (...args: any[]) => void): MockWaylandClient;
    emit(event: string, ...args: any[]): void;
    close(): void;
}

/** 与 `src/wayland/api.ts` 的 ServerEvents / 查询 / notify 同形的 mock 服务端 */
export interface MockWaylandServer {
    socketDir: string;
    socketName: string;
    clients: Map<string, MockWaylandClient>;
    windows: {
        list(): MockWindowInfo[];
        get(handle: string): MockWindowInfo | undefined;
        preview(handle: string): OffscreenCanvas | undefined;
    };
    cursor: { get(clientId: string): unknown };
    /** 造窗口：分配全局 handle 并发出 `window.created` */
    openWindow(op: { clientId: string; winId?: string; renderId: string; width?: number; height?: number }): string;
    closeWindow(handle: string): void;
    closeWindowOf(clientId: string, winId: string): void;
    handleOf(clientId: string, winId: string): string | undefined;
    /** client 的 appid 变化后调用，给该客户端每个窗口发 `window.changed` */
    touchAppid(clientId: string): void;
    on(event: string, cb: (...args: any[]) => void): MockWaylandServer;
    off(event: string, cb: (...args: any[]) => void): MockWaylandServer;
    emit(event: string, ...args: any[]): void;
    respond(event: string, cb: (...args: any[]) => any): () => void;
    request(event: string, ...args: any[]): Promise<any>;
    notify(event: string, ...args: any[]): void;
    destroy(): void;
}

export interface MockConfig {
    /** 是否启用详细日志，默认false */
    verbose?: boolean;
    /** 自定义MSysApi实现（部分覆盖） */
    sysApi?: Partial<DesktopApi["MSysApi"]>;
    /** 自定义MInputMap实现（部分覆盖） */
    inputMap?: Partial<DesktopApi["MInputMap"]>;
    /** 自定义MSetting实现 */
    setting?: DesktopApi["MSetting"];
    /** 自定义MConnect实现 */
    connect?: DesktopApi["MConnect"];
    /** 自定义vfs文件存储 */
    vfsStore?: MockVfsStore;
    /** 蓝牙管理器 */
    blueManager?: MockBlueManager;
    /** 网络管理器 */
    networkManager?: MockNetworkManager;
    /** 电源管理器 */
    powerManager?: MockPowerManager;
    /** 通知管理器 */
    notificationManager?: MockNotificationManager;
    /** MPRIS管理器 */
    mprisManager?: MockMprisManager;
    /** 托盘管理器 */
    trayManager?: MockTrayManager;
    /** 音量管理器 */
    volumeManager?: MockVolumeManager;
}

type SettingInitReturn = ReturnType<DesktopApi["MSetting"]["init"]>;

function createMockRenderTools(): renderTools {
    if (globalRenderTools) {
        return globalRenderTools;
    }
    return {
        on(_op?: renderToolsOn): void {},
        idScope(): (id: unknown) => string {
            return (id: unknown) => String(id);
        },
        bindCanvas(_id: string): void {},
        renderCanvas(_canvas: OffscreenCanvas, _id: string): void {},
        destroyCanvas(_id: string): void {},
        setCanvasAnchor(_id: string, _parentId: string): void {},
        setCanvasOffset(_id: string, _x: number, _y: number): void {},
        setBufferOffset(_id: string, _x: number, _y: number): void {},
        createXdgSurfaceEle(_id: string, _canvasId: string): void {},
        getXdgSurfaceEle(_id: string): unknown {
            return undefined;
        },
        destroyXdgSurfaceEle(_id: string, _type: "toplevel" | "popup"): void {},
        setXdgSurfaceGeo(_id: string, _width: number, _height: number, _offsetX: number, _offsetY: number): void {},
        asToplevel(_id: string): void {},
        addPopupToXdgSurface(_popupSurfaceId: string, _parentSurfaceId: string): void {},
        setPopupPosi(_popupSurfaceId: string, _x: number, _y: number): void {},
        setCursor(_canvas: OffscreenCanvas | string | undefined, _hotspotX: number, _hotspotY: number): void {},
    };
}

export function createMockClient(op?: string | { id?: string; server?: MockWaylandServer }): MockWaylandClient {
    const id = typeof op === "string" ? op : (op?.id ?? "mock-client");
    const server = typeof op === "string" ? undefined : op?.server;
    const windows = new Map<string, MockWaylandWindow>();
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    let appid = "";

    const dispatch = (event: string, ...args: any[]) => {
        // biome-ignore  lint/suspicious/useIterableCallbackReturn:''
        listeners.get(event)?.forEach((cb) => cb(...args));
    };

    const client: MockWaylandClient = {
        id,
        getWindows: () => windows,
        getAppid: () => appid,
        setAppid: (next: string) => {
            appid = next;
            dispatch("appid", next);
            server?.touchAppid(id);
        },
        setLogConfig: (_config) => {},
        on(event: string, cb: (...args: any[]) => void) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)?.add(cb);
            return client;
        },
        /**
         * 应用侧抛出的语义事实：先派发给本 client 的监听者，再 fan-in 到 server
         * （server 转成 `window.*` 域事件，与真实实现一致）。
         */
        emit(event: string, ...args: any[]) {
            dispatch(event, ...args);
            if (!server) return;
            const winId = args[0] as string | undefined;
            const handle = winId === undefined ? undefined : server.handleOf(id, winId);
            switch (event) {
                case "windowCreated":
                    server.openWindow({ clientId: id, winId, renderId: args[1] as string });
                    break;
                case "windowClosed":
                    if (winId) server.closeWindowOf(id, winId);
                    break;
                case "windowStartMove":
                    if (handle) server.emit("window.startMove", handle);
                    break;
                case "windowMaximized":
                    if (handle) server.notify("window.maximize", handle);
                    break;
                case "windowUnMaximized":
                    if (handle) server.notify("window.unmaximize", handle);
                    break;
            }
        },
        close() {
            dispatch("close");
            windows.clear();
            listeners.clear();
        },
    };
    return client;
}

/**
 * 与 `src/wayland/host/server.ts` 同形状的 mock 服务端：
 * 全局 handle 表、域事件 fan-in、`windows.*` 查询、`notify`/`respond`。
 * 桌面开发者拿它跑界面，无需真实 dbus/wayland。
 */
export function createMockServer(): MockWaylandServer {
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    const responders = new Map<string, (...args: any[]) => any>();
    const clients = new Map<string, MockWaylandClient>();
    const infos = new Map<string, MockWindowInfo>();
    const handleByWin = new Map<string, string>();
    const winByHandle = new Map<string, string>();
    let nextHandle = 1;

    const dispatch = (event: string, ...args: any[]) => {
        // biome-ignore  lint/suspicious/useIterableCallbackReturn:''
        listeners.get(event)?.forEach((cb) => cb(...args));
    };
    const key = (clientId: string, winId: string) => `${clientId}|${winId}`;
    const changed = (info: MockWindowInfo) => dispatch("window.changed", info);

    const server: MockWaylandServer = {
        socketDir: "/tmp/mock",
        socketName: "mock-socket",
        clients,
        windows: {
            list: () => Array.from(infos.values()),
            get: (handle) => infos.get(handle),
            preview: (handle) => {
                const info = infos.get(handle);
                const winId = winByHandle.get(handle);
                if (!info || winId === undefined) return undefined;
                return clients.get(info.clientId)?.getWindows().get(winId)?.getPreview();
            },
        },
        cursor: { get: (clientId) => (clients.has(clientId) ? "default" : undefined) },
        openWindow(op) {
            const handle = `w${nextHandle++}`;
            const info: MockWindowInfo = {
                handle,
                clientId: op.clientId,
                appid: clients.get(op.clientId)?.getAppid() ?? "",
                title: "",
                rect: { x: 0, y: 0, w: op.width ?? 0, h: op.height ?? 0 },
                states: { activated: false, maximized: false, minimized: false },
                renderId: op.renderId,
            };
            infos.set(handle, info);
            if (op.winId !== undefined) {
                handleByWin.set(key(op.clientId, op.winId), handle);
                winByHandle.set(handle, op.winId);
            }
            dispatch("window.created", info);
            return handle;
        },
        closeWindow(handle) {
            if (!infos.delete(handle)) return;
            winByHandle.delete(handle);
            for (const [k, v] of handleByWin) if (v === handle) handleByWin.delete(k);
            dispatch("window.closed", handle);
        },
        closeWindowOf(clientId, winId) {
            const handle = handleByWin.get(key(clientId, winId));
            if (handle !== undefined) server.closeWindow(handle);
        },
        handleOf: (clientId, winId) => handleByWin.get(key(clientId, winId)),
        touchAppid(clientId) {
            const appid = clients.get(clientId)?.getAppid() ?? "";
            for (const info of infos.values()) {
                if (info.clientId !== clientId) continue;
                info.appid = appid;
                changed(info);
            }
        },
        on(event, cb) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)?.add(cb);
            return server;
        },
        off(event, cb) {
            listeners.get(event)?.delete(cb);
            return server;
        },
        emit: dispatch,
        respond(event, cb) {
            responders.set(event, cb);
            return () => {
                if (responders.get(event) === cb) responders.delete(event);
            };
        },
        async request(event, ...args) {
            const handler = responders.get(event);
            return handler ? [handler(...args)] : [];
        },
        notify(event, ...args) {
            if (event === "clipboard.paste") return;
            const handle = args[0] as string;
            const info = infos.get(handle);
            if (!info) return;
            switch (event) {
                case "window.focus":
                    info.states.activated = true;
                    info.states.minimized = false;
                    changed(info);
                    break;
                case "window.blur":
                    info.states.activated = false;
                    changed(info);
                    break;
                case "window.maximize":
                    info.states.activated = true;
                    info.states.maximized = true;
                    info.states.minimized = false;
                    changed(info);
                    break;
                case "window.unmaximize":
                    info.states.maximized = false;
                    changed(info);
                    break;
                case "window.minimize":
                    info.states.activated = false;
                    info.states.minimized = true;
                    changed(info);
                    break;
                case "window.setSize": {
                    const size = args[1] as { width: number; height: number };
                    info.rect = { ...info.rect, w: size.width, h: size.height };
                    changed(info);
                    break;
                }
                case "window.close":
                    server.closeWindow(handle);
                    break;
                default:
                    // input.* / clipboard.* / setBox：mock 不模拟客户端
                    break;
            }
        },
        destroy() {
            clients.clear();
            infos.clear();
            handleByWin.clear();
            winByHandle.clear();
            listeners.clear();
            responders.clear();
        },
    };

    // server 自己应答的查询（形状同真实实现）
    server.respond("window.get", (handle: string) => infos.get(handle));
    server.respond("window.getBounds", (handle: string) => infos.get(handle)?.rect);
    return server;
}

export function createMockWindow(id: string): MockWaylandWindow {
    const title = "";
    let width = 0;
    let height = 0;
    let actived = false;
    let renderId = `render-${id}`;
    const canvas = new OffscreenCanvas(1, 1);

    const window: MockWaylandWindow = {
        focus() {
            if (actived) return false;
            actived = true;
            return true;
        },
        blur() {
            actived = false;
        },
        setWinBoxData(data) {
            width = data.width;
            height = data.height;
        },
        setSize(w, h) {
            width = w;
            height = h;
        },
        maximize(w, h) {
            width = w;
            height = h;
            actived = true;
        },
        unmaximize(w, h) {
            width = w;
            height = h;
        },
        minimize() {
            actived = false;
        },
        close() {},
        point: {
            renderId() {
                return renderId;
            },
            inWin(p) {
                return p.x >= 0 && p.x < width && p.y >= 0 && p.y < height;
            },
            updatePointerFocus(p) {
                if (p.x >= 0 && p.x < width && p.y >= 0 && p.y < height) {
                    return { x: p.x, y: p.y };
                }
                return undefined;
            },
            sendPointerEvent(_type, _p) {},
            sendScrollEvent(_op) {},
        },
        getPreview() {
            return canvas;
        },
        getTitle() {
            return title;
        },
    };

    // 添加设置renderId的方法
    (window as any).setRenderId = (id: string) => {
        renderId = id;
    };

    return window;
}

function createMockSettingInstance(): SettingInitReturn {
    const store = new Map<string, unknown>();
    const nsStore = new Map<string, Map<string, unknown>>();

    return {
        get<K extends string>(key: K): any {
            return store.get(key);
        },
        set<K extends string>(key: K, value: any): void {
            store.set(key, value);
        },
        nget<K extends string>(key: K): any {
            const ns = nsStore.get("default");
            return ns?.get(key);
        },
        nset<K extends string>(key: K, value: any): void {
            let ns = nsStore.get("default");
            if (!ns) {
                ns = new Map();
                nsStore.set("default", ns);
            }
            ns.set(key, value);
        },
    } as SettingInitReturn;
}

function createMockEventEmitter<T extends Record<string, any[]>>(): EventEmitter<T> {
    return new EventEmitter<T>();
}

export class MockTrayItem {
    private name: string;
    private titleValue: string;
    private itemIsMenuValue: boolean;
    private iconName: string;
    private menuLayout: MenuItem[];

    constructor(name: string, title: string, iconName = "application-default-icon", itemIsMenu = false) {
        this.name = name;
        this.titleValue = title;
        this.iconName = iconName;
        this.itemIsMenuValue = itemIsMenu;
        this.menuLayout = [];
    }

    async init() {}
    async title() {
        return this.titleValue;
    }
    async itemIsMenu() {
        return this.itemIsMenuValue;
    }
    async getIcon(_op?: { size?: number; scale?: number; theme?: string }) {
        return this.iconName;
    }
    async getMenu() {
        return this.menuLayout;
    }
    getPath() {
        return this.name;
    }

    setTitle(title: string) {
        this.titleValue = title;
    }
    setItemIsMenu(itemIsMenu: boolean) {
        this.itemIsMenuValue = itemIsMenu;
    }
    setIconName(iconName: string) {
        this.iconName = iconName;
    }
    setMenuLayout(layout: MenuItem[]) {
        this.menuLayout = layout;
    }
}

export class MockMprisPlayer {
    private name: string;
    private identity: string;
    private playbackStatus: "Playing" | "Paused" | "Stopped" = "Stopped";
    private currentMetadata: Record<string, any> = {};
    private currentTime = 0;
    private trackDuration = 0;
    private metaChangeCallbacks: Array<() => unknown> = [];
    private statusChangeCallbacks: Array<() => unknown> = [];

    constructor(name: string, identity: string) {
        this.name = name;
        this.identity = identity;
    }

    async init(_name: string) {}
    async identityFn() {
        return this.identity;
    }
    getServerName() {
        return this.name;
    }

    play() {
        this.playbackStatus = "Playing";
        this.notifyStatusChange();
    }

    pause() {
        this.playbackStatus = "Paused";
        this.notifyStatusChange();
    }

    stop() {
        this.playbackStatus = "Stopped";
        this.notifyStatusChange();
    }

    next() {
        this.notifyMetaChange();
    }

    previous() {
        this.notifyMetaChange();
    }

    async getCurrentTime() {
        return this.currentTime;
    }
    setCurrentTime(s: number) {
        this.currentTime = s;
    }

    async metadata() {
        return this.currentMetadata;
    }
    async duration() {
        return this.trackDuration;
    }
    async paused() {
        return this.playbackStatus === "Paused" || this.playbackStatus === "Stopped";
    }
    async title() {
        return this.currentMetadata["xesam:title"] || "";
    }
    async artist() {
        return this.currentMetadata["xesam:artist"] || [];
    }
    async artCover() {
        return this.currentMetadata["mpris:artUrl"] || "";
    }

    onMetaChange(callback: () => unknown) {
        this.metaChangeCallbacks.push(callback);
    }

    onStatusChange(callback: () => unknown) {
        this.statusChangeCallbacks.push(callback);
    }

    setIdentity(identity: string) {
        this.identity = identity;
    }
    setPlaybackStatus(status: "Playing" | "Paused" | "Stopped") {
        this.playbackStatus = status;
        this.notifyStatusChange();
    }

    setMetadata(metadata: Record<string, any>) {
        this.currentMetadata = metadata;
        this.notifyMetaChange();
    }

    setDuration(duration: number) {
        this.trackDuration = duration;
    }

    private notifyMetaChange() {
        for (const cb of this.metaChangeCallbacks) {
            cb();
        }
    }

    private notifyStatusChange() {
        for (const cb of this.statusChangeCallbacks) {
            cb();
        }
    }
}

export class MockMprisManager {
    private players = new Map<string, MockMprisPlayer>();
    private emitter = createMockEventEmitter<MprisEvents>();
    private log: (...args: any[]) => void;

    constructor(log: (...args: any[]) => void) {
        this.log = log;
    }

    addPlayer(player: MockMprisPlayer) {
        this.players.set(player.getServerName(), player);
        this.emitter.emit("new-player", player as any);
    }

    removePlayer(name: string) {
        this.players.delete(name);
    }

    getPlayer(name: string) {
        return this.players.get(name);
    }

    getPlayers() {
        return Array.from(this.players.values());
    }

    createMock(): MockType<mpris> {
        const manager = this;
        return {
            async init() {
                manager.log("media.init");
            },
            on: manager.emitter.on.bind(manager.emitter),
            off: manager.emitter.off.bind(manager.emitter),
            once: manager.emitter.once.bind(manager.emitter),
            emit: manager.emitter.emit.bind(manager.emitter),
            waitFor: manager.emitter.waitFor.bind(manager.emitter),
            removeAllListeners: manager.emitter.removeAllListeners.bind(manager.emitter),
            listenerCount: manager.emitter.listenerCount.bind(manager.emitter),
            hasListeners: manager.emitter.hasListeners.bind(manager.emitter),
            respond: manager.emitter.respond.bind(manager.emitter),
            request: manager.emitter.request.bind(manager.emitter),
        };
    }
}

function createMockMedia(log: (...args: any[]) => void): MockType<mpris> {
    const manager = new MockMprisManager(log);
    return manager.createMock();
}

export class MockNotificationManager {
    private notifications = new Map<number, NotificationData>();
    private nextId = 1;
    private emitter = createMockEventEmitter<NotificationEvents>();
    private log: (...args: any[]) => void;

    constructor(log: (...args: any[]) => void) {
        this.log = log;
    }

    sendNotification(data: Omit<NotificationData, "id">): number {
        const id = data.replaces_id === 0 ? this.nextId++ : data.replaces_id;
        if (data.replaces_id === 0) this.nextId++;
        const notification: NotificationData = { ...data, id };
        this.notifications.set(id, notification);
        this.emitter.emit("new", notification);
        return id;
    }

    removeNotification(id: number) {
        this.notifications.delete(id);
    }

    clearNotifications() {
        this.notifications.clear();
    }

    getNotifications() {
        return Array.from(this.notifications.values());
    }

    getNotification(id: number) {
        return this.notifications.get(id);
    }

    createMock(): MockType<notification> {
        const manager = this;
        return {
            async init() {
                manager.log("notification.init");
            },
            on: manager.emitter.on.bind(manager.emitter),
            off: manager.emitter.off.bind(manager.emitter),
            once: manager.emitter.once.bind(manager.emitter),
            emit: manager.emitter.emit.bind(manager.emitter),
            waitFor: manager.emitter.waitFor.bind(manager.emitter),
            removeAllListeners: manager.emitter.removeAllListeners.bind(manager.emitter),
            listenerCount: manager.emitter.listenerCount.bind(manager.emitter),
            hasListeners: manager.emitter.hasListeners.bind(manager.emitter),
            respond: manager.emitter.respond.bind(manager.emitter),
            request: manager.emitter.request.bind(manager.emitter),
        };
    }
}

function createMockNotification(log: (...args: any[]) => void): MockType<notification> {
    const manager = new MockNotificationManager(log);
    return manager.createMock();
}

export class MockTrayManager {
    private items = new Map<string, MockTrayItem>();
    private log: (...args: any[]) => void;

    constructor(log: (...args: any[]) => void) {
        this.log = log;
    }

    addItem(item: MockTrayItem) {
        this.items.set(item.getPath(), item);
    }

    removeItem(path: string) {
        this.items.delete(path);
    }

    getItem(path: string) {
        return this.items.get(path);
    }

    getItems() {
        return Array.from(this.items.values());
    }

    createMock(): MockType<tray> {
        const manager = this;
        return {
            async init() {
                manager.log("tray.init");
            },
            ev: new EventEmitter<{ new: [string]; remove: [string]; menuUpdate: [] }>(),
            tarysService: manager.items as any,
        };
    }
}

function createMockTray(log: (...args: any[]) => void): MockType<tray> {
    const manager = new MockTrayManager(log);
    return manager.createMock();
}

export class MockPowerDevice {
    private path: string;
    private percentage: number;
    private state: string;
    private powerSupply: boolean;
    private type: string;
    private model: string;

    constructor(
        path: string,
        percentage = 100,
        state = "Charging",
        powerSupply = true,
        type = "Battery",
        model = "mock-battery",
    ) {
        this.path = path;
        this.percentage = percentage;
        this.state = state;
        this.powerSupply = powerSupply;
        this.type = type;
        this.model = model;
    }

    async init() {}
    async getPercentage() {
        return this.percentage;
    }
    async getState() {
        return this.state;
    }
    async getPowerSupply() {
        return this.powerSupply;
    }
    async getType() {
        return this.type;
    }
    async getModel() {
        return this.model;
    }
    getPath() {
        return this.path;
    }

    setPercentage(percentage: number) {
        this.percentage = percentage;
    }
    setState(state: string) {
        this.state = state;
    }
    setType(type: string) {
        this.type = type;
    }
    setModel(model: string) {
        this.model = model;
    }
}

export class MockPowerManager {
    private devices = new Map<string, MockPowerDevice>();
    private log: (...args: any[]) => void;

    constructor(log: (...args: any[]) => void) {
        this.log = log;
    }

    addDevice(device: MockPowerDevice) {
        this.devices.set(device.getPath(), device);
    }

    removeDevice(path: string) {
        this.devices.delete(path);
    }

    getDevice(path: string) {
        return this.devices.get(path);
    }

    createMock(): MockType<power> {
        const manager = this;
        return {
            async init() {
                manager.log("power.init");
            },
            getDevices() {
                return Array.from(manager.devices.values()) as any;
            },
        };
    }
}

function createMockPower(log: (...args: any[]) => void): MockType<power> {
    const manager = new MockPowerManager(log);
    return manager.createMock();
}

export class MockBlueDevice {
    private path: string;
    private name: string;
    private address: string;
    private connected: boolean;
    private trusted: boolean;

    constructor(path: string, name: string, address: string, connected = false, trusted = false) {
        this.path = path;
        this.name = name;
        this.address = address;
        this.connected = connected;
        this.trusted = trusted;
    }

    async init() {}
    async getName() {
        return this.name;
    }
    async getAddress() {
        return this.address;
    }
    async isConnected() {
        return this.connected;
    }
    async isTrusted() {
        return this.trusted;
    }
    async connect() {
        this.connected = true;
    }
    async disconnect() {
        this.connected = false;
    }
    async pair() {
        this.trusted = true;
    }
    async remove() {}
    getPath() {
        return this.path;
    }

    setName(name: string) {
        this.name = name;
    }
    setConnected(connected: boolean) {
        this.connected = connected;
    }
    setTrusted(trusted: boolean) {
        this.trusted = trusted;
    }
}

export class MockBlueManager {
    private devices = new Map<string, MockBlueDevice>();
    private powered = false;
    private adapterName = "mock-adapter";
    private log: (...args: any[]) => void;

    constructor(log: (...args: any[]) => void) {
        this.log = log;
    }

    addDevice(device: MockBlueDevice) {
        this.devices.set(device.getPath(), device);
    }

    removeDevice(path: string) {
        this.devices.delete(path);
    }

    getDevice(path: string) {
        return this.devices.get(path);
    }

    setPowered(powered: boolean) {
        this.powered = powered;
    }
    setAdapterName(name: string) {
        this.adapterName = name;
    }

    createMock(): MockType<blue> {
        const manager = this;
        return {
            async init() {
                manager.log("blue.init");
            },
            async isPowered() {
                return manager.powered;
            },
            async getAdapterName() {
                return manager.adapterName;
            },
            async setPowered(powered: boolean) {
                manager.log("blue.setPowered", powered);
                manager.powered = powered;
            },
            async startDiscovery() {
                manager.log("blue.startDiscovery");
            },
            async stopDiscovery() {
                manager.log("blue.stopDiscovery");
            },
            getDevices() {
                return Array.from(manager.devices.values()) as any;
            },
        };
    }
}

function createMockBlue(log: (...args: any[]) => void): MockType<blue> {
    const manager = new MockBlueManager(log);
    return manager.createMock();
}

export class MockAccessPoint {
    private path: string;
    private ssid: string;
    private strength: number;
    private frequency: number;
    private hwAddress: string;
    private maxBitrate: number;
    private active: boolean;

    constructor(
        path: string,
        ssid: string,
        strength = 80,
        frequency = 2437,
        hwAddress = "00:11:22:33:44:55",
        maxBitrate = 54000,
    ) {
        this.path = path;
        this.ssid = ssid;
        this.strength = strength;
        this.frequency = frequency;
        this.hwAddress = hwAddress;
        this.maxBitrate = maxBitrate;
        this.active = false;
    }

    async init() {}
    async getSsid() {
        return this.ssid;
    }
    async getStrength() {
        return this.strength;
    }
    async getFrequency() {
        return this.frequency;
    }
    async getHwAddress() {
        return this.hwAddress;
    }
    async getMaxBitrate() {
        return this.maxBitrate;
    }
    async isActive() {
        return this.active;
    }
    getPath() {
        return this.path;
    }

    setSsid(ssid: string) {
        this.ssid = ssid;
    }
    setStrength(strength: number) {
        this.strength = strength;
    }
    setActive(active: boolean) {
        this.active = active;
    }
}

export class MockWifiDevice {
    private path: string;
    private iface: string;
    private state: number;
    private deviceType: number;
    private accessPoints: Map<string, MockAccessPoint> = new Map();
    private activeAp: MockAccessPoint | null = null;

    constructor(path: string, iface = "wlan0", state = 30, deviceType = 2) {
        this.path = path;
        this.iface = iface;
        this.state = state;
        this.deviceType = deviceType;
    }

    async init() {}
    async getInterface() {
        return this.iface;
    }
    async getState() {
        return this.state;
    }
    async getDeviceType() {
        return this.deviceType;
    }
    async getAccessPoints() {
        return Array.from(this.accessPoints.values()) as any;
    }
    async requestScan() {}
    async getActiveAccessPoint() {
        return this.activeAp as any;
    }
    async getSavedConnections() {
        return [];
    }
    async connect(_ssid: string) {}
    async disconnect() {}
    getPath() {
        return this.path;
    }

    addAccessPoint(ap: MockAccessPoint) {
        this.accessPoints.set(ap.getPath(), ap);
    }

    removeAccessPoint(path: string) {
        this.accessPoints.delete(path);
        if (this.activeAp?.getPath() === path) {
            this.activeAp = null;
        }
    }

    setActiveAccessPoint(ap: MockAccessPoint | null) {
        this.activeAp = ap;
    }

    setState(state: number) {
        this.state = state;
    }
    setInterface(iface: string) {
        this.iface = iface;
    }
}

export class MockNetworkManager {
    private wifiDevices = new Map<string, MockWifiDevice>();
    private networkingEnabled = true;
    private wirelessEnabled = true;
    private state = 70;
    private activeConnection: {
        path: string;
        id: string;
        type: string;
        state: number;
        specificObject: string;
        devicePath: string;
    } | null = null;
    private log: (...args: any[]) => void;

    constructor(log: (...args: any[]) => void) {
        this.log = log;
    }

    addWifiDevice(device: MockWifiDevice) {
        this.wifiDevices.set(device.getPath(), device);
    }

    removeWifiDevice(path: string) {
        this.wifiDevices.delete(path);
    }

    getWifiDevice(path: string) {
        return this.wifiDevices.get(path);
    }

    setNetworkingEnabled(enabled: boolean) {
        this.networkingEnabled = enabled;
    }
    setWirelessEnabled(enabled: boolean) {
        this.wirelessEnabled = enabled;
    }
    setState(state: number) {
        this.state = state;
    }
    setActiveConnection(conn: typeof this.activeConnection) {
        this.activeConnection = conn;
    }

    createMock(): MockType<network> {
        const manager = this;
        return {
            async init() {
                manager.log("network.init");
            },
            async getActiveWifiConnection() {
                return manager.activeConnection as any;
            },
            async getState() {
                return manager.state;
            },
            async isNetworkingEnabled() {
                return manager.networkingEnabled;
            },
            async isWirelessEnabled() {
                return manager.wirelessEnabled;
            },
            async setWirelessEnabled(enabled: boolean) {
                manager.log("network.setWirelessEnabled", enabled);
                manager.wirelessEnabled = enabled;
            },
            getWifiDevices() {
                return Array.from(manager.wifiDevices.values()) as any;
            },
        };
    }
}

function createMockNetwork(log: (...args: any[]) => void): MockType<network> {
    const manager = new MockNetworkManager(log);
    return manager.createMock();
}

function createMockDisplay(log: (...args: any[]) => void): MockType<display> {
    const emitter = createMockEventEmitter<Record<string, [any]>>();
    return {
        setType(type: "desktop" | "window") {
            log("display.setType", type);
        },
        getType() {
            return "desktop" as const;
        },
        async connect(_op: { socketPath: string; mus: any }) {
            log("display.connect", _op);
        },
        async setWindowSize(_width: number, _height: number) {
            log("display.setWindowSize", _width, _height);
        },
        async renderToScreen(screenIndex: number, rect: Rect, transform?: Transform) {
            log("display.renderToScreen", screenIndex, rect, transform);
        },
        async getScreens() {
            return [];
        },
        async setInputEnabled(_enabled: boolean) {
            log("display.setInputEnabled", _enabled);
            return false;
        },
        async ping() {
            log("display.ping");
        },
        disconnect() {
            log("display.disconnect");
        },
        on: emitter.on.bind(emitter),
        off: emitter.off.bind(emitter),
        once: emitter.once.bind(emitter),
        emit: emitter.emit.bind(emitter),
        waitFor: emitter.waitFor.bind(emitter),
        removeAllListeners: emitter.removeAllListeners.bind(emitter),
        listenerCount: emitter.listenerCount.bind(emitter),
        hasListeners: emitter.hasListeners.bind(emitter),
        respond: emitter.respond.bind(emitter),
        request: emitter.request.bind(emitter),
    };
}

function createMockInput(log: (...args: any[]) => void): MockType<InputManager> {
    const emitter = createMockEventEmitter<any>();
    // myde-input 的 InputManager 基于 node:events EventEmitter（on 返回 this 等），
    // mock 用自己的 emitter 模拟事件行为，方法签名不完全一致，统一断言
    return {
        async init() {
            log("input.init");
            return { ok: true, value: undefined };
        },
        isInitialized() {
            return false;
        },
        on: emitter.on.bind(emitter),
        off: emitter.off.bind(emitter),
        once: emitter.once.bind(emitter),
        emit: emitter.emit.bind(emitter),
        waitFor: emitter.waitFor.bind(emitter),
        removeAllListeners: emitter.removeAllListeners.bind(emitter),
        listenerCount: emitter.listenerCount.bind(emitter),
        hasListeners: emitter.hasListeners.bind(emitter),
        respond: emitter.respond.bind(emitter),
        request: emitter.request.bind(emitter),
        getDevices() {
            return [];
        },
        getDevice(_path: string) {
            return undefined;
        },
        async destroy() {
            log("input.destroy");
        },
    } as unknown as MockType<InputManager>;
}

export class MockVfsStore {
    private files = new Map<string, ArrayBuffer>();
    private dirs = new Set<string>();

    addFile(path: string, content: string | ArrayBuffer) {
        if (typeof content === "string") {
            this.files.set(path, new TextEncoder().encode(content).buffer);
        } else {
            this.files.set(path, content);
        }
    }

    addTextFile(path: string, content: string) {
        this.addFile(path, content);
    }

    addBinaryFile(path: string, content: ArrayBuffer) {
        this.files.set(path, content);
    }

    removeFile(path: string) {
        this.files.delete(path);
    }

    addDir(path: string) {
        this.dirs.add(path);
    }

    clear() {
        this.files.clear();
        this.dirs.clear();
    }

    has(path: string) {
        return this.files.has(path) || this.dirs.has(path);
    }

    getContent(path: string) {
        return this.files.get(path);
    }

    getTextContent(path: string) {
        const buf = this.files.get(path);
        return buf ? new TextDecoder().decode(buf) : undefined;
    }
}

function createMockVfs(verbose: boolean, store?: MockVfsStore): MockType<DesktopApi["MSysApi"]["fs"]> {
    const log = (method: string, ...args: unknown[]) => {
        if (verbose) console.log(`[Mock:fs] ${method}`, ...args);
    };

    const fileStore = store || new MockVfsStore();

    const getMime = (p: string) => {
        const ext = p.split(".").pop()?.toLowerCase() || "";
        const mimes: Record<string, string> = {
            svg: "image/svg+xml",
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            webp: "image/webp",
            ico: "image/x-icon",
            mp3: "audio/mpeg",
            wav: "audio/wav",
            ogg: "audio/ogg",
            mp4: "video/mp4",
            webm: "video/webm",
            pdf: "application/pdf",
            zip: "application/zip",
            txt: "text/plain",
            html: "text/html",
            css: "text/css",
            js: "application/javascript",
            json: "application/json",
        };
        return mimes[ext] || "application/octet-stream";
    };

    const toBase64 = (buf: ArrayBuffer) => {
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    };

    return {
        readFile: async (p: string) => {
            log("readFile", p);
            return fileStore.getContent(p) || new ArrayBuffer(0);
        },
        readFileSync: (p: string) => {
            log("readFileSync", p);
            return fileStore.getContent(p) || new ArrayBuffer(0);
        },
        readTextFile: async (p: string) => {
            log("readTextFile", p);
            return fileStore.getTextContent(p) || "";
        },
        readTextFileSync: (p: string) => {
            log("readTextFileSync", p);
            return fileStore.getTextContent(p) || "";
        },
        readFileAsDataURL: async (p: string) => {
            log("readFileAsDataURL", p);
            const buf = fileStore.getContent(p);
            if (!buf) return `data:${getMime(p)};base64,`;
            return `data:${getMime(p)};base64,${toBase64(buf)}`;
        },
        readFileAsDataURLSync: (p: string) => {
            log("readFileAsDataURLSync", p);
            const buf = fileStore.getContent(p);
            if (!buf) return `data:${getMime(p)};base64,`;
            return `data:${getMime(p)};base64,${toBase64(buf)}`;
        },
        readFileAsBlob: async (p: string) => {
            log("readFileAsBlob", p);
            const buf = fileStore.getContent(p);
            return buf ? new Blob([buf]) : new Blob([]);
        },
        readFileAsBlobSync: (p: string) => {
            log("readFileAsBlobSync", p);
            const buf = fileStore.getContent(p);
            return buf ? new Blob([buf]) : new Blob([]);
        },
        exists: async (p: string) => {
            log("exists", p);
            return fileStore.has(p);
        },
        existsSync: (p: string) => {
            log("existsSync", p);
            return fileStore.has(p);
        },
        isFile: async (p: string) => {
            log("isFile", p);
            return fileStore.has(p) && !p.endsWith("/");
        },
        isFileSync: (p: string) => {
            log("isFileSync", p);
            return fileStore.has(p) && !p.endsWith("/");
        },
        isDirectory: async (p: string) => {
            log("isDirectory", p);
            return fileStore.has(p) && p.endsWith("/");
        },
        isDirectorySync: (p: string) => {
            log("isDirectorySync", p);
            return fileStore.has(p) && p.endsWith("/");
        },
        stat: async (p: string) => {
            log("stat", p);
            const buf = fileStore.getContent(p);
            return { size: buf?.byteLength || 0, mtime: Date.now(), isFile: !!buf, isDirectory: false };
        },
        statSync: (p: string) => {
            log("statSync", p);
            const buf = fileStore.getContent(p);
            return { size: buf?.byteLength || 0, mtime: Date.now(), isFile: !!buf, isDirectory: false };
        },
        readdir: async (_p: string) => {
            log("readdir", _p);
            return [];
        },
        readdirSync: (_p: string) => {
            log("readdirSync", _p);
            return [];
        },
        readdirWithTypes: async (_p: string) => {
            log("readdirWithTypes", _p);
            return [];
        },
    };
}

export function createMockMyde(config: MockConfig = {}): DesktopApi {
    const {
        verbose = false,
        sysApi: sysApiOverrides = {},
        inputMap: inputMapOverrides = {},
        setting: settingOverride,
        connect: connectOverride,
        vfsStore,
        blueManager,
        networkManager,
        powerManager,
        notificationManager,
        mprisManager,
        trayManager,
        volumeManager,
    } = config;

    const log = (method: string, ...args: unknown[]) => {
        if (verbose) console.log(`[Mock] ${method}`, ...args);
    };

    const defaultSysApi = {
        getDesktopEntry: async (id: string, lans?: string[]) => {
            log("getDesktopEntry", id, lans);
            return {
                name: id,
                nameLocal: id,
                comment: "",
                commentLocal: "",
                icon: "application-default-icon",
                exec: id,
                desktopFile: `${id}.desktop`,
            };
        },
        getDesktopEntries: async (lans?: string[]) => {
            log("getDesktopEntries", lans);
            return [];
        },
        getDesktopIcon: async (
            icon: string,
            _op?: { size?: number; scale?: number; theme?: string; themeBasePath?: string },
        ) => {
            log("getDesktopIcon", icon, _op);
            return icon || undefined;
        },
        refreshDesktopEntries: async (lans?: string[]) => {
            log("refreshDesktopEntries", lans);
            return [];
        },
        getEnv: () => {
            log("getEnv");
            return {
                HOME: "/home/mock",
                USER: "mock",
                XDG_RUNTIME_DIR: "/tmp/mock",
                LANG: "en_US.UTF-8",
                LANGUAGE: "en_US:en",
            };
        },
        server: (op: { dev?: boolean; render: renderTools }) => {
            log("server", op);
            const mockServer = createMockServer();

            return {
                runApp: (exec: string, xServerNum?: number) => {
                    log("runApp", exec, xServerNum);
                    return {} as any;
                },
                server: mockServer,
            } as any;
        },
        fs: createMockVfs(verbose, vfsStore),
        login: (state: "suspend" | "hibernate" | "shutdown" | "restart") => {
            log("login", state);
        },
        media: mprisManager ? mprisManager.createMock() : createMockMedia(log),
        notification: notificationManager ? notificationManager.createMock() : createMockNotification(log),
        verifyUserPassword: async (_password: string) => {
            log("verifyUserPassword");
            return false;
        },
        tray: trayManager ? trayManager.createMock() : createMockTray(log),
        power: powerManager ? powerManager.createMock() : createMockPower(log),
        blue: blueManager ? blueManager.createMock() : createMockBlue(log),
        network: networkManager ? networkManager.createMock() : createMockNetwork(log),
        volume: volumeManager ? volumeManager.createMock() : createMockVolume(log),
        display: createMockDisplay(log),
        input: createMockInput(log),
        // 统一输入事件 → 模拟 DOM 事件：真实实现无外部依赖，mock 环境直接复用
        inputSim: new inputSim(),
        appControl: {
            getPidTree: async (pid?: number): Promise<Item> => {
                log("getPidTree", pid);
                return { pid: pid || 0, ppid: 0, name: "mock", memoryUsage: 0, children: [] };
            },
            getPid: (pid: number) => {
                log("getPid", pid);
                return {
                    getPidTree: async () => ({ pid, ppid: 0, name: "mock", memoryUsage: 0, children: [] }),
                    setPriority: (priority: number) => log("setPriority", pid, priority),
                    getPriority: () => 0,
                    suspend: () => log("suspend", pid),
                    resume: () => log("resume", pid),
                    kill: () => log("kill", pid),
                };
            },
        },
    };

    const defaultInputMap: DesktopApi["MInputMap"] = {
        mapKeyCode: (code: string) => {
            log("mapKeyCode", code);
            return 0;
        },
        // abs 转换是纯函数，mock 直接复用真实实现（abs 值 → 小数）
        absRange,
        absRatio,
        absPosMapping,
    };

    const defaultSetting: DesktopApi["MSetting"] = {
        init: (_op: any) => {
            log("MSetting.init", _op);
            return createMockSettingInstance();
        },
    } as DesktopApi["MSetting"];

    const defaultConnect: DesktopApi["MConnect"] = (id: string) => {
        log("MConnect", id);
        return {} as any;
    };

    return {
        MSysApi: { ...defaultSysApi, ...sysApiOverrides },
        MInputMap: { ...defaultInputMap, ...inputMapOverrides },
        MUtils: {
            renderToolsHtmlEl: class {
                constructor() {
                    if (globalRenderTools) {
                        // biome-ignore lint/correctness/noConstructorReturn:''
                        return globalRenderTools;
                    }
                    // biome-ignore lint/correctness/noConstructorReturn:''
                    return createMockRenderTools();
                }
            } as any,
        },
        MSetting: settingOverride || defaultSetting,
        MConnect: connectOverride || defaultConnect,
    } as DesktopApi;
}

export function setupMydeMock(config: MockConfig = {}): void {
    (globalThis as any).myde = createMockMyde(config);
}

export function clearMydeMock(): void {
    delete (globalThis as any).myde;
}

export function createObservableMock(config: MockConfig = {}): {
    myde: DesktopApi;
    calls: Array<{ method: string; args: unknown[]; timestamp: number }>;
} {
    const calls: Array<{ method: string; args: unknown[]; timestamp: number }> = [];
    const originalMock = createMockMyde(config);

    const handler: ProxyHandler<any> = {
        get(target, prop, receiver) {
            const val = Reflect.get(target, prop, receiver);
            if (typeof val === "function") {
                return (...args: unknown[]) => {
                    calls.push({ method: String(prop), args, timestamp: Date.now() });
                    return val.apply(target, args);
                };
            }
            if (typeof val === "object" && val !== null) {
                return new Proxy(val, handler);
            }
            return val;
        },
    };

    return { myde: new Proxy(originalMock, handler), calls };
}
