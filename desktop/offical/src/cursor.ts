import { type ElType, ele, view } from "dkh-ui";

type cursorState =
    | { type: "default" }
    | { type: "hidden" }
    | { type: "shape"; shape: string }
    | { type: "image"; canvas: OffscreenCanvas; hotspot: { x: number; y: number } };

// 形状光标的公共样式（与默认圆点一致），尺寸和圆角由各形状自己定义
const shapeStyle = {
    background: "rgba(0,0,0,0.5)",
    outline: "1px solid #fff",
    transform: "translate(-50%, -50%)",
};

/** 桌面光标
 *
 * 管理光标的位置与内容：默认圆点、语义shape（wp_cursor_shape_device_v1.shape枚举名）、
 * 客户端surface图片光标（含热点）、隐藏
 *
 * 客户端设置的光标会被记忆：指针移开surface（软件窗口）时显示默认光标，重新进入时恢复记忆的光标
 *
 * 状态变化统一经过apply/render，日后可在render里实现过渡动画
 */
export class Cursor {
    private warpEl: ElType<HTMLElement>;
    private state: cursorState = { type: "default" };
    /** 客户端最后设置的光标（记忆），指针移开surface后重新进入时恢复 */
    private clientState: cursorState = { type: "default" };
    /** 指针是否在客户端surface（软件窗口）上 */
    private surfaceFocus = false;

    constructor(parent: ElType<HTMLElement>) {
        this.warpEl = view()
            .style({
                position: "fixed",
                left: "0px",
                top: "0px",
                pointerEvents: "none",
                zIndex: 9999,
            })
            .addInto(parent);
        this.render();
    }

    /** 移动光标位置 */
    move(x: number, y: number) {
        this.warpEl.style({ left: `${x}px`, top: `${y}px` });
    }

    /** 指针进入/离开客户端surface（软件窗口）
     *
     * 离开时显示默认光标，重新进入时恢复记忆的客户端光标
     */
    setSurfaceFocus(focus: boolean) {
        if (focus === this.surfaceFocus) return;
        this.surfaceFocus = focus;
        this.apply(focus ? this.clientState : { type: "default" });
    }

    /** 客户端surface图片光标，hotspot为热点相对图片左上角的偏移 */
    setImage(canvas: OffscreenCanvas, hotspotX: number, hotspotY: number) {
        this.clientUpdate({ type: "image", canvas, hotspot: { x: hotspotX, y: hotspotY } });
    }

    /** 语义shape，wp_cursor_shape_device_v1.shape的枚举名 */
    setShape(shape: string) {
        this.clientUpdate({ type: "shape", shape });
    }

    /** 隐藏光标 */
    hide() {
        this.clientUpdate({ type: "hidden" });
    }

    /** 清空记忆并恢复默认光标 */
    reset() {
        this.clientState = { type: "default" };
        this.apply({ type: "default" });
    }

    /** 记忆客户端设置的光标，指针焦点在客户端surface上时才显示（协议规定焦点外不改变光标） */
    private clientUpdate(state: cursorState) {
        this.clientState = state;
        if (this.surfaceFocus) this.apply(state);
    }

    private apply(state: cursorState) {
        if (isSameState(this.state, state)) return;
        this.state = state;
        this.render();
    }

    /** 根据状态渲染光标内容，日后可在这里加入过渡动画 */
    private render() {
        this.warpEl.clear().add(this.newContent(this.state));
    }

    private newContent(state: cursorState): ElType<HTMLElement> {
        if (state.type === "image") {
            const cel = ele("canvas");
            cel.attr({ width: state.canvas.width, height: state.canvas.height });
            cel.el.getContext("2d")?.drawImage(state.canvas, 0, 0);
            return cel.style({
                position: "absolute",
                left: `-${state.hotspot.x}px`,
                top: `-${state.hotspot.y}px`,
            });
        }
        if (state.type === "hidden") {
            return view();
        }
        return this.newShape(state.type === "shape" ? state.shape : "default");
    }

    /** 目前只支持default、pointer、text三种shape，其余回落到default */
    private newShape(shape: string): ElType<HTMLElement> {
        switch (shape) {
            case "pointer":
                // 更大的圆角正方形
                return view().style({ ...shapeStyle, width: "20px", height: "20px", borderRadius: "6px" });
            case "text":
                // 竖线
                return view().style({ ...shapeStyle, width: "2px", height: "20px", borderRadius: "1px" });
            default:
                // 默认圆点
                return view().style({ ...shapeStyle, width: "10px", height: "10px", borderRadius: "50%" });
        }
    }
}

function isSameState(a: cursorState, b: cursorState): boolean {
    if (a.type !== b.type) return false;
    if (a.type === "shape" && b.type === "shape") return a.shape === b.shape;
    if (a.type === "image" && b.type === "image")
        return a.canvas === b.canvas && a.hotspot.x === b.hotspot.x && a.hotspot.y === b.hotspot.y;
    return true;
}
