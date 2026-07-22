import type { DesktopApi } from "../../src/desktop-api";
import { EventEmitter } from "../../src/event-emitter/event-emitter";
import type { Item } from "../../src/sys_api/app_control";
import type { tray } from "../../src/sys_api/appIndicator";
import type { blue } from "../../src/sys_api/blue";
import type { display } from "../../src/sys_api/display";
import type { InputManager } from "../../src/sys_api/input";
import type { MprisEvents, mpris } from "../../src/sys_api/mpris";
import type { network } from "../../src/sys_api/network";
import type { NotificationEvents, notification } from "../../src/sys_api/notification";
import type { power } from "../../src/sys_api/power";
import type { renderTools, renderToolsOn } from "../../src/wayland/render_tools";
import type { MockRenderTools } from "./render-tools";

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

export interface MockWaylandClient {
    getWindows(): Map<string, MockWaylandWindow>;
    win(id: string): MockWaylandWindow | undefined;
    getAppid(): string;
    setAppid(appid: string): void;
    setLogConfig(config: { receive: string[]; send: string[] }): void;
    on(event: string, cb: (...args: any[]) => void): MockWaylandClient;
    onSync(event: string, cb: (...args: any[]) => any): MockWaylandClient;
    emit(event: string, ...args: any[]): void;
    keyboard: {
        sendKey(code: number, state: string): void;
    };
    pointer: {
        sendMove(x: number, y: number): void;
        sendButton(button: number, state: string): void;
    };
    close(): void;
}

export interface MockWaylandServer {
    socketDir: string;
    socketName: string;
    clients: Map<number, MockWaylandClient>;
    on(event: string, cb: (...args: any[]) => void): MockWaylandServer;
    off(event: string, cb: (...args: any[]) => void): MockWaylandServer;
    emit(event: string, ...args: any[]): void;
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
    };
}

export function createMockClient(): MockWaylandClient {
    const windows = new Map<string, MockWaylandWindow>();
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    let appid = "";

    const client: MockWaylandClient = {
        getWindows: () => windows,
        win: (id: string) => windows.get(id),
        getAppid: () => appid,
        setAppid: (id: string) => {
            appid = id;
            // 触发appid事件
            listeners.get("appid")?.forEach((cb) => cb(id));
        },
        setLogConfig: (_config) => {},
        on(event: string, cb: (...args: any[]) => void) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)?.add(cb);
            return client;
        },
        onSync(event: string, cb: (...args: any[]) => any) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)?.add(cb);
            return client;
        },
        emit(event: string, ...args: any[]) {
            // biome-ignore  lint/suspicious/useIterableCallbackReturn:''
            listeners.get(event)?.forEach((cb) => cb(...args));
        },
        keyboard: {
            sendKey: (_code, _state) => {},
        },
        pointer: {
            sendMove: (_x, _y) => {},
            sendButton: (_button, _state) => {},
        },
        close() {
            // 触发close事件
            listeners.get("close")?.forEach((cb) => cb());
            windows.clear();
            listeners.clear();
        },
    };
    return client;
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

function createMockMedia(log: (...args: any[]) => void): MockType<mpris> {
    const emitter = createMockEventEmitter<MprisEvents>();
    return {
        async init() {
            log("media.init");
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

function createMockNotification(log: (...args: any[]) => void): MockType<notification> {
    const emitter = createMockEventEmitter<NotificationEvents>();
    return {
        async init() {
            log("notification.init");
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

function createMockTray(log: (...args: any[]) => void): MockType<tray> {
    return {
        async init() {
            log("tray.init");
        },
        tarysService: new Map(),
    };
}

function createMockPower(log: (...args: any[]) => void): MockType<power> {
    return {
        async init() {
            log("power.init");
        },
        getDevices() {
            return [];
        },
    };
}

function createMockBlue(log: (...args: any[]) => void): MockType<blue> {
    return {
        async init() {
            log("blue.init");
        },
        async isPowered() {
            return false;
        },
        async getAdapterName() {
            return "mock-adapter";
        },
        async setPowered(_powered: boolean) {
            log("blue.setPowered", _powered);
        },
        async startDiscovery() {
            log("blue.startDiscovery");
        },
        async stopDiscovery() {
            log("blue.stopDiscovery");
        },
        getDevices() {
            return [];
        },
    };
}

function createMockNetwork(log: (...args: any[]) => void): MockType<network> {
    return {
        async init() {
            log("network.init");
        },
        async getActiveWifiConnection() {
            return null;
        },
        async getState() {
            return 0;
        },
        async isNetworkingEnabled() {
            return true;
        },
        async isWirelessEnabled() {
            return true;
        },
        async setWirelessEnabled(_enabled: boolean) {
            log("network.setWirelessEnabled", _enabled);
        },
        getWifiDevices() {
            return [];
        },
    };
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
        async renderToScreen(_screenIndex: number, _rects: any[], _transforms?: any[]) {
            log("display.renderToScreen", _screenIndex, _rects, _transforms);
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
    return {
        async init() {
            log("input.init");
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
        destroy() {
            log("input.destroy");
        },
    };
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
            const clients = new Map<number, MockWaylandClient>();
            const listeners = new Map<string, Set<(...args: any[]) => void>>();

            const mockServer: MockWaylandServer = {
                socketDir: "/tmp/mock",
                socketName: "mock-socket",
                clients,
                on(event: string, cb: (...args: any[]) => void) {
                    if (!listeners.has(event)) listeners.set(event, new Set());
                    listeners.get(event)?.add(cb);
                    return mockServer;
                },
                off(event: string, cb: (...args: any[]) => void) {
                    listeners.get(event)?.delete(cb);
                    return mockServer;
                },
                emit(event: string, ...args: any[]) {
                    // biome-ignore  lint/suspicious/useIterableCallbackReturn:''
                    listeners.get(event)?.forEach((cb) => cb(...args));
                },
                destroy() {
                    log("server.destroy");
                    clients.clear();
                    listeners.clear();
                },
            };

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
        media: createMockMedia(log),
        notification: createMockNotification(log),
        verifyUserPassword: async (_password: string) => {
            log("verifyUserPassword");
            return false;
        },
        tray: createMockTray(log),
        power: createMockPower(log),
        blue: createMockBlue(log),
        network: createMockNetwork(log),
        display: createMockDisplay(log),
        input: createMockInput(log),
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
