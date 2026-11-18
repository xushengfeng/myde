import { type ElType, ele, view } from "dkh-ui";
import { AnimationGear, timingFunction } from "myde-ui";

type cursorState =
    | { type: "default" }
    | { type: "hidden" }
    | { type: "shape"; shape: string }
    | {
          type: "image";
          canvas: OffscreenCanvas;
          hotspot: { x: number; y: number };
          /** 桌面显示尺寸（已乘输出缩放）；缺省时按位图尺寸 */
          size?: { width: number; height: number };
      };

/** wp_cursor_shape 形状的几何参数；形状过渡直接在这些数字之间插值 */
type CursorShapeMetrics = {
    width: number;
    height: number;
    radius: number;
    rotation: number;
    /** body 相对光标中心的偏移，默认 0；progress 的指示点用左上偏移 */
    x: number;
    y: number;
};

/** 光标基座上的装饰件，坐标以光标热点为中心 */
type CursorDecoration = {
    x: number;
    y: number;
    width: number;
    height: number;
    radius?: number;
    rotation?: number;
    style?: "fill" | "outline" | "white" | "frame";
};

/** 一个光标设计：一个基座 body + 前后两层装饰 */
type CursorDesign = {
    /** 设计身份；相同 key 表示视觉完全一致 */
    key: string;
    /** 基座几何 key，对应 CURSOR_METRICS */
    bodyKey: string;
    body: CursorShapeMetrics;
    /** body 的填色方式：default 为半透明填充，outline 为空心描边（外框/菱形） */
    bodyStyle?: "fill" | "outline";
    /** 装饰层身份；相同 key 表示装饰完全一样，切换时不必淡入淡出 */
    decoKey?: string;
    /** 热点在局部坐标里的位置，缺省 (0, 0) */
    hotspot?: { x: number; y: number };
    /** body 后方/前方的装饰件 */
    back?: CursorDecoration[];
    front?: CursorDecoration[];
};

// 形状光标的公共样式（与默认圆点一致），尺寸和圆角由各形状自己定义
const shapeStyle = {
    background: "rgba(0,0,0,0.5)",
    outline: "1px solid #fff",
    transform: "translate(-50%, -50%)",
};

/** wp_cursor_shape_device_v1.shape 的全部枚举名，测试预览页按它铺矩阵 */
const CURSOR_SHAPES = [
    "default",
    "context_menu",
    "help",
    "pointer",
    "progress",
    "wait",
    "cell",
    "crosshair",
    "text",
    "vertical_text",
    "alias",
    "copy",
    "move",
    "no_drop",
    "not_allowed",
    "grab",
    "grabbing",
    "e_resize",
    "n_resize",
    "ne_resize",
    "nw_resize",
    "s_resize",
    "se_resize",
    "sw_resize",
    "w_resize",
    "ew_resize",
    "ns_resize",
    "nesw_resize",
    "nwse_resize",
    "col_resize",
    "row_resize",
    "all_scroll",
    "zoom_in",
    "zoom_out",
    "dnd_ask",
    "all_resize",
] as const;

type CursorShapeName = (typeof CURSOR_SHAPES)[number];

/** 已专门设计的基座几何；没列出的形状按 alias 复用或回落到 default */
const CURSOR_METRICS: Record<string, CursorShapeMetrics> = {
    default: { width: 10, height: 10, radius: 5, rotation: 0, x: 0, y: 0 },
    pointer: { width: 20, height: 20, radius: 6, rotation: 0, x: 0, y: 0 },
    text: { width: 2, height: 20, radius: 1, rotation: 0, x: 0, y: 0 },
    "text-horizontal": { width: 20, height: 2, radius: 1, rotation: 0, x: 0, y: 0 },
    "ew-resize": { width: 22, height: 3, radius: 2, rotation: 0, x: 0, y: 0 },
    "ns-resize": { width: 3, height: 22, radius: 2, rotation: 0, x: 0, y: 0 },
    "nwse-resize": { width: 3, height: 22, radius: 2, rotation: -45, x: 0, y: 0 },
    "nesw-resize": { width: 3, height: 22, radius: 2, rotation: 45, x: 0, y: 0 },
    "context-menu": { width: 14, height: 3, radius: 2, rotation: 0, x: 0, y: 0 },
    "cell-frame": { width: 20, height: 20, radius: 2, rotation: 0, x: 0, y: 0 },
    crosshair: { width: 20, height: 2, radius: 1, rotation: 0, x: 0, y: 0 },
    copy: { width: 16, height: 16, radius: 4, rotation: 0, x: 0, y: 0 },
    "move-diamond": { width: 16, height: 16, radius: 2, rotation: 45, x: 0, y: 0 },
    grab: { width: 16, height: 16, radius: 0, rotation: 0, x: 0, y: 0 },
    grabbing: { width: 10, height: 10, radius: 0, rotation: 0, x: 0, y: 0 },
    "no-symbol": { width: 8, height: 8, radius: 4, rotation: 0, x: 0, y: 0 },
    zoom: { width: 16, height: 16, radius: 8, rotation: 0, x: 0, y: 0 },
    progress: { width: 6, height: 6, radius: 3, rotation: 0, x: -8, y: -8 },
    wait: { width: 6, height: 6, radius: 3, rotation: 0, x: 0, y: 0 },
    "three-dots": { width: 4, height: 4, radius: 2, rotation: 0, x: 0, y: 0 },
    "alias-dot": { width: 6, height: 6, radius: 3, rotation: 0, x: 0, y: 0 },
};

