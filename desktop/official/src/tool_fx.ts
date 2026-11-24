import { type ElType, view } from "dkh-ui";
import { AnimationGear, timingFunction } from "myde-ui";
import { gGlassStyle, gSurfaceStyle } from "./ui";

/**
 * 工具弹窗第一个 L2 的状态动效。
 *
 * 循环全部由 AnimationGear 驱动；动效层平时隐藏。
 * 状态开启且弹窗展开时，动效从 L2 中心用圆形遮罩扩开并启动循环；收起时循环继续运动，遮罩反向收完后再暂停。
 */

/** 电量条条纹的间距；条纹位移由它换算 */
const STRIPE_PERIOD = 16;
/** 所有动效线条的统一粗细 */
const FX_LINE_WIDTH = 2;

/** 圆形遮罩展开的时长与缓动 */
const REVEAL_IN = { duration: 420, map: timingFunction.easeOut };
const REVEAL_OUT = { duration: 240, map: timingFunction.easeIn };
/** 遮罩展开到超过最远角，保证最后完全覆盖 L2 */
const REVEAL_FULL = 108;
/** 遮罩边缘的柔化宽度，按离中心最远距离的百分比 */
const REVEAL_EDGE = 12;

type Rgba = { r: number; g: number; b: number; a: number };

function rgba({ r, g, b, a }: Rgba) {
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(a * 1000) / 1000})`;
}

/** 解析 #rrggbb / #rrggbbaa；工具弹窗的材质 token 都用这种格式 */
function parseColor(color: string): Rgba {
    const hex = color.startsWith("#") ? color.slice(1) : color;
    const full =
        hex.length === 3
            ? hex
                  .split("")
                  .map((c) => c + c)
                  .join("")
            : hex;
    return {
        r: Number.parseInt(full.slice(0, 2), 16),
        g: Number.parseInt(full.slice(2, 4), 16),
        b: Number.parseInt(full.slice(4, 6), 16),
        a: full.length >= 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1,
    };
}

function mixColor(from: Rgba, to: Rgba, progress: number): Rgba {
    return {
        r: from.r + (to.r - from.r) * progress,
        g: from.g + (to.g - from.g) * progress,
        b: from.b + (to.b - from.b) * progress,
        a: from.a + (to.a - from.a) * progress,
    };
}

/** L2 内层动效容器：父级建立独立的层叠上下文，动效垫在文字和控件下面 */
function createFxLayer(row: ElType<HTMLElement>) {
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

/** 从中心向外扩开的圆形遮罩；收起时反向缩回 */
function createReveal(layer: ElType<HTMLElement>) {
    const gear = new AnimationGear({ r: 0 }, { transition: REVEAL_IN });
    const apply = (r: number) => {
        layer.style({
            maskImage: `radial-gradient(circle at 50% 50%, #000 ${Math.max(0, r - REVEAL_EDGE)}%, transparent ${r}%)`,
            maskSize: "100% 100%",
        });
    };
    gear.setUpdateCallback(({ r }) => apply(r));
    apply(0);
    let shown = false;
    return {
        show() {
            shown = true;
            layer.style({ display: "block" });
            gear.moveTo({ r: REVEAL_FULL }, REVEAL_IN);
        },
        hide(onHidden?: () => void) {
            if (!shown) {
                onHidden?.();
                return;
            }
            shown = false;
            // AnimationGear 会把 onComplete 写进传入的 transition 对象，这里必须用副本，
            // 否则共享的 REVEAL_OUT 会带上上一个面板的收起回调，串到别的面板
            gear.moveTo({ r: 0 }, { ...REVEAL_OUT }, () => {
                layer.style({ display: "none" });
                onHidden?.();
            });
        },
    };
}

