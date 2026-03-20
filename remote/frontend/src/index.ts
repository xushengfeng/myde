interface CanvasData {
    type: string;
    canvasId?: string;
    width?: number;
    height?: number;
    data?: number[];
    parentId?: string;
    x?: number;
    y?: number;
    offsetX?: number;
    offsetY?: number;
    surfaceId?: string;
    surfaceType?: string;
    popupId?: string;
    toplevelId?: string;
    toplevels?: Array<{ id: string; surfaceId: string }>;
}

class RemoteDesktop {
    private ws: WebSocket | null = null;
    private canvasMap = new Map<string, HTMLCanvasElement>();
    private toplevels = new Set<string>();
    private mode: "launcher" | "render" = "launcher";
    private toplevelId: string | null = null;

    constructor() {
        // 从URL判断模式
        const urlParams = new URLSearchParams(window.location.search);
        this.toplevelId = urlParams.get("toplevelId");

        if (this.toplevelId) {
            this.mode = "render";
            document.title = `Render: ${this.toplevelId}`;
            this.showView("render");
        } else {
            this.mode = "launcher";
            document.title = "MyDE Remote Desktop - Launcher";
            this.showView("launcher");
            this.setupLauncherEvents();
        }

        this.connect();
    }

    private showView(mode: "launcher" | "render") {
        const launcherView = document.getElementById("launcher-view");
        const renderView = document.getElementById("render-view");

        if (mode === "launcher") {
            if (launcherView) launcherView.style.display = "block";
            if (renderView) renderView.style.display = "none";
        } else {
            if (launcherView) launcherView.style.display = "none";
            if (renderView) renderView.style.display = "block";
        }
    }

