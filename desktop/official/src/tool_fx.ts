import { type ElType, view } from "dkh-ui";

/**
 * 工具弹窗第一个 L2 的状态动效。
 *
 * 动效层挂在 L2 内部、内容下层；状态关闭时直接 `display: none`。
 * 这些是持续循环的氛围动画，用 CSS animation 写：弹窗收起后父元素不可见，动画会自动停止，
 * 不需要额外订阅弹窗显隐，也不会在桌面空闲时占用帧预算。
 */

const STYLE_ID = "tool-l2-fx-style";

/** 电量条条纹的间距；keyframes 的位移和条纹渐变都由它生成 */
const STRIPE_PERIOD = 16;

const FX_STYLE = `
@keyframes tool-l2-fx-ripple-bottom {
    from { transform: translate(-50%, 50%) scale(0.06); opacity: 0.85; }
    70% { opacity: 0.35; }
    to { transform: translate(-50%, 50%) scale(1); opacity: 0; }
}
@keyframes tool-l2-fx-ripple-left {
    from { transform: translate(-50%, -50%) scale(0.06); opacity: 0.85; }
    70% { opacity: 0.35; }
    to { transform: translate(-50%, -50%) scale(1); opacity: 0; }
}
@keyframes tool-l2-fx-orbit {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}
@keyframes tool-l2-fx-stripes-left {
    from { background-position-x: 0; }
    to { background-position-x: -${STRIPE_PERIOD}px; }
}
`;

let styleReady = false;

function ensureStyle() {
    if (styleReady) return;
    styleReady = true;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = FX_STYLE;
    document.head.appendChild(style);
}

/** L2 内层动效容器：父级建立独立的层叠上下文，动效垫在文字和控件下面 */
function createFxLayer(row: ElType<HTMLElement>) {
    ensureStyle();
    row.style({ position: "relative", isolation: "isolate" });
    const el = view().style({
        position: "absolute",
        inset: "0",
        zIndex: "-1",
        pointerEvents: "none",
        overflow: "hidden",
        display: "none",
    });
    row.add(el);
    return el;
}

/**
 * 同心细线水波：从 L2 的底部中间向上，或从左边中间向右扩散。
 * 状态开启时显示，关闭后整个容器隐藏，动画随之停止。
 */
export function attachRippleFx(
    row: ElType<HTMLElement>,
    op: { color: string; from: "bottom" | "left"; size?: number; rings?: number; duration?: number },
) {
    const layer = createFxLayer(row);
    const rings = op.rings ?? 6;
    // 扩散范围覆盖整个 L2，超出部分交给 L2 的 overflow 裁切
    const size = op.size ?? (op.from === "bottom" ? 380 : 560);
    const duration = op.duration ?? 3;
    const animationName = op.from === "bottom" ? "tool-l2-fx-ripple-bottom" : "tool-l2-fx-ripple-left";
    const origin = op.from === "bottom" ? { left: "50%", bottom: "0" } : { left: "0", top: "50%" };
    for (let i = 0; i < rings; i++) {
        layer.add(
            view().style({
                position: "absolute",
                width: `${size}px`,
                height: `${size}px`,
                boxSizing: "border-box",
                borderRadius: "50%",
                border: `4px solid ${op.color}`,
                opacity: "0",
                ...origin,
                animationName,
                animationDuration: `${duration}s`,
                animationDelay: `${(duration / rings) * i}s`,
                animationTimingFunction: "linear",
                animationIterationCount: "infinite",
            }),
        );
    }
    return {
        el: layer,
        setActive: (active: boolean) => layer.style({ display: active ? "block" : "none" }),
    };
}

/**
 * 中心圆点 + 多层环绕轨道：轨道直径按 L2 宽度取比例，最外层铺满整个 L2 宽度。
 * 环绕点沿细轨道匀速旋转，速度各不相同、方向交替；超出 L2 的部分由父级裁切。
 */
export function attachOrbitFx(row: ElType<HTMLElement>, op: { color: string; tracks?: number[]; speeds?: number[] }) {
    const layer = createFxLayer(row);
    // 正方形轨道场，宽度跟随 L2；高度等于宽度，上下超出部分被裁切
    const field = view().style({
        position: "absolute",
        left: "50%",
        top: "50%",
        width: "100%",
        aspectRatio: "1",
        transform: "translate(-50%, -50%)",
    });
    field.add(
        view().style({
            position: "absolute",
            left: "50%",
            top: "50%",
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: op.color,
            transform: "translate(-50%, -50%)",
        }),
    );
    const tracks = op.tracks ?? [1, 0.8, 0.6, 0.4, 0.2];
    const speeds = op.speeds ?? [9.6, 7.4, 5.6, 8.2, 4.8];
    tracks.forEach((ratio, i) => {
        const size = `${ratio * 100}%`;
        field.add(
            view().style({
                position: "absolute",
                inset: "0",
                margin: "auto",
                width: size,
                height: size,
                borderRadius: "50%",
                border: `1px solid ${op.color}`,
                opacity: "0.32",
            }),
        );
        const orbit = view().style({
            position: "absolute",
            inset: "0",
            margin: "auto",
            width: size,
            height: size,
            animationName: "tool-l2-fx-orbit",
            animationDuration: `${speeds[i] ?? speeds[speeds.length - 1]}s`,
            animationTimingFunction: "linear",
            animationIterationCount: "infinite",
            animationDirection: i % 2 === 0 ? "normal" : "reverse",
        });
        orbit.add(
            view().style({
                position: "absolute",
                left: "50%",
                top: "0",
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: op.color,
                transform: "translate(-50%, -50%)",
            }),
        );
        field.add(orbit);
    });
    layer.add(field);
    return {
        el: layer,
        setActive: (active: boolean) => layer.style({ display: active ? "block" : "none" }),
    };
}