/** 没单独设计的 resize 方向先复用现有横/竖/斜线几何 */
const CURSOR_DESIGN_ALIASES: Record<string, string> = {
    "e-resize": "ew-resize",
    "w-resize": "ew-resize",
    "col-resize": "ew-resize",
    "n-resize": "ns-resize",
    "s-resize": "ns-resize",
    "row-resize": "ns-resize",
    "ne-resize": "nesw-resize",
    "sw-resize": "nesw-resize",
    "nw-resize": "nwse-resize",
    "se-resize": "nwse-resize",
    "all-scroll": "move",
    "all-resize": "move",
    "no-drop": "not-allowed",
    help: "three-dots",
    "dnd-ask": "three-dots",
};

function makeDesign(
    key: string,
    bodyKey: string,
    parts?: {
        bodyStyle?: "fill" | "outline";
        decoKey?: string;
        hotspot?: { x: number; y: number };
        back?: CursorDecoration[];
        front?: CursorDecoration[];
    },
): CursorDesign {
    return { key, bodyKey, body: CURSOR_METRICS[bodyKey], ...parts };
}

/** progress / wait 共用的静态米字 */
const BUSY_STAR: CursorDecoration[] = [
    { x: 0, y: 0, width: 20, height: 2, radius: 1 },
    { x: 0, y: 0, width: 2, height: 20, radius: 1 },
    { x: 0, y: 0, width: 20, height: 2, radius: 1, rotation: 45 },
    { x: 0, y: 0, width: 20, height: 2, radius: 1, rotation: -45 },
];

/** 每个协议形状对应的设计；未列出的回落到 default */
const CURSOR_DESIGNS: Record<string, CursorDesign> = {
    default: makeDesign("default", "default"),
    pointer: makeDesign("pointer", "pointer"),
    text: makeDesign("text", "text"),
    "vertical-text": makeDesign("vertical-text", "text-horizontal"),
    "ew-resize": makeDesign("ew-resize", "ew-resize"),
    "ns-resize": makeDesign("ns-resize", "ns-resize"),
    "nwse-resize": makeDesign("nwse-resize", "nwse-resize"),
    "nesw-resize": makeDesign("nesw-resize", "nesw-resize"),
    "context-menu": makeDesign("context-menu", "context-menu", {
        back: [
            { x: 0, y: -5, width: 14, height: 3, radius: 2 },
            { x: 0, y: 5, width: 14, height: 3, radius: 2 },
        ],
    }),
    progress: makeDesign("progress", "progress", {
        decoKey: "busy-star",
        hotspot: { x: -8, y: -8 },
        back: BUSY_STAR,
    }),
    wait: makeDesign("wait", "wait", {
        decoKey: "busy-star",
        back: BUSY_STAR,
    }),
    "three-dots": makeDesign("three-dots", "three-dots", {
        back: [
            { x: -5, y: 0, width: 4, height: 4, radius: 2 },
            { x: 5, y: 0, width: 4, height: 4, radius: 2 },
        ],
    }),
    alias: makeDesign("alias", "alias-dot", {
        back: [{ x: 7, y: 0, width: 6, height: 6, radius: 0 }],
    }),
    cell: makeDesign("cell", "cell-frame", {
        bodyStyle: "outline",
        back: [
            { x: 0, y: 0, width: 14, height: 2, radius: 1 },
            { x: 0, y: 0, width: 2, height: 14, radius: 1 },
        ],
    }),
    crosshair: makeDesign("crosshair", "crosshair", {
        back: [{ x: 0, y: 0, width: 2, height: 20, radius: 1 }],
    }),
    copy: makeDesign("copy", "copy", {
        back: [{ x: -4, y: -4, width: 16, height: 16, radius: 4 }],
    }),
    move: makeDesign("move", "move-diamond", {
        bodyStyle: "outline",
        back: [
            { x: 0, y: 0, width: 20, height: 3, radius: 1 },
            { x: 0, y: 0, width: 3, height: 20, radius: 1 },
        ],
    }),
    grab: makeDesign("grab", "grab"),
    grabbing: makeDesign("grabbing", "grabbing"),
    "not-allowed": makeDesign("not-allowed", "no-symbol", {
        front: [{ x: 0, y: 0, width: 20, height: 2, radius: 1, rotation: 45 }],
    }),
    "zoom-in": makeDesign("zoom-in", "zoom", {
        front: [
            { x: 0, y: 0, width: 8, height: 2, radius: 1, style: "white" },
            { x: 0, y: 0, width: 2, height: 8, radius: 1, style: "white" },
        ],
    }),
    "zoom-out": makeDesign("zoom-out", "zoom", {
        front: [{ x: 0, y: 0, width: 8, height: 2, radius: 1, style: "white" }],
    }),
};

