import { type ElType, ele, view } from "dkh-ui";
import type { renderTools, renderToolsOn } from "./render_tools";

type CanvasEntry = {
    warpEl: ElType<HTMLElement>;
    canvas: ElType<HTMLCanvasElement>;
    /** surface-local 逻辑尺寸；CSS 尺寸 = 逻辑尺寸 × scale */
    logical?: { width: number; height: number };
    /** wl_surface.offset：canvas 元素自身的偏移（surface 逻辑坐标） */
    offset: { x: number; y: number };
    /** subsurface 位置：外层 warp 的偏移（surface 逻辑坐标） */
    warpOffset: { x: number; y: number };
    /** 该 canvas 是 xdg 根 surface：warp 偏移由 setXdgSurfaceGeo 管理，subsurface 偏移不要覆盖它 */
    xdgRoot?: boolean;
};

type XdgEntry = {
    warpEl: ElType<HTMLElement>;
    canvasWrap: ElType<HTMLElement>;
    /** xdg window geometry（逻辑坐标）：w/h 是窗口尺寸，ox/oy 是 surface 相对几何原点的偏移 */
    logical?: { width: number; height: number; offsetX: number; offsetY: number };
    /** popup 在父 xdg surface 中的位置（逻辑坐标） */
    popup?: { x: number; y: number };
};

