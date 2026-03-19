const { createServer } = require("http") as typeof import("http");
const { WebSocket, WebSocketServer } = require("ws") as typeof import("ws");

type WebSocketType = import("ws").WebSocket;

export class RemoteServer {
    private wss: InstanceType<typeof WebSocketServer>;
    private server: ReturnType<typeof createServer>;
    private port: number;
    private onInputEvent: ((event: any) => void) | null = null;
    private onRunApp: ((command: string) => void) | null = null;

    constructor(port: number = 8080) {
        this.port = port;
        this.server = createServer();
        this.wss = new WebSocketServer({ server: this.server });
        this.setupWebSocket();
    }

    private setupWebSocket() {
        this.wss.on("connection", (ws: WebSocketType) => {
            console.log("New WebSocket connection");

            ws.on("message", (message: Buffer) => {
                try {
                    const data = JSON.parse(message.toString());
                    this.handleWebSocketMessage(ws, data);
                } catch (error) {
                    console.error("Error parsing WebSocket message:", error);
                }
            });

            ws.on("close", () => {
                console.log("WebSocket connection closed");
            });
        });
    }

    private handleWebSocketMessage(ws: WebSocketType, data: any) {
        switch (data.type) {
            case "inputEvent":
                if (this.onInputEvent) {
                    this.onInputEvent(data.event);
                }
                break;

            case "runApp":
                if (data.command && this.onRunApp) {
                    console.log("Run app:", data.command);
                    this.onRunApp(data.command);
                }
                break;

            case "listWindows":
                ws.send(JSON.stringify({ type: "windowList", windows: [] }));
                break;
        }
    }

    public setInputHandler(handler: (event: any) => void) {
        this.onInputEvent = handler;
    }

    public setRunAppHandler(handler: (command: string) => void) {
        this.onRunApp = handler;
    }

    public broadcast(message: any) {
        this.wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
            }
        });
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
