import type { renderTools, renderToolsOn } from "../../src/wayland/render_tools";
import { rectsToClipPath, resolveRegion } from "../../src/wayland/utils/region";

export class MockRenderTools implements renderTools {
    private canvasMap = new Map<string, { canvas: HTMLCanvasElement; container: HTMLElement }>();
    private xdgElMap = new Map<string, { element: HTMLElement; canvasId: string }>();
    private xdgSizes = new Map<string, { width: number; height: number }>();
    private blurEls = new Map<string, HTMLElement>();
    private blurRegions = new Map<string, { x: number; y: number; width: number; height: number; type: "+" | "-" }[]>();
    private _on: renderToolsOn = {};
    private idGen = 0;

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

    renderCanvas(canvas: OffscreenCanvas, id: string, op?: { logicalWidth: number; logicalHeight: number }): void {
        const info = this.canvasMap.get(id);
        if (!info) return;

        info.canvas.width = canvas.width;
        info.canvas.height = canvas.height;
        const ctx = info.canvas.getContext("2d");
        if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(canvas, 0, 0);
        }
        this.applyBlur(id);

        // 与真实渲染器一致：xdg 根 surface 的画布尺寸变化时同步通知桌面
        const xdg = [...this.xdgElMap].find(([, e]) => e.canvasId === id);
        if (!xdg) return;
        const width = Math.max(1, op?.logicalWidth ?? canvas.width);
        const height = Math.max(1, op?.logicalHeight ?? canvas.height);
        const prev = this.xdgSizes.get(xdg[0]);
        if (prev?.width === width && prev.height === height) return;
        this.xdgSizes.set(xdg[0], { width, height });
        this._on.onXdgSurfaceSize?.(xdg[0], width, height);
    }

    destroyCanvas(id: string): void {
        const info = this.canvasMap.get(id);
        if (info) {
            this.blurEls.get(id)?.remove();
            this.blurEls.delete(id);
            this.blurRegions.delete(id);
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

    setBlurRegion(
        id: string,
        region: { x: number; y: number; width: number; height: number; type: "+" | "-" }[] | undefined,
    ): void {
        if (region && region.length > 0) this.blurRegions.set(id, region);
        else this.blurRegions.delete(id);
        this.applyBlur(id);
    }

    private applyBlur(id: string): void {
        const info = this.canvasMap.get(id);
        if (!info) return;
        const region = this.blurRegions.get(id);
        const rects =
            region && region.length > 0
                ? resolveRegion(region, {
                      width: Math.max(1, info.canvas.width),
                      height: Math.max(1, info.canvas.height),
                  })
                : [];
        let blur = this.blurEls.get(id);
        if (rects.length === 0) {
            blur?.remove();
            this.blurEls.delete(id);
            return;
        }
        if (!blur) {
            blur = document.createElement("div");
            blur.style.position = "absolute";
            blur.style.pointerEvents = "none";
            this.blurEls.set(id, blur);
        }
        if (blur.parentElement !== info.container || blur.nextSibling !== info.canvas) {
            info.container.insertBefore(blur, info.canvas);
        }
        blur.style.left = "0px";
        blur.style.top = "0px";
        blur.style.width = `${info.canvas.width}px`;
        blur.style.height = `${info.canvas.height}px`;
        blur.style.backdropFilter = "blur(16px)";
        blur.style.clipPath = `path("${rectsToClipPath(rects)}")`;
    }

    createXdgSurfaceEle(id: string, canvasId: string): void {
        const canvasInfo = this.canvasMap.get(canvasId);
        if (!canvasInfo) return;

        const element = document.createElement("div");
        element.id = id;
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
        this.xdgSizes.delete(id);
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

    setCursor(canvas: OffscreenCanvas | string | undefined, hotspotX: number, hotspotY: number): void {
        this._on.onCursorUpdata?.(canvas, hotspotX, hotspotY, 1);
    }

    destroy(): void {
        for (const [, info] of this.xdgElMap) {
            info.element.remove();
        }
        this.xdgElMap.clear();
        this.xdgSizes.clear();
        for (const [, info] of this.canvasMap) {
            info.container.remove();
        }
        this.canvasMap.clear();
        this.blurEls.clear();
        this.blurRegions.clear();
    }
}
