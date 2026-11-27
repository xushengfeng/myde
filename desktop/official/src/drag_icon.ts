import { type ElType, ele, view } from "dkh-ui";

/**
 * 拖拽图标层：源客户端通过 `wl_data_device.start_drag` 提交的图标 surface。
 *
 * 它跟随指针但只负责图标本身，不替换光标——图层在光标之下，光标热点仍画在
 * 图标左上角。尺寸按 surface 逻辑尺寸 × 输出缩放显示。
 */
export class DragIcon {
    private host: ElType<HTMLElement>;
    private canvas: ElType<HTMLCanvasElement> | undefined;
    /** surface-local 逻辑尺寸 */
    private size = { width: 0, height: 0 };
    /** 相对指针热点的位移（surface-local） */
    private offset = { x: 0, y: 0 };
    /** 指针位置（桌面视口坐标） */
    private pointer = { x: 0, y: 0 };
    private scale = 1;

    constructor(parent: ElType<HTMLElement>) {
        this.host = view()
            .style({
                position: "fixed",
                left: "0px",
                top: "0px",
                pointerEvents: "none",
                display: "none",
                // 光标层是 9999：图标在它下面，不遮挡光标
                zIndex: "9998",
            })
            .addInto(parent);
    }

    /** 显示/更新图标；pointerX、pointerY 是桌面视口里的指针位置 */
    show(
        canvas: OffscreenCanvas,
        size: { width: number; height: number },
        offset: { x: number; y: number },
        pointerX: number,
        pointerY: number,
    ): void {
        if (size.width <= 0 || size.height <= 0) {
            this.clear();
            return;
        }
        if (!this.canvas) {
            this.canvas = ele("canvas").style({ position: "absolute", left: "0px", top: "0px" }).addInto(this.host);
        }
        const el = this.canvas.el;
        if (el.width !== canvas.width) el.width = canvas.width;
        if (el.height !== canvas.height) el.height = canvas.height;
        const c2d = el.getContext("2d");
        if (c2d) {
            c2d.clearRect(0, 0, el.width, el.height);
            c2d.drawImage(canvas, 0, 0);
        }
        this.size = size;
        this.offset = offset;
        this.pointer = { x: pointerX, y: pointerY };
        this.applySize();
        this.applyPosition();
        this.host.style({ display: "block" });
    }

    /** 跟随指针；隐藏时也记住位置，图标出现时不用等下一次移动 */
    move(x: number, y: number): void {
        this.pointer = { x, y };
        this.applyPosition();
    }

    /** 输出缩放变化：surface 逻辑尺寸换到桌面 CSS px */
    setScale(scale: number): void {
        if (!Number.isFinite(scale) || scale <= 0 || scale === this.scale) return;
        this.scale = scale;
        this.applySize();
        this.applyPosition();
    }

    clear(): void {
        this.host.style({ display: "none" });
    }

    private applySize(): void {
        this.canvas?.style({
            width: `${this.size.width * this.scale}px`,
            height: `${this.size.height * this.scale}px`,
        });
    }

    private applyPosition(): void {
        this.host.style({
            left: `${this.pointer.x + this.offset.x * this.scale}px`,
            top: `${this.pointer.y + this.offset.y * this.scale}px`,
        });
    }
}
