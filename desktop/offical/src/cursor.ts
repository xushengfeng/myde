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

const DEFAULT_STATE: cursorState = { type: "default" };

/** 桌面光标
 *
 * 管理光标的位置与内容：默认圆点、语义shape（wp_cursor_shape_device_v1.shape枚举名）、
 * 客户端surface图片光标（含热点）、隐藏
 *
 * 客户端设置的光标按客户端记忆：指针离开surface（软件窗口）时显示默认光标，
 * 回到同一个客户端时恢复它的光标，进入另一个客户端时用另一个客户端自己的记忆，
 * 避免某个客户端（尤其是正在退出的客户端）的光标状态串到其他软件上。
 * `hidden` 只影响当前焦点，不参与记忆，防止退出流程里的隐藏把光标永久留空。
 *
 * 状态变化统一经过apply/render，日后可在render里实现过渡动画
 */
export class Cursor {
    private warpEl: ElType<HTMLElement>;
    private state: cursorState = DEFAULT_STATE;
    /** 每个客户端最后设置的光标（记忆），指针离开后重新进入时恢复 */
    private clientStates = new Map<string, cursorState>();
    /** 指针当前所在客户端的 id，undefined 表示在桌面上 */
    private clientId: string | undefined;

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
     * 离开时显示默认光标，重新进入时恢复该客户端记忆的光标
     */
    setSurfaceFocus(clientId: string | undefined) {
        if (clientId === this.clientId) return;
        this.clientId = clientId;
        this.apply(this.contentOf(clientId));
    }

    /** 客户端surface图片光标，hotspot为热点相对图片左上角的偏移 */
    setImage(clientId: string, canvas: OffscreenCanvas, hotspotX: number, hotspotY: number) {
        this.clientUpdate(clientId, { type: "image", canvas, hotspot: { x: hotspotX, y: hotspotY } });
    }

    /** 语义shape，wp_cursor_shape_device_v1.shape的枚举名 */
    setShape(clientId: string, shape: string) {
        this.clientUpdate(clientId, { type: "shape", shape });
    }

    /** 隐藏光标 */
    hide(clientId: string) {
        this.clientUpdate(clientId, { type: "hidden" });
    }

    /** 客户端退出：丢弃它的记忆；指针还停在它的窗口上时立即恢复默认光标 */
    forgetClient(clientId: string) {
        this.clientStates.delete(clientId);
        if (this.clientId === clientId) {
            this.clientId = undefined;
            this.apply(DEFAULT_STATE);
        }
    }

    /** 清空全部记忆并恢复默认光标 */
    reset() {
        this.clientStates.clear();
        this.clientId = undefined;
        this.apply(DEFAULT_STATE);
    }

    private contentOf(clientId: string | undefined): cursorState {
        if (clientId === undefined) return DEFAULT_STATE;
        return this.clientStates.get(clientId) ?? DEFAULT_STATE;
    }

    /** 记忆客户端设置的光标，指针焦点在该客户端上时才显示（协议规定焦点外不改变光标） */
    private clientUpdate(clientId: string, state: cursorState) {
        // hidden 只在当前焦点下生效，不进入记忆：隐藏往往发生在软件退出/窗口销毁的收尾阶段，
        // 若记下来，指针下次进入（或其他窗口复用同一客户端）就会得到一把看不见的光标
        if (state.type === "hidden") this.clientStates.delete(clientId);
        else this.clientStates.set(clientId, state);
        if (this.clientId === clientId) this.apply(state);
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
