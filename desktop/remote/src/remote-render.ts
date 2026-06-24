import type { renderTools, renderToolsOn } from "../../src/view/render_tools";
import type { PeerManager } from "./server";

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
    private server: PeerManager;

    constructor(server: PeerManager) {
        this.server = server;
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

    private findToplevelForCanvas(canvasId: string): string | undefined {
        for (const [id, state] of this.surfaceMap) {
            if (state.canvasId === canvasId && this.toplevels.has(id)) return id;
        }
        return undefined;
    }

    bindCanvas(id: string) {
        const canvas = new OffscreenCanvas(1, 1);
        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("Could not get 2D context");
        }
        this.canvasMap.set(id, { canvas, context, width: 1, height: 1 });

        const tid = this.findToplevelForCanvas(id);
        this.server.broadcast({ type: "bindCanvas", canvasId: id, ...(tid ? { toplevelId: tid } : {}) });
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

        const tid = this.findToplevelForCanvas(id);
        this.sendCanvasData(id, canvasData, undefined, tid);
    }

    private sendCanvasData(canvasId: string, canvasData: CanvasState, peerId?: string, toplevelId?: string) {
        const context = canvasData.canvas.getContext("2d");
        if (!context) return;

        const imageData = context.getImageData(0, 0, canvasData.canvas.width, canvasData.canvas.height);
        const message: any = {
            type: "canvas",
            canvasId,
            width: canvasData.canvas.width,
            height: canvasData.canvas.height,
            data: Array.from(imageData.data), // todo 发送二进制
        };
        if (toplevelId) message.toplevelId = toplevelId;

        if (peerId) {
            this.server.sendMessage(peerId, message);
        } else {
            this.server.broadcast(message);
        }
    }

    destroyCanvas(id: string): void {
        this.canvasMap.delete(id);
        const tid = this.findToplevelForCanvas(id);
        this.server.broadcast({ type: "destroyCanvas", canvasId: id, ...(tid ? { toplevelId: tid } : {}) });
    }

    setCanvasAnchor(id: string, parentId: string) {
        const tid = this.findToplevelForCanvas(id);
        this.server.broadcast({ type: "setCanvasAnchor", canvasId: id, parentId, ...(tid ? { toplevelId: tid } : {}) });
    }

    setCanvasOffset(id: string, x: number, y: number) {
        const tid = this.findToplevelForCanvas(id);
        this.server.broadcast({ type: "setCanvasOffset", canvasId: id, x, y, ...(tid ? { toplevelId: tid } : {}) });
    }

    setBufferOffset(id: string, x: number, y: number): void {
        const tid = this.findToplevelForCanvas(id);
        this.server.broadcast({ type: "setBufferOffset", canvasId: id, x, y, ...(tid ? { toplevelId: tid } : {}) });
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

    private sendToplevelList(peerId: string) {
        const list = this.getToplevels();
        this.server.sendMessage(peerId, { type: "toplevelList", toplevels: list });
    }

    private sendToplevelListToAll() {
        const list = this.getToplevels();
        this.server.broadcast({ type: "toplevelList", toplevels: list });
    }

    sendStateForToplevel(peerId: string, toplevelId: string) {
        console.log(`Sending state for toplevel ${toplevelId}`);

        const toplevel = this.toplevels.get(toplevelId);
        if (!toplevel) {
            console.log(`Toplevel ${toplevelId} not found`);
            return;
        }

        for (const [id, state] of this.surfaceMap) {
            if (id === toplevelId) {
                this.server.sendMessage(peerId, { type: "bindCanvas", canvasId: state.canvasId, toplevelId });

                const canvasState = this.canvasMap.get(state.canvasId);
                if (canvasState && canvasState.width > 0 && canvasState.height > 0) {
                    this.sendCanvasData(state.canvasId, canvasState, peerId, toplevelId);
                }

                this.server.sendMessage(peerId, {
                    type: "createXdgSurfaceEle",
                    surfaceId: id,
                    canvasId: state.canvasId,
                    toplevelId,
                });

                if (state.isToplevel) {
                    this.server.sendMessage(peerId, { type: "asToplevel", surfaceId: id, toplevelId });
                }

                if (state.width > 0 && state.height > 0) {
                    this.server.sendMessage(peerId, {
                        type: "setXdgSurfaceGeo",
                        surfaceId: id,
                        width: state.width,
                        height: state.height,
                        offsetX: state.offsetX,
                        offsetY: state.offsetY,
                        toplevelId,
                    });
                }
            }
        }

        for (const [id, state] of this.popupMap) {
            if (state.parentId === toplevelId) {
                this.server.sendMessage(peerId, {
                    type: "addPopupToXdgSurface",
                    popupId: state.popupId,
                    toplevelId,
                });
                this.server.sendMessage(peerId, {
                    type: "setPopupPosi",
                    popupId: state.popupId,
                    x: state.x,
                    y: state.y,
                    toplevelId,
                });
            }
        }
    }

    sendToplevelListToPeer(peerId: string) {
        this.sendToplevelList(peerId);
    }
}