/** 状态开启 + 弹窗展开时才显示；退出时循环继续跑，等遮罩收完再暂停 */
function createActivity(row: ElType<HTMLElement>, layer: ElType<HTMLElement>, loop: { start(): void; pause(): void }) {
    const reveal = createReveal(layer);
    // L2 底色从半透明白过渡到 L3 实心白，和遮罩使用同一组时长
    const rowBase = parseColor(gGlassStyle.itemInBg.backgroundColor);
    const rowSolid = parseColor(gSurfaceStyle.solid.backgroundColor);
    const background = new AnimationGear({ progress: 0 }, { transition: REVEAL_IN });
    background.setUpdateCallback(({ progress }) =>
        row.style({ backgroundColor: rgba(mixColor(rowBase, rowSolid, progress)) }),
    );
    background.moveTo({ progress: 0 }, 0);
    let active = false;
    let visible = false;
    let shown = false;
    const sync = () => {
        const next = active && visible;
        if (next === shown) return;
        shown = next;
        if (next) {
            reveal.show();
            loop.start();
            background.moveTo({ progress: 1 }, REVEAL_IN);
        } else {
            background.moveTo({ progress: 0 }, REVEAL_OUT);
            reveal.hide(() => loop.pause());
        }
    };
    return {
        setActive(next: boolean) {
            if (active === next) return;
            active = next;
            sync();
        },
        setVisible(next: boolean) {
            if (visible === next) return;
            visible = next;
            sync();
        },
    };
}

/** 水波圆环的固定透明度：扩散到外圈也不变淡 */
const RIPPLE_OPACITY = 0.85;

/** 圆环在循环进度 p（0~1）处的半径比例 */
function rippleAt(phase: number) {
    const p = Math.min(1, Math.max(0, phase));
    return { scale: 0.06 + 0.94 * p, opacity: RIPPLE_OPACITY };
}

type RippleRing = {
    gear: AnimationGear<{ scale: number; opacity: number }>;
    current: { scale: number; opacity: number };
};

/**
 * 同心细线水波：从 L2 的底部中间向上，或从左边中间向右扩散。
 * 每圈从自己的相位开始循环，形成连续外扩的水波。
 */
export function attachRippleFx(
    row: ElType<HTMLElement>,
    op: { color: string; from: "bottom" | "left"; size?: number; rings?: number; duration?: number },
) {
    const layer = createFxLayer(row);
    const count = op.rings ?? 6;
    // 扩散范围覆盖整个 L2，超出部分交给 L2 的 overflow 裁切
    const size = op.size ?? (op.from === "bottom" ? 380 : 560);
    const cycleMs = (op.duration ?? 3) * 1000;
    const origin = op.from === "bottom" ? { left: "50%", bottom: "0" } : { left: "0", top: "50%" };
    const translateY = op.from === "bottom" ? "50%" : "-50%";
    const rings: RippleRing[] = [];
    for (let i = 0; i < count; i++) {
        const el = view().style({
            position: "absolute",
            width: `${size}px`,
            height: `${size}px`,
            boxSizing: "border-box",
            borderRadius: "50%",
            border: `${FX_LINE_WIDTH}px solid ${op.color}`,
            opacity: "0",
            ...origin,
        });
        const phase = i / count;
        const current = rippleAt(phase);
        const gear = new AnimationGear(current, { transition: { duration: cycleMs, map: timingFunction.linear } });
        const ring: RippleRing = { gear, current };
        gear.setUpdateCallback((value) => {
            ring.current = value;
            // 用宽高而不是 scale 缩放，边框不会跟着变大变细
            el.style({
                opacity: `${value.opacity}`,
                width: `${size * value.scale}px`,
                height: `${size * value.scale}px`,
                transform: `translate(-50%, ${translateY})`,
            });
        });
        gear.moveTo(current, 0);
        layer.add(el);
        rings.push(ring);
    }

    let running = false;
    const runRing = (ring: RippleRing, fromPhase: number) => {
        ring.gear.moveTo(
            { scale: 1, opacity: RIPPLE_OPACITY },
            {
                duration: (1 - fromPhase) * cycleMs,
                map: timingFunction.linear,
                onComplete: () => {
                    if (!running) return;
                    const start = rippleAt(0);
                    ring.gear.moveTo(start, 0);
                    runRing(ring, 0);
                },
            },
        );
    };
    const start = () => {
        running = true;
        for (const ring of rings) {
            // 从当前半径反推循环进度，退出遮罩还没收完就重新进入时接着走，不回到起点
            const progress = (ring.current.scale - 0.06) / 0.94;
            runRing(ring, Math.min(1, Math.max(0, progress)));
        }
    };
    const pause = () => {
        running = false;
        for (const ring of rings) ring.gear.moveTo(ring.current, 0);
    };

    return { el: layer, ...createActivity(row, layer, { start, pause }) };
}

