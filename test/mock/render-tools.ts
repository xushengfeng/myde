import type { renderTools, renderToolsOn } from "../../src/wayland/render_tools";

export class MockRenderTools implements renderTools {
    private canvasMap = new Map<string, { canvas: HTMLCanvasElement; container: HTMLElement }>();
    private xdgElMap = new Map<string, { element: HTMLElement; canvasId: string }>();
    private _on: renderToolsOn = {};
    private idGen = 0;

    constructor() {}

    on(op?: renderToolsOn): void {
        if (op) {
            this._on = { ...this._on, ...op };
        }
    }

    idScope(): (id: unknown) => string {
        const baseId = this.idGen++;
        return (id: unknown) => `${baseId}-${String(id)}`;
    }

    bindCanvas(id: string): void {
        const canvas = document.createElement("canvas");
        canvas.style.position = "absolute";
        const container = document.createElement("div");
        container.style.position = "absolute";
        container.appendChild(canvas);
        this.canvasMap.set(id, { canvas, container });
    }

    renderCanvas(canvas: OffscreenCanvas, id: string): void {
        const info = this.canvasMap.get(id);
        if (!info) return;
        
        info.canvas.width = canvas.width;
        info.canvas.height = canvas.height;
        const ctx = info.canvas.getContext("2d");
        if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(canvas, 0, 0);
        }
    }

    destroyCanvas(id: string): void {
        const info = this.canvasMap.get(id);
        if (info) {
            info.container.remove();
            this.canvasMap.delete(id);
        }
    }

    setCanvasAnchor(id: string, parentId: string): void {
        const parent = this.canvasMap.get(parentId);
        const child = this.canvasMap.get(id);
        if (parent && child) {
            parent.container.appendChild(child.container);
        }
    }

    setCanvasOffset(id: string, x: number, y: number): void {
        const info = this.canvasMap.get(id);
        if (info) {
            info.container.style.left = `${x}px`;
            info.container.style.top = `${y}px`;
        }
    }

    setBufferOffset(id: string, x: number, y: number): void {
        const info = this.canvasMap.get(id);
        if (info) {
            info.canvas.style.left = `${x}px`;
            info.canvas.style.top = `${y}px`;
        }
    }

    createXdgSurfaceEle(id: string, canvasId: string): void {
        const canvasInfo = this.canvasMap.get(canvasId);
        if (!canvasInfo) return;

        const element = document.createElement("div");
        element.style.position = "absolute";
        element.appendChild(canvasInfo.container);
        this.xdgElMap.set(id, { element, canvasId });
    }

    getXdgSurfaceEle(id: string): HTMLElement | undefined {
        return this.xdgElMap.get(id)?.element;
    }

    destroyXdgSurfaceEle(id: string, type: "toplevel" | "popup"): void {
        const info = this.xdgElMap.get(id);
        if (!info) return;

        if (type === "toplevel" && this._on.onToplevelRemove) {
            this._on.onToplevelRemove(id);
        } else {
            info.element.remove();
        }
        this.xdgElMap.delete(id);
    }

    setXdgSurfaceGeo(id: string, width: number, height: number, offsetX: number, offsetY: number): void {
        const info = this.xdgElMap.get(id);
        if (!info) return;

        info.element.style.width = `${width}px`;
        info.element.style.height = `${height}px`;
        const canvasInfo = this.canvasMap.get(info.canvasId);
        if (canvasInfo) {
            canvasInfo.container.style.left = `-${offsetX}px`;
            canvasInfo.container.style.top = `-${offsetY}px`;
        }
    }

    asToplevel(id: string): void {
        const info = this.xdgElMap.get(id);
        if (!info) return;

        // 元素通过getXdgSurfaceEle传递给官方桌面，不需要添加到container
        if (this._on.onToplevelCreate) {
            this._on.onToplevelCreate(id);
        }
    }

    addPopupToXdgSurface(popupId: string, parentId: string): void {
        const popup = this.xdgElMap.get(popupId);
        const parent = this.xdgElMap.get(parentId);
        if (popup && parent) {
            parent.element.appendChild(popup.element);
        }
    }

    setPopupPosi(popupId: string, x: number, y: number): void {
        const info = this.xdgElMap.get(popupId);
        if (info) {
            info.element.style.left = `${x}px`;
            info.element.style.top = `${y}px`;
        }
    }

    destroy(): void {
        for (const [id, info] of this.xdgElMap) {
            info.element.remove();
        }
        this.xdgElMap.clear();
        for (const [id, info] of this.canvasMap) {
            info.container.remove();
        }
        this.canvasMap.clear();
    }
}