/** 所有形状对先共用这一套过渡；以后可以给个别 pair 单独覆盖时长/曲线 */
const SHAPE_TRANSITION = {
    duration: 150,
    map: timingFunction.easeOut,
};

/** 协议用下划线（ew_resize），桌面内部用连字符（ew-resize），两种都接受 */
function normalizeCursorShape(shape: string): string {
    return shape.replaceAll("_", "-");
}

/** 形状名映射到设计；未设计的形状回落到 default */
function cursorDesign(shape: string): CursorDesign {
    const key = normalizeCursorShape(shape);
    const alias = CURSOR_DESIGN_ALIASES[key];
    return CURSOR_DESIGNS[alias ?? key] ?? CURSOR_DESIGNS.default;
}

/** 线 resize 的内部方向：0=东，90=南，顺时针为正 */
type LineResizeInfo = {
    angle: number;
    /** ew/ns/对角/col/row 是双向线，方向不唯一 */
    twoWay: boolean;
};

const LINE_RESIZE_INFO: Record<string, LineResizeInfo> = {
    "e-resize": { angle: 0, twoWay: false },
    "se-resize": { angle: 45, twoWay: false },
    "s-resize": { angle: 90, twoWay: false },
    "sw-resize": { angle: 135, twoWay: false },
    "w-resize": { angle: 180, twoWay: false },
    "nw-resize": { angle: 225, twoWay: false },
    "n-resize": { angle: 270, twoWay: false },
    "ne-resize": { angle: 315, twoWay: false },
    "ew-resize": { angle: 0, twoWay: true },
    "ns-resize": { angle: 90, twoWay: true },
    "nwse-resize": { angle: 45, twoWay: true },
    "nesw-resize": { angle: 135, twoWay: true },
    "col-resize": { angle: 0, twoWay: true },
    "row-resize": { angle: 90, twoWay: true },
};

function lineResizeInfo(shape: string): LineResizeInfo | undefined {
    return LINE_RESIZE_INFO[normalizeCursorShape(shape)];
}

/** 归一到 (-180, 180]，180 度保持正方向 */
function normalizeAngle(angle: number): number {
    const normalized = ((angle % 360) + 360) % 360;
    return normalized > 180 ? normalized - 360 : normalized;
}

/** 双向线里挑离给定方向更近的那个方向 */
function closestLineDirection(info: LineResizeInfo, angle: number): number {
    if (!info.twoWay) return info.angle;
    const other = info.angle + 180;
    return Math.abs(normalizeAngle(info.angle - angle)) <= Math.abs(normalizeAngle(other - angle)) ? info.angle : other;
}

/**
 * 线 resize 的方向过渡：
 * - 双向 → 单向 / 单向 → 双向共线时 delta 为 0，不转；
 * - 其余情况按语义方向旋转，反向单方向之间得到 180 度。
 */
function lineTransition(from: LineResizeInfo, to: LineResizeInfo) {
    const targetAngle = to.twoWay ? closestLineDirection(to, from.angle) : to.angle;
    const startAngle = from.twoWay ? closestLineDirection(from, targetAngle) : from.angle;
    return { startAngle, targetAngle, delta: normalizeAngle(targetAngle - startAngle) };
}

