import type { CursorState } from "../api";
import type { SurfaceId } from "../module";
import type { renderTools } from "../render_tools";

export type { CursorState };

/** 画布可能被后续渲染复用/清空，复制一份供外部持有 */
function snapshotCanvas(canvas: OffscreenCanvas): OffscreenCanvas {
    const snapshot = new OffscreenCanvas(canvas.width, canvas.height);
    snapshot.getContext("2d")?.drawImage(canvas, 0, 0);
    return snapshot;
}

/**
 * 光标的唯一写入点。
 *
 * 「后到者生效」与「隐藏后 commit 不应重新显示」两条规则在这里集中判定，
 * 调用方（commit / surface.destroy / set_cursor / set_shape）只负责报事实。
 *
 * 两个出口：
 * - `render.setCursor` —— `renderTools` 契约（场景层已搁置，见 PLAN §3.1）
 * - `onChanged` —— server fan-in 成 `cursor.changed(clientId, state)`
 */
export class CursorStore {
    #render: renderTools;
    #onChanged: ((state: CursorState) => void) | undefined;
    #state: CursorState = { kind: "hidden" };

    constructor(render: renderTools, onChanged?: (state: CursorState) => void) {
        this.#render = render;
        this.#onChanged = onChanged;
    }

    get state(): CursorState {
        return this.#state;
    }

    /** wl_pointer.set_cursor(surface, hotspot)：热点立即生效，之后的 commit 沿用 */
    setSurface(id: SurfaceId, hotspot: { x: number; y: number }, frame?: OffscreenCanvas): void {
        const canvas = frame ? snapshotCanvas(frame) : undefined;
        this.#state = canvas
            ? { kind: "image", surfaceId: id, hotspot, canvas }
            : { kind: "image", surfaceId: id, hotspot };
        if (canvas) {
            // surface 已有内容时立即更新光标，不需要等下一次 commit
            this.#render.setCursor(canvas, hotspot.x, hotspot.y);
        }
        this.#onChanged?.(this.#state);
    }

    /**
     * 当前光标 surface 提交了新帧。
     * 只有仍在充当光标的那张 surface 才推送 —— 隐藏/切换之后 commit 不应重新显示。
     */
    updateFrame(id: SurfaceId, frame: OffscreenCanvas): void {
        const s = this.#state;
        if (s.kind !== "image" || s.surfaceId !== id) return;
        const canvas = snapshotCanvas(frame);
        this.#state = { kind: "image", surfaceId: id, hotspot: s.hotspot, canvas };
        this.#render.setCursor(canvas, s.hotspot.x, s.hotspot.y);
        this.#onChanged?.(this.#state);
    }

    /**
     * 隐藏光标。传 id 表示「仅当这张 surface 是当前光标时才隐藏」——
     * surface.destroy 走这条；不传 id 是无条件隐藏（set_cursor(undefined)）。
     */
    hide(id?: SurfaceId): void {
        if (id !== undefined && !this.isCursorSurface(id)) return;
        this.#state = { kind: "hidden" };
        this.#render.setCursor(undefined, 0, 0);
        this.#onChanged?.(this.#state);
    }

    /** wp_cursor_shape_device_v1.set_shape：语义光标替换 surface 光标（后到者生效） */
    setShape(shape: string): void {
        this.#state = { kind: "shape", shape, hotspot: { x: 0, y: 0 } };
        this.#render.setCursor(shape, 0, 0);
        this.#onChanged?.(this.#state);
    }

    isCursorSurface(id: SurfaceId): boolean {
        const s = this.#state;
        return s.kind === "image" && s.surfaceId === id;
    }
}
