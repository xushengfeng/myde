import type { renderTools, renderToolsOn } from "../../src/renderer/view/render_tools";
import type { RemoteServer } from "./server";

export class RemoteRender implements renderTools {
    private canvasMap = new Map<string, { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D }>();
    private xdgElMap = new Map<string, { canvasId: string }>();
    private _on: renderToolsOn = {};
    private idGen = 0;
    private server: RemoteServer;

    constructor(server: RemoteServer) {
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

    bindCanvas(id: string) {
        const canvas = new OffscreenCanvas(1, 1);
        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("Could not get 2D context");
        }
        this.canvasMap.set(id, { canvas, context });

        // 通知前端创建新的canvas
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

        // 更新canvas内容
        canvasData.canvas.width = canvas.width;
        canvasData.canvas.height = canvas.height;
        canvasData.context.clearRect(0, 0, canvas.width, canvas.height);
        canvasData.context.drawImage(canvas, 0, 0);

        // 发送更新的canvas数据到前端
        this.sendCanvasData(id, canvasData.canvas);
    }

    private sendCanvasData(canvasId: string, canvas: OffscreenCanvas) {
        // 直接获取像素数据
        const context = canvas.getContext("2d");
        if (!context) return;

        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        this.server.broadcast({
            type: "canvas",
            canvasId,
            width: canvas.width,
            height: canvas.height,
            data: Array.from(imageData.data),
        });
    }

    destroyCanvas(id: string): void {
        this.canvasMap.delete(id);

        // 通知前端销毁canvas
        this.server.broadcast({
            type: "destroyCanvas",
            canvasId: id,
        });
    }

    setCanvasAnchor(id: string, parentId: string) {
        // 设置canvas锚点关系
        this.server.broadcast({
            type: "setCanvasAnchor",
            canvasId: id,
            parentId,
        });
    }

    setCanvasOffset(id: string, x: number, y: number) {
        // 设置canvas偏移
        this.server.broadcast({
            type: "setCanvasOffset",
            canvasId: id,
            x,
            y,
        });
    }

    setBufferOffset(id: string, x: number, y: number): void {
        // 设置buffer偏移
        this.server.broadcast({
            type: "setBufferOffset",
            canvasId: id,
            x,
            y,
        });
    }

    createXdgSurfaceEle(id: string, canvasId: string) {
        // 创建xdg surface元素
        this.xdgElMap.set(id, { canvasId });

        this.server.broadcast({
            type: "createXdgSurfaceEle",
            surfaceId: id,
            canvasId,
        });
    }

    getXdgSurfaceEle(id: string) {
        // 在远程渲染中，我们返回一个虚拟的HTMLElement
        // 实际渲染在前端完成
        return {
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
        };
    }

    destroyXdgSurfaceEle(id: string, type: "toplevel" | "popup"): void {
        const el = this.xdgElMap.get(id);
        if (el) {
            if (type === "toplevel" && this._on.onToplevelRemove) {
                // 通知前端销毁toplevel
                this.server.broadcast({
                    type: "destroyXdgSurfaceEle",
                    surfaceId: id,
                    surfaceType: type,
                });
            } else {
                // 通知前端销毁popup
                this.server.broadcast({
                    type: "destroyXdgSurfaceEle",
                    surfaceId: id,
                    surfaceType: type,
                });
            }
            this.xdgElMap.delete(id);
        }
    }

    setXdgSurfaceGeo(id: string, width: number, height: number, offsetX: number, offsetY: number) {
        // 设置xdg surface几何信息
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
        // 设置为toplevel
        this.server.broadcast({
            type: "asToplevel",
            surfaceId: id,
        });
    }

    addPopupToXdgSurface(popupId: string, toplevelId: string) {
        // 添加popup到xdg surface
        this.server.broadcast({
            type: "addPopupToXdgSurface",
            popupId,
            toplevelId,
        });
    }

    setPopupPosi(popupId: string, x: number, y: number) {
        // 设置popup位置
        this.server.broadcast({
            type: "setPopupPosi",
            popupId,
            x,
            y,
        });
    }
}