    private connect() {
        const wsUrl = `ws://${location.hostname}:8080`;
        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = "arraybuffer";

        this.ws.onopen = () => {
            console.log("WebSocket connected");
            this.updateStatus("Connected", true);

            // 注册客户端类型
            this.ws?.send(
                JSON.stringify({
                    type: "register",
                    clientType: this.mode,
                    toplevelId: this.toplevelId,
                }),
            );
        };

        this.ws.onmessage = (event) => {
            this.handleMessage(event.data);
        };

        this.ws.onclose = () => {
            console.log("WebSocket disconnected");
            this.updateStatus("Disconnected", false);
            setTimeout(() => this.connect(), 3000);
        };

        this.ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            this.updateStatus("Error", false);
        };
    }

    private updateStatus(status: string, connected: boolean) {
        const statusElement = document.querySelector(`#${this.mode}-view #status`);
        if (statusElement) {
            statusElement.textContent = status;
            statusElement.className = connected ? "connected" : "disconnected";
        }
    }

    private handleMessage(data: any) {
        try {
            const message: CanvasData = JSON.parse(data);

            switch (message.type) {
                // Launcher messages
                case "toplevelList":
                    if (this.mode === "launcher" && message.toplevels) {
                        this.updateToplevelList(message.toplevels);
                    }
                    break;

                case "asToplevel":
                    if (this.mode === "launcher" && message.toplevelId) {
                        this.addToplevel(message.toplevelId);
                    }
                    break;

                case "destroyXdgSurfaceEle":
                    if (this.mode === "launcher" && message.surfaceType === "toplevel") {
                        this.removeToplevel(message.surfaceId || "");
                    } else if (this.mode === "render" && message.surfaceId) {
                        this.destroyXdgSurface(message.surfaceId);
                    }
                    break;

                // Render messages
                case "bindCanvas":
                    if (this.mode === "render" && message.canvasId) {
                        this.createCanvas(message.canvasId);
                    }
                    break;

                case "canvas":
                    if (this.mode === "render" && message.canvasId && message.width && message.height && message.data) {
                        this.updateCanvas(message.canvasId, message.width, message.height, message.data);
                    }
                    break;

                case "destroyCanvas":
                    if (this.mode === "render" && message.canvasId) {
                        this.destroyCanvas(message.canvasId);
                    }
                    break;

                case "setCanvasAnchor":
                    if (this.mode === "render" && message.canvasId && message.parentId) {
                        this.setCanvasAnchor(message.canvasId, message.parentId);
                    }
                    break;

                case "setCanvasOffset":
                    if (
                        this.mode === "render" &&
                        message.canvasId &&
                        message.x !== undefined &&
                        message.y !== undefined
                    ) {
                        this.setCanvasOffset(message.canvasId, message.x, message.y);
                    }
                    break;

                case "setBufferOffset":
                    if (
                        this.mode === "render" &&
                        message.canvasId &&
                        message.x !== undefined &&
                        message.y !== undefined
                    ) {
                        this.setBufferOffset(message.canvasId, message.x, message.y);
                    }
                    break;

                case "createXdgSurfaceEle":
                    if (this.mode === "render" && message.surfaceId && message.canvasId) {
                        const desktop = document.getElementById("desktop");
                        if (!desktop?.innerHTML)
                            // 渲染好的界面不需要添加其他窗口了
                            this.createXdgSurface(message.surfaceId, message.canvasId);
                    }
                    break;

                case "setXdgSurfaceGeo":
                    if (
                        this.mode === "render" &&
                        message.surfaceId &&
                        message.width &&
                        message.height &&
                        message.offsetX !== undefined &&
                        message.offsetY !== undefined
                    ) {
                        this.setXdgSurfaceGeo(
                            message.surfaceId,
                            message.width,
                            message.height,
                            message.offsetX,
                            message.offsetY,
                        );
                    }
                    break;

                case "addPopupToXdgSurface":
                    if (this.mode === "render" && message.popupId && message.toplevelId) {
                        this.addPopupToXdgSurface(message.popupId, message.toplevelId);
                    }
                    break;

                case "setPopupPosi":
                    if (
                        this.mode === "render" &&
                        message.popupId &&
                        message.x !== undefined &&
                        message.y !== undefined
                    ) {
                        this.setPopupPosi(message.popupId, message.x, message.y);
                    }
                    break;
            }
        } catch (error) {
            console.error("Error parsing message:", error);
        }
    }

    // Launcher methods
    private updateToplevelList(toplevels: Array<{ id: string; surfaceId: string }>) {
        this.toplevels.clear();
        for (const t of toplevels) {
            this.toplevels.add(t.id);
        }
        this.renderToplevelList();
    }

    private addToplevel(toplevelId: string) {
        if (!this.toplevels.has(toplevelId)) {
            this.toplevels.add(toplevelId);
            this.renderToplevelList();
        }
    }

    private removeToplevel(toplevelId: string) {
        if (this.toplevels.has(toplevelId)) {
            this.toplevels.delete(toplevelId);
            this.renderToplevelList();
        }
    }

    private renderToplevelList() {
        const container = document.getElementById("toplevel-list");
        if (!container) return;

        if (this.toplevels.size === 0) {
            container.innerHTML = '<div style="color: #666; font-size: 14px;">No windows</div>';
            return;
        }

        container.innerHTML = "";
        for (const toplevelId of this.toplevels) {
            const item = document.createElement("div");
            item.className = "toplevel-item";
            item.innerHTML = `
                <div class="id">${toplevelId}</div>
                <div style="display: flex; gap: 4px;">
                    <button class="open-btn">Open in new tab</button>
                    <button class="close-btn">Close</button>
                </div>
            `;

            const openBtn = item.querySelector(".open-btn");
            if (openBtn) {
                openBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this.openToplevel(toplevelId);
                });
            }

            const closeBtn = item.querySelector(".close-btn");
            if (closeBtn) {
                closeBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this.closeToplevel(toplevelId);
                });
            }

            item.addEventListener("click", () => {
                this.openToplevel(toplevelId);
            });

            container.appendChild(item);
        }
    }

    private openToplevel(toplevelId: string) {
        const url = `/?toplevelId=${encodeURIComponent(toplevelId)}`;
        window.open(url, "_blank");
    }

    private closeToplevel(toplevelId: string) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "closeWindow", toplevelId }));
        }
    }

    private runApp(command: string) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "runApp", command }));
        }
    }

    private setupLauncherEvents() {
        const runAppButton = document.getElementById("run-app");
        const appCommandInput = document.getElementById("app-command") as HTMLInputElement;

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

    // Render methods
    private createCanvas(canvasId: string) {
        if (this.canvasMap.has(canvasId)) return;

        const canvas = document.createElement("canvas");
        canvas.id = canvasId;
        canvas.style.position = "absolute";
        this.canvasMap.set(canvasId, canvas);
    }

    private updateCanvas(canvasId: string, width: number, height: number, data: number[]) {
        if (width <= 0 || height <= 0 || !data || data.length === 0) return;

        let canvas = this.canvasMap.get(canvasId);
        if (!canvas || !canvas.isConnected) {
            this.createCanvas(canvasId);
            canvas = this.canvasMap.get(canvasId);
        }

        if (!canvas) return;

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

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

        const desktop = document.getElementById("desktop");
        if (desktop) {
            desktop.appendChild(surface);
        }
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
            const canvas = surface.querySelector("canvas");
            if (canvas) {
                canvas.style.left = `-${offsetX}px`;
                canvas.style.top = `-${offsetY}px`;
            }
        }
    }

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

    sendInputEvent(event: any) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "inputEvent", event }));
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const app = new RemoteDesktop();

    // 如果是render模式，设置输入事件监听
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("toplevelId")) {
        const desktop = document.getElementById("desktop");
        if (desktop) {
            desktop.addEventListener("pointerdown", (e) => {
                app.sendInputEvent({
                    type: "pointerdown",
                    x: e.clientX,
                    y: e.clientY,
                    button: e.button,
                });
            });

            desktop.addEventListener("pointerup", (e) => {
                app.sendInputEvent({
                    type: "pointerup",
                    x: e.clientX,
                    y: e.clientY,
                    button: e.button,
                });
            });

            desktop.addEventListener("pointermove", (e) => {
                app.sendInputEvent({
                    type: "pointermove",
                    x: e.clientX,
                    y: e.clientY,
                });
            });

            desktop.addEventListener("wheel", (e) => {
                app.sendInputEvent({
                    type: "wheel",
                    deltaX: e.deltaX,
                    deltaY: e.deltaY,
                });
            });

            document.addEventListener("keydown", (e) => {
                app.sendInputEvent({
                    type: "keydown",
                    code: e.code,
                    key: e.key,
                });
            });

            document.addEventListener("keyup", (e) => {
                app.sendInputEvent({
                    type: "keyup",
                    code: e.code,
                    key: e.key,
                });
            });
        }
    }
});
