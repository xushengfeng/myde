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
    private toplevels = new Map<string, { surfaceId: string }>();
    private _on: renderToolsOn = {};
    private idGen = 0;
    private server: RemoteServer;

    constructor(server: RemoteServer) {
        this.server = server;

        server.setOnNewClient((ws, toplevelId) => {
            if (toplevelId) {
                // render客户端，发送该toplevel的状态
                this.sendStateForToplevel(ws, toplevelId);
            } else {
                // launcher客户端，发送toplevel列表
                this.sendToplevelList(ws);
            }
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

        // 广播给所有客户端
        this.server.broadcast({ type: "bindCanvas", canvasId: id });
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

        this.sendCanvasData(id, canvasData);
    }

    private sendCanvasData(canvasId: string, canvasData: CanvasState, ws?: any) {
        const context = canvasData.canvas.getContext("2d");
        if (!context) return;

        const imageData = context.getImageData(0, 0, canvasData.canvas.width, canvasData.canvas.height);
        const message = {
            type: "canvas",
            canvasId,
            width: canvasData.canvas.width,
            height: canvasData.canvas.height,
            data: Array.from(imageData.data),
        };

        if (ws) {
            this.server.sendTo(ws, message);
        } else {
            this.server.broadcast(message);
        }
    }

    destroyCanvas(id: string): void {
        this.canvasMap.delete(id);
        this.server.broadcast({ type: "destroyCanvas", canvasId: id });
    }

    setCanvasAnchor(id: string, parentId: string) {
        this.server.broadcast({ type: "setCanvasAnchor", canvasId: id, parentId });
    }

    setCanvasOffset(id: string, x: number, y: number) {
        this.server.broadcast({ type: "setCanvasOffset", canvasId: id, x, y });
    }

    setBufferOffset(id: string, x: number, y: number): void {
        this.server.broadcast({ type: "setBufferOffset", canvasId: id, x, y });
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

        this.server.broadcast({ type: "createXdgSurfaceEle", surfaceId: id, canvasId });
    }

    getXdgSurfaceEle(id: string) {
        return {
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
        };
    }

    destroyXdgSurfaceEle(id: string, type: "toplevel" | "popup"): void {
        const surface = this.surfaceMap.get(id);
        if (surface) {
            if (type === "toplevel") {
                if (this._on.onToplevelRemove) {
                    this._on.onToplevelRemove(id);
                }
                this.toplevels.delete(id);
                this.sendToplevelListToAll();
            }

            this.server.broadcast({
                type: "destroyXdgSurfaceEle",
                surfaceId: id,
                surfaceType: type,
            });

            this.surfaceMap.delete(id);

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
            this.toplevels.set(id, { surfaceId: id });

            if (this._on.onToplevelCreate) {
                this._on.onToplevelCreate(id);
            }

            this.sendToplevelListToAll();
        }

        this.server.broadcast({ type: "asToplevel", surfaceId: id });
    }

    addPopupToXdgSurface(popupId: string, toplevelId: string) {
        this.popupMap.set(popupId, { popupId, parentId: toplevelId, x: 0, y: 0 });
        this.server.broadcast({ type: "addPopupToXdgSurface", popupId, toplevelId });
    }

    setPopupPosi(popupId: string, x: number, y: number) {
        const popup = this.popupMap.get(popupId);
        if (popup) {
            popup.x = x;
            popup.y = y;
        }
        this.server.broadcast({ type: "setPopupPosi", popupId, x, y });
    }

    public getToplevels(): Array<{ id: string; surfaceId: string }> {
        return Array.from(this.toplevels.entries()).map(([id, { surfaceId }]) => ({ id, surfaceId }));
    }

    private sendToplevelList(ws: any) {
        const list = this.getToplevels();
        this.server.sendTo(ws, { type: "toplevelList", toplevels: list });
    }

    private sendToplevelListToAll() {
        const list = this.getToplevels();
        this.server.broadcast({ type: "toplevelList", toplevels: list });
    }

    private sendStateForToplevel(ws: any, toplevelId: string) {
        console.log(`Sending state for toplevel ${toplevelId}`);

        // 找到toplevel对应的surface
        const toplevel = this.toplevels.get(toplevelId);
        if (!toplevel) {
            console.log(`Toplevel ${toplevelId} not found`);
            return;
        }

        // 发送该toplevel相关的所有状态
        for (const [id, state] of this.surfaceMap) {
            if (id === toplevelId) {
                this.server.sendTo(ws, { type: "bindCanvas", canvasId: state.canvasId });

                const canvasState = this.canvasMap.get(state.canvasId);
                if (canvasState && canvasState.width > 0 && canvasState.height > 0) {
                    this.sendCanvasData(state.canvasId, canvasState, ws);
                }

                this.server.sendTo(ws, {
                    type: "createXdgSurfaceEle",
                    surfaceId: id,
                    canvasId: state.canvasId,
                });

                if (state.isToplevel) {
                    this.server.sendTo(ws, { type: "asToplevel", surfaceId: id });
                }

                if (state.width > 0 && state.height > 0) {
                    this.server.sendTo(ws, {
                        type: "setXdgSurfaceGeo",
                        surfaceId: id,
                        width: state.width,
                        height: state.height,
                        offsetX: state.offsetX,
                        offsetY: state.offsetY,
                    });
                }
            }
        }

        for (const [id, state] of this.popupMap) {
            if (state.parentId === toplevelId) {
                this.server.sendTo(ws, {
                    type: "addPopupToXdgSurface",
                    popupId: state.popupId,
                    toplevelId,
                });
                this.server.sendTo(ws, {
                    type: "setPopupPosi",
                    popupId: state.popupId,
                    x: state.x,
                    y: state.y,
                });
            }
        }
    }
}