type Orbit = {
    gear: AnimationGear<{ angle: number }>;
    speed: number;
    direction: number;
    current: number;
};

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
    const orbits: Orbit[] = [];
    tracks.forEach((ratio, i) => {
        const size = `${ratio * 100}%`;
        field.add(
            view().style({
                position: "absolute",
                inset: "0",
                margin: "auto",
                width: size,
                height: size,
                boxSizing: "border-box",
                borderRadius: "50%",
                border: `${FX_LINE_WIDTH}px solid ${op.color}`,
                opacity: "0.32",
            }),
        );
        const orbit = view().style({
            position: "absolute",
            inset: "0",
            margin: "auto",
            width: size,
            height: size,
        });
        orbit.add(
            view().style({
                position: "absolute",
                left: "50%",
                top: `${FX_LINE_WIDTH / 2}px`,
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: op.color,
                transform: "translate(-50%, -50%)",
            }),
        );
        field.add(orbit);

        const speed = Math.max(0.1, speeds[i] ?? speeds[speeds.length - 1] ?? 5);
        const direction = i % 2 === 0 ? 1 : -1;
        const gear = new AnimationGear(
            { angle: 0 },
            { transition: { duration: speed * 1000, map: timingFunction.linear } },
        );
        const entry: Orbit = { gear, speed, direction, current: 0 };
        gear.setUpdateCallback(({ angle }) => {
            entry.current = angle;
            orbit.style({ transform: `rotate(${angle}deg)` });
        });
        orbits.push(entry);
    });
    layer.add(field);

    let running = false;
    const runOrbit = (orbit: Orbit, fromProgress: number) => {
        orbit.gear.moveTo(
            { angle: orbit.direction * 360 },
            {
                duration: (1 - fromProgress) * orbit.speed * 1000,
                map: timingFunction.linear,
                onComplete: () => {
                    if (!running) return;
                    orbit.gear.moveTo({ angle: 0 }, 0);
                    runOrbit(orbit, 0);
                },
            },
        );
    };
    const start = () => {
        running = true;
        for (const orbit of orbits) {
            // 从当前角度反推循环进度；反向轨道角度为负，乘方向后归一到 0~1
            const progress = Math.min(1, Math.max(0, (orbit.current * orbit.direction) / 360));
            runOrbit(orbit, progress);
        }
    };
    const pause = () => {
        running = false;
        for (const orbit of orbits) orbit.gear.moveTo({ angle: orbit.current }, 0);
    };

    return { el: layer, ...createActivity(row, layer, { start, pause }) };
}

function stripeGradient(color: Rgba) {
    return `repeating-linear-gradient(90deg, ${rgba(color)} 0 ${FX_LINE_WIDTH}px, transparent ${FX_LINE_WIDTH}px ${STRIPE_PERIOD}px)`;
}

/** 充电时未充满的一段：绿色细条纹向左流动，速度最快 */
const CHARGE_TAIL_COLOR: Rgba = { r: 34, g: 197, b: 94, a: 0.6 };
const CHARGE_TAIL_STRIPES = stripeGradient(CHARGE_TAIL_COLOR);
const CHARGE_TAIL_DURATION = 0.55;

/** 电量条上的消耗条纹：性能（蓝）最快，平衡次之，静音最慢；充电时也按当前模式运行 */
function fillStripeDuration(profile: string) {
    if (profile === "performance") return 0.8;
    if (profile === "power-saver") return 1.45;
    return 1.1;
}

/** 电量分界线的移动、颜色切换、充电线的淡入淡出 */
const BOUNDARY_TRANSITION = { duration: 240, map: timingFunction.easeOut };
const COLOR_TRANSITION = { duration: 300, map: timingFunction.easeInOut };
const CHARGE_FADE = { duration: 260, map: timingFunction.easeOut };

function batteryPalette(
    profile: string,
    charging: boolean,
    percentage: number,
): { base: Rgba; stripe: Rgba; edge: Rgba } {
    // 非充电时填充区是 L3 实心白
    const whiteBase = parseColor(gSurfaceStyle.solid.backgroundColor);
    if (charging)
        return {
            base: { r: 74, g: 222, b: 128, a: 0.62 },
            stripe: { r: 255, g: 255, b: 255, a: 0.85 },
            edge: { r: 255, g: 255, b: 255, a: 0.95 },
        };
    if (profile === "power-saver")
        return {
            base: whiteBase,
            stripe: { r: 234, g: 179, b: 8, a: 0.7 },
            edge: { r: 234, g: 179, b: 8, a: 0.85 },
        };
    if (profile === "performance")
        return {
            base: whiteBase,
            stripe: { r: 59, g: 130, b: 246, a: 0.55 },
            edge: { r: 59, g: 130, b: 246, a: 0.8 },
        };
    if (percentage < 20)
        return {
            base: whiteBase,
            stripe: { r: 239, g: 68, b: 68, a: 0.55 },
            edge: { r: 239, g: 68, b: 68, a: 0.8 },
        };
    return {
        base: whiteBase,
        stripe: { r: 34, g: 197, b: 94, a: 0.48 },
        edge: { r: 34, g: 197, b: 94, a: 0.8 },
    };
}

