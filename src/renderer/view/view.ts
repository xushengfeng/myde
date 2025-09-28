const net = require("node:net") as typeof import("node:net");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const child_process = require("node:child_process") as typeof import("node:child_process");

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

import { button, txt, view } from "dkh-ui";
import { WaylandEncoder } from "../wayland/wayland-encoder";

type Client = {
    id: string;
    socket: import("node:net").Socket;
    objects: Map<WaylandObjectId, WaylandProtocol>; // 客户端拥有的对象
    nextId: number; // 客户端本地对象ID
};

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
    server: import("node:net").Server | null = null;
    clients: Map<string, any>;
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
        this.server = net.createServer((socket) => {
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

    handleNewConnection(socket: import("node:net").Socket) {
        const clientId = crypto.randomUUID();
        console.log(`New client connected: ${clientId}`);

        const client: Client = {
            id: clientId,
            socket: socket,
            objects: new Map(), // 客户端拥有的对象
            nextId: 1, // 客户端本地对象ID
        };

        this.clients.set(clientId, client);

        // 设置消息处理
        socket.on("data", (data) => {
            this.handleClientMessage(client, data);
        });

        socket.on("close", () => {
            console.log(`Client ${client.id} disconnected`);
            // this.handleClientDisconnect(client);
        });

        socket.on("error", (err) => {
            console.error(`Client ${clientId} error:`, err);
            // this.handleClientDisconnect(client);
        });
    }
    handleClientMessage(client: Client, data: Buffer) {
        // 解析并处理客户端消息
        const decoder = new WaylandDecoder(data.buffer);

        const opArray: { proto: WaylandProtocol; op: WaylandOp; args: Record<string, any> }[] = [];

        console.log(`Parsed data from client ${client.id}:`);
        while (decoder.getRemainingBytes() > 0) {
            const header = decoder.readHeader();
            const x = getX(client.objects, "request", header.objectId, header.opcode);
            if (!x) {
                console.warn(`Unknown objectId/opcode: ${header.objectId}/${header.opcode}`);
                return;
            }
            const args = parseArgs(decoder, x.op.args);
            console.log(`Parsed args for ${x.proto.name}.${x.op.name}:`, args);
            opArray.push({ proto: x.proto, op: x.op, args });
        }
        const willRun: { objectId: WaylandObjectId; opcode: number; args: Record<string, any> }[] = [];
        let callbackId: WaylandObjectId | undefined;
        for (const x of opArray) {
            if (x.proto.name === "wl_display" && x.op.name === "sync") {
                callbackId = x.args.callback as WaylandObjectId;
                client.objects.set(callbackId, WaylandProtocols.wl_callback);
                willRun.push({
                    objectId: callbackId,
                    opcode: 0,
                    args: {},
                });
                this.sendMessage(client, waylandObjectId(1), 1, { id: callbackId });
            }
            if (x.proto.name === "wl_display" && x.op.name === "get_registry") {
                const registryId = x.args.registry as WaylandObjectId;
                client.objects.set(registryId, WaylandProtocols.wl_registry);
                for (const [i, proto] of waylandProtocolsNameMap) {
                    willRun.push({
                        objectId: registryId,
                        opcode: 0,
                        args: {
                            name: i,
                            interface: proto.name,
                            version: proto.version,
                        },
                    });
                }
            }
            if (x.proto.name === "wl_registry" && x.op.name === "bind") {
                const name = x.args.name as WaylandName;
                const id = x.args.id as WaylandObjectId;
                const proto = waylandProtocolsNameMap.get(name);
                if (!proto) {
                    console.warn(`Unknown global name: ${name}`);
                    return;
                }
                client.objects.set(id, proto);
                console.log(`Client ${client.id} bound ${proto.name} to id ${id}`);
            }
        }
        for (const x of willRun) {
            this.sendMessage(client, x.objectId, x.opcode, x.args);
        }
    }
    sendMessage(client: Client, objectId: WaylandObjectId, opcode: number, args: Record<string, any>) {
        const p = getX(client.objects, "event", objectId, opcode);
        if (!p) {
            console.error("Cannot find protocol for sending message", objectId, opcode);
            return;
        }
        console.log(`Sending message to client ${client.id}:`, {
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
        client.socket.write(new Uint8Array(x.data), (err) => {
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

function getX(
    map: Map<WaylandObjectId, WaylandProtocol>,
    type: "request" | "event",
    objectId: WaylandObjectId,
    opcode: number,
) {
    const proto = objectId === 1 ? WaylandProtocols.wl_display : map.get(objectId);
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
                // 这里假设FD是通过某种方式传递的，我们用一个占位符
                parsed[arg.name] = -1; // 占位符，实际实现中需要处理FD传递
                break;
            default:
                throw new Error(`Unknown argument type: ${arg.type}`);
        }
    }
    return parsed;
}

function runApp(execPath: string) {
    console.log(`Running application: ${execPath}`);

    const subprocess = child_process.spawn(execPath, {
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
        console.error(`Subprocess stderr: ${data.toString("utf8")}`);
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

txt("hello").addInto();

button("run")
    .on("click", () => {
        const execPath = "/usr/bin/google-chrome-stable";
        runApp(execPath);
    })
    .addInto();

button("wayland-info")
    .on("click", () => {
        console.log("Wayland info button clicked");
        const execPath = "/usr/bin/wayland-info";
        runApp(execPath);
    })
    .addInto();
