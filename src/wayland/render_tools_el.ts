import { type ElType, ele, view } from "dkh-ui";
import type { renderTools, renderToolsOn } from "./render_tools";
import { type RegionRect, rectsToClipPath, resolveRegion } from "./utils/region";

/** 逻辑模糊半径（surface px）；实际 CSS px = 半径 × 输出缩放，和窗口尺寸一起缩放。 */
const SURFACE_BLUR_RADIUS = 16;

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
    /** 该 canvas 所属的 xdg surface id（surface 尺寸回调用） */
    xdgId?: string;
    /** 背景模糊层（垫在 canvas 下面）；没有模糊区域时为 undefined */
    blurEl?: ElType<HTMLElement>;
    /** ext_background_effect_v1 的区域（surface 局部逻辑坐标） */
    blurRegion?: RegionRect[];
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
        for (const id of this.canvasMap.keys()) {
            this.applyCanvas(id);
            this.applyBlur(id);
        }
        for (const id of this.xdgElMap.keys()) this.applyXdg(id);
        // 逻辑尺寸没变但 CSS/物理尺寸变了，外框也要跟着换
        for (const [id, entry] of this.xdgElMap) {
            if (entry.logical) {
                this._on.onXdgSurfaceSize?.(id, entry.logical.width * this.scale, entry.logical.height * this.scale);
            }
        }
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
    /**
     * 背景模糊层：铺满整个 surface，用 region 解析出的路径裁剪。
     * 垫在 canvas 下面，所以 surface 自己的像素（文字、图标、半透明背景）仍然盖在模糊上；
     * canvas 的透明区域透出的是「已模糊的桌面/下层窗口」。
     */
    private applyBlur(id: string) {
        const entry = this.canvasMap.get(id);
        if (!entry) return;
        const region = entry.blurRegion;
        const logical = entry.logical;
        if (!region || !logical || logical.width <= 0 || logical.height <= 0) {
            entry.blurEl?.remove();
            entry.blurEl = undefined;
            return;
        }
        const rects = resolveRegion(region, { width: logical.width, height: logical.height });
        if (rects.length === 0) {
            entry.blurEl?.remove();
            entry.blurEl = undefined;
            return;
        }
        if (!entry.blurEl) {
            entry.blurEl = view().style({ position: "absolute", pointerEvents: "none" });
        }
        const el = entry.blurEl.el;
        // 保持在 canvas 之前：模糊必须是「背后的内容」，不能盖住 surface 自己。
        if (el.parentElement !== entry.warpEl.el || el.nextSibling !== entry.canvas.el) {
            entry.warpEl.el.insertBefore(el, entry.canvas.el);
        }
        entry.blurEl.style({
            left: "0px",
            top: "0px",
            width: `${logical.width * this.scale}px`,
            height: `${logical.height * this.scale}px`,
            backdropFilter: `blur(${SURFACE_BLUR_RADIUS * this.scale}px)`,
            clipPath: `path("${rectsToClipPath(rects, this.scale)}")`,
        });
    }
    setBlurRegion(id: string, region: RegionRect[] | undefined): void {
        const entry = this.canvasMap.get(id);
        if (!entry) {
            console.error("Canvas element not found for id:", id, this.canvasMap);
            return;
        }
        entry.blurRegion = region && region.length > 0 ? region : undefined;
        this.applyBlur(id);
    }
    /**
     * 通知桌面的显示尺寸：xdg window geometry（不含客户端自绘的阴影），不是 buffer 尺寸。
     * buffer 可能带阴影/装饰，比窗口几何大；根元素本身按几何摆放，外框和指针映射都跟它走。
     * 还没有几何时退回 buffer 逻辑尺寸（未 map 的 surface）。
     */
    private xdgDisplaySize(xdgId: string, bufferWidth: number, bufferHeight: number) {
        const geo = this.xdgElMap.get(xdgId)?.logical;
        return {
            width: Math.max(1, (geo?.width ?? bufferWidth) * this.scale),
            height: Math.max(1, (geo?.height ?? bufferHeight) * this.scale),
        };
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
        const prevLogical = entry.logical;
        if (op) entry.logical = { width: op.logicalWidth, height: op.logicalHeight };
        this.applyCanvas(id);
        this.applyBlur(id);
        if (entry.xdgId && op && (prevLogical?.width !== op.logicalWidth || prevLogical?.height !== op.logicalHeight)) {
            // 画布 CSS 尺寸写进 DOM 之后再通知，外框和 surface 在同一任务里对齐
            const size = this.xdgDisplaySize(entry.xdgId, op.logicalWidth, op.logicalHeight);
            this._on.onXdgSurfaceSize?.(entry.xdgId, size.width, size.height);
        }
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
        canvasEl.xdgId = id;

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
