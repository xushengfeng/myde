import type {} from "../../src/renderer/desktop-api";
import { RemoteRender } from "./remote-render";
import { RemoteServer } from "./server";

const { MSysApi, MInputMap } = window.myde;

class RemoteDesktop {
    private render: RemoteRender;
    private server: ReturnType<typeof MSysApi.server>;
    private remoteServer: RemoteServer;
    private currentToplevelId: string | null = null;

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

        // 设置输入事件处理器
        this.remoteServer.setInputHandler((event: any, toplevelId: string | null) => {
            this.handleInputEvent(event, toplevelId);
        });

        // 设置关闭窗口处理器
        this.remoteServer.setCloseWindowHandler((toplevelId: string) => {
            this.closeWindow(toplevelId);
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

    private handleInputEvent(event: any, toplevelId: string | null) {
        switch (event.type) {
            case "pointermove":
                this.sendPointerEvent("move", event, toplevelId);
                break;
            case "pointerdown":
                this.sendPointerEvent("down", event, toplevelId);
                break;
            case "pointerup":
                this.sendPointerEvent("up", event, toplevelId);
                break;
            case "wheel":
                this.sendScrollEvent(event, toplevelId);
                break;
            case "keydown":
                this.sendKeyEvent("pressed", event.code);
                break;
            case "keyup":
                this.sendKeyEvent("released", event.code);
                break;
        }
    }

    private sendPointerEvent(
        type: "move" | "down" | "up",
        p: { x: number; y: number; button?: number },
        toplevelId: string | null,
    ) {
        for (const [_id, client] of this.server.server.clients) {
            for (const [winId, _win] of client.getWindows()) {
                const xwin = client.win(winId);
                if (!xwin) continue;

                const renderId = xwin.point.renderId();

                // 如果指定了toplevelId，只处理匹配的窗口
                if (toplevelId && renderId !== toplevelId) continue;

                // 检查鼠标是否在窗口内（简化处理，假设窗口从0,0开始）
                const inWin = xwin.point.inWin({ x: p.x, y: p.y });
                if (!inWin) continue;

                // 发送指针事件
                xwin.point.sendPointerEvent(
                    type,
                    new PointerEvent(`pointer${type}`, {
                        clientX: p.x,
                        clientY: p.y,
                        button: p.button || 0,
                    }),
                );

                // 处理焦点
                if (type === "down") {
                    xwin.focus();
                    client.offerTo();
                    // 模糊其他窗口
                    for (const [otherWinId, _otherWin] of client.getWindows()) {
                        if (otherWinId !== winId) {
                            client.win(otherWinId)?.blur();
                        }
                    }
                }

                break;
            }
        }
    }

    private sendScrollEvent(p: { deltaX: number; deltaY: number }, toplevelId: string | null) {
        for (const [_, client] of this.server.server.clients) {
            for (const [winId, _win] of client.getWindows()) {
                const xwin = client.win(winId);
                if (!xwin) continue;

                const renderId = xwin.point.renderId();

                // 如果指定了toplevelId，只处理匹配的窗口
                if (toplevelId && renderId !== toplevelId) continue;

                // 假设鼠标在窗口内（简化处理）
                xwin.point.sendScrollEvent({
                    p: new WheelEvent("wheel", {
                        deltaX: p.deltaX,
                        deltaY: p.deltaY,
                    }),
                });

                break;
            }
        }
    }

    private sendKeyEvent(state: "pressed" | "released", code: string) {
        const keyCode = MInputMap.mapKeyCode(code);
        for (const [_id, client] of this.server.server.clients) {
            client.keyboard.sendKey(keyCode, state);
        }
    }

    private closeWindow(toplevelId: string) {
        for (const [_id, client] of this.server.server.clients) {
            for (const [winId, _win] of client.getWindows()) {
                const xwin = client.win(winId);
                if (!xwin) continue;

                const renderId = xwin.point.renderId();
                if (renderId === toplevelId) {
                    xwin.close();
                    return;
                }
            }
        }
    }
}

// 初始化远程桌面
new RemoteDesktop();