function lineRotationDelta(fromShape: string, toShape: string): number {
    const from = lineResizeInfo(fromShape);
    const to = lineResizeInfo(toShape);
    if (!from || !to) return 0;
    return lineTransition(from, to).delta;
}

/** 标准横线：长度/粗细和现有 resize 线一致，只靠 rotation 表示方向 */
function canonicalLineMetrics(rotation: number): CursorShapeMetrics {
    return { width: 22, height: 3, radius: 2, rotation, x: 0, y: 0 };
}

/** move 十字的一条臂：标准横线，竖向用 rotation 90/270 */
function crossArmMetrics(rotation: number): CursorShapeMetrics {
    return { width: 20, height: 3, radius: 1, rotation, x: 0, y: 0 };
}

const MOVE_LIKE_SHAPES = new Set(["move", "all-scroll", "all-resize"]);

function isMoveLikeShape(shape: string): boolean {
    return MOVE_LIKE_SHAPES.has(normalizeCursorShape(shape));
}

/** 0/45/90/135 的线方向，忽略单向/反向 */
function lineOrientation(angle: number): number {
    return ((angle % 180) + 180) % 180;
}

const CROSS_H_ARM: CursorDecoration = { x: 0, y: 0, width: 20, height: 3, radius: 1 };
const CROSS_V_ARM: CursorDecoration = { x: 0, y: 0, width: 3, height: 20, radius: 1 };
const MOVE_DIAMOND_DECORATION: CursorDecoration = {
    x: 0,
    y: 0,
    width: 16,
    height: 16,
    radius: 2,
    rotation: 45,
    style: "frame",
};

/** resize ↔ move 特殊过渡的临时设计：一条十字臂作为 body，菱形和另一条臂作为装饰 */
function moveLineSpecialDesign(bodyArmVertical: boolean): CursorDesign {
    return {
        key: `move-line-special-${bodyArmVertical ? "v" : "h"}`,
        bodyKey: "move-diamond",
        body: CURSOR_METRICS["move-diamond"],
        bodyStyle: "fill",
        back: [MOVE_DIAMOND_DECORATION, bodyArmVertical ? CROSS_H_ARM : CROSS_V_ARM],
    };
}

/** text / crosshair 共用的临时设计：竖线 body + 横线装饰 */
const TEXT_CROSS_VERTICAL: CursorDesign = {
    key: "text-cross-vertical",
    bodyKey: "text",
    body: CURSOR_METRICS.text,
    bodyStyle: "fill",
    back: [{ x: 0, y: 0, width: 20, height: 2, radius: 1 }],
};

function applyCursorShapeMetrics(el: HTMLElement, metrics: CursorShapeMetrics) {
    el.style.width = `${metrics.width}px`;
    el.style.height = `${metrics.height}px`;
    el.style.borderRadius = `${metrics.radius}px`;
    el.style.transform = `translate(-50%, -50%) translate(${metrics.x}px, ${metrics.y}px) rotate(${metrics.rotation}deg)`;
}

function createDecorationEl(decoration: CursorDecoration): ElType<HTMLElement> {
    const style: Record<string, string> = {
        position: "absolute",
        left: `${decoration.x}px`,
        top: `${decoration.y}px`,
        width: `${decoration.width}px`,
        height: `${decoration.height}px`,
        borderRadius: `${decoration.radius ?? 0}px`,
        transform: `translate(-50%, -50%) rotate(${decoration.rotation ?? 0}deg)`,
        boxSizing: "border-box",
    };
    if (decoration.style === "outline") {
        style.background = "transparent";
        style.border = "1px solid #fff";
    } else if (decoration.style === "frame") {
        // 和 outline body 一样：深色内边 + 白色外描边
        style.background = "transparent";
        style.border = "1px solid rgba(0,0,0,0.5)";
        style.outline = "1px solid #fff";
    } else if (decoration.style === "white") {
        style.background = "#fff";
    } else {
        style.background = "rgba(0,0,0,0.5)";
        style.outline = "1px solid #fff";
    }
    return view().style(style);
}

/** 一个装饰层；过渡时旧层淡出、新层淡入 */
function createDecorationLayer(decorations: CursorDecoration[]): ElType<HTMLElement> {
    const layer = view().style({
        position: "absolute",
        left: "0px",
        top: "0px",
        width: "0px",
        height: "0px",
    });
    for (const decoration of decorations) layer.add(createDecorationEl(decoration));
    return layer;
}

