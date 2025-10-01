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
import { WaylandDecoder } from "../wayland/wayland-decoder";
import WaylandProtocolsJSON from "../wayland/protocols.json?raw";
const WaylandProtocolsx = JSON.parse(WaylandProtocolsJSON) as Record<string, WaylandProtocol[]>;
const WaylandProtocols = Object.fromEntries(Object.values(WaylandProtocolsx).flatMap((v) => v.map((p) => [p.name, p])));
import { WaylandEncoder } from "../wayland/wayland-encoder";

import { getDesktopEntries, getDesktopIcon } from "../sys_api/application";

import { button, ele, image, txt, view } from "dkh-ui";

type ParsedMessage = { id: WaylandObjectId; proto: WaylandProtocol; op: WaylandOp; args: Record<string, any> };

type WaylandData = {
    wl_shm_pool: { fd: number };
    wl_surface: {
        canvas: HTMLCanvasElement;
        buffer?: ImageData;
        damageList?: { x: number; y: number; width: number; height: number }[];
    };
    xdg_surface: { surface: WaylandObjectId };
    wl_buffer: { imageData: ImageData };
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

        this.clients.set(clientId, client);
    }
}

class WaylandClient {
    id: string;
    socket: USocket;
    objects: Map<WaylandObjectId, { protocol: WaylandProtocol; data: any }>; // 客户端拥有的对象
    nextId: number; // 客户端本地对象ID
    lastRecive: ParsedMessage | null;
    constructor({ id, socket }: { id: string; socket: USocket }) {
        this.id = id;
        this.socket = socket;
        this.objects = new Map();
        this.nextId = 1;
        this.lastRecive = null;
        socket.on("readable", () => {
            console.log("connected");
            const x = socket.read(undefined, null);
            if (x?.data) this.handleClientMessage(x.data, x.fds);
        });

        socket.on("close", () => {
            console.log(`Client ${this.id} disconnected`);
            // this.handleClientDisconnect(client);
        });

        socket.on("error", (err) => {
            console.error(`Client ${this.id} error:`, err);
            // this.handleClientDisconnect(client);
        });
    }

    getObject<T extends keyof WaylandData>(id: WaylandObjectId): WaylandObjectX<T> {
        const obj = this.objects.get(id);
        if (!obj) throw new Error(`Wayland object not found: ${id}`);
        return obj as WaylandObjectX<T>;
    }

    handleClientMessage(data: Buffer, fds: number[] = []) {
        // 解析并处理客户端消息
        const decoder = new WaylandDecoder(data.buffer, fds);

        const opArray: ParsedMessage[] = [];

        console.log(`Parsed data from client ${this.id}:`, data.buffer, fds);
        while (decoder.getRemainingBytes() > 0) {
            const header = decoder.readHeader();
            const x = getX(this.objects, "request", header.objectId, header.opcode);
            if (!x) {
                console.warn(`Unknown objectId/opcode: ${header.objectId}/${header.opcode}`, data.buffer);
                return;
            }
            const args = parseArgs(decoder, x.op.args);
            const rest = decoder.final();
            console.log(
                `Parsed args for ${x.proto.name}.${x.op.name}:`,
                args,
                Object.fromEntries(x.op.args.filter((a) => a.interface).map((i) => [i.name, i.interface])),
            );
            if (rest.length) console.log("rest", rest);
            opArray.push({ proto: x.proto, op: x.op, args, id: header.objectId });
            for (const v of Object.values(x.op.args)) {
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
                    console.log(`Client ${this.id} created ${v.interface} with id ${id}`);
                }
            }
        }

        let useOp = false;
        function isOp(x: ParsedMessage, name: string, op: string) {
            const v = x.proto.name === name && x.op.name === op;
            if (v) useOp = true;
            return v;
        }

