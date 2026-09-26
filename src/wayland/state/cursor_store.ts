import type { SurfaceId } from "../module";
import type { renderTools } from "../render_tools";

/** 画布可能被后续渲染复用/清空，复制一份供外部持有 */
function snapshotCanvas(canvas: OffscreenCanvas): OffscreenCanvas {
    const snapshot = new OffscreenCanvas(canvas.width, canvas.height);
    snapshot.getContext("2d")?.drawImage(canvas, 0, 0);
    return snapshot;
}

export type CursorState =
    | { kind: "hidden" }
    | { kind: "image"; surface: SurfaceId; hotspot: { x: number; y: number } }
    | { kind: "shape"; shape: string };

/**
 * 光标的唯一写入点。
 *
 * 收敛前光标状态散在 `obj2.cursorSurface` 与 `WaylandData.wl_surface.cursorHotspot`，
 * 有 4 处写入（commit / surface.destroy / set_cursor / set_shape），「后到者生效」
 * 与「隐藏后 commit 不应重新显示」这两条规则靠调用方自觉，容易漏。
 *
 * 对外仍经 `render.setCursor` 送达（`renderToolsOn.onCursorUpdata`），形状不变 ——
 * 把它上提到 server 级事件属 Phase 6。
 */
export class CursorStore {
    #render: renderTools;
    #state: CursorState = { kind: "hidden" };

    constructor(render: renderTools) {
        this.#render = render;
    }

    get state(): CursorState {
        return this.#state;
    }

    /** wl_pointer.set_cursor(surface, hotspot)：热点立即生效，之后的 commit 沿用 */
    setSurface(id: SurfaceId, hotspot: { x: number; y: number }, frame?: OffscreenCanvas): void {
        this.#state = { kind: "image", surface: id, hotspot };
        if (frame) {
            // surface 已有内容时立即更新光标，不需要等下一次 commit
            this.#render.setCursor(snapshotCanvas(frame), hotspot.x, hotspot.y);
        }
    }

    /**
     * 当前光标 surface 提交了新帧。
     * 只有仍在充当光标的那张 surface 才推送 —— 隐藏/切换之后 commit 不应重新显示。
     */
    updateFrame(id: SurfaceId, frame: OffscreenCanvas): void {
        const s = this.#state;
        if (s.kind !== "image" || s.surface !== id) return;
        this.#render.setCursor(snapshotCanvas(frame), s.hotspot.x, s.hotspot.y);
    }

    /**
     * 隐藏光标。传 id 表示「仅当这张 surface 是当前光标时才隐藏」——
     * surface.destroy 走这条；不传 id 是无条件隐藏（set_cursor(undefined)）。
     */
    hide(id?: SurfaceId): void {
        if (id !== undefined && !this.isCursorSurface(id)) return;
        this.#state = { kind: "hidden" };
        this.#render.setCursor(undefined, 0, 0);
    }

    /** wp_cursor_shape_device_v1.set_shape：语义光标替换 surface 光标（后到者生效） */
    setShape(shape: string): void {
        this.#state = { kind: "shape", shape };
        this.#render.setCursor(shape, 0, 0);
    }

    isCursorSurface(id: SurfaceId): boolean {
        const s = this.#state;
        return s.kind === "image" && s.surface === id;
    }
}