function swapDecorationLayer(
    host: ElType<HTMLElement>,
    current: ElType<HTMLElement> | undefined,
    decorations: CursorDecoration[] | undefined,
    duration: number,
): ElType<HTMLElement> | undefined {
    const next =
        decorations && decorations.length > 0 ? createDecorationLayer(decorations).style({ opacity: "0" }) : undefined;
    if (next) host.add(next);

    if (duration > 0) {
        if (current) {
            const old = current;
            old.el
                .animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: "ease-out", fill: "forwards" })
                .finished.then(() => old.remove())
                .catch(() => old.remove());
        }
        next?.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: "ease-out", fill: "forwards" });
    } else {
        current?.remove();
        next?.style({ opacity: "1" });
    }
    return next;
}

function applyBodyStyle(el: HTMLElement, style: CursorDesign["bodyStyle"]) {
    el.style.boxSizing = "border-box";
    if (style === "outline") {
        // 空心外框用深色边 + 白色外描边：白底看黑边，黑底看白边
        el.style.background = "transparent";
        el.style.outline = "1px solid #fff";
        el.style.border = "1px solid rgba(0,0,0,0.5)";
    } else {
        el.style.background = "rgba(0,0,0,0.5)";
        el.style.outline = "1px solid #fff";
        el.style.border = "none";
    }
}

/** 光标形状视图：一个基座 body + 前后装饰层，供运行时和预览页共用 */
type CursorShapeView = {
    el: ElType<HTMLElement>;
    setBody(metrics: CursorShapeMetrics): void;
    setDesign(design: CursorDesign, duration: number): void;
    setScale(scale: number): void;
};

function createCursorShapeView(): CursorShapeView {
    const el = view().style({
        position: "absolute",
        left: "0px",
        top: "0px",
        width: "0px",
        height: "0px",
        pointerEvents: "none",
    });
    const backHost = view().style({
        position: "absolute",
        left: "0px",
        top: "0px",
        width: "0px",
        height: "0px",
        zIndex: "1",
    });
    const body = view().style({
        ...shapeStyle,
        position: "absolute",
        left: "0px",
        top: "0px",
        zIndex: "2",
    });
    const frontHost = view().style({
        position: "absolute",
        left: "0px",
        top: "0px",
        width: "0px",
        height: "0px",
        zIndex: "3",
    });
    el.add([backHost, body, frontHost]);

    let designKey: string | undefined;
    let decoKey: string | undefined;
    let backLayer: ElType<HTMLElement> | undefined;
    let frontLayer: ElType<HTMLElement> | undefined;

    /** 桌面 UI 缩放；光标位置仍由外层 warpEl 用视口坐标控制 */
    let scale = 1;
    let hotspotX = 0;
    let hotspotY = 0;

    /** 整个视觉内容按 -hotspot 平移，让热点落到指针/单元格中心；缩放包在外层 */
    function applyTransform(duration: number) {
        el.el.style.transition = duration > 0 ? `transform ${duration}ms ease-out` : "none";
        el.el.style.transform = `scale(${scale}) translate(${-hotspotX}px, ${-hotspotY}px)`;
    }

    function applyHotspot(design: CursorDesign, duration: number) {
        hotspotX = design.hotspot?.x ?? 0;
        hotspotY = design.hotspot?.y ?? 0;
        applyTransform(duration);
    }

    return {
        el,
        setBody(metrics: CursorShapeMetrics) {
            applyCursorShapeMetrics(body.el, metrics);
        },
        setDesign(design: CursorDesign, duration: number) {
            if (designKey === design.key) return;
            designKey = design.key;
            applyHotspot(design, duration);
            applyBodyStyle(body.el, design.bodyStyle);
            // progress / wait 共用同一组米字装饰，只移动 body 指示点，不重复淡入淡出
            const nextDecoKey = design.decoKey ?? design.key;
            if (decoKey !== nextDecoKey) {
                decoKey = nextDecoKey;
                backLayer = swapDecorationLayer(backHost, backLayer, design.back, duration);
                frontLayer = swapDecorationLayer(frontHost, frontLayer, design.front, duration);
            }
        },
        setScale(value: number) {
            if (value <= 0 || value === scale) return;
            scale = value;
            applyTransform(0);
        },
    };
}

