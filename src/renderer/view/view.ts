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

import { ele, view } from "dkh-ui";
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
            id: WaylandObjectId;
            posi: {
                x: number;
                y: number;
            };
        }[]; // 索引大的在上面
        childrenEl?: HTMLElement;
    };
    wl_subsurface: {
        parent: WaylandObjectId;
        child: WaylandObjectId;
    };
    wl_buffer: { fd: number; start: number; end: number; imageData: ImageData };
    xdg_surface: { surface: WaylandObjectId; xdg_role?: WaylandObjectId };
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
    };
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
    private id: string;
    private socket: USocket;
    private objects: Map<WaylandObjectId, { protocol: WaylandProtocol; data: any }>; // 客户端拥有的对象
    private protoVersions: Map<string, number> = new Map();
    private toSend: { objectId: WaylandObjectId; opcode: number; args: Record<string, any>; fds?: number[] }[] = [];
    private obj2: Partial<{
        pointer: WaylandObjectId;
        keyboard: WaylandObjectId;
        focusSurface: WaylandObjectId | null;
        textInput: { focus: WaylandObjectId | null; m: Map<WaylandObjectId, { focus: boolean }> };
        serial: number;
    }> & {
        windows: Map<
            WaylandObjectId, // xdg_toplevel id
            {
                root: WaylandObjectId; // wl_surface id
                xdg_surface: WaylandObjectId;
                children: Set<WaylandObjectId>; // wl_surface id
                actived: boolean;
            }
        >;
        surfaces: { id: WaylandObjectId; el: HTMLCanvasElement }[];
    } & Record<string, any>;
    // 事件存储
    private events: { [K in keyof WaylandClientEventMap]?: WaylandClientEventMap[K][] } = {};

    constructor({ id, socket }: { id: string; socket: USocket }) {
        this.id = id;
        this.socket = socket;
        this.objects = new Map();
        this.obj2 = { surfaces: [], windows: new Map() };
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

    // 注册事件
    public on<K extends keyof WaylandClientEventMap>(event: K, handler: WaylandClientEventMap[K]): void {
        if (!this.events[event]) this.events[event] = [];
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

    private handleClientMessage(data: Buffer, fds: number[] = []) {
        // 解析并处理客户端消息
        const decoder = new WaylandDecoder(data.buffer, fds);

        let useOp = false;
        function isOp<T extends keyof WaylandRequestObj>(
            x: ParsedMessage,
            op: T,
            f: (x: ParsedMessage & { args: WaylandRequestObj[T] }) => void,
        ) {
            const [proto, name] = op.split(".");
            if (x.proto.name === proto && x.op.name === name) {
                f(x as ParsedMessage & { args: WaylandRequestObj[T] });
                useOp = true;
                return true;
            }
            return false;
        }

        console.log(`Parsed data from client ${this.id}:`, data.buffer, fds);
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
            console.log(
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

                    console.log(`Client ${this.id} created ${v.interface} with id ${id}`);
                }
            }

            const x = { proto: _x.proto, op: _x.op, args, id: header.objectId };
            isOp(x, "wl_display.sync", (x) => {
                const callbackId = x.args.callback;
                this.sendMessageImm(waylandObjectId(1), "wl_display.delete_id", { id: callbackId });

                this.sendMessageX(callbackId, "wl_callback.done", { callback_data: 0 });
            });
            isOp(x, "wl_display.get_registry", (x) => {
                const registryId = x.args.registry;
                for (const [i, proto] of waylandProtocolsNameMap) {
                    this.sendMessageX(registryId, "wl_registry.global", {
                        name: i,
                        interface: proto.name,
                        version: proto.version,
                    });
                }
            });
            isOp(x, "wl_registry.bind", (x) => {
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
            isOp(x, "wl_shm.create_pool", (x) => {
                const fd = x.args.fd;
                this.getObject<"wl_shm_pool">(x.args.id).data = { fd };
            });
            isOp(x, "wl_compositor.create_surface", (x) => {
                const surfaceId = x.args.id;
                const surface = this.getObject<"wl_surface">(surfaceId);
                const canvasEl = ele("canvas");
                canvasEl.data({ id: String(surfaceId) });
                const canvas = canvasEl.el;
                canvas.width = 1;
                canvas.height = 1;
                this.obj2.surfaces.push({ id: surfaceId, el: canvas });
                surface.data = { canvas, bufferPointer: 0 };
            });
            isOp(x, "wl_shm_pool.create_buffer", (x) => {
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
            isOp(x, "wl_shm_pool.destroy", (x) => {
                this.deleteId(x.id);
            });
            isOp(x, "wl_region.destroy", (x) => {
                this.deleteId(x.id);
            });
            isOp(x, "wl_surface.attach", (x) => {
                const surfaceId = x.id;
                const surface = this.getObject<"wl_surface">(surfaceId);
                const bufferId = waylandObjectId(x.args.buffer);
                if (!bufferId) return;
                const buffer = this.getObject<"wl_buffer">(bufferId);
                const imageData = buffer.data.imageData;
                if (surface.data.bufferPointer === 0) surface.data.buffer = { id: bufferId, data: imageData };
                else surface.data.buffer2 = { id: bufferId, data: imageData };
            });
            isOp(x, "wl_surface.damage", (x) => {
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
            isOp(x, "wl_surface.damage_buffer", (x) => {
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
            isOp(x, "wl_surface.frame", (x) => {
                const callbackId = x.args.callback;
                const surface = this.getObject<"wl_surface">(x.id);
                surface.data.callback = callbackId;
            });
            isOp(x, "wl_surface.commit", (x) => {
                const surfaceId = x.id;
                const surface = this.getObject<"wl_surface">(surfaceId);
                const canvas = surface.data.canvas;
                const ctx = canvas.getContext("2d")!;
                const buffer = surface.data.bufferPointer === 0 ? surface.data.buffer : surface.data.buffer2;
                const imagedata = buffer?.data;
                if (!imagedata) {
                    console.warn("wl_surface buffer not found", surfaceId);
                } else {
                    if (imagedata.width !== canvas.width || imagedata.height !== canvas.height) {
                        canvas.width = imagedata.width;
                        canvas.height = imagedata.height;
                        for (const [id, p] of this.objects) {
                            if (p.protocol.name === "xdg_toplevel") {
                                // this.sendMessage(id, 0, {
                                //     width: canvas.width,
                                //     height: canvas.height,
                                //     states: new Uint8Array([
                                //         WaylandProtocols.xdg_toplevel.enum![2].enum.resizing,
                                //         WaylandProtocols.xdg_toplevel.enum![2].enum.activated,
                                //     ]),
                                // });
                                // todo 考虑实际窗口的几何，否则有外边框的会变大
                            }
                        }
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
                    const bufferId =
                        surface.data.bufferPointer === 0 ? surface.data.buffer2?.id : surface.data.buffer?.id;
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
            isOp(x, "wl_surface.destroy", (x) => {
                const surfaceId = x.id;
                const surface = this.getObject<"wl_surface">(surfaceId);
                surface.data.canvas.remove();
                this.obj2.surfaces = this.obj2.surfaces.filter((s) => s.id !== surfaceId);
                this.deleteId(surfaceId);
            });
            isOp(x, "wl_subcompositor.get_subsurface", (x) => {
                const surfaceRelation = this.getObject<"wl_subsurface">(x.args.id);
                surfaceRelation.data = {
                    parent: waylandObjectId(x.args.parent),
                    child: waylandObjectId(x.args.surface),
                };

                const parent = this.getObject<"wl_surface">(waylandObjectId(x.args.parent));
                const cs = parent.data.children || [];
                cs.push({ id: waylandObjectId(x.args.surface), posi: { x: 0, y: 0 } });
                parent.data.children = cs;
                for (const [_, w] of this.obj2.windows) {
                    // todo 如果先绑定小的，在一起绑定大的，会找不到，除非协议规定必须先绑定大的
                    if (w.children.has(waylandObjectId(x.args.parent))) {
                        w.children.add(waylandObjectId(x.args.surface));
                        break;
                    }
                }
                const thisChild = this.getObject<"wl_surface">(waylandObjectId(x.args.surface));
                parent.data.canvas.parentElement!.appendChild(thisChild.data.canvas);
                thisChild.data.canvas.style.position = "absolute";
                // @ts-expect-error
                parent.data.canvas.style.anchorName = `--${x.args.parent}`;
            });
            isOp(x, "wl_subsurface.set_position", (x) => {
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

            isOp(x, "wl_seat.get_pointer", (x) => {
                const pointerId = x.args.id;
                this.obj2.pointer = pointerId;
            });
            isOp(x, "wl_seat.get_keyboard", (x) => {
                const keyboardId = x.args.id;
                this.obj2.keyboard = keyboardId;
                this.sendMessageX(keyboardId, "wl_keyboard.repeat_info", {
                    rate: 25,
                    delay: 600,
                });

                const keymapStr = fs.readFileSync(path.join(__dirname, "../../", "script/xcb", "x.xkb"), "utf-8");
                const { fd, size } = newFd(keymapStr);

                this.sendMessageX(
                    keyboardId,
                    "wl_keyboard.keymap",
                    {
                        format: getEnumValue("wl_keyboard.keymap_format", "xkb_v1"),
                        fd: 0,
                        size: size,
                    },
                    [fd],
                );
            });

            isOp(x, "xdg_wm_base.get_xdg_surface", (x) => {
                const xdgSurfaceId = x.args.id;
                const xdgSurface = this.getObject<"xdg_surface">(xdgSurfaceId);
                const surfaceId = x.args.surface as WaylandObjectId;
                xdgSurface.data = { surface: surfaceId };
            });
            isOp(x, "xdg_wm_base.create_positioner", (x) => {
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
            isOp(x, "xdg_positioner.set_size", (x) => {
                const pData = this.getObject<"xdg_positioner">(x.id).data;
                pData.size = x.args;
            });
            isOp(x, "xdg_positioner.set_anchor_rect", (x) => {
                const pData = this.getObject<"xdg_positioner">(x.id).data;
                pData.anchor_rect = x.args;
            });
            isOp(x, "xdg_positioner.set_anchor", (x) => {
                const pData = this.getObject<"xdg_positioner">(x.id).data;
                pData.anchor = x.args.anchor;
            });
            isOp(x, "xdg_positioner.set_gravity", (x) => {
                const pData = this.getObject<"xdg_positioner">(x.id).data;
                pData.gravity = x.args.gravity;
            });
            isOp(x, "xdg_positioner.set_constraint_adjustment", (x) => {
                const pData = this.getObject<"xdg_positioner">(x.id).data;
                pData.constraint_adjustment = x.args.constraint_adjustment;
            });
            isOp(x, "xdg_positioner.set_offset", (x) => {
                const pData = this.getObject<"xdg_positioner">(x.id).data;
                pData.offset = x.args;
            });
            isOp(x, "xdg_positioner.set_parent_size", (x) => {
                const pData = this.getObject<"xdg_positioner">(x.id).data;
                pData.parent_size = x.args;
            });
            isOp(x, "xdg_positioner.set_reactive", (x) => {
                const pData = this.getObject<"xdg_positioner">(x.id).data;
                pData.reactive = true;
            });
            isOp(x, "xdg_surface.get_toplevel", (x) => {
                const toplevelId = x.args.id;
                this.sendMessageX(toplevelId, "xdg_toplevel.configure_bounds", { width: 1920, height: 1080 });
                for (const [id, p] of this.objects) {
                    if (p.protocol.name === "xdg_surface") {
                        this.sendMessageX(id, "xdg_surface.configure", { serial: 1 }); // todo
                    }
                }
                const el = view().style({ position: "relative" });
                const surfaceId = this.getObject<"xdg_surface">(x.id).data.surface;
                const surface = this.getObject<"wl_surface">(surfaceId);
                el.add(surface.data.canvas);
                this.getObject<"xdg_surface">(x.id).data.xdg_role = toplevelId;
                this.obj2.windows.set(toplevelId, {
                    root: surfaceId,
                    xdg_surface: x.id,
                    children: new Set([surfaceId]),
                    actived: false,
                });
                this.emit("windowCreated", toplevelId, el.el);
            });
            isOp(x, "xdg_surface.set_window_geometry", (x) => {
                const surfaceId = this.getObject<"xdg_surface">(x.id).data.surface;
                const surface = this.getObject<"wl_surface">(surfaceId);
                const canvas = surface.data.canvas;
                canvas.width = x.args.width;
                canvas.height = x.args.height;
                // todo xy
            });
            isOp(x, "xdg_surface.get_popup", (x) => {
                const thisSurfaceId = this.getObject<"xdg_surface">(x.id).data.surface;
                const thisSurface = this.getObject<"wl_surface">(thisSurfaceId);
                const parentXdgSurfaceId = x.args.parent;
                if (!parentXdgSurfaceId) {
                    console.error("No parent for popup");
                    return;
                }
                const parentSurfaceId = this.getObject<"xdg_surface">(waylandObjectId(parentXdgSurfaceId)).data.surface;
                const parentSurface = this.getObject<"wl_surface">(parentSurfaceId);

                this.getObject<"xdg_popup">(x.args.id).data = { xdg_surface: x.id };
                this.getObject<"xdg_surface">(x.id).data.xdg_role = x.args.id;
                const win = this.obj2.windows.get(
                    this.getObject<"xdg_surface">(waylandObjectId(parentXdgSurfaceId)).data.xdg_role!,
                );
                if (win) {
                    win.children.add(thisSurfaceId);
                } else {
                    console.error(`cannt find window by xdg_surface ${parentXdgSurfaceId}`);
                }

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

                parentSurface.data.canvas.parentElement!.appendChild(thisSurface.data.canvas);
                thisSurface.data.canvas.style.position = "absolute";

                // todo 给定外部处理的接口

                // @ts-expect-error
                parentSurface.data.canvas.style.anchorName = `--${parentSurfaceId}`;
                thisSurface.data.canvas.style.left = `calc(anchor(--${parentSurfaceId} left) + ${Math.floor(nx)}px)`;
                thisSurface.data.canvas.style.top = `calc(anchor(--${parentSurfaceId} top) + ${Math.floor(ny)}px)`;

                this.sendMessageX(x.args.id, "xdg_popup.configure", {
                    x: Math.floor(nx),
                    y: Math.floor(ny),
                    width: positionerData.size.width,
                    height: positionerData.size.height,
                });
                this.sendMessageX(x.id, "xdg_surface.configure", { serial: 0 });
            });
            isOp(x, "xdg_popup.destroy", (x) => {
                const xdgSurfaceId = this.getObject<"xdg_popup">(x.id).data.xdg_surface;
                const surface = this.getObject<"wl_surface">(this.getObject<"xdg_surface">(xdgSurfaceId).data.surface);
                surface.data.canvas.remove();
                // this.obj2.windows.get() // todo remove
                this.sendMessageX(x.id, "xdg_popup.popup_done", {});
                this.deleteId(x.id);
            });

            isOp(x, "zwp_linux_dmabuf_v1.get_surface_feedback", (x) => {
                const feedbackId = x.args.id;
                this.sendMessageX(feedbackId, "zwp_linux_dmabuf_feedback_v1.done", {});
            });
            isOp(x, "zwp_linux_dmabuf_v1.get_default_feedback", (x) => {
                const feedbackId = x.args.id;

                const formatTable = createFormatTableBuffer([
                    { format: DRM_FORMAT.DRM_FORMAT_ARGB8888, modifier: 0n },
                    { format: DRM_FORMAT.DRM_FORMAT_XRGB8888, modifier: 0n },
                ]);
                const { fd } = newFd(new Uint8Array(formatTable.buffer));
                this.sendMessageX(
                    feedbackId,
                    "zwp_linux_dmabuf_feedback_v1.format_table",
                    {
                        fd: 0,
                        size: formatTable.byteLength,
                    },
                    [fd],
                );

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

            isOp(x, "zwp_text_input_manager_v1.create_text_input", (x) => {
                const textInputId = x.args.id;
                if (!this.obj2.textInput) this.obj2.textInput = { focus: null, m: new Map() };
                this.obj2.textInput.m.set(textInputId, { focus: false });
            });
            isOp(x, "zwp_text_input_v1.activate", (x) => {
                this.sendMessageX(x.id, "zwp_text_input_v1.enter", { surface: x.args.surface });
                if (!this.obj2.textInput) return;
                this.obj2.textInput.m.get(x.id)!.focus = true;
                for (const [k, v] of this.obj2.textInput!.m) {
                    if (k !== x.id && v.focus) {
                        this.sendMessageX(k, "zwp_text_input_v1.leave", {});
                        v.focus = false;
                    }
                }
            });
            isOp(x, "zwp_text_input_v1.deactivate", (x) => {
                if (this.obj2.textInput?.m.get(x.id)?.focus !== true) {
                    return;
                }
                this.sendMessageX(x.id, "zwp_text_input_v1.leave", {});
                if (!this.obj2.textInput) return;
                this.obj2.textInput.m.get(x.id)!.focus = false;
            });

            if (!useOp) {
                console.warn("No matching operation found", `${x.proto.name}.${x.op.name}`, x);
            }
            useOp = false;
        }

        for (const m of this.toSend) {
            this.sendMessage(m.objectId, m.opcode, m.args, m.fds);
        }
        this.toSend = [];
    }
    private sendMessageImm<T extends keyof WaylandEventObj>(
        objectId: WaylandObjectId,
        op: T,
        args: WaylandEventObj[T],
        fds?: number[],
    ) {
        this.sendMessage(objectId, WaylandEventOpcode[op.replace(".", "__")], args, fds);
    }
    private sendMessageX<T extends keyof WaylandEventObj>(
        objectId: WaylandObjectId,
        op: T,
        args: WaylandEventObj[T],
        fds?: number[],
    ) {
        this.toSend.push({ objectId, opcode: WaylandEventOpcode[op.replace(".", "__")], args, fds });
    }
    private sendMessage(objectId: WaylandObjectId, opcode: number, args: Record<string, any>, fds?: number[]) {
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
                    encoder.writeNewId(a.interface!, 1);
                    break;
                case WaylandArgType.ARRAY:
                    encoder.writeArray(new Uint8Array(argValue));
                    break;
                case WaylandArgType.FD:
                    if (!fds || !fds.length) {
                        console.error("No FD provided for sending message with FD argument");
                        break;
                    }
                    break;
                default:
                    break;
            }
        }
        const x = encoder.finalizeMessage();

        console.log(`-> ${this.id}:`, {
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
        win: typeof this.obj2.windows extends Map<infer K, infer V> ? V : never,
    ) {
        const s: number[] = [];
        if (win.actived) s.push(getEnumValue("xdg_toplevel.state", "activated"));
        this.sendMessageImm(winid, "xdg_toplevel.configure", {
            width: 0, // todo
            height: 0,
            states: s,
        });
        this.sendMessageImm(win.xdg_surface, "xdg_surface.configure", { serial: 1 });
    }
    win(id: WaylandObjectId) {
        const win = this.obj2.windows.get(id);
        if (win === undefined) return undefined;
        const winObj = {
            focus: () => {
                if (win.actived) return;
                win.actived = true;
                this.configureWin(id, win);
            },
            blur: () => {
                if (!win.actived) return;
                win.actived = false;
                this.configureWin(id, win);
            },
            point: {
                rootEl: () => {
                    const rootSurfaceId = win.root;
                    const rootSurface = this.getObject<"wl_surface">(rootSurfaceId);
                    return rootSurface.data.canvas;
                },
                inWin: (p: { x: number; y: number }) => {
                    const rootSurfaceId = win.root;
                    const rootSurface = this.getObject<"wl_surface">(rootSurfaceId);
                    const rect = rootSurface.data.canvas.getBoundingClientRect();
                    if (p.x < rect.left || p.x >= rect.right || p.y < rect.top || p.y >= rect.bottom) return false;
                    return true; // todo
                },
                sendPointerEvent: (type: "move" | "down" | "up", p: PointerEvent) => {
                    const { x, y } = p;
                    if (!this.obj2.pointer) return;
                    let nx = x;
                    let ny = y;
                    const { x: baseX, y: baseY } = winObj.point.rootEl().getBoundingClientRect();
                    // todo zindex
                    for (const s of Array.from(win.children).toReversed()) {
                        const cs = this.getObject<"wl_surface">(s).data.canvas;
                        // todo 缓存
                        const rect = cs.getBoundingClientRect();
                        const offsetX = rect.left - baseX;
                        const offsetY = rect.top - baseY;
                        const offsetX1 = rect.right - baseX;
                        const offsetY1 = rect.bottom - baseY;
                        if (x >= offsetX && x < offsetX1 && y >= offsetY && y < offsetY1) {
                            console.log(`pointer in surface ${s}`);
                            if (this.obj2.focusSurface !== s) {
                                if (this.obj2.focusSurface) {
                                    this.sendMessageImm(this.obj2.pointer, "wl_pointer.leave", {
                                        serial: 0,
                                        surface: this.obj2.focusSurface,
                                    });
                                    this.keyboard.blurSurface(this.obj2.focusSurface);
                                }
                                this.sendMessageImm(this.obj2.pointer, "wl_pointer.enter", {
                                    serial: 0,
                                    surface: s,
                                    surface_x: x - offsetX,
                                    surface_y: y - offsetY,
                                });
                                this.keyboard.focusSurface(s);
                                this.sendMessageImm(this.obj2.pointer, "wl_pointer.frame", {});
                                this.obj2.focusSurface = s;
                                nx = x - offsetX;
                                ny = y - offsetY;
                            }
                            break;
                        }
                    }
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
        },
    };
    close() {
        for (const obj of this.objects.values()) {
            if (obj.protocol.name === "wl_shm_pool") {
                fs.closeSync(obj.data.fd);
            }
        }
        for (const s of this.obj2.surfaces) {
            s.el.remove();
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
