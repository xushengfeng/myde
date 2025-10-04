const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const child_process = require("node:child_process") as typeof import("node:child_process");

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

import { getDesktopEntries, getDesktopIcon } from "../sys_api/application";

import { button, ele, image, pack, txt, view, initDKH, input, addStyle } from "dkh-ui";
import { InputEventCodes } from "../input_codes/types";
import { createFormatTableBuffer, DRM_FORMAT } from "../wayland/dma-buf";

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
    };
    xdg_surface: { surface: WaylandObjectId };
    wl_buffer: { fd: number; start: number; end: number; imageData: ImageData };
};

type WaylandObjectX<T extends keyof WaylandData> = { protocol: WaylandProtocol; data: WaylandData[T] };

function waylandName(name: number): WaylandName {
    return name as WaylandName;
}
function waylandObjectId(id: number): WaylandObjectId {
    return id as WaylandObjectId;
}

class WaylandServer {
    socketDir = "/tmp";
    socketName = "my-wayland-server-0";
    socketPath: string;
    server: UServer | null = null;
    clients: Map<string, WaylandClient>;
    globalObjects: Map<string, any>;
    nextObjectId: number;
    constructor() {
        this.socketPath = path.join(this.socketDir, this.socketName);
        this.clients = new Map(); // 存储连接的客户端
        this.globalObjects = new Map(); // 全局对象注册表
        this.nextObjectId = 1; // Wayland 对象ID计数器

        this.setupSocket();
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

    handleNewConnection(socket: USocket) {
        const clientId = crypto.randomUUID().slice(0, 8);
        console.log(`New client connected: ${clientId}`);

        const client = new WaylandClient({ id: clientId, socket });

        this.clients.set(clientId, client); // todo onclose
    }
}

class WaylandClient {
    id: string;
    socket: USocket;
    objects: Map<WaylandObjectId, { protocol: WaylandProtocol; data: any }>; // 客户端拥有的对象
    protoVersions: Map<string, number> = new Map();
    queueMap = new Map<WaylandObjectId, number>();
    toSend: Record<
        number,
        Array<{ objectId: WaylandObjectId; opcode: number; args: Record<string, any>; fds?: number[] }>
    > = {};
    lastCallback: WaylandObjectId | null; // todo 移除
    obj2: Partial<{
        pointer: WaylandObjectId;
        keyboard: WaylandObjectId;
    }> & {
        surfaces: { id: WaylandObjectId; el: HTMLCanvasElement }[];
    } & Record<string, any>;
    constructor({ id, socket }: { id: string; socket: USocket }) {
        this.id = id;
        this.socket = socket;
        this.objects = new Map();
        this.lastCallback = null;
        this.obj2 = { surfaces: [] };
        socket.on("readable", () => {
            console.log("connected");
            const x = socket.read(undefined, null);
            if (x?.data) this.handleClientMessage(x.data, x.fds);
        });

        socket.on("close", () => {
            console.log(`Client ${this.id} disconnected`);
            this.close();
        });

        socket.on("error", (err) => {
            console.error(`Client ${this.id} error:`, err);
            this.close();
        });
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

        let theMessageQueueId: number | undefined; // 目前任务一串消息的队列是相同的

        console.log(`Parsed data from client ${this.id}:`, data.buffer, fds);
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

            if (theMessageQueueId === undefined && header.objectId !== 1) {
                theMessageQueueId = this.queueMap.get(header.objectId);
                if (theMessageQueueId !== undefined) {
                    console.log("Found thisMessageQueueId", theMessageQueueId);
                }
            }

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
                    const queueId = this.queueMap.get(header.objectId);
                    if (queueId) {
                        this.queueMap.set(id, queueId);
                        console.log("Set queueId for new object", id, queueId);
                    }
                    this.objects.set(id, { protocol: _interface, data: undefined });
                    console.log(`Client ${this.id} created ${v.interface} with id ${id}`);
                }
            }