/**
 * 管理一个形状视图的过渡：
 * - 普通形状：AnimationGear 补间 body，装饰层交叉淡入淡出；
 * - 线 resize ↔ 线 resize：用标准横线按语义方向旋转，结束后立刻切回目标的无方向帧。
 */
class CursorShapeAnimator {
    readonly el: ElType<HTMLElement>;
    private readonly view: CursorShapeView;
    private readonly gear: AnimationGear<CursorShapeMetrics>;
    private metrics: CursorShapeMetrics = { ...CURSOR_METRICS.default };
    private shape: string | undefined;
    private designKey: string | undefined;
    private bodyKey: string | undefined;
    private lineRotating = false;

    constructor() {
        this.view = createCursorShapeView();
        this.el = this.view.el;
        this.gear = new AnimationGear(CURSOR_METRICS.default, { transition: SHAPE_TRANSITION });
        for (const [name, metrics] of Object.entries(CURSOR_METRICS)) {
            this.gear.addState(name, metrics, []);
        }
        this.gear.setUpdateCallback((metrics) => {
            this.metrics = metrics;
            this.view.setBody(metrics);
        });
    }

    /** 桌面 UI 缩放；形状几何和装饰一起缩放，热点仍落在指针位置 */
    setScale(scale: number) {
        this.view.setScale(scale);
    }

    setShape(shape: string, duration: number, instant = false) {
        // 同一目标重复渲染时保持正在进行的过渡：指针进出热区会同时触发 localShape 和
        // setSurfaceFocus 两次 render，若再走线 resize 的 delta=0 分支会直接跳到静止帧
        if (!instant && this.shape === shape) return;

        const design = cursorDesign(shape);
        const line = lineResizeInfo(shape);
        const prevLine = this.shape ? lineResizeInfo(this.shape) : undefined;
        const move = isMoveLikeShape(shape);
        const prevMove = this.shape ? isMoveLikeShape(this.shape) : false;
        const shapeKey = normalizeCursorShape(shape);
        const prevShapeKey = this.shape ? normalizeCursorShape(this.shape) : undefined;

        // 初始帧；从图片/隐藏切回来也直接落到目标帧
        if (this.shape === undefined || instant) {
            this.applyResting(shape, design);
            return;
        }

        // text ↔ crosshair：竖线保持为十字竖装饰，不旋转
        if (
            (shapeKey === "crosshair" && prevShapeKey === "text") ||
            (shapeKey === "text" && prevShapeKey === "crosshair")
        ) {
            this.transitionTextCross(shape, design, shapeKey === "crosshair", duration);
            return;
        }

        // resize → move：用十字臂作为临时 body，而不是外框
        if (move && prevLine) {
            this.transitionMoveLine(shape, design, prevLine, true, duration);
            return;
        }
        // move → resize
        if (line && prevMove) {
            this.transitionMoveLine(shape, design, line, false, duration);
            return;
        }

        // 线 resize 之间的方向旋转
        if (line && prevLine) {
            if (this.lineRotating) {
                const startAngle = this.metrics.rotation;
                const targetAngle = line.twoWay ? closestLineDirection(line, startAngle) : line.angle;
                const delta = normalizeAngle(targetAngle - startAngle);
                this.shape = shape;
                if (delta === 0) {
                    this.applyResting(shape, design);
                } else {
                    this.animateLine(startAngle, startAngle + delta, duration, () => this.applyResting(shape, design));
                }
                return;
            }
            const { startAngle, delta } = lineTransition(prevLine, line);
            this.shape = shape;
            if (delta === 0) {
                // 共线的双向 ↔ 单向：视觉相同，不转，只更新内部方向
                this.applyResting(shape, design);
            } else {
                this.animateLine(startAngle, startAngle + delta, duration, () => this.applyResting(shape, design));
            }
            return;
        }

        // 普通形状过渡
        this.lineRotating = false;
        this.shape = shape;
        if (this.designKey === design.key) return;
        this.designKey = design.key;
        this.view.setDesign(design, duration);
        if (this.bodyKey !== design.bodyKey) {
            this.bodyKey = design.bodyKey;
            this.gear.moveTo(design.bodyKey, duration);
        }
    }

    /** 无动画地落到目标设计；线 resize 结束时也用它替换成无方向语义帧 */
    private applyResting(shape: string, design: CursorDesign) {
        this.shape = shape;
        this.designKey = design.key;
        this.bodyKey = design.bodyKey;
        this.lineRotating = false;
        this.view.setDesign(design, 0);
        this.gear.moveTo(design.bodyKey, 0);
    }

