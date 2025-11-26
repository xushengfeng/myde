const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const usocket = require("@xushengfeng/usocket") as typeof import("@xushengfeng/usocket");

import type { UServer, USocket } from "@xushengfeng/usocket";

import {
    WaylandArgType,
    type WaylandOp,
    type WaylandName,
    type WaylandObjectId,
    type WaylandProtocol,
} from "../wayland/wayland-binary";
import {
    type WaylandEnumObj,
    type WaylandEventObj,
    WaylandEventOpcode,
    type WaylandRequestObj,
} from "../wayland/wayland-types";
import { WaylandDecoder } from "../wayland/wayland-decoder";
import WaylandProtocolsJSON from "../wayland/protocols.json?raw";
const WaylandProtocolsx = JSON.parse(WaylandProtocolsJSON) as Record<string, WaylandProtocol[]>;
const WaylandProtocols = Object.fromEntries(Object.values(WaylandProtocolsx).flatMap((v) => v.map((p) => [p.name, p])));
import { WaylandEncoder } from "../wayland/wayland-encoder";

import { ele, pack, view } from "dkh-ui";
import { InputEventCodes } from "../input_codes/types";
import { createFormatTableBuffer, DRM_FORMAT } from "../wayland/dma-buf";
import { getRectKeyPoint } from "../wayland/xdg";

export { WaylandClient, WaylandServer };

type ParsedMessage = { id: WaylandObjectId; proto: WaylandProtocol; op: WaylandOp; args: Record<string, any> };

type WaylandData = {
    wl_shm_pool: { fd: number };
    wl_surface: {
        canvas: HTMLCanvasElement;
        buffer?: { id: WaylandObjectId; data: ImageData };
        buffer2?: { id: WaylandObjectId; data: ImageData };
        // 双缓冲，不过没有实际作用，只是为了日志对齐，方便调试
        bufferPointer: 0 | 1;
        damageList?: { x: number; y: number; width: number; height: number }[];
        damageBufferList?: { x: number; y: number; width: number; height: number }[];
        callback?: WaylandObjectId;
        children?: {
            id: WaylandObjectId; // wl_surface
            posi: {
                x: number;
                y: number;
            };
        }[]; // 索引大的在上面
        parentSurface?: WaylandObjectId;
        inputRegion?: WaylandData["wl_region"]["rects"];
    };
    wl_subsurface: {
        parent: WaylandObjectId; // wl_surface
        child: WaylandObjectId; // wl_surface
    };
    wl_buffer: { fd: number; start: number; end: number; imageData: ImageData };
    wl_region: {
        rects: { x: number; y: number; width: number; height: number; type: "+" | "-" }[];
    };
    xdg_surface: {
        surface: WaylandObjectId; // wl_surface
        warpEl: HTMLElement;
        xdg_role?: WaylandObjectId;
    };
    xdg_positioner: {
        size: { width: number; height: number };
        anchor_rect: { x: number; y: number; width: number; height: number };
        anchor: number;
        gravity: number;
        constraint_adjustment: number;
        offset: { x: number; y: number };
        reactive: boolean;
        parent_size: { parent_width: number; parent_height: number };
    };
    xdg_popup: {
        xdg_surface: WaylandObjectId;
        parent_xdg_surface: WaylandObjectId;
    };
    xdg_toplevel: { xdg_surface: WaylandObjectId };
    wl_data_source: { offers: string[] };
};

type WaylandObjectX<T extends keyof WaylandData> = { protocol: WaylandProtocol; data: WaylandData[T] };

interface WaylandServerEventMap {
    newClient: (client: WaylandClient, clientId: string) => void;
    clientClose: (client: WaylandClient, clientId: string) => void;
}
interface WaylandClientEventMap {
    close: () => void;
    windowCreated: (xdgToplevelId: WaylandObjectId, el: HTMLElement) => void;
    windowClosed: (xdgToplevelId: WaylandObjectId, el: HTMLElement) => void;
    windowStartMove: (xdgToplevelId: WaylandObjectId) => void;
    windowResized: (xdgToplevelId: WaylandObjectId, width: number, height: number) => void;
    windowMaximized: (xdgToplevelId: WaylandObjectId) => void;
    windowUnMaximized: (xdgToplevelId: WaylandObjectId) => void;
    copy: (text: string) => void;
    paste: () => void;
}

interface WaylandClientSyncEventMap {
    windowBound?: () => { width: number; height: number } | undefined;
}

function waylandName(name: number): WaylandName {
    return name as WaylandName;
}

function waylandObjectId<T extends number | undefined>(id: T): T extends number ? WaylandObjectId : undefined {
    if (id === undefined) {
        return undefined as any;
    }
    return id as any;
}

const waylandProtocolsNameMap = new Map<WaylandName, WaylandProtocol>();

class WaylandServer {
    private events: { [K in keyof WaylandServerEventMap]?: WaylandServerEventMap[K][] } = {};

