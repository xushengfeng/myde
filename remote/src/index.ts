import { RemoteRender } from "./remote-render";
import { RemoteServer } from "./server";

import type {} from "../../src/renderer/desktop-api";

const { MSysApi } = window.myde;

class RemoteDesktop {
    private render: RemoteRender;
    private server: ReturnType<typeof MSysApi.server>;
    private remoteServer: RemoteServer;

    constructor() {
        // 创建WebSocket服务器
        this.remoteServer = new RemoteServer(8080);

        // 创建远程渲染器
        this.render = new RemoteRender(this.remoteServer);

        // 创建wayland服务器
        this.server = MSysApi.server({ render: this.render });

        // 设置启动应用处理器
        this.remoteServer.setRunAppHandler((command: string) => {
            this.server.runApp(command);
        });

        // 启动WebSocket服务器
        this.remoteServer.start();

        this.setupServerEvents();
    }

    private setupServerEvents() {
        this.server.server.on("newClient", (client, clientId) => {
            console.log(`New client connected: ${clientId}`);

            client.onSync("windowBound", () => {
                return { width: 1920, height: 1080 };
            });

            client.on("windowCreated", (windowId, renderId) => {
                console.log(`Client ${clientId} created window ${windowId}`, renderId);
                client.win(windowId)?.focus();
            });

            client.on("windowClosed", (windowId) => {
                console.log(`Client ${clientId} closed window ${windowId}`);
            });

            client.on("windowMaximized", (windowId) => {
                const xwin = client.win(windowId);
                if (!xwin) return;

                const width = 1920;
                const height = 1080;
                xwin.maximize(width, height);
            });
        });

        this.server.server.on("clientClose", (_, clientId) => {
            console.log(`Client ${clientId} disconnected`);
        });
    }
}

// 初始化远程桌面
new RemoteDesktop();