    private animateLine(startAngle: number, targetAngle: number, duration: number, onComplete: () => void) {
        this.lineRotating = true;
        this.gear.moveTo(canonicalLineMetrics(startAngle), 0);
        this.gear.moveTo(canonicalLineMetrics(targetAngle), {
            duration,
            map: SHAPE_TRANSITION.map,
            onComplete,
        });
    }

    /**
     * text ↔ crosshair：竖线始终是 body，横线作为装饰淡入/淡出，不做旋转或尺寸伸缩。
     */
    private transitionTextCross(
        targetShape: string,
        targetDesign: CursorDesign,
        toCrosshair: boolean,
        duration: number,
    ) {
        this.lineRotating = false;
        this.shape = targetShape;
        if (toCrosshair) {
            // text → crosshair：竖线保持，横线作为装饰淡入
            this.view.setDesign(TEXT_CROSS_VERTICAL, duration);
        } else {
            // crosshair → text：先把角色切成“竖线 body + 横线装饰”，再让横线淡出
            this.view.setDesign(TEXT_CROSS_VERTICAL, 0);
            this.gear.moveTo(CURSOR_METRICS.text, 0);
            this.view.setDesign(targetDesign, duration);
        }
        // 用一次同目标的 body 补间拿结束回调；body 视觉不变
        this.gear.moveTo(CURSOR_METRICS.text, {
            duration,
            map: SHAPE_TRANSITION.map,
            onComplete: () => this.applyResting(targetShape, targetDesign),
        });
    }

    /**
     * resize ↔ move 的特殊过渡：
     * - 横/竖 resize 不旋转，直接作为十字的一条臂；
     * - 斜 resize 旋转到最近的横/竖臂；
     * - 菱形外框和另一条臂作为装饰淡入/淡出，不参与 body 形变。
     */
    private transitionMoveLine(
        targetShape: string,
        targetDesign: CursorDesign,
        resizeLine: LineResizeInfo,
        targetIsMove: boolean,
        duration: number,
    ) {
        const wasLineRotating = this.lineRotating;
        this.lineRotating = false;
        this.shape = targetShape;

        if (targetIsMove) {
            // resize → move：线变成十字臂，菱形和另一条臂淡入
            const sourceOrientation = wasLineRotating
                ? lineOrientation(this.metrics.rotation)
                : lineOrientation(resizeLine.angle);
            const sourceAngle = wasLineRotating
                ? this.metrics.rotation
                : sourceOrientation === 135
                  ? -45
                  : sourceOrientation;
            // 和 move → resize 选同一条臂，保证进入/退出可逆
            const armOrientation = sourceOrientation === 90 ? 90 : 0;
            const otherArmAngle = armOrientation + 180;
            const armAngle =
                Math.abs(normalizeAngle(armOrientation - sourceAngle)) <=
                Math.abs(normalizeAngle(otherArmAngle - sourceAngle))
                    ? armOrientation
                    : otherArmAngle;
            const delta = normalizeAngle(armAngle - sourceAngle);
            const endAngle = sourceAngle + delta;
            const bodyArmVertical = armOrientation === 90;
            this.view.setDesign(moveLineSpecialDesign(bodyArmVertical), duration);
            this.gear.moveTo(canonicalLineMetrics(sourceAngle), 0);
            this.gear.moveTo(crossArmMetrics(endAngle), {
                duration,
                map: SHAPE_TRANSITION.map,
                onComplete: () => this.applyResting(targetShape, targetDesign),
            });
            return;
        }

        // move → resize：先切到十字臂，再旋转/缩短成 resize 线，菱形和另一条臂淡出
        const orientation = lineOrientation(resizeLine.angle);
        const targetAngle = orientation === 135 ? -45 : orientation;
        const startArmVertical = orientation === 90;
        this.view.setDesign(moveLineSpecialDesign(startArmVertical), 0);
        this.gear.moveTo(crossArmMetrics(startArmVertical ? 90 : 0), 0);
        this.view.setDesign(targetDesign, duration);
        this.gear.moveTo(canonicalLineMetrics(targetAngle), {
            duration,
            map: SHAPE_TRANSITION.map,
            onComplete: () => this.applyResting(targetShape, targetDesign),
        });
    }
}

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
 * 形状之间用 AnimationGear 补间基座几何；装饰层独立淡入淡出。
 * 图片/隐藏没有可连续的形状，直接切换。
 */