        for (const x of opArray) {
            if (isOp(x, "wl_display", "sync")) {
                const callbackId = x.args.callback as WaylandObjectId;
                this.sendMessage(waylandObjectId(1), 1, { id: callbackId }); // delete id

                if (this.lastRecive) {
                    console.log(`client.lastRecive`, this.lastRecive);
                    if (this.lastRecive.proto.name === "wl_display" && this.lastRecive.op.name === "get_registry") {
                        const registryId = this.lastRecive.args.registry as WaylandObjectId;
                        for (const [i, proto] of waylandProtocolsNameMap) {
                            this.sendMessage(registryId, 0, {
                                name: i,
                                interface: proto.name,
                                version: proto.version,
                            });
                        }
                    }

                    this.lastRecive = null;
                } else {
                    console.log("xxxx");
                    // todo Connect Time  outputs, compositor, input devices
                    // wl_shm wl_seat wl_output
                    for (const [id, p] of this.objects) {
                        if (p.protocol.name === "wl_shm") {
                            this.sendMessage(id, 0, { format: p.protocol.enum![1].enum.argb8888 }); // wl_shm.format
                            this.sendMessage(id, 0, { format: p.protocol.enum![1].enum.xrgb8888 }); // wl_shm.format
                        }
                    }
                }

                this.sendMessage(callbackId, 0, {}); // done
            }
            if (isOp(x, "wl_display", "get_registry")) {
                this.lastRecive = x;
            }
            if (isOp(x, "wl_registry", "bind")) {
                const name = x.args.name as WaylandName;
                const id = x.args.id as WaylandObjectId;
                const proto = waylandProtocolsNameMap.get(name);
                if (!proto) {
                    console.warn(`Unknown global name: ${name}`);
                    return;
                }
                this.objects.set(id, { protocol: proto, data: undefined });
                console.log(`Client ${this.id} bound ${proto.name} to id ${id}`);
            }
            if (isOp(x, "wl_shm", "create_pool")) {
                const fd = x.args.fd as number;
                this.getObject<"wl_shm_pool">(x.args.id).data = { fd };
            }
            if (isOp(x, "wl_compositor", "create_surface")) {
                const surfaceId = x.args.id as WaylandObjectId;
                const surface = this.getObject<"wl_surface">(surfaceId);
                const canvasEl = ele("canvas").addInto();
                const canvas = canvasEl.el;
                surface.data = { canvas };
            }
            if (isOp(x, "xdg_wm_base", "get_xdg_surface")) {
                const xdgSurfaceId = x.args.id as WaylandObjectId;
                const xdgSurface = this.getObject<"xdg_surface">(xdgSurfaceId);
                const surfaceId = x.args.surface as WaylandObjectId;
                xdgSurface.data = { surface: surfaceId };
            }
            if (isOp(x, "wl_shm_pool", "create_buffer")) {
                const bufferId = x.args.id as WaylandObjectId;
                const buffer = this.getObject<"wl_buffer">(bufferId);
                const imageData = new ImageData(x.args.width as number, x.args.height as number);
                const data = fs.readFileSync(this.getObject<"wl_shm_pool">(x.id).data.fd);
                const xdata = data.buffer.slice(
                    x.args.offset as number,
                    (x.args.offset as number) + (x.args.stride as number) * (x.args.height as number),
                );
                imageData.data.set(new Uint8ClampedArray(xdata));
                buffer.data = { imageData };
            }
            if (isOp(x, "wl_surface", "attach")) {
                const surfaceId = x.id;
                const surface = this.getObject<"wl_surface">(surfaceId);
                const bufferId = x.args.buffer as WaylandObjectId;
                const buffer = this.getObject<"wl_buffer">(bufferId);
                surface.data.buffer = buffer.data.imageData;
            }
            if (isOp(x, "wl_surface", "damage")) {
                const surfaceId = x.id;
                const surface = this.getObject<"wl_surface">(surfaceId);
                const damageList = surface.data.damageList || [];
                damageList.push({
                    x: x.args.x as number,
                    y: x.args.y as number,
                    width: x.args.width as number,
                    height: x.args.height as number,
                });
                surface.data.damageList = damageList;
            }
            if (isOp(x, "wl_surface", "commit")) {
                const surfaceId = x.id;
                const surface = this.getObject<"wl_surface">(surfaceId);
                const canvas: HTMLCanvasElement = surface.data.canvas;
                const ctx = canvas.getContext("2d")!;
                const imagedata = surface.data.buffer;
                if (!imagedata) {
                    console.warn("wl_surface buffer not found", surfaceId);
                    return;
                }
                if (surface.data.damageList?.length) {
                    for (const damage of surface.data.damageList) {
                        ctx.putImageData(imagedata, damage.x, damage.y, 0, 0, damage.width, damage.height);
                    }
                } else {
                    ctx.putImageData(imagedata, 0, 0);
                }
            }
            if (isOp(x, "xdg_surface", "get_toplevel")) {
                const toplevelId = x.args.id as WaylandObjectId;
                this.sendMessage(toplevelId, 2, { width: 1920, height: 1080 });
                this.sendMessage(toplevelId, 0, { width: 0, height: 0, states: new Uint8Array([]) });
                for (const [id, p] of this.objects) {
                    if (p.protocol.name === "xdg_surface") {
                        this.sendMessage(id, 0, { serial: 1 }); // todo
                    }
                }
            }
            if (isOp(x, "xdg_surface", "set_window_geometry")) {
                const surfaceId = this.getObject<"xdg_surface">(x.id).data.surface;
                const surface = this.getObject<"wl_surface">(surfaceId);
                const canvas = surface.data.canvas;
                canvas.width = x.args.width as number;
                canvas.height = x.args.height as number;
                // todo xy
            }
            if (!useOp) {
                console.warn("No matching operation found", `${x.proto.name}.${x.op.name}`, x);
            }
            useOp = false;
        }
    }
    sendMessage(objectId: WaylandObjectId, opcode: number, args: Record<string, any>) {
        const p = getX(this.objects, "event", objectId, opcode);
        if (!p) {
            console.error("Cannot find protocol for sending message", objectId, opcode);
            return;
        }
        console.log(`Sending message to client ${this.id}:`, {
            p: `${p.proto.name}.${p.op.name}`,
            args,
        });
        const { op } = p;
        const encoder = new WaylandEncoder();
        encoder.writeHeader(objectId, opcode);
        for (const a of op.args) {
            const argValue = args[a.name];
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
                    encoder.writeArray(argValue);
                    break;
                case WaylandArgType.FD:
                    // 这里假设FD是通过某种方式传递的，我们用一个占位符
                    break; // 占位符，实际实现中需要处理FD传递
                default:
                    break;
            }
        }
        const x = encoder.finalizeMessage();
        this.socket.write(Buffer.from(x.data), (err) => {
            if (err) {
                console.error("Failed to send message to client:", err);
            }
        }); // todo array 类型
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
                    decoder.readString();
                    decoder.readUint();
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
        },
    });

    subprocess.stdout.on("data", (data) => {
        console.log(`Subprocess stdout: ${data.toString("utf8")}`);
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
        console.log(`Subprocess stderr: ${data.toString("utf8")}`);
    });

    subprocess.on("error", (err) => {
        console.error("Failed to start subprocess:", err);
    });

    subprocess.on("exit", (code, signal) => {
        console.log(`Subprocess exited with code ${code} and signal ${signal}`);
    });
}

console.log("Support protocols:", Object.keys(WaylandProtocols));

const server = new WaylandServer();

const deEnv = JSON.parse(new URLSearchParams(location.search).get("env") ?? "{}");

const waylandProtocolsNameMap = new Map<WaylandName, WaylandProtocol>();

initWaylandProtocols();

["google-chrome-stable", "wayland-info", "weston-flower", "weston-simple-damage"].forEach((app) => {
    button(app)
        .on("click", () => {
            const execPath = `/usr/bin/${app}`;
            runApp(execPath);
        })
        .addInto();
});

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
