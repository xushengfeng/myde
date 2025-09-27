const net = require("node:net") as typeof import("node:net");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const child_process = require("node:child_process") as typeof import("node:child_process");

import { WaylandArgType, type WaylandProtocol } from "../wayland/wayland-binary";
import { WaylandProtocols } from "../wayland/wayland-db";
import { WaylandDecoder } from "../wayland/wayland-decoder";

import { addClass, check, type ElType, image, label, p, pack, pureStyle, spacer, trackPoint, txt, view } from "dkh-ui";

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

        const client = {
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
            // this.handleClientDisconnect(client);
        });

        socket.on("error", (err) => {
            console.error(`Client ${clientId} error:`, err);
            // this.handleClientDisconnect(client);
        });
    }
    handleClientMessage(client: any, data: Buffer) {
        // 解析并处理客户端消息
        console.log(`Received data from client ${client.id}:`, data);

        const decoder = new WaylandDecoder(data.buffer);
        const header = decoder.readHeader();
        console.log(`Parsed header from client ${client.id}:`, header);
        const x = getX(header.objectId, header.opcode);
        if (!x) {
            console.warn(`Unknown objectId/opcode: ${header.objectId}/${header.opcode}`);
            return;
        }
        const args = parseArgs(decoder, x.op.args);
        console.log(`Parsed args for ${x.proto.name}.${x.op.name}:`, args);
    }
}

function initWaylandProtocols() {
    for (const [_, proto] of Object.entries(WaylandProtocols)) {
        waylandProtocolsMap.set(proto.objectId, proto);
    }
}

function getX(objectId: number, opcode: number) {
    const proto = waylandProtocolsMap.get(objectId);
    if (!proto) return null;
    const op = proto.ops[opcode];
    if (!op) return null;
    return { proto, op };
}

function parseArgs(decoder: WaylandDecoder, args: WaylandProtocol["ops"][0]["args"]) {
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
    console.log(`Running application: ${execPath}`, {
        ...deEnv,
        XDG_RUNTIME_DIR: server.socketDir, // 设置XDG_RUNTIME_DIR
        WAYLAND_DISPLAY: server.socketName, // 设置环境变量以指向我们的Wayland服务器
    });

    const subprocess = child_process.spawn(execPath, {
        stdio: "inherit",
        env: {
            HOME: deEnv.HOME,
            XDG_SESSION_TYPE: "wayland",
            XDG_RUNTIME_DIR: server.socketDir, // 设置XDG_RUNTIME_DIR
            WAYLAND_DISPLAY: server.socketName, // 设置环境变量以指向我们的Wayland服务器
        },
    });

    subprocess.on("error", (err) => {
        console.error("Failed to start subprocess:", err);
    });

    subprocess.on("exit", (code, signal) => {
        console.log(`Subprocess exited with code ${code} and signal ${signal}`);
    });
}

const server = new WaylandServer();

const deEnv = JSON.parse(new URLSearchParams(location.search).get("env") ?? "{}");

const waylandProtocolsMap = new Map<number, WaylandProtocol>();

initWaylandProtocols();

txt("hello").addInto();

view()
    .add("run")
    .on("click", () => {
        const execPath = "/usr/bin/google-chrome-stable"; // 替换为你想运行的Wayland应用程序路径
        runApp(execPath);
    })
    .addInto();