export class Cursor {
    private warpEl: ElType<HTMLElement>;
    private state: cursorState = DEFAULT_STATE;
    /** 每个客户端最后设置的光标（记忆），指针离开后重新进入时恢复 */
    private clientStates = new Map<string, cursorState>();
    /** 指针当前所在客户端的 id，undefined 表示在桌面上 */
    private clientId: string | undefined;
    /** 桌面覆盖层（如窗口缩放热区）临时指定的光标形状，优先于客户端光标 */
    private localShape: string | undefined;
    /** 当前形状动画器；图片/隐藏状态时不存在 */
    private shapeAnimator: CursorShapeAnimator | undefined;
    /** 桌面 UI 缩放；只作用于形状光标，位置仍是视口坐标 */
    private scale = 1;

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
        this.showShape("default", true);
    }

    /** 移动光标位置 */
    move(x: number, y: number) {
        this.warpEl.style({ left: `${x}px`, top: `${y}px` });
    }

    /** 桌面 UI 缩放（只影响形状光标；图片光标由调用方按输出/界面缩放设置尺寸） */
    setScale(scale: number) {
        if (!Number.isFinite(scale) || scale <= 0 || scale === this.scale) return;
        this.scale = scale;
        this.shapeAnimator?.setScale(scale);
    }

    /** 桌面覆盖层指定的光标形状（如缩放热区的 ew-resize），传 undefined 取消 */
    setLocalShape(shape: string | undefined) {
        if (this.localShape === shape) return;
        this.localShape = shape;
        this.render();
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

    /** 客户端surface图片光标，hotspot/尺寸都是桌面显示坐标（已乘输出缩放） */
    setImage(
        clientId: string,
        canvas: OffscreenCanvas,
        hotspotX: number,
        hotspotY: number,
        size?: { width: number; height: number },
    ) {
        this.clientUpdate(clientId, { type: "image", canvas, hotspot: { x: hotspotX, y: hotspotY }, size });
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

    /** 根据状态渲染光标内容；形状之间补间，图片/隐藏直接切换 */
    private render() {
        // 桌面覆盖层的光标优先于客户端光标（缩放热区盖在窗口内容上）
        const state = this.localShape === undefined ? this.state : ({ type: "shape", shape: this.localShape } as const);
        if (state.type === "image") {
            this.showOther(this.imageContent(state));
            return;
        }
        if (state.type === "hidden") {
            this.showOther(view());
            return;
        }
        this.showShape(state.type === "shape" ? state.shape : "default");
    }

    /** 确保形状动画器存在并过渡到目标形状 */
    private showShape(shape: string, instant = false) {
        if (this.shapeAnimator === undefined) {
            this.shapeAnimator = new CursorShapeAnimator();
            this.shapeAnimator.setScale(this.scale);
            this.warpEl.clear().add(this.shapeAnimator.el);
        }
        this.shapeAnimator.setShape(shape, SHAPE_TRANSITION.duration, instant);
    }

    /** 图片/隐藏内容没有可补间的几何，直接换掉 */
    private showOther(content: ElType<HTMLElement>) {
        this.shapeAnimator = undefined;
        this.warpEl.clear().add(content);
    }

    private imageContent(state: Extract<cursorState, { type: "image" }>): ElType<HTMLElement> {
        const cel = ele("canvas");
        cel.attr({ width: state.canvas.width, height: state.canvas.height });
        cel.el.getContext("2d")?.drawImage(state.canvas, 0, 0);
        if (state.size) {
            cel.style({ width: `${state.size.width}px`, height: `${state.size.height}px` });
        }
        return cel.style({
            position: "absolute",
            left: `-${state.hotspot.x}px`,
            top: `-${state.hotspot.y}px`,
        });
    }
}

function isSameState(a: cursorState, b: cursorState): boolean {
    if (a.type !== b.type) return false;
    if (a.type === "shape" && b.type === "shape") return a.shape === b.shape;
    if (a.type === "image" && b.type === "image")
        return (
            a.canvas === b.canvas &&
            a.hotspot.x === b.hotspot.x &&
            a.hotspot.y === b.hotspot.y &&
            a.size?.width === b.size?.width &&
            a.size?.height === b.size?.height
        );
    return true;
}

export {
    CURSOR_SHAPES,
    type CursorDecoration,
    type CursorDesign,
    CursorShapeAnimator,
    type CursorShapeMetrics,
    type CursorShapeName,
    cursorDesign,
    lineRotationDelta,
};