function stripeGradient(color: string, width: number) {
    return `repeating-linear-gradient(90deg, ${color} 0 ${width}px, transparent ${width}px ${STRIPE_PERIOD}px)`;
}

/** 充电时未充满的一段：绿色细条纹向左流动，速度最快 */
const CHARGE_TAIL_STRIPES = stripeGradient("rgba(34, 197, 94, 0.6)", 2);
const CHARGE_TAIL_DURATION = 0.55;

const STRIPES_LEFT = {
    animationName: "tool-l2-fx-stripes-left",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
} as const;

/** 电量条上的消耗条纹：性能（蓝）最快，平衡次之，静音最慢；充电时也按当前模式运行 */
function fillStripeDuration(profile: string) {
    if (profile === "performance") return 0.8;
    if (profile === "power-saver") return 1.45;
    return 1.1;
}

function batteryPalette(profile: string, charging: boolean, percentage: number) {
    const whiteBase = "rgba(255, 255, 255, 0.92)";
    if (charging)
        return {
            base: "rgba(74, 222, 128, 0.62)",
            stripe: "rgba(255, 255, 255, 0.85)",
            stripeWidth: 2,
            edge: "rgba(255, 255, 255, 0.95)",
        };
    if (profile === "power-saver")
        return { base: whiteBase, stripe: "rgba(234, 179, 8, 0.7)", stripeWidth: 1, edge: "rgba(234, 179, 8, 0.85)" };
    if (profile === "performance")
        return { base: whiteBase, stripe: "rgba(59, 130, 246, 0.55)", stripeWidth: 1, edge: "rgba(59, 130, 246, 0.8)" };
    if (percentage < 20)
        return { base: whiteBase, stripe: "rgba(239, 68, 68, 0.55)", stripeWidth: 1, edge: "rgba(239, 68, 68, 0.8)" };
    return { base: whiteBase, stripe: "rgba(34, 197, 94, 0.48)", stripeWidth: 1, edge: "rgba(34, 197, 94, 0.8)" };
}

/**
 * 电池进度条：L2 整行作为电量轨道，填充宽度跟随百分比。
 * 静音黄线 / 平衡绿线 / 低电红线 / 性能蓝线，均为白底细条纹；充电为绿底白条纹。
 * 条纹统一向左流动，速度按充电流入 > 性能 > 平衡 > 静音排列；充电时填充条纹仍按当前模式的速度。
 * 填充区的消耗条纹集中在电量分界线附近，向左渐隐；分界线本身有一条固定细线。
 */
export function attachBatteryFx(row: ElType<HTMLElement>) {
    const layer = createFxLayer(row);
    layer.style({ display: "block" });

    const tail = view().style({
        position: "absolute",
        top: "0",
        bottom: "0",
        left: "0",
        right: "0",
        backgroundImage: CHARGE_TAIL_STRIPES,
        display: "none",
        animationDuration: `${CHARGE_TAIL_DURATION}s`,
        ...STRIPES_LEFT,
    });
    const fill = view().style({
        position: "absolute",
        left: "0",
        top: "0",
        bottom: "0",
        width: "0%",
        transition: "width 240ms ease",
    });
    // 消耗条纹只集中在电量分界线附近，向左淡出；底色仍铺满整个填充区
    const fillStripes = view().style({
        position: "absolute",
        inset: "0",
        maskImage: "linear-gradient(to right, transparent calc(100% - 90px), #000 100%)",
        ...STRIPES_LEFT,
    });
    fill.add(fillStripes);
    // 分界线：固定细线一直标出已填充和未填充的边界
    const edge = view().style({
        position: "absolute",
        top: "0",
        bottom: "0",
        left: "0",
        width: "2px",
        transform: "translateX(-100%)",
        display: "none",
    });
    layer.add([tail, fill, edge]);

    let percentage = 0;
    let charging = false;
    let profile = "";

    const render = () => {
        const value = Math.min(100, Math.max(0, percentage));
        const palette = batteryPalette(profile, charging, value);
        fill.style({
            width: `${value}%`,
            backgroundColor: palette.base,
        });
        fillStripes.style({
            backgroundImage: stripeGradient(palette.stripe, palette.stripeWidth),
            animationDuration: `${fillStripeDuration(profile)}s`,
        });
        tail.style({
            left: `${value}%`,
            display: charging ? "block" : "none",
        });
        edge.style({
            left: `${value}%`,
            backgroundColor: palette.edge,
            display: value > 0 ? "block" : "none",
        });
    };
    render();

    return {
        el: layer,
        setPercentage: (value: number) => {
            percentage = value;
            render();
        },
        setCharging: (value: boolean) => {
            charging = value;
            render();
        },
        setProfile: (value: string) => {
            profile = value;
            render();
        },
    };
}
