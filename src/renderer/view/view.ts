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

import { button, image, txt, view } from "dkh-ui";

type ParsedMessage = { proto: WaylandProtocol; op: WaylandOp; args: Record<string, any> };

type Client = {
    id: string;
    socket: USocket;
    objects: Map<WaylandObjectId, WaylandProtocol>; // 客户端拥有的对象
    nextId: number; // 客户端本地对象ID
    lastRecive: ParsedMessage | null;
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
    server: UServer | null = null;
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

        const client: Client = {
            id: clientId,
            socket: socket,
            objects: new Map(), // 客户端拥有的对象
            nextId: 1, // 客户端本地对象ID
            lastRecive: null,
        };

        this.clients.set(clientId, client);

        // 设置消息处理
        socket.on("readable", () => {
            console.log("connected");
            const x = socket.read(undefined, null);
            if (x?.data) this.handleClientMessage(client, x.data, x.fds);
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
    handleClientMessage(client: Client, data: Buffer, fds: number[] = []) {
        // 解析并处理客户端消息
        const decoder = new WaylandDecoder(data.buffer, fds);

        const opArray: ParsedMessage[] = [];

        console.log(`Parsed data from client ${client.id}:`, data.buffer, fds);
        while (decoder.getRemainingBytes() > 0) {
            const header = decoder.readHeader();
            const x = getX(client.objects, "request", header.objectId, header.opcode);
            if (!x) {
                console.warn(`Unknown objectId/opcode: ${header.objectId}/${header.opcode}`, data.buffer);
                return;
            }
            const args = parseArgs(decoder, x.op.args);
            const rest = decoder.final();
            console.log(`Parsed args for ${x.proto.name}.${x.op.name}:`, args);
            if (rest.length) console.log("rest", rest);
            opArray.push({ proto: x.proto, op: x.op, args });
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
                    client.objects.set(id, _interface);
                    console.log(`Client ${client.id} created ${v.interface} with id ${id}`);
                }
            }
        }
        for (const x of opArray) {
            if (x.proto.name === "wl_display" && x.op.name === "sync") {
                const callbackId = x.args.callback as WaylandObjectId;
                this.sendMessage(client, waylandObjectId(1), 1, { id: callbackId }); // delete id

                if (client.lastRecive) {
                    console.log(`client.lastRecive`, client.lastRecive);
                    if (client.lastRecive.proto.name === "wl_display" && client.lastRecive.op.name === "get_registry") {
                        const registryId = client.lastRecive.args.registry as WaylandObjectId;
                        for (const [i, proto] of waylandProtocolsNameMap) {
                            this.sendMessage(client, registryId, 0, {
                                name: i,
                                interface: proto.name,
                                version: proto.version,
                            });
                        }
                    }

                    client.lastRecive = null;
                } else {
                    console.log("xxxx");
                    // todo Connect Time  outputs, compositor, input devices
                    // wl_shm wl_seat wl_output
                }

                this.sendMessage(client, callbackId, 0, {}); // done
            }
            if (x.proto.name === "wl_display" && x.op.name === "get_registry") {
                client.lastRecive = x;
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
            if (x.proto.name === "wl_shm" && x.op.name === "create_pool") {
                // todo
                // console.log("Received placeholder fd, cannot read data directly:");
                const fd = x.args.fd as number;
                const data = fs.readFileSync(fd);
                console.log("Received placeholder fd, cannot read data directly:", data);
            }
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
        client.socket.write(Buffer.from(x.data), (err) => {
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

["google-chrome-stable", "wayland-info", "weston-flower"].forEach((app) => {
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
        apps.push(app);
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
