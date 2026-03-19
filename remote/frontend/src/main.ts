interface CanvasData {
    type: string;
    canvasId?: string;
    width?: number;
    height?: number;
    data?: number[];
    parentId?: string;
    x?: number;
    y?: number;
    surfaceId?: string;
    surfaceType?: string;
    popupId?: string;
    toplevelId?: string;
}

class RemoteDesktopClient {
    private ws: WebSocket | null = null;
    private canvasMap = new Map<string, HTMLCanvasElement>();
    private container: HTMLElement;
    private statusElement: HTMLElement;
    private selectedWindow: string | null = null;

    constructor() {
        this.container = document.getElementById("desktop") || document.body;
        this.statusElement = document.getElementById("status") || document.body;
        this.setupEventListeners();
    }

    public connect() {
        const wsUrl = `ws://localhost:8080`;
        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = "arraybuffer";

        this.ws.onopen = () => {
            console.log("WebSocket connected to server");
            this.updateStatus("Connected", true);
        };

        this.ws.onmessage = (event) => {
            this.handleMessage(event.data);
        };

        this.ws.onclose = () => {
            console.log("WebSocket disconnected");
            this.updateStatus("Disconnected", false);
            // 尝试重新连接
            setTimeout(() => this.connect(), 3000);
        };

        this.ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            this.updateStatus("Error", false);
        };
    }

    public disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    public runApp(command: string) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(
                JSON.stringify({
                    type: "runApp",
                    command,
                }),
            );
        }
    }

    private updateStatus(status: string, connected: boolean) {
        this.statusElement.textContent = status;
        this.statusElement.className = connected ? "connected" : "disconnected";
    }

    private handleMessage(data: any) {
        try {
            const message: CanvasData = JSON.parse(data);

            switch (message.type) {
                case "bindCanvas":
                    if (message.canvasId) {
                        this.createCanvas(message.canvasId);
                    }
                    break;

                case "canvas":
                    if (message.canvasId && message.width && message.height && message.data) {
                        this.updateCanvas(message.canvasId, message.width, message.height, message.data);
                    }
                    break;

                case "destroyCanvas":
                    if (message.canvasId) {
                        this.destroyCanvas(message.canvasId);
                    }
                    break;

                case "setCanvasAnchor":
                    if (message.canvasId && message.parentId) {
                        this.setCanvasAnchor(message.canvasId, message.parentId);
                    }
                    break;

                case "setCanvasOffset":
                    if (message.canvasId && message.x !== undefined && message.y !== undefined) {
                        this.setCanvasOffset(message.canvasId, message.x, message.y);
                    }
                    break;

                case "setBufferOffset":
                    if (message.canvasId && message.x !== undefined && message.y !== undefined) {
                        this.setBufferOffset(message.canvasId, message.x, message.y);
                    }
                    break;

                case "createXdgSurfaceEle":
                    if (message.surfaceId && message.canvasId) {
                        this.createXdgSurface(message.surfaceId, message.canvasId);
                    }
                    break;

                case "destroyXdgSurfaceEle":
                    if (message.surfaceId) {
                        this.destroyXdgSurface(message.surfaceId);
                    }
                    break;

                case "setXdgSurfaceGeo":
                    if (
                        message.surfaceId &&
                        message.width &&
                        message.height &&
                        message.x !== undefined &&
                        message.y !== undefined
                    ) {
                        this.setXdgSurfaceGeo(message.surfaceId, message.width, message.height, message.x, message.y);
                    }
                    break;

                case "asToplevel":
                    if (message.surfaceId) {
                        this.asToplevel(message.surfaceId);
                    }
                    break;

                case "addPopupToXdgSurface":
                    if (message.popupId && message.toplevelId) {
                        this.addPopupToXdgSurface(message.popupId, message.toplevelId);
                    }
                    break;

                case "setPopupPosi":
                    if (message.popupId && message.x !== undefined && message.y !== undefined) {
                        this.setPopupPosi(message.popupId, message.x, message.y);
                    }
                    break;
            }
        } catch (error) {
            console.error("Error parsing message:", error);
        }
    }

    private createCanvas(canvasId: string) {
        const canvas = document.createElement("canvas");
        canvas.id = canvasId;
        canvas.style.position = "absolute";
        this.container.appendChild(canvas);
        this.canvasMap.set(canvasId, canvas);
    }

    private updateCanvas(canvasId: string, width: number, height: number, data: number[]) {
        if (width <= 0 || height <= 0 || !data || data.length === 0) return;

        const canvas = this.canvasMap.get(canvasId);
        if (!canvas || !canvas.isConnected) {
            // canvas不存在或已从DOM移除，自动创建
            this.createCanvas(canvasId);
            return this.updateCanvas(canvasId, width, height, data);
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // 将数据转换为ImageData
        const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
        ctx.putImageData(imageData, 0, 0);
    }

    private destroyCanvas(canvasId: string) {
        const canvas = this.canvasMap.get(canvasId);
        if (canvas) {
            canvas.remove();
            this.canvasMap.delete(canvasId);
        }
    }

    private setCanvasAnchor(canvasId: string, parentId: string) {
        const canvas = this.canvasMap.get(canvasId);
        const parent = this.canvasMap.get(parentId);
        if (canvas && parent) {
            parent.parentElement?.appendChild(canvas);
        }
    }

    private setCanvasOffset(canvasId: string, x: number, y: number) {
        const canvas = this.canvasMap.get(canvasId);
        if (canvas) {
            canvas.style.left = `${x}px`;
            canvas.style.top = `${y}px`;
        }
    }

    private setBufferOffset(canvasId: string, x: number, y: number) {
        const canvas = this.canvasMap.get(canvasId);
        if (canvas) {
            canvas.style.left = `${x}px`;
            canvas.style.top = `${y}px`;
        }
    }

    private createXdgSurface(surfaceId: string, canvasId: string) {
        const canvas = this.canvasMap.get(canvasId);
        if (!canvas) return;

        const surface = document.createElement("div");
        surface.id = surfaceId;
        surface.className = "canvas-container";
        surface.appendChild(canvas);
        this.container.appendChild(surface);
    }

    private destroyXdgSurface(surfaceId: string) {
        const surface = document.getElementById(surfaceId);
        if (surface) {
            surface.remove();
        }
    }

    private setXdgSurfaceGeo(surfaceId: string, width: number, height: number, offsetX: number, offsetY: number) {
        const surface = document.getElementById(surfaceId);
        if (surface) {
            surface.style.width = `${width}px`;
            surface.style.height = `${height}px`;
            surface.style.left = `${offsetX}px`;
            surface.style.top = `${offsetY}px`;
        }
    }

    private asToplevel(surfaceId: string) {}

    private addPopupToXdgSurface(popupId: string, toplevelId: string) {
        const popup = document.getElementById(popupId);
        const toplevel = document.getElementById(toplevelId);
        if (popup && toplevel) {
            toplevel.appendChild(popup);
        }
    }

    private setPopupPosi(popupId: string, x: number, y: number) {
        const popup = document.getElementById(popupId);
        if (popup) {
            popup.style.position = "absolute";
            popup.style.left = `${x}px`;
            popup.style.top = `${y}px`;
        }
    }

    private setupEventListeners() {
        // 处理鼠标事件
        this.container.addEventListener("pointerdown", (e) => {
            this.sendInputEvent({
                type: "pointerdown",
                x: e.clientX,
                y: e.clientY,
                button: e.button,
            });
        });

        this.container.addEventListener("pointerup", (e) => {
            this.sendInputEvent({
                type: "pointerup",
                x: e.clientX,
                y: e.clientY,
                button: e.button,
            });
        });

        this.container.addEventListener("pointermove", (e) => {
            this.sendInputEvent({
                type: "pointermove",
                x: e.clientX,
                y: e.clientY,
            });
        });

        // 处理键盘事件
        document.addEventListener("keydown", (e) => {
            this.sendInputEvent({
                type: "keydown",
                code: e.code,
                key: e.key,
            });
        });

        document.addEventListener("keyup", (e) => {
            this.sendInputEvent({
                type: "keyup",
                code: e.code,
                key: e.key,
            });
        });

        // 处理滚轮事件
        this.container.addEventListener("wheel", (e) => {
            this.sendInputEvent({
                type: "wheel",
                deltaX: e.deltaX,
                deltaY: e.deltaY,
            });
        });

        // 设置按钮事件
        const connectButton = document.getElementById("connect");
        const disconnectButton = document.getElementById("disconnect");
        const refreshButton = document.getElementById("refresh");
        const runAppButton = document.getElementById("run-app");
        const appCommandInput = document.getElementById("app-command") as HTMLInputElement;

        if (connectButton) {
            connectButton.addEventListener("click", () => this.connect());
        }

        if (disconnectButton) {
            disconnectButton.addEventListener("click", () => this.disconnect());
        }

        if (refreshButton) {
            refreshButton.addEventListener("click", () => {
                this.container.innerHTML = "";
                this.canvasMap.clear();
            });
        }

        if (runAppButton && appCommandInput) {
            runAppButton.addEventListener("click", () => {
                const command = appCommandInput.value.trim();
                if (command) {
                    this.runApp(command);
                    appCommandInput.value = "";
                }
            });

            appCommandInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    const command = appCommandInput.value.trim();
                    if (command) {
                        this.runApp(command);
                        appCommandInput.value = "";
                    }
                }
            });
        }
    }

    private sendInputEvent(event: any) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(
                JSON.stringify({
                    type: "inputEvent",
                    event,
                }),
            );
        }
    }
}

// 初始化远程桌面客户端
document.addEventListener("DOMContentLoaded", () => {
    const client = new RemoteDesktopClient();
    // 自动连接
    client.connect();
});