export class renderToolsHtmlEl implements renderTools {
    private canvasMap = new Map<string, CanvasEntry>();
    private xdgElMap = new Map<string, XdgEntry>();
    private _on: renderToolsOn = {};
    private idGen = 0;
    /** 桌面显示缩放：Wayland surface 逻辑 px → 桌面 CSS/物理 px */
    private scale = 1;
    on(op?: renderToolsOn): void {
        if (op) {
            this._on = { ...this._on, ...op };
        }
    }
    idScope(): (id: unknown) => string {
        const baseId = this.idGen++;
        return (id: unknown) => `${baseId}-${String(id)}`;
    }
    setScale(scale: number): void {
        if (!Number.isFinite(scale) || scale <= 0 || scale === this.scale) return;
        this.scale = scale;
        for (const id of this.canvasMap.keys()) this.applyCanvas(id);
        for (const id of this.xdgElMap.keys()) this.applyXdg(id);
    }
    bindCanvas(id: string) {
        const canvasEl = ele("canvas").attr({ id: id }).style({ position: "absolute" });
        const warpEl = view().add(canvasEl).style({ position: "absolute" });
        this.canvasMap.set(id, {
            warpEl: warpEl,
            canvas: canvasEl,
            offset: { x: 0, y: 0 },
            warpOffset: { x: 0, y: 0 },
        });
    }
    private applyCanvas(id: string) {
        const entry = this.canvasMap.get(id);
        if (!entry) return;
        if (entry.logical) {
            entry.canvas.style({
                width: `${entry.logical.width * this.scale}px`,
                height: `${entry.logical.height * this.scale}px`,
            });
        }
        entry.canvas.style({
            left: `${entry.offset.x * this.scale}px`,
            top: `${entry.offset.y * this.scale}px`,
        });
        if (!entry.xdgRoot) {
            entry.warpEl.style({
                left: `${entry.warpOffset.x * this.scale}px`,
                top: `${entry.warpOffset.y * this.scale}px`,
            });
        }
    }
    renderCanvas(canvas: OffscreenCanvas, id: string, op?: { logicalWidth: number; logicalHeight: number }) {
        const entry = this.canvasMap.get(id);
        if (!entry) {
            console.error("Canvas element not found for id:", id, this.canvasMap);
            return;
        }
        // 给 width/height 赋值会重置整块位图（即使数值没变），每帧都写等于每帧重新分配
        // 后备存储；只在尺寸变化时更新。
        if (entry.canvas.el.width !== canvas.width) entry.canvas.el.width = canvas.width;
        if (entry.canvas.el.height !== canvas.height) entry.canvas.el.height = canvas.height;
        const ctx = entry.canvas.el.getContext("2d");
        if (ctx) {
            // 每帧是完整替换，不是叠加：同尺寸时设置 width/height 不会清空旧像素，
            // 直接 drawImage 会让半透明/透明区域按 source-over 叠在上一帧上。
            ctx.clearRect(0, 0, entry.canvas.el.width, entry.canvas.el.height);
            ctx.drawImage(canvas, 0, 0);
        }
        if (op) entry.logical = { width: op.logicalWidth, height: op.logicalHeight };
        this.applyCanvas(id);
    }
    destroyCanvas(id: string): void {
        const canvasInfo = this.canvasMap.get(id);
        if (canvasInfo) {
            canvasInfo.warpEl.remove();
        }
        this.canvasMap.delete(id);
    }
    setCanvasAnchor(id: string, parentId: string) {
        const parent = this.canvasMap.get(parentId);
        const thisChild = this.canvasMap.get(id);
        if (!parent || !thisChild) {
            console.error("error");
            return;
        }
        parent.warpEl.add(thisChild.warpEl);
    }
    setCanvasOffset(id: string, x: number, y: number) {
        const thisChild = this.canvasMap.get(id);
        if (!thisChild) {
            console.error("error");
            return;
        }
        thisChild.warpOffset = { x, y };
        thisChild.warpEl.style({ left: `${x * this.scale}px`, top: `${y * this.scale}px` });
    }
    setBufferOffset(id: string, x: number, y: number): void {
        const canvas = this.canvasMap.get(id);
        if (!canvas) {
            console.error("error");
            return;
        }
        canvas.offset = { x, y };
        canvas.canvas.style({ left: `${x * this.scale}px`, top: `${y * this.scale}px` });
    }
    private applyXdg(id: string) {
        const entry = this.xdgElMap.get(id);
        if (!entry) return;
        if (entry.logical) {
            entry.warpEl.style({
                width: `${entry.logical.width * this.scale}px`,
                height: `${entry.logical.height * this.scale}px`,
            });
            entry.canvasWrap.style({
                position: "absolute",
                top: `${-entry.logical.offsetY * this.scale}px`,
                left: `${-entry.logical.offsetX * this.scale}px`,
            });
        }
        if (entry.popup) {
            entry.warpEl.style({
                position: "absolute",
                left: `${entry.popup.x * this.scale}px`,
                top: `${entry.popup.y * this.scale}px`,
            });
        }
    }
    createXdgSurfaceEle(id: string, canvasId: string) {
        const canvasEl = this.canvasMap.get(canvasId);
        if (!canvasEl) {
            console.error("error");
            return;
        }
        const el = view().attr({ id: id }).style({ position: "absolute" }).add(canvasEl.warpEl);
        canvasEl.xdgRoot = true;

        this.xdgElMap.set(id, { warpEl: el, canvasWrap: canvasEl.warpEl });
    }
    getXdgSurfaceEle(id: string) {
        return this.xdgElMap.get(id)?.warpEl.el;
    }
    destroyXdgSurfaceEle(id: string, type: "toplevel" | "popup"): void {
        const el = this.xdgElMap.get(id);
        if (!el) return;
        if (type === "toplevel") {
            // 桌面可能要在回调里取元素做额外清理；回调之后再无条件移除，避免没注册回调时残留
            this._on.onToplevelRemove?.(id);
        }
        el.warpEl.remove();
        this.xdgElMap.delete(id);
    }
    setXdgSurfaceGeo(id: string, width: number, height: number, offsetX: number, offsetY: number) {
        const surface = this.xdgElMap.get(id);
        if (!surface) {
            console.error("error");
            return;
        }
        surface.logical = { width, height, offsetX, offsetY };
        this.applyXdg(id);
    }
    asToplevel(id: string) {
        const el = this.xdgElMap.get(id);
        if (!el) {
            console.error("error");
            return;
        }
        this._on.onToplevelCreate?.(id);
    }
    addPopupToXdgSurface(popupId: string, toplevelId: string) {
        const popup = this.xdgElMap.get(popupId);
        const toplevel = this.xdgElMap.get(toplevelId);
        if (!popup || !toplevel) {
            console.error("error");
            return;
        }
        toplevel.warpEl.add(popup.warpEl);
    }
    setPopupPosi(popupId: string, x: number, y: number) {
        const popup = this.xdgElMap.get(popupId);
        if (!popup) {
            console.error("error");
            return;
        }
        popup.popup = { x, y };
        popup.warpEl.style({
            position: "absolute",
            left: `${x * this.scale}px`,
            top: `${y * this.scale}px`,
        });
    }
    setCursor(canvas: OffscreenCanvas | string | undefined, hotspotX: number, hotspotY: number): void {
        this._on.onCursorUpdata?.(canvas, hotspotX, hotspotY, this.scale);
    }
}
