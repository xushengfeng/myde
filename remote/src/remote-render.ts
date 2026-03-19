import type { renderTools, renderToolsOn } from "../../src/renderer/view/render_tools";
import type { RemoteServer } from "./server";

interface CanvasState {
    canvas: OffscreenCanvas;
    context: OffscreenCanvasRenderingContext2D;
    width: number;
    height: number;
}

interface SurfaceState {
    canvasId: string;
    isToplevel: boolean;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
}

interface PopupState {
    popupId: string;
    parentId: string;
    x: number;
    y: number;
}

export class RemoteRender implements renderTools {
    private canvasMap = new Map<string, CanvasState>();
    private surfaceMap = new Map<string, SurfaceState>();
    private popupMap = new Map<string, PopupState>();
    private toplevels = new Set<string>();
    private _on: renderToolsOn = {};
    private idGen = 0;
    private server: RemoteServer;

    constructor(server: RemoteServer) {
        this.server = server;

        // 设置新客户端连接时的状态恢复
        server.setOnNewClient((ws) => {
            this.sendFullState(ws);
        });
    }

    on(op?: renderToolsOn): void {
        if (op) {
            this._on = { ...this._on, ...op };
        }
    }

    idScope(): (id: unknown) => string {
        const baseId = this.idGen++;
        return (id: unknown) => `${baseId}-${String(id)}`;
    }

    bindCanvas(id: string) {
        const canvas = new OffscreenCanvas(1, 1);
        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("Could not get 2D context");
        }
        this.canvasMap.set(id, { canvas, context, width: 1, height: 1 });

        this.server.broadcast({
            type: "bindCanvas",
            canvasId: id,
        });
    }

    renderCanvas(canvas: OffscreenCanvas, id: string) {
        const canvasData = this.canvasMap.get(id);
        if (!canvasData) {
            console.error("Canvas element not found for id:", id);
            return;
        }

        canvasData.canvas.width = canvas.width;
        canvasData.canvas.height = canvas.height;
        canvasData.width = canvas.width;
        canvasData.height = canvas.height;
        canvasData.context.clearRect(0, 0, canvas.width, canvas.height);
        canvasData.context.drawImage(canvas, 0, 0);

        this.sendCanvasData(id, canvasData.canvas);
    }

    private sendCanvasData(canvasId: string, canvas: OffscreenCanvas, ws?: any) {
        const context = canvas.getContext("2d");
        if (!context) return;

        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const message = {
            type: "canvas",
            canvasId,
            width: canvas.width,
            height: canvas.height,
            data: Array.from(imageData.data),
        };

        if (ws) {
            ws.send(JSON.stringify(message));
        } else {
            this.server.broadcast(message);
        }
    }

    destroyCanvas(id: string): void {
        this.canvasMap.delete(id);

        this.server.broadcast({
            type: "destroyCanvas",
            canvasId: id,
        });
    }

    setCanvasAnchor(id: string, parentId: string) {
        this.server.broadcast({
            type: "setCanvasAnchor",
            canvasId: id,
            parentId,
        });
    }

    setCanvasOffset(id: string, x: number, y: number) {
        this.server.broadcast({
            type: "setCanvasOffset",
            canvasId: id,
            x,
            y,
        });
    }

    setBufferOffset(id: string, x: number, y: number): void {
        this.server.broadcast({
            type: "setBufferOffset",
            canvasId: id,
            x,
            y,
        });
    }

    createXdgSurfaceEle(id: string, canvasId: string) {
        this.surfaceMap.set(id, {
            canvasId,
            isToplevel: false,
            width: 0,
            height: 0,
            offsetX: 0,
            offsetY: 0,
        });

        this.server.broadcast({
            type: "createXdgSurfaceEle",
            surfaceId: id,
            canvasId,
        });
    }

    getXdgSurfaceEle(id: string) {
        return {
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
        };
    }

    destroyXdgSurfaceEle(id: string, type: "toplevel" | "popup"): void {
        const surface = this.surfaceMap.get(id);
        if (surface) {
            this.server.broadcast({
                type: "destroyXdgSurfaceEle",
                surfaceId: id,
                surfaceType: type,
            });

            this.surfaceMap.delete(id);
            this.toplevels.delete(id);

            // 清理关联的 popup
            for (const [popupId, popup] of this.popupMap) {
                if (popup.parentId === id) {
                    this.popupMap.delete(popupId);
                }
            }
        }
    }

    setXdgSurfaceGeo(id: string, width: number, height: number, offsetX: number, offsetY: number) {
        const surface = this.surfaceMap.get(id);
        if (surface) {
            surface.width = width;
            surface.height = height;
            surface.offsetX = offsetX;
            surface.offsetY = offsetY;
        }

        this.server.broadcast({
            type: "setXdgSurfaceGeo",
            surfaceId: id,
            width,
            height,
            offsetX,
            offsetY,
        });
    }

    asToplevel(id: string) {
        const surface = this.surfaceMap.get(id);
        if (surface) {
            surface.isToplevel = true;
            this.toplevels.add(id);

            if (this._on.onToplevelCreate) {
                this._on.onToplevelCreate(id);
            }
        }

        this.server.broadcast({
            type: "asToplevel",
            surfaceId: id,
        });
    }

    addPopupToXdgSurface(popupId: string, toplevelId: string) {
        this.popupMap.set(popupId, {
            popupId,
            parentId: toplevelId,
            x: 0,
            y: 0,
        });

        this.server.broadcast({
            type: "addPopupToXdgSurface",
            popupId,
            toplevelId,
        });
    }

    setPopupPosi(popupId: string, x: number, y: number) {
        const popup = this.popupMap.get(popupId);
        if (popup) {
            popup.x = x;
            popup.y = y;
        }

        this.server.broadcast({
            type: "setPopupPosi",
            popupId,
            x,
            y,
        });
    }

    // 获取所有 toplevel 的渲染 ID
    public getToplevelIds(): string[] {
        return Array.from(this.toplevels);
    }

    // 发送完整状态到新连接的客户端
    private sendFullState(ws: any) {
        console.log("Sending full state to new client");

        // 发送所有 canvas
        for (const [id, state] of this.canvasMap) {
            ws.send(JSON.stringify({ type: "bindCanvas", canvasId: id }));
            if (state.width > 0 && state.height > 0) {
                this.sendCanvasData(id, state.canvas, ws);
            }
        }

        // 发送所有 surface
        for (const [id, state] of this.surfaceMap) {
            ws.send(
                JSON.stringify({
                    type: "createXdgSurfaceEle",
                    surfaceId: id,
                    canvasId: state.canvasId,
                }),
            );

            if (state.isToplevel) {
                ws.send(JSON.stringify({ type: "asToplevel", surfaceId: id }));
            }

            if (state.width > 0 && state.height > 0) {
                ws.send(
                    JSON.stringify({
                        type: "setXdgSurfaceGeo",
                        surfaceId: id,
                        width: state.width,
                        height: state.height,
                        offsetX: state.offsetX,
                        offsetY: state.offsetY,
                    }),
                );
            }
        }

        // 发送所有 popup
        for (const [id, state] of this.popupMap) {
            ws.send(
                JSON.stringify({
                    type: "addPopupToXdgSurface",
                    popupId: state.popupId,
                    toplevelId: state.parentId,
                }),
            );

            ws.send(
                JSON.stringify({
                    type: "setPopupPosi",
                    popupId: state.popupId,
                    x: state.x,
                    y: state.y,
                }),
            );
        }
    }
}