/**
 * 三次 Hermite 曲线：用于条纹速度变化。
 * 起点和终点的斜率对应旧速度和新速度，中间连续过渡，不会突然变速。
 */
function speedMap(startSlope: number, endSlope: number) {
    return (u: number) => {
        const u2 = u * u;
        const u3 = u2 * u;
        return startSlope * (u3 - 2 * u2 + u) + (3 * u2 - 2 * u3) + endSlope * (u3 - u2);
    };
}

/**
 * 电池进度条：L2 整行作为电量轨道，填充宽度跟随百分比。
 * 静音黄线 / 平衡绿线 / 低电红线 / 性能蓝线，均为白底细条纹；充电为绿底白条纹。
 * 条纹统一向左流动，速度按充电流入 > 性能 > 平衡 > 静音排列；充电时填充条纹仍按当前模式的速度。
 * 填充区的消耗条纹集中在电量分界线附近，向左渐隐；分界线本身有一条固定细线。
 *
 * 填充宽度、分界线、右侧充电线共用同一个百分比补间，电量变化时分界点一起移动；
 * 底色、条纹色和分界线色单独补间，充电切换时平滑变色；充电线用透明度淡入淡出；
 * 消耗条纹以分界线为锚点，切换性能模式时速度用 Hermite 曲线平滑过渡。
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
        backgroundSize: `${STRIPE_PERIOD}px 100%`,
        backgroundRepeat: "repeat-x",
        display: "none",
    });
    const fill = view().style({
        position: "absolute",
        left: "0",
        top: "0",
        bottom: "0",
        width: "0%",
    });
    // 消耗条纹只集中在电量分界线附近，向左淡出；底色仍铺满整个填充区
    const fillStripes = view().style({
        position: "absolute",
        inset: "0",
        backgroundSize: `${STRIPE_PERIOD}px 100%`,
        backgroundRepeat: "repeat-x",
        maskImage: "linear-gradient(to right, transparent calc(100% - 90px), #000 100%)",
    });
    fill.add(fillStripes);
    // 分界线：固定细线一直标出已填充和未填充的边界
    const edge = view().style({
        position: "absolute",
        top: "0",
        bottom: "0",
        left: "0",
        width: `${FX_LINE_WIDTH}px`,
        transform: "translateX(-100%)",
        display: "none",
    });
    layer.add([tail, fill, edge]);

    let percentage = 0;
    let charging = false;
    let profile = "";
    let visible = false;

    // 分界点：填充宽度、分界线位置、充电线起点都由它驱动，保证电量变化时三者同步
    const boundary = new AnimationGear({ percent: 0 }, { transition: BOUNDARY_TRANSITION });
    boundary.setUpdateCallback(({ percent }) => {
        const value = Math.min(100, Math.max(0, percent));
        fill.style({ width: `${value}%` });
        edge.style({ left: `${value}%`, display: value > 0.01 ? "block" : "none" });
        tail.style({ left: `${value}%` });
    });

    const initialPalette = batteryPalette("", false, 0);
    const baseColor = new AnimationGear(initialPalette.base, { transition: COLOR_TRANSITION });
    baseColor.setUpdateCallback((color) => fill.style({ backgroundColor: rgba(color) }));
    const edgeColor = new AnimationGear(initialPalette.edge, { transition: COLOR_TRANSITION });
    edgeColor.setUpdateCallback((color) => edge.style({ backgroundColor: rgba(color) }));
    const stripeColor = new AnimationGear(initialPalette.stripe, { transition: COLOR_TRANSITION });
    stripeColor.setUpdateCallback((color) => fillStripes.style({ backgroundImage: stripeGradient(color) }));

    // 右侧充电线：透明度控制出现和消失，淡出结束后再隐藏
    const chargeMix = new AnimationGear({ show: 0 }, { transition: CHARGE_FADE });
    chargeMix.setUpdateCallback(({ show }) => {
        tail.style({ opacity: `${show}`, display: show > 0 ? "block" : "none" });
    });

    let tailPhase = 0;
    const tailStripes = new AnimationGear(
        { phase: 0 },
        {
            transition: { duration: CHARGE_TAIL_DURATION * 1000, map: timingFunction.linear },
        },
    );
    tailStripes.setUpdateCallback(({ phase }) => {
        tailPhase = phase;
        // 以右端为锚点向左流动，和分界线处的消耗条纹保持一致
        tail.style({ backgroundPositionX: `calc(100% - ${phase * STRIPE_PERIOD}px)` });
    });

    let fillPhase = 0;
    let fillSpeed = 1 / fillStripeDuration(profile);
    let liveFillSpeed = fillSpeed;
    let lastFillPhase = 0;
    let lastFillAt = 0;
    const fillLoop = new AnimationGear(
        { phase: 0 },
        {
            transition: { duration: 1000 / fillSpeed, map: timingFunction.linear },
        },
    );
    fillLoop.setUpdateCallback(({ phase }) => {
        const now = Date.now();
        if (lastFillAt > 0) {
            const elapsed = (now - lastFillAt) / 1000;
            let delta = phase - lastFillPhase;
            if (delta < -0.5) delta += 1;
            if (delta >= 0 && delta < 0.5 && elapsed > 0) liveFillSpeed = delta / elapsed;
        }
        lastFillPhase = phase;
        lastFillAt = now;
        fillPhase = phase;
        // 图案以分界点为锚点，分界线移动时条纹不会跟着错位
        fillStripes.style({ backgroundPositionX: `calc(100% - ${phase * STRIPE_PERIOD}px)` });
    });

    let running = false;
    const runTail = (from: number) => {
        tailStripes.moveTo({ phase: from }, 0);
        tailStripes.moveTo(
            { phase: 1 },
            {
                duration: (1 - from) * CHARGE_TAIL_DURATION * 1000,
                map: timingFunction.linear,
                onComplete: () => {
                    if (!running) return;
                    runTail(0);
                },
            },
        );
    };
    const runFill = (from: number, fromSpeed: number, toSpeed: number) => {
        if (!running) return;
        const start = Math.min(0.999, Math.max(0, from));
        const average = Math.max(0.01, (fromSpeed + toSpeed) / 2);
        const duration = ((1 - start) / average) * 1000;
        fillLoop.moveTo({ phase: start }, 0);
        fillLoop.moveTo(
            { phase: 1 },
            {
                duration,
                map: speedMap(fromSpeed / average, toSpeed / average),
                onComplete: () => {
                    if (!running) return;
                    const speed = 1 / fillStripeDuration(profile);
                    fillPhase = 0;
                    fillLoop.moveTo({ phase: 0 }, 0);
                    runFill(0, speed, speed);
                },
            },
        );
    };
    const start = () => {
        running = true;
        runTail(tailPhase);
        runFill(fillPhase, fillSpeed, fillSpeed);
    };
    const pause = () => {
        running = false;
        tailStripes.moveTo({ phase: tailPhase }, 0);
        fillLoop.moveTo({ phase: fillPhase }, 0);
        lastFillAt = 0;
    };

    const renderPalette = () => {
        const value = Math.min(100, Math.max(0, percentage));
        const palette = batteryPalette(profile, charging, value);
        baseColor.moveTo(palette.base);
        stripeColor.moveTo(palette.stripe);
        edgeColor.moveTo(palette.edge);
    };
    renderPalette();

    return {
        el: layer,
        setPercentage: (value: number) => {
            percentage = value;
            boundary.moveTo({ percent: Math.min(100, Math.max(0, value)) });
            renderPalette();
        },
        setCharging: (value: boolean) => {
            charging = value;
            renderPalette();
            chargeMix.moveTo({ show: value ? 1 : 0 }, visible ? CHARGE_FADE : 0);
        },
        setProfile: (value: string) => {
            const fromSpeed = liveFillSpeed;
            profile = value;
            fillSpeed = 1 / fillStripeDuration(profile);
            renderPalette();
            if (running) runFill(fillPhase, fromSpeed, fillSpeed);
        },
        setVisible: (next: boolean) => {
            if (visible === next) return;
            visible = next;
            if (next) start();
            else pause();
        },
    };
}