            const x = { proto: _x.proto, op: _x.op, args, id: header.objectId };
            isOp(x, "wl_display.sync", (x) => {
                const callbackId = x.args.callback;
                this.sendMessageX(waylandObjectId(1), "wl_display.delete_id", { id: callbackId });

                if (theMessageQueueId === undefined) {
                    console.log(this.toSend, this.queueMap);
                    throw new Error("thisMessageQueueId is undefined");
                }
                const msgs = this.toSend[theMessageQueueId] || [];

                for (const msg of msgs || []) {
                    this.sendMessage(msg.objectId, msg.opcode, msg.args, msg.fds);
                }

                this.toSend = [];

                this.sendMessageX(callbackId, "wl_callback.done", { callback_data: 0 });
            });
            isOp(x, "wl_display.get_registry", (x) => {
                const registryId = x.args.registry;
                this.queueMap.set(registryId, registryId);
                theMessageQueueId = registryId;
                console.log("Set queueId", registryId);
                for (const [i, proto] of waylandProtocolsNameMap) {
                    this.sendMessageLater(registryId, "wl_registry.global", {
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
                this.queueMap.set(id, x.id);
                console.log("Set queueId for new object", id, x.id);
                this.protoVersions.set(proto.name, x.args._version);
                console.log(`Client ${this.id} bound ${proto.name} to id ${id}`);

                // wl_shm wl_seat wl_output

                if (proto.name === "wl_shm") {
                    this.sendMessageLater(id, "wl_shm.format", {
                        format: getEnumValue(proto, "wl_shm.format", "argb8888"),
                    });
                    this.sendMessageLater(id, "wl_shm.format", {
                        format: getEnumValue(proto, "wl_shm.format", "xrgb8888"),
                    });
                }
                if (proto.name === "wl_seat") {
                    this.sendMessageLater(id, "wl_seat.name", { name: "seat0" });
                    this.sendMessageLater(id, "wl_seat.capabilities", {
                        capabilities: getEnumValue(proto, "wl_seat.capability", ["pointer", "keyboard"]),
                    });
                }
            });
            isOp(x, "wl_shm.create_pool", (x) => {
                const fd = x.args.fd;
                this.getObject<"wl_shm_pool">(x.args.id).data = { fd };
            });
            isOp(x, "wl_compositor.create_surface", (x) => {
                const surfaceId = x.args.id;
                const surface = this.getObject<"wl_surface">(surfaceId);
                const canvasEl = ele("canvas").addInto();
                const canvas = canvasEl.el;
                this.obj2.surfaces.push({ id: surfaceId, el: canvas });
                surface.data = { canvas, bufferPointer: 0 };
            });
            isOp(x, "xdg_wm_base.get_xdg_surface", (x) => {
                const xdgSurfaceId = x.args.id;
                const xdgSurface = this.getObject<"xdg_surface">(xdgSurfaceId);
                const surfaceId = x.args.surface as WaylandObjectId;
                xdgSurface.data = { surface: surfaceId };
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
                this.objects.delete(x.id);
                this.sendMessageX(waylandObjectId(1), "wl_display.delete_id", { id: x.id });
            });
            isOp(x, "wl_region.destroy", (x) => {
                this.objects.delete(x.id);
                this.sendMessageX(waylandObjectId(1), "wl_display.delete_id", { id: x.id });
            });
            isOp(x, "wl_surface.attach", (x) => {
                const surfaceId = x.id;
                const surface = this.getObject<"wl_surface">(surfaceId);
                const bufferId = x.args.buffer as WaylandObjectId;
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
            isOp(x, "wl_surface.frame", (x) => {
                const callbackId = x.args.callback;
                this.lastCallback = callbackId;
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
                    return;
                }
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
                imagedata.data.set(buffern);

                if (surface.data.damageList?.length) {
                    for (const damage of surface.data.damageList) {
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
                surface.data.damageList = [];
                if (this.lastCallback) {
                    const x = this.lastCallback;

                    requestAnimationFrame(() => {
                        const bufferId =
                            surface.data.bufferPointer === 0 ? surface.data.buffer2?.id : surface.data.buffer?.id;
                        if (bufferId) {
                            this.sendMessageX(bufferId, "wl_buffer.release", {});
                        }
                        surface.data.bufferPointer = surface.data.bufferPointer === 0 ? 1 : 0;
                        this.sendMessageX(waylandObjectId(1), "wl_display.delete_id", {
                            id: x,
                        });
                        this.sendMessageX(x, "wl_callback.done", { callback_data: Date.now() });
                        this.lastCallback = null;
                    });
                }
            });
            isOp(x, "xdg_surface.get_toplevel", (x) => {
                const toplevelId = x.args.id;
                // this.sendMessage(toplevelId, 2, { width: 1920, height: 1080 });
                this.sendMessageX(toplevelId, "xdg_toplevel.configure", {
                    width: 0,
                    height: 0,
                    states: [],
                });
                for (const [id, p] of this.objects) {
                    if (p.protocol.name === "xdg_surface") {
                        this.sendMessageX(id, "xdg_surface.configure", { serial: 1 }); // todo
                    }
                }
            });
            isOp(x, "xdg_surface.set_window_geometry", (x) => {
                const surfaceId = this.getObject<"xdg_surface">(x.id).data.surface;
                const surface = this.getObject<"wl_surface">(surfaceId);
                const canvas = surface.data.canvas;
                canvas.width = x.args.width;
                canvas.height = x.args.height;
                // todo xy
            });
            isOp(x, "wl_seat.get_pointer", (x) => {
                const pointerId = x.args.id;
                this.obj2.pointer = pointerId;
            });
            isOp(x, "wl_seat.get_keyboard", (x) => {
                const keyboardId = x.args.id;
                this.obj2.keyboard = keyboardId;
                this.sendMessageLater(keyboardId, "wl_keyboard.repeat_info", {
                    rate: 25,
                    delay: 600,
                });
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
                const tmpPath = `/dev/shm/dmabuf-format-table-${crypto.randomUUID()}`;
                const fd = fs.openSync(tmpPath, "w+");
                fs.writeSync(fd, new Uint8Array(formatTable.buffer));
                this.sendMessageLater(
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
                this.sendMessageLater(feedbackId, "zwp_linux_dmabuf_feedback_v1.main_device", { device: a });
                this.sendMessageLater(feedbackId, "zwp_linux_dmabuf_feedback_v1.tranche_target_device", {
                    device: a,
                });

                this.sendMessageLater(feedbackId, "zwp_linux_dmabuf_feedback_v1.done", {});
            });

            if (!useOp) {
                console.warn("No matching operation found", `${x.proto.name}.${x.op.name}`, x);
            }
            useOp = false;
        }
    }
    private sendMessageX<T extends keyof WaylandEventObj>(
        objectId: WaylandObjectId,
        op: T,
        args: WaylandEventObj[T],
        fds?: number[],
    ) {
        this.sendMessage(objectId, WaylandEventOpcode[op.replace(".", "__")], args, fds);
    }
    private sendMessageLater<T extends keyof WaylandEventObj>(
        objectId: WaylandObjectId,
        op: T,
        args: WaylandEventObj[T],
        fds?: number[],
    ) {
        const queueId = this.queueMap.get(objectId);
        if (queueId === undefined) {
            console.error("Cannot find queue for objectId", objectId);
            return;
        }
        if (!this.toSend[queueId]) this.toSend[queueId] = [];
        this.toSend[queueId].push({
            objectId,
            opcode: WaylandEventOpcode[op.replace(".", "__")],
            args,
            fds,
        });
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

        console.log(`q${this.queueMap.get(objectId) ?? 0}-> ${this.id}:`, {
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
    sendPointerEvent(type: "move" | "down" | "up" | "in", p: PointerEvent, surface: WaylandObjectId) {
        const { x, y } = p;
        if (!this.obj2.pointer) return;
        if (type === "move") {
            this.sendMessageX(this.obj2.pointer, "wl_pointer.motion", { time: Date.now(), surface_x: x, surface_y: y });
            this.sendMessageX(this.obj2.pointer, "wl_pointer.frame", {});
        }
        if (type === "in") {
            this.sendMessageX(this.obj2.pointer, "wl_pointer.enter", {
                serial: 0,
                surface: surface,
                surface_x: x,
                surface_y: y,
            });
            this.sendMessageX(this.obj2.pointer, "wl_pointer.frame", {});
        }
        if (type === "down") {
            this.sendMessageX(this.obj2.pointer, "wl_pointer.button", {
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
                state: getEnumValue(WaylandProtocols.wl_pointer, "wl_pointer.button_state", "pressed"),
            });
            this.sendMessageX(this.obj2.pointer, "wl_pointer.frame", {});
        }
        if (type === "up") {
            this.sendMessageX(this.obj2.pointer, "wl_pointer.button", {
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
                state: getEnumValue(WaylandProtocols.wl_pointer, "wl_pointer.button_state", "released"),
            });
            this.sendMessageX(this.obj2.pointer, "wl_pointer.frame", {});
        }
    }
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

function getEnumValue<T extends keyof WaylandEnumObj>(
    proto: WaylandProtocol,
    enumName: T,
    value: WaylandEnumObj[T] | WaylandEnumObj[T][],
) {
    if (!proto.enum) throw new Error(`Protocol ${proto.name} has no enums`);
    const [pName, enumN] = enumName.split(".");
    if (pName !== proto.name) throw new Error(`Enum ${enumName} does not belong to protocol ${proto.name}`);
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

function sendPointerEvent(type: "move" | "down" | "up", p: PointerEvent) {
    for (const client of server.clients.values()) {
        for (const surface of client.obj2.surfaces) {
            const rect = surface.el.getBoundingClientRect();
            if (p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom) {
                if (!client.obj2.in) {
                    client.obj2.in = true;
                    client.sendPointerEvent(
                        "in",
                        new PointerEvent(p.type, { ...p, clientX: p.x - rect.left, clientY: p.y - rect.top }),
                        surface.id,
                    );
                }
                client.sendPointerEvent(
                    type,
                    new PointerEvent(p.type, { ...p, clientX: p.x - rect.left, clientY: p.y - rect.top }),
                    surface.id,
                );
            }
        }
    }
}

function runApp(execPath: string, args: string[] = []) {
    console.log(`Running application: ${execPath}`);

    const subprocess = child_process.spawn(execPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            HOME: deEnv.HOME,
            WAYLAND_DEBUG: "1",
            XDG_SESSION_TYPE: "wayland",
            XDG_RUNTIME_DIR: server.socketDir,
            WAYLAND_DISPLAY: server.socketName,
            ...(Number.isNaN(xServerNum) ? {} : { DISPLAY: `:${xServerNum}` }),
        },
    });

    subprocess.stdout.on("data", (data) => {
        console.log(`Subprocess ${execPath} stdout:\n${data.toString("utf8")}`);
    });

    subprocess.stderr.on("data", (data) => {
        const dataStr = data.toString("utf8");
        const m = dataStr.match(/\{Default Queue\}(.+?)#/)?.[1];
        if (m) {
            const p = (m as string).replace("->", "").trim();
            if (!WaylandProtocols[p]) {
                console.error(`Unknown protocol in debug output: ${p}`);
            }
        }
        console.log(`Subprocess ${execPath} stderr:\n${data.toString("utf8")}`);
    });

    subprocess.on("error", (err) => {
        console.error("Failed to start subprocess:", err);
    });

    subprocess.on("exit", (code, signal) => {
        console.log(`Subprocess ${execPath} exited with code ${code} and signal ${signal}`);
    });
}

console.log("Support protocols:", Object.keys(WaylandProtocols));

const server = new WaylandServer();

const deEnv = JSON.parse(new URLSearchParams(location.search).get("env") ?? "{}");

const waylandProtocolsNameMap = new Map<WaylandName, WaylandProtocol>();

initWaylandProtocols();

let xServerNum = NaN;

const mouseEL = view().addInto().style({
    position: "fixed",
    width: "10px",
    height: "10px",
    background: "rgba(0,0,0,0.5)",
    outline: "1px solid #fff",
    borderRadius: "50%",
    pointerEvents: "none",
    top: "0px",
    left: "0px",
    transform: "translate(-50%, -50%)",
    zIndex: 9999,
});

function mouseMove(x: number, y: number) {
    mouseEL.style({ top: `${y}px`, left: `${x}px` });
    sendPointerEvent("move", new PointerEvent("pointermove", { clientX: x, clientY: y }));
}

initDKH({ pureStyle: true });

const body = pack(document.body);

body.on("pointermove", (e) => {
    mouseMove(e.x, e.y);
});
body.on("pointerdown", (e) => {
    sendPointerEvent("down", e);
});
body.on("pointerup", (e) => {
    sendPointerEvent("up", e);
});

body.style({
    background: 'url("file:///usr/share/wallpapers/ScarletTree/contents/images/5120x2880.png") center/cover no-repeat',
    height: "100vh",
    cursor: "none",
});

addStyle({
    "*": {
        cursor: "none !important",
    },
});

button("self")
    .on("click", () => {
        runApp(process.argv[0], process.argv.slice(1));
    })
    .addInto();

view()
    .add(
        [
            "google-chrome-stable",
            "firefox-nightly",
            "wayland-info",
            "weston-flower",
            "weston-simple-damage",
            "weston-simple-shm",
            "weston-simple-egl",
            "weston-simple-dmabuf-egl",
            "weston-simple-dmabuf-feedback",
            "weston-editor",
            "weston-clickdot",
            "glxgears",
        ].map((app) =>
            button(app)
                .style({ padding: "4px 8px", background: "#fff" })
                .on("click", () => {
                    const execPath = `/usr/bin/${app}`;
                    runApp(execPath);
                }),
        ),
    )
    .addInto();

view()
    .add(
        input().on("change", (e, el) => {
            const command = el.gv;
            runApp(`/usr/bin/${command}`);
        }),
    )
    .addInto();

view()
    .add(
        button("xwayland").on("click", () => {
            for (let i = 0; i < 100; i++) {
                const socketPath = `/tmp/.X11-unix/X${i}`;
                if (!fs.existsSync(socketPath)) {
                    xServerNum = i;
                    runApp("/usr/bin/Xwayland", [`:${xServerNum}`]);
                    break;
                }
            }
        }),
    )
    .addInto();

const allApps = getDesktopEntries(["zh_CN", "zh", "zh-Hans"]);
console.log("Found desktop entries:", allApps);
const apps: typeof allApps = [];
const appNameSet = new Set<string>();

for (const app of allApps) {
    if (!appNameSet.has(app.name)) {
        appNameSet.add(app.name);
        // apps.push(app);
    }
}

view("y")
    .add(
        apps.map((app) => {
            const iconPath = getDesktopIcon(app.icon) || "";
            return view("x")
                .add([
                    iconPath ? image(`file://${iconPath}`, app.name).style({ width: "24px" }) : "",
                    txt(app.nameLocal),
                ])
                .on("click", () => {
                    const exec = app.exec.split(" ")[0]; // 简单处理参数
                    runApp(exec, app.exec.split(" ").slice(1));
                });
        }),
    )
    .addInto();
