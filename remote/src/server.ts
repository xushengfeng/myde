const { createServer } = require("http") as typeof import("http");
const { WebSocket, WebSocketServer } = require("ws") as typeof import("ws");

type WebSocketType = import("ws").WebSocket;

interface ClientInfo {
    ws: WebSocketType;
    type: "launcher" | "render";
    toplevelId: string | null;
}

export class RemoteServer {
    private wss: InstanceType<typeof WebSocketServer>;
    private server: ReturnType<typeof createServer>;
    private port: number;
    private clients = new Map<WebSocketType, ClientInfo>();
    private onInputEvent: ((event: any, toplevelId: string | null) => void) | null = null;
    private onRunApp: ((command: string) => void) | null = null;
    private onNewClient: ((ws: WebSocketType, toplevelId: string | null) => void) | null = null;
    private onCloseWindow: ((toplevelId: string) => void) | null = null;

    constructor(port: number = 8080) {
        this.port = port;
        this.server = createServer();
        this.wss = new WebSocketServer({ server: this.server });
        this.setupWebSocket();
    }

    private setupWebSocket() {
        this.wss.on("connection", (ws: WebSocketType) => {
            // 默认为launcher
            const clientInfo: ClientInfo = { ws, type: "launcher", toplevelId: null };
            this.clients.set(ws, clientInfo);
            console.log("New WebSocket connection");

            ws.on("message", (message: Buffer) => {
                try {
                    const data = JSON.parse(message.toString());
                    this.handleWebSocketMessage(ws, data, clientInfo);
                } catch (error) {
                    console.error("Error parsing WebSocket message:", error);
                }
            });

            ws.on("close", () => {
                this.clients.delete(ws);
                console.log("WebSocket connection closed");
            });
        });
    }

    private handleWebSocketMessage(ws: WebSocketType, data: any, clientInfo: ClientInfo) {
        switch (data.type) {
            case "register":
                // 客户端注册自己的类型和toplevelId
                clientInfo.type = data.clientType || "launcher";
                clientInfo.toplevelId = data.toplevelId || null;
                console.log(
                    `Client registered as ${clientInfo.type}${clientInfo.toplevelId ? ` for toplevel ${clientInfo.toplevelId}` : ""}`,
                );

                if (this.onNewClient) {
                    this.onNewClient(ws, clientInfo.toplevelId);
                }
                break;

            case "inputEvent":
                if (this.onInputEvent) {
                    this.onInputEvent(data.event, clientInfo.toplevelId);
                }
                break;

            case "runApp":
                if (data.command && this.onRunApp) {
                    console.log("Run app:", data.command);
                    this.onRunApp(data.command);
                }
                break;

            case "closeWindow":
                if (data.toplevelId && this.onCloseWindow) {
                    console.log("Close window:", data.toplevelId);
                    this.onCloseWindow(data.toplevelId);
                }
                break;
        }
    }

    public setInputHandler(handler: (event: any, toplevelId: string | null) => void) {
        this.onInputEvent = handler;
    }

    public setRunAppHandler(handler: (command: string) => void) {
        this.onRunApp = handler;
    }

    public setOnNewClient(handler: (ws: WebSocketType, toplevelId: string | null) => void) {
        this.onNewClient = handler;
    }

    public setCloseWindowHandler(handler: (toplevelId: string) => void) {
        this.onCloseWindow = handler;
    }

    // 广播消息，可指定toplevelId过滤
    public broadcast(message: any, toplevelId?: string | null) {
        const msgStr = JSON.stringify(message);

        this.clients.forEach((client, ws) => {
            if (ws.readyState !== WebSocket.OPEN) return;

            // launcher接收所有消息
            if (client.type === "launcher") {
                ws.send(msgStr);
                return;
            }

            // render只接收自己的toplevel消息
            if (client.type === "render") {
                if (toplevelId && client.toplevelId === toplevelId) {
                    ws.send(msgStr);
                } else if (!toplevelId) {
                    ws.send(msgStr);
                }
            }
        });
    }

    // 发送消息给特定客户端
    public sendTo(ws: WebSocketType, message: any) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }

    // 获取所有launcher客户端
    public getLauncherClients(): WebSocketType[] {
        const result: WebSocketType[] = [];
        this.clients.forEach((client, ws) => {
            if (client.type === "launcher") {
                result.push(ws);
            }
        });
        return result;
    }

    public start() {
        this.server.listen(this.port, () => {
            console.log(`WebSocket server running on ws://localhost:${this.port}`);
        });
    }

    public stop() {
        this.server.close();
    }
}
