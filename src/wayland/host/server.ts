/**
 * WaylandServer：连接生命周期（socket 监听、建连）与协议模块装配。
 * 单个连接的全部职责在 ./client.ts。
 */

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const usocket = require("myde-unix-socket") as typeof import("myde-unix-socket");

import type { UServer, USocket } from "myde-unix-socket";
import { assertModuleConflicts } from "../protocols/index";
import type { renderTools } from "../render_tools";
import type { WaylandName } from "../utils/wayland-binary";
import { WaylandProtocols, waylandProtocolsNameMap } from "../utils/wayland-proto";
import { WaylandClient } from "./client";

export { WaylandClient, WaylandServer };

interface WaylandServerEventMap {
    newClient: (client: WaylandClient, clientId: string) => void;
    clientClose: (client: WaylandClient, clientId: string) => void;
}

function waylandName(name: number): WaylandName {
    return name as WaylandName;
}

class WaylandServer {
    private events: { [K in keyof WaylandServerEventMap]?: WaylandServerEventMap[K][] } = {};

    socketDir = "/tmp";
    socketName = "my-wayland-server-0";
    private socketPath: string;
    private server: UServer | null = null;
    private render: renderTools;
    clients: Map<string, WaylandClient>;
    constructor(op: {
        socketDir?: string;
        socketName?: string;
        render: renderTools;
    }) {
        this.socketDir = op.socketDir || this.socketDir;
        this.socketName = op.socketName || this.socketName;
        this.render = op.render;

        this.socketPath = path.join(this.socketDir, this.socketName);
        this.clients = new Map(); // 存储连接的客户端

        initWaylandProtocols();
        assertModuleConflicts();

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

        const client = new WaylandClient({ id: clientId, socket, render: this.render });
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