    socketDir = "/tmp";
    socketName = "my-wayland-server-0";
    private socketPath: string;
    private server: UServer | null = null;
    clients: Map<string, WaylandClient>;
    constructor(op?: {
        socketDir?: string;
        socketName?: string;
    }) {
        if (op) {
            this.socketDir = op.socketDir || this.socketDir;
            this.socketName = op.socketName || this.socketName;
        }

        this.socketPath = path.join(this.socketDir, this.socketName);
        this.clients = new Map(); // 存储连接的客户端

        initWaylandProtocols();

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

        const client = new WaylandClient({ id: clientId, socket });
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

class WaylandClient {
    logConfig = {
        receive: true,
        send: true,
    } as {
        receive: true | string[];
        send: true | string[];
    };

    private id: string;
    private socket: USocket;
    private opa = this.newOp();
    private objects: Map<WaylandObjectId, { protocol: WaylandProtocol; data: any }>; // 客户端拥有的对象
    private protoVersions: Map<string, number> = new Map();
    private toSend: { objectId: WaylandObjectId; opcode: number; args: Record<string, any> }[] = [];
    private nextObjectId: number = 0xff000000;
    private obj2: Partial<{
        pointer: WaylandObjectId;
        keyboard: WaylandObjectId;
        focusSurface: WaylandObjectId | null;
        focusSurfaceType: "main" | "popup" | null;
        textInput: { focus: WaylandObjectId | null; m: Map<WaylandObjectId, { focus: boolean }> };
        serial: number;
        dataDevices: Set<WaylandObjectId>;
        pendingPaste: { offerId: WaylandObjectId; fd: number; mime: string; timeout: NodeJS.Timeout };
        modifiers: Set<number>;
    }> & {
        windows: Map<
            WaylandObjectId, // xdg_toplevel id
            {
                xdg_surface: WaylandObjectId;
                popups: Set<WaylandObjectId>; // xdg_popup id
                actived: boolean;
                box: {
                    width: number;
                    height: number;
                };
            }
        >;
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

    constructor({ id, socket }: { id: string; socket: USocket }) {
        this.id = id;
        this.socket = socket;
        this.objects = new Map();
        this.obj2 = { windows: new Map(), modifiers: new Set() };
        socket.on("readable", () => {
            console.log("connected");
            const x = socket.read(undefined, null);
            if (x?.data) this.handleClientMessage(x.data, x.fds);
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

    private getObject<T extends keyof WaylandData>(id: WaylandObjectId): WaylandObjectX<T> {
        const obj = this.objects.get(id);
        if (!obj) throw new Error(`Wayland object not found: ${id}`);
        return obj as WaylandObjectX<T>;
    }
    private getObjectOption<T extends keyof WaylandData>(
        id: WaylandObjectId | undefined,
    ): WaylandObjectX<T> | undefined {
        if (typeof id === "undefined") return undefined;
        const obj = this.objects.get(id);
        if (!obj) return undefined;
        return obj as WaylandObjectX<T>;
    }

    private newOp() {
        const m = new Map<string, (x: ParsedMessage & { args: any }) => void>();

        function isOp<T extends keyof WaylandRequestObj>(
            op: T,
            f: (x: ParsedMessage & { args: WaylandRequestObj[T] }) => void,
        ) {
            m.set(op, f);
        }

        isOp("wl_display.sync", (x) => {
            const callbackId = x.args.callback;
            this.sendMessageImm(waylandObjectId(1), "wl_display.delete_id", { id: callbackId });

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
            const id = x.args.id;
            const proto = waylandProtocolsNameMap.get(name);
            if (!proto) {
                console.warn(`Unknown global name: ${name}`);
                return;
            }
            this.objects.set(id, { protocol: proto, data: undefined });
            this.protoVersions.set(proto.name, x.args._version);
            console.log(`Client ${this.id} bound ${proto.name} to id ${id}`);

            // todo 添加自定义

            if (proto.name === "wl_shm") {
                this.sendMessageX(id, "wl_shm.format", {
                    format: getEnumValue("wl_shm.format", "argb8888"),
                });
                this.sendMessageX(id, "wl_shm.format", {
                    format: getEnumValue("wl_shm.format", "xrgb8888"),
                });
            }
            if (proto.name === "wl_seat") {
                this.sendMessageX(id, "wl_seat.name", { name: "seat0" });
                this.sendMessageX(id, "wl_seat.capabilities", {
                    capabilities: getEnumValue("wl_seat.capability", ["pointer", "keyboard"]),
                });
            }
            if (proto.name === "wl_output") {
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
        });
        isOp("wl_shm.create_pool", (x) => {
            const fd = x.args.fd;
            this.getObject<"wl_shm_pool">(x.args.id).data = { fd };
        });
        isOp("wl_compositor.create_surface", (x) => {
            const surfaceId = x.args.id;
            const surface = this.getObject<"wl_surface">(surfaceId);
            const canvasEl = ele("canvas");
            canvasEl.data({ id: String(surfaceId) });
            const canvas = canvasEl.el;
            canvas.width = 1;
            canvas.height = 1;
            surface.data = { canvas, bufferPointer: 0 };
        });
        isOp("wl_compositor.create_region", (x) => {
            const regionId = x.args.id;
            const region = this.getObject<"wl_region">(regionId);
            region.data = { rects: [] };
        });
        isOp("wl_shm_pool.create_buffer", (x) => {
            const thisObj = this.getObject<"wl_shm_pool">(x.id);
            const bufferId = x.args.id;
            const buffer = this.getObject<"wl_buffer">(bufferId);
            const imageData = new ImageData(x.args.width, x.args.height);
            buffer.data = {
                fd: thisObj.data.fd,
                start: x.args.offset,
                end: x.args.offset + x.args.stride * x.args.height,
                imageData: imageData,
            };
        });
        isOp("wl_shm_pool.destroy", (x) => {
            this.deleteId(x.id);
        });
        isOp("wl_surface.attach", (x) => {
            const surfaceId = x.id;
            const surface = this.getObject<"wl_surface">(surfaceId);
            const bufferId = waylandObjectId(x.args.buffer);
            if (!bufferId) return;
            const buffer = this.getObject<"wl_buffer">(bufferId);
            const imageData = buffer.data.imageData;
            if (surface.data.bufferPointer === 0) surface.data.buffer = { id: bufferId, data: imageData };
            else surface.data.buffer2 = { id: bufferId, data: imageData };
        });
        isOp("wl_surface.damage", (x) => {
            const surfaceId = x.id;
            const surface = this.getObject<"wl_surface">(surfaceId);
            const damageList = surface.data.damageList || [];
            damageList.push({
                x: x.args.x,
                y: x.args.y,
                width: x.args.width,
                height: x.args.height,
            });
            surface.data.damageList = damageList;
        });
        isOp("wl_surface.damage_buffer", (x) => {
            const surfaceId = x.id;
            const surface = this.getObject<"wl_surface">(surfaceId);
            const damageBufferList = surface.data.damageBufferList || [];
            damageBufferList.push({
                x: x.args.x,
                y: x.args.y,
                width: x.args.width,
                height: x.args.height,
            });
            surface.data.damageBufferList = damageBufferList;
        });
        isOp("wl_surface.frame", (x) => {
            const callbackId = x.args.callback;
            const surface = this.getObject<"wl_surface">(x.id);
            surface.data.callback = callbackId;
        });
        isOp("wl_surface.commit", (x) => {
            const surfaceId = x.id;
            const surface = this.getObject<"wl_surface">(surfaceId);
            const canvas = surface.data.canvas;
            // biome-ignore lint/style/noNonNullAssertion: 忽略小概率
            const ctx = canvas.getContext("2d")!;
            const buffer = surface.data.bufferPointer === 0 ? surface.data.buffer : surface.data.buffer2;
            const imagedata = buffer?.data;
            if (!imagedata) {
                console.warn("wl_surface buffer not found", surfaceId);
            } else {
                if (imagedata.width !== canvas.width || imagedata.height !== canvas.height) {
                    canvas.width = imagedata.width;
                    canvas.height = imagedata.height;
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
                            this.sendMessageX(id, "xdg_surface.configure", { serial: 1 });
                        }
                    }
                }

                const bufferX = this.getObject<"wl_buffer">(buffer.id);
                const buffern = new Uint8ClampedArray(bufferX.data.end - bufferX.data.start);
                try {
                    fs.readSync(bufferX.data.fd, buffern, bufferX.data.start, buffern.length, 0);
                } catch (error) {
                    console.error("Error reading shm buffer:", error);
                }
                // todo 搞清楚为什么给定rgb格式，读取出来是bgr格式
                const rgba = new Uint8ClampedArray(buffern.length);
                for (let i = 0; i < buffern.length; i += 4) {
                    rgba[i] = buffern[i + 2];
                    rgba[i + 1] = buffern[i + 1];
                    rgba[i + 2] = buffern[i];
                    rgba[i + 3] = buffern[i + 3];
                }
                imagedata.data.set(rgba);

                const damageList = [...(surface.data.damageList || []), ...(surface.data.damageBufferList || [])];
                // todo 有区别，但现在先不处理
                if (damageList.length) {
                    for (const damage of damageList) {
                        ctx.putImageData(
                            imagedata,
                            0,
                            0,
                            damage.x,
                            damage.y,
                            Math.min(canvas.width, damage.width),
                            Math.min(canvas.height, damage.height),
                        );
                    }
                } else {
                    ctx.putImageData(imagedata, 0, 0);
                }
            }

            surface.data.damageList = [];
            surface.data.damageBufferList = [];
            requestAnimationFrame(() => {
                const bufferId = surface.data.bufferPointer === 0 ? surface.data.buffer2?.id : surface.data.buffer?.id;
                if (bufferId) {
                    this.sendMessageImm(bufferId, "wl_buffer.release", {});
                }
                surface.data.bufferPointer = surface.data.bufferPointer === 0 ? 1 : 0;
                const x = surface.data.callback;
                if (x) {
                    this.sendMessageImm(waylandObjectId(1), "wl_display.delete_id", {
                        id: x,
                    });
                    this.sendMessageImm(x, "wl_callback.done", { callback_data: Date.now() });
                    this.objects.delete(x);
                    surface.data.callback = undefined;
                }
            });
        });
        isOp("wl_surface.destroy", (x) => {
            const surfaceId = x.id;
            const surface = this.getObject<"wl_surface">(surfaceId);
            surface.data.canvas.remove();
            const parentSurface = this.getObjectOption<"wl_surface">(surface.data.parentSurface);
            if (parentSurface) {
                parentSurface.data.children = parentSurface.data.children?.filter((i) => i.id !== surfaceId);
            }
            this.deleteId(surfaceId);
        });
        isOp("wl_surface.set_input_region", (x) => {
            const surface = this.getObject<"wl_surface">(x.id);
            console.error("re", x.args);
            const region = this.getObjectOption<"wl_region">(waylandObjectId(x.args.region));
            surface.data.inputRegion = region?.data.rects;
        });
        isOp("wl_subcompositor.get_subsurface", (x) => {
            const surfaceRelation = this.getObject<"wl_subsurface">(x.args.id);
            surfaceRelation.data = {
                parent: waylandObjectId(x.args.parent),
                child: waylandObjectId(x.args.surface),
            };

            const parent = this.getObject<"wl_surface">(waylandObjectId(x.args.parent));
            const cs = parent.data.children || [];
            cs.push({ id: waylandObjectId(x.args.surface), posi: { x: 0, y: 0 } });
            parent.data.children = cs;
            const thisChild = this.getObject<"wl_surface">(waylandObjectId(x.args.surface));
            thisChild.data.parentSurface = waylandObjectId(x.args.parent);
            // todo 渲染el可能需要分离
            // biome-ignore lint/style/noNonNullAssertion: 假装有
            parent.data.canvas.parentElement!.appendChild(thisChild.data.canvas);
            thisChild.data.canvas.style.position = "absolute";
            // @ts-expect-error
            parent.data.canvas.style.anchorName = `--${x.args.parent}`;
        });
        isOp("wl_subsurface.set_position", (x) => {
            const thisData = this.getObject<"wl_subsurface">(x.id);
            const parent = this.getObject<"wl_surface">(thisData.data.parent);
            const cs = parent.data.children;
            if (!cs) {
                console.error("No children found");
                return;
            }
            const child = cs.find((c) => c.id === thisData.data.child);
            if (!child) {
                console.error("No child found");
                return;
            }
            child.posi = { x: x.args.x, y: x.args.y };
            const thisChild = this.getObject<"wl_surface">(thisData.data.child);
            thisChild.data.canvas.style.left = `calc(anchor(--${thisData.data.parent} left) + ${x.args.x}px)`;
            thisChild.data.canvas.style.top = `calc(anchor(--${thisData.data.parent} top) + ${x.args.y}px)`;
        });

        isOp("wl_seat.get_pointer", (x) => {
            const pointerId = x.args.id;
            this.obj2.pointer = pointerId;
        });
        isOp("wl_seat.get_keyboard", (x) => {
            const keyboardId = x.args.id;
            this.obj2.keyboard = keyboardId;
            this.sendMessageX(keyboardId, "wl_keyboard.repeat_info", {
                rate: 25,
                delay: 600,
            });

            const keymapStr = fs.readFileSync(path.join(__dirname, "../../", "script/xcb", "x.xkb"), "utf-8");
            const { fd, size } = newFd(keymapStr);

            this.sendMessageX(keyboardId, "wl_keyboard.keymap", {
                format: getEnumValue("wl_keyboard.keymap_format", "xkb_v1"),
                fd: fd,
                size: size,
            });
        });
        isOp("wl_region.add", (x) => {
            const region = this.getObject<"wl_region">(x.id);
            region.data.rects.push({ ...x.args, type: "+" });
        });
        isOp("wl_region.subtract", (x) => {
            const region = this.getObject<"wl_region">(x.id);
            region.data.rects.push({ ...x.args, type: "-" });
        });
        isOp("wl_region.destroy", (x) => {
            this.deleteId(x.id);
        });
        isOp("wl_data_device_manager.create_data_source", (x) => {
            const id = x.args.id;
            const src = this.getObject<"wl_data_source">(id);
            src.data = { offers: [] };
        });
        isOp("wl_data_device_manager.get_data_device", (x) => {
            const ddId = x.args.id;
            const dataDevices = this.obj2.dataDevices || new Set<WaylandObjectId>();
            dataDevices.add(ddId);
            this.obj2.dataDevices = dataDevices;
        });
        isOp("wl_data_source.offer", (x) => {
            const src = this.getObject<"wl_data_source">(x.id);
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
        isOp("wl_data_source.destroy", (x) => {
            this.objects.delete(x.id);
        });
        isOp("wl_data_device.set_selection", (x) => {
            const srcId = waylandObjectId(x.args.source);
            if (!srcId) {
                console.log("Selection cleared");
                return;
            }

            const src = this.getObject<"wl_data_source">(srcId);
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
            const xdgSurfaceId = x.args.id;
            const xdgSurface = this.getObject<"xdg_surface">(xdgSurfaceId);
            const surfaceId = x.args.surface as WaylandObjectId;
            const el = view().style({ position: "relative" });
            xdgSurface.data = { surface: surfaceId, warpEl: el.el };
        });
        isOp("xdg_wm_base.create_positioner", (x) => {
            const thisObj = this.getObject<"xdg_positioner">(x.args.id);
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
        isOp("xdg_positioner.set_size", (x) => {
            const pData = this.getObject<"xdg_positioner">(x.id).data;
            pData.size = x.args;
        });
        isOp("xdg_positioner.set_anchor_rect", (x) => {
            const pData = this.getObject<"xdg_positioner">(x.id).data;
            pData.anchor_rect = x.args;
        });
        isOp("xdg_positioner.set_anchor", (x) => {
            const pData = this.getObject<"xdg_positioner">(x.id).data;
            pData.anchor = x.args.anchor;
        });
        isOp("xdg_positioner.set_gravity", (x) => {
            const pData = this.getObject<"xdg_positioner">(x.id).data;
            pData.gravity = x.args.gravity;
        });
        isOp("xdg_positioner.set_constraint_adjustment", (x) => {
            const pData = this.getObject<"xdg_positioner">(x.id).data;
            pData.constraint_adjustment = x.args.constraint_adjustment;
        });
        isOp("xdg_positioner.set_offset", (x) => {
            const pData = this.getObject<"xdg_positioner">(x.id).data;
            pData.offset = x.args;
        });
        isOp("xdg_positioner.set_parent_size", (x) => {
            const pData = this.getObject<"xdg_positioner">(x.id).data;
            pData.parent_size = x.args;
        });
        isOp("xdg_positioner.set_reactive", (x) => {
            const pData = this.getObject<"xdg_positioner">(x.id).data;
            pData.reactive = true;
        });
        isOp("xdg_positioner.destroy", (x) => {
            this.deleteId(x.id);
        });
        isOp("xdg_surface.get_toplevel", (x) => {
            const toplevelId = x.args.id;
            this.sendMessageImm(toplevelId, "xdg_toplevel.wm_capabilities", {
                capabilities: [
                    getEnumValue("xdg_toplevel.wm_capabilities", "minimize"),
                    getEnumValue("xdg_toplevel.wm_capabilities", "maximize"),
                ],
            });
            const outerBounds = this.emitSync("windowBound") || { width: 800, height: 600 };
            this.sendMessageX(toplevelId, "xdg_toplevel.configure_bounds", {
                width: outerBounds.width,
                height: outerBounds.height,
            });
            this.sendMessageX(x.id, "xdg_surface.configure", { serial: 1 });
            const thisXdgSurface = this.getObject<"xdg_surface">(x.id);
            const surfaceId = thisXdgSurface.data.surface;
            const el = pack(thisXdgSurface.data.warpEl);
            const surface = this.getObject<"wl_surface">(surfaceId);
            el.add(surface.data.canvas);
            thisXdgSurface.data.xdg_role = toplevelId;
            this.getObject<"xdg_toplevel">(toplevelId).data = { xdg_surface: x.id };
            this.obj2.windows.set(toplevelId, {
                xdg_surface: x.id,
                popups: new Set(),
                actived: false,
                box: {
                    width: 0,
                    height: 0,
                },
            });
            this.emit("windowCreated", toplevelId, el.el);
        });
        isOp("xdg_surface.set_window_geometry", (x) => {
            const thisXdgSurface = this.getObject<"xdg_surface">(x.id);
            const surfaceId = thisXdgSurface.data.surface;
            const surface = this.getObject<"wl_surface">(surfaceId);
            const canvas = surface.data.canvas;
            const canvasEl = pack(canvas);
            canvasEl.style({ position: "absolute", top: `-${x.args.y}px`, left: `-${x.args.x}px` });
            pack(thisXdgSurface.data.warpEl).style({
                width: `${x.args.width}px`,
                height: `${x.args.height}px`,
            });
            if (thisXdgSurface.data.xdg_role) {
                this.emit("windowResized", thisXdgSurface.data.xdg_role, x.args.width, x.args.height);
            }
        });
        isOp("xdg_surface.get_popup", (x) => {
            const thisXdgSurface = this.getObject<"xdg_surface">(x.id);
            const thisSurfaceId = thisXdgSurface.data.surface;
            const thisSurface = this.getObject<"wl_surface">(thisSurfaceId);
            const parentXdgSurfaceId = waylandObjectId(x.args.parent);
            if (!parentXdgSurfaceId) {
                console.error("No parent for popup");
                return;
            }
            const parentXdgSurface = this.getObject<"xdg_surface">(parentXdgSurfaceId);

            this.getObject<"xdg_popup">(x.args.id).data = {
                xdg_surface: x.id,
                parent_xdg_surface: parentXdgSurfaceId,
            };
            thisXdgSurface.data.xdg_role = x.args.id;
            // todo 错误处理
            // biome-ignore lint/style/noNonNullAssertion: 先不管
            const win = this.obj2.windows.get(parentXdgSurface.data.xdg_role!);
            if (win) {
                win.popups.add(x.args.id);
            } else {
                console.error(`cannt find window by xdg_surface ${parentXdgSurfaceId}`);
            }
            const thisEl = pack(thisXdgSurface.data.warpEl)
                .style({ position: "absolute" })
                .add(thisSurface.data.canvas);

            const positioner = this.getObject<"xdg_positioner">(waylandObjectId(x.args.positioner));
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

            parentXdgSurface.data.warpEl.appendChild(thisEl.el);

            // todo 给定外部处理的接口

            thisEl.style({
                left: `${Math.floor(nx)}px`,
                top: `${Math.floor(ny)}px`,
            });

            this.sendMessageX(x.args.id, "xdg_popup.configure", {
                x: Math.floor(nx),
                y: Math.floor(ny),
                width: positionerData.size.width,
                height: positionerData.size.height,
            });
            this.sendMessageX(x.id, "xdg_surface.configure", { serial: 0 });
        });
        isOp("xdg_surface.destroy", (x) => {
            this.deleteId(x.id);
        });
        isOp("xdg_popup.destroy", (x) => {
            const xdgSurfaceId = this.getObject<"xdg_popup">(x.id).data.xdg_surface;
            this.getObject<"xdg_surface">(xdgSurfaceId).data.warpEl.remove(); // todo 可以外部处理
            for (const s of this.obj2.windows.values()) {
                // todo 不用循环而是向上找到对应的window
                if (s.popups.has(x.id)) {
                    s.popups.delete(x.id);
                    break;
                }
            }
            this.sendMessageX(x.id, "xdg_popup.popup_done", {});
            this.deleteId(x.id);
        });
        isOp("xdg_toplevel.move", (x) => {
            this.emit("windowStartMove", x.id);
        });
        isOp("xdg_toplevel.set_maximized", (x) => {
            this.emit("windowMaximized", x.id);
        });
        isOp("xdg_toplevel.unset_maximized", (x) => {
            this.emit("windowUnMaximized", x.id);
        });

        isOp("xdg_toplevel.destroy", (x) => {
            const xdgSurfaceId = this.getObject<"xdg_toplevel">(x.id).data.xdg_surface;
            this.getObject<"xdg_surface">(xdgSurfaceId).data.warpEl.remove(); // todo 可以外部处理
            this.obj2.windows.delete(x.id);
            this.deleteId(x.id);
        });

        isOp("zwp_linux_dmabuf_v1.get_surface_feedback", (x) => {
            const feedbackId = x.args.id;
            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.done", {});
        });
        isOp("zwp_linux_dmabuf_v1.get_default_feedback", (x) => {
            const feedbackId = x.args.id;

            const formatTable = createFormatTableBuffer([
                { format: DRM_FORMAT.DRM_FORMAT_ARGB8888, modifier: 0n },
                { format: DRM_FORMAT.DRM_FORMAT_XRGB8888, modifier: 0n },
            ]);
            const { fd } = newFd(new Uint8Array(formatTable.buffer));
            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.format_table", {
                fd: fd,
                size: formatTable.byteLength,
            });

            const r = fs.statSync("/dev/dri/card1"); // todo
            const buffer = Buffer.alloc(8);
            buffer.writeBigUInt64LE(BigInt(r.rdev));
            const a = Array.from(new Uint8Array(buffer.buffer));
            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.main_device", { device: a });
            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.tranche_target_device", {
                device: a,
            });
            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.tranche_done", {});

            this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.done", {});
        });

        isOp("zwp_text_input_manager_v1.create_text_input", (x) => {
            const textInputId = x.args.id;
            if (!this.obj2.textInput) this.obj2.textInput = { focus: null, m: new Map() };
            this.obj2.textInput.m.set(textInputId, { focus: false });
        });
        isOp("zwp_text_input_v1.activate", (x) => {
            this.sendMessageX(x.id, "zwp_text_input_v1.enter", { surface: x.args.surface });
            if (!this.obj2.textInput) return;
            // biome-ignore lint/style/noNonNullAssertion: 假装有 // todo
            this.obj2.textInput.m.get(x.id)!.focus = true;
            // biome-ignore lint/style/noNonNullAssertion: 上面已经保证了
            for (const [k, v] of this.obj2.textInput!.m) {
                if (k !== x.id && v.focus) {
                    this.sendMessageX(k, "zwp_text_input_v1.leave", {});
                    v.focus = false;
                }
            }
        });
        isOp("zwp_text_input_v1.deactivate", (x) => {
            if (this.obj2.textInput?.m.get(x.id)?.focus !== true) {
                return;
            }
            this.sendMessageX(x.id, "zwp_text_input_v1.leave", {});
            if (!this.obj2.textInput) return;
            // biome-ignore lint/style/noNonNullAssertion: 假装有 // todo
            this.obj2.textInput.m.get(x.id)!.focus = false;
        });

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
        // 解析并处理客户端消息
        const decoder = new WaylandDecoder(data.buffer, fds);

        this.receiveLog(`Parsed data from client ${this.id}:`, data.buffer, fds);
        this.toSend = [];
        while (decoder.getRemainingBytes() > 0) {
            const header = decoder.readHeader();
            const _x = getX(this.objects, "request", header.objectId, header.opcode);
            if (!_x) {
                console.warn(`Unknown objectId/opcode: ${header.objectId}/${header.opcode}`, data.buffer);
                return;
            }
            const args = parseArgs(decoder, _x.op.args);
            const rest = decoder.final();
            this.receiveLog(
                `Parsed args for ${_x.proto.name}#${header.objectId}.${_x.op.name}:`,
                args,
                Object.fromEntries(_x.op.args.filter((a) => a.interface).map((i) => [i.name, i.interface])),
            );
            if (rest.length) console.log("rest", rest);

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

            if (!useOp) {
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
            const dataOfferId = this.allocateObjectId();
            this.objects.set(dataOfferId, { protocol: WaylandProtocols.wl_data_offer, data: {} });

            this.sendMessageImm(ddId, "wl_data_device.data_offer", { id: dataOfferId });
            this.sendMessageImm(dataOfferId, "wl_data_offer.offer", { mime_type: "text/plain;charset=utf-8" });
            this.sendMessageImm(dataOfferId, "wl_data_offer.offer", { mime_type: "text/plain" });
            this.sendMessageImm(ddId, "wl_data_device.selection", { id: dataOfferId });
        }
    }
    private sendMessageImm<T extends keyof WaylandEventObj>(
        objectId: WaylandObjectId,
        op: T,
        args: WaylandEventObj[T],
    ) {
        this.sendMessage(objectId, WaylandEventOpcode[op.replace(".", "__")], args);
    }
    private sendMessageX<T extends keyof WaylandEventObj>(objectId: WaylandObjectId, op: T, args: WaylandEventObj[T]) {
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
                    {
                        const u32 = new Uint32Array(argValue);
                        encoder.writeArray(new Uint8Array(u32.buffer));
                    }
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
    private deleteId(id: WaylandObjectId) {
        this.sendMessageX(waylandObjectId(1), "wl_display.delete_id", { id });
        this.objects.delete(id);
    }

    getWindows() {
        return this.obj2.windows;
    }
    private configureWin(
        winid: WaylandObjectId,
        win: typeof this.obj2.windows extends Map<infer _K, infer V> ? V : never,
    ) {
        const s: number[] = [];
        if (win.actived) s.push(getEnumValue("xdg_toplevel.state", "activated"));
        this.sendMessageImm(winid, "xdg_toplevel.configure", {
            width: win.box.width,
            height: win.box.height,
            states: s,
        });
        this.sendMessageImm(win.xdg_surface, "xdg_surface.configure", { serial: 1 });
    }
    win(id: WaylandObjectId) {
        const win = this.obj2.windows.get(id);
        if (win === undefined) return undefined;
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
                    states: [
                        getEnumValue("xdg_toplevel.state", "activated"),
                        getEnumValue("xdg_toplevel.state", "maximized"),
                    ],
                });
                this.sendMessageImm(win.xdg_surface, "xdg_surface.configure", { serial: 1 });
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
                rootWinEl: () => {
                    const rootSurfaceId = win.xdg_surface;
                    const rootSurface = this.getObject<"xdg_surface">(rootSurfaceId);
                    return rootSurface.data.warpEl;
                },
                inWin: (p: { x: number; y: number }) => {
                    const rootSurfaceId = win.xdg_surface;
                    const rootSurface = this.getObject<"xdg_surface">(rootSurfaceId);
                    const rect = rootSurface.data.warpEl.getBoundingClientRect(); // todo 缓存
                    // todo popup
                    if (p.x < rect.left || p.x >= rect.right || p.y < rect.top || p.y >= rect.bottom) return false;
                    return true; // todo
                },
                updatePointerFocus: (p: { x: number; y: number }) => {
                    if (!this.obj2.pointer) return;
                    const { x, y } = p;
                    let nx = x;
                    let ny = y;
                    let canSend = false;
                    let inXdgSurface: WaylandObjectId | undefined;
                    let reasonSurfaceType: "main" | "popup" | null = null;
                    const {
                        x: baseX,
                        y: baseY,
                        bottom: baseBottom,
                        right: baseRight,
                    } = winObj.point.rootWinEl().getBoundingClientRect();
                    // todo zindex
                    for (const p of Array.from(win.popups).toReversed()) {
                        const popup = this.getObject<"xdg_popup">(p);
                        const popupSurface = this.getObject<"xdg_surface">(popup.data.xdg_surface);
                        const rect = popupSurface.data.warpEl.getBoundingClientRect();
                        const offsetX = rect.left - baseX;
                        const offsetY = rect.top - baseY;
                        const offsetX1 = rect.right - baseX;
                        const offsetY1 = rect.bottom - baseY;
                        if (x >= offsetX && x < offsetX1 && y >= offsetY && y < offsetY1) {
                            console.log(`pointer in popup surface ${popup.data.xdg_surface}`);
                            inXdgSurface = popup.data.xdg_surface;
                            reasonSurfaceType = "popup";
                            break;
                        }
                    }
                    if (!inXdgSurface) {
                        if (0 < x && x < baseRight - baseX && 0 < y && y < baseBottom - baseY) {
                            inXdgSurface = win.xdg_surface;
                            reasonSurfaceType = "main";
                        } else {
                            return undefined;
                        }
                    }
                    const surfaces: WaylandObjectId[] = [];
                    const mainSurfaceId = this.getObject<"xdg_surface">(inXdgSurface).data.surface;
                    surfaces.push(mainSurfaceId);
                    const mainSurface = this.getObject<"wl_surface">(mainSurfaceId);
                    if (mainSurface.data.children) {
                        // todo 遍历树
                        for (const c of mainSurface.data.children) {
                            surfaces.push(c.id);
                        }
                    }
                    for (const s of surfaces.toReversed()) {
                        const cs = this.getObject<"wl_surface">(s).data.canvas;
                        // todo 缓存
                        const rect = cs.getBoundingClientRect();
                        const offsetX = rect.left - baseX;
                        const offsetY = rect.top - baseY;
                        const offsetX1 = rect.right - baseX;
                        const offsetY1 = rect.bottom - baseY;
                        if (x >= offsetX && x < offsetX1 && y >= offsetY && y < offsetY1) {
                            console.log(`pointer in surface ${s}`);
                            nx = x - offsetX;
                            ny = y - offsetY;
                            // todo input region
                            // const surfaceInputRegion = this.getObject<"wl_surface">(s).data.inputRegion;
                            // if (surfaceInputRegion) {
                            //     for (const r of surfaceInputRegion) {
                            //         if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
                            //             if (r.type === "+") {
                            //                 canSend = true;
                            //             } else {
                            //                 canSend = false;
                            //                 break;
                            //             }
                            //         }
                            //     }
                            // } else canSend = true;
                            canSend = true;
                            if (this.obj2.focusSurface !== s) {
                                if (this.obj2.focusSurface && this.objects.has(this.obj2.focusSurface)) {
                                    this.sendMessageImm(this.obj2.pointer, "wl_pointer.leave", {
                                        serial: 0,
                                        surface: this.obj2.focusSurface,
                                    });
                                    if (this.obj2.focusSurfaceType === "main" && reasonSurfaceType === "main")
                                        this.keyboard.blurSurface(this.obj2.focusSurface); // todo popup
                                }
                                this.sendMessageImm(this.obj2.pointer, "wl_pointer.enter", {
                                    serial: 0,
                                    surface: s,
                                    surface_x: nx,
                                    surface_y: ny,
                                });
                                this.sendMessageImm(this.obj2.pointer, "wl_pointer.frame", {});
                                if (
                                    (this.obj2.focusSurfaceType === "main" || !this.obj2.focusSurfaceType) &&
                                    reasonSurfaceType === "main"
                                )
                                    this.keyboard.focusSurface(s);
                                this.obj2.focusSurface = s;
                                this.obj2.focusSurfaceType = reasonSurfaceType;
                            }
                            break;
                        }
                    }
                    if (!canSend) return undefined;
                    return { x: nx, y: ny };
                },
                sendPointerEvent: (type: "move" | "down" | "up", p: PointerEvent) => {
                    if (!this.obj2.pointer) return;
                    const pos = winObj.point.updatePointerFocus({ x: p.x, y: p.y });
                    if (!pos) return;
                    const { x: nx, y: ny } = pos;
                    if (type === "move") {
                        this.sendMessageImm(this.obj2.pointer, "wl_pointer.motion", {
                            time: Date.now(),
                            surface_x: nx,
                            surface_y: ny,
                        });
                        this.sendMessageImm(this.obj2.pointer, "wl_pointer.frame", {});
                    }
                    if (type === "down") {
                        this.sendMessageImm(this.obj2.pointer, "wl_pointer.button", {
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
                        this.sendMessageImm(this.obj2.pointer, "wl_pointer.frame", {});
                    }
                    if (type === "up") {
                        this.sendMessageImm(this.obj2.pointer, "wl_pointer.button", {
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
                        this.sendMessageImm(this.obj2.pointer, "wl_pointer.frame", {});
                    }
                },
                sendScrollEvent: (op: { p: WheelEvent }) => {
                    const { p } = op;
                    if (!this.obj2.pointer) return;
                    // todo region
                    const { deltaX, deltaY } = p;
                    if (deltaX !== 0) {
                        this.sendMessageImm(this.obj2.pointer, "wl_pointer.axis", {
                            time: Date.now(),
                            axis: getEnumValue("wl_pointer.axis", "horizontal_scroll"),
                            value: deltaX,
                        });
                    }
                    if (deltaY !== 0) {
                        this.sendMessageImm(this.obj2.pointer, "wl_pointer.axis", {
                            time: Date.now(),
                            axis: getEnumValue("wl_pointer.axis", "vertical_scroll"),
                            value: deltaY,
                        });
                    }
                    this.sendMessageImm(this.obj2.pointer, "wl_pointer.frame", {});
                },
            },
        };
        return winObj;
    }
    keyboard = {
        // todo Surface管理
        focusSurface: (id: WaylandObjectId) => {
            if (!this.obj2.keyboard) return;
            this.sendMessageImm(this.obj2.keyboard, "wl_keyboard.enter", { serial: 0, surface: id, keys: [] });
            this.sendMessageImm(this.obj2.keyboard, "wl_keyboard.modifiers", {
                serial: 0,
                mods_depressed: 0,
                mods_latched: 0,
                mods_locked: 0,
                group: 0,
            });
        },
        blurSurface: (id: WaylandObjectId) => {
            if (!this.obj2.keyboard) return;
            this.sendMessageImm(this.obj2.keyboard, "wl_keyboard.leave", { serial: 0, surface: id });
        },
        sendKey: (key: number, state: "pressed" | "released") => {
            if (!this.obj2.keyboard) return;
            const s = this.obj2.serial ?? 1;
            this.obj2.serial = s + 2;
            this.sendMessageImm(this.obj2.keyboard, "wl_keyboard.key", {
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
            if (bit !== undefined && this.obj2.modifiers) {
                if (isPressed) this.obj2.modifiers.add(bit);
                else this.obj2.modifiers.delete(bit);

                const mods_depressed = this.computeModsDepressed();
                const mods_latched = 0; // todo not tracking latched in this implementation
                const mods_locked = 0; // todo not tracking locked separately here

                this.sendMessageImm(this.obj2.keyboard, "wl_keyboard.modifiers", {
                    serial: s,
                    mods_depressed,
                    mods_latched,
                    mods_locked,
                    group: 0,
                });
            }
        },
    };

    private computeModsDepressed(): number {
        if (!this.obj2.modifiers) return 0;
        let mask = 0;
        for (const b of this.obj2.modifiers) {
            mask |= 1 << b;
        }
        return mask;
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
        for (const win of this.obj2.windows.values()) {
            const xdgSurface = this.getObject<"xdg_surface">(win.xdg_surface);
            xdgSurface.data.warpEl.remove();
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

function getEnumValue<T extends keyof WaylandEnumObj>(enumName: T, value: WaylandEnumObj[T] | WaylandEnumObj[T][]) {
    const [pName, enumN] = enumName.split(".");
    const proto = WaylandProtocols[pName];
    if (!proto) throw new Error(`Protocol ${pName} cannot find`);
    if (!proto.enum) throw new Error(`Protocol ${proto.name} has no enums`);
    const e = proto.enum.find((e) => e.name === enumN);
    if (!e) throw new Error(`Enum ${enumN} not found in protocol ${proto.name}`);
    if (Array.isArray(value)) {
        if (e.bitfield) {
            const b = value.map((i) => e.enum[i]).reduce((acc, curr) => acc | curr, 0);
            return b;
        } else {
            throw new Error(`Enum ${enumName} is not a bitfield`);
        }
    } else {
        const entry = e.enum[value];
        if (entry === undefined) throw new Error(`Value ${value} not found in enum ${enumName}`);
        return entry;
    }
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
