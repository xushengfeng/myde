/**
 * 帧时间图表：采样 requestAnimationFrame 的帧间隔，实时画出滚动条带与统计值。
 *
 * 只依赖 DOM / Canvas，桌面设置与 `test/frametime` 预览页共用。
 * 采样的是 rAF 时间戳之间的间隔，也就是桌面这一帧到下一帧的距离：
 * 稳定在目标预算内说明桌面链路跟得上，翻倍则说明有帧被丢掉。
 */

/** 一帧的采样：`t` 是 rAF 时间戳（该帧开始），`dt` 是距上一帧的间隔 */
type FrameSample = { t: number; dt: number };

export type FrameChartStats = {
    /** 窗口内的帧数 */
    samples: number;
    /** 最近一帧的间隔（ms） */
    current: number;
    /** 平均间隔（ms） */
    average: number;
    /** 平均帧率 */
    fps: number;
    /** 99 分位帧时间（ms） */
    p99: number;
    /** 窗口内最长的一帧（ms） */
    max: number;
    /** 1% low 帧率：最差 1% 帧的平均帧率 */
    lowFps: number;
    /** 超过长帧阈值的帧数 */
    longFrames: number;
    /** 当前使用的目标帧间隔（ms） */
    budget: number;
};

export type FrameChartOptions = {
    /** 滚动窗口时长（毫秒），默认 4000 */
    windowMs?: number;
    /** 目标刷新率（Hz），可传 getter 跟随设置变化 */
    refreshRate?: number | (() => number);
    /** 已知目标帧间隔（毫秒）时直接给出，优先级低于 refreshRate */
    budgetMs?: number;
    /** 画布高度（CSS px），默认 132 */
    height?: number;
    /** 创建后立即开始采样，默认 true */
    autoStart?: boolean;
    /** 长帧阈值相对目标帧间隔的倍数，默认 1.5 */
    longFrameFactor?: number;
};

export type FrameChart = {
    el: HTMLElement;
    start(): void;
    stop(): void;
    reset(): void;
    /** 切换目标刷新率，预算线与长帧判定随之变化 */
    setRefreshRate(refreshRate: number): void;
    /** 切换滚动窗口时长（毫秒） */
    setWindow(windowMs: number): void;
    readonly running: boolean;
    /** 当前窗口统计；还没有采样时为 null */
    stats(): FrameChartStats | null;
    destroy(): void;
};

const COLOR_NORMAL = "#00aaff";
const COLOR_WARN = "#f5a623";
const COLOR_BAD = "#e5484d";
const COLOR_GRID = "#00000012";
const COLOR_BUDGET = "#e5484daa";
const COLOR_LABEL = "#11111180";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** 纵轴刻度：帧时间通常落在几毫秒到几十毫秒，用固定档位避免每帧跳变 */
const Y_STEPS = [
    4, 6, 8, 10, 12, 16, 20, 25, 33, 40, 50, 66, 80, 100, 130, 160, 200, 250, 330, 400, 500, 660, 800, 1000, 1500, 2000,
];

/** 两帧间隔超过这个值按恢复/挂起处理，不画成一次长帧 */
const RESUME_GAP = 500;
const STATS_INTERVAL = 120;
const SCALE_HOLD = 700;

function dom<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    css: string,
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    for (const child of children) node.append(child);
    return node;
}

function formatMs(value: number) {
    if (!Number.isFinite(value) || value <= 0) return "0 ms";
    return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`;
}

export function createFrameChart(options: FrameChartOptions = {}): FrameChart {
    let windowLength = Math.max(500, options.windowMs ?? 4000);
    const height = Math.max(64, options.height ?? 132);
    const longFrameFactor = options.longFrameFactor ?? 1.5;
    let refreshRate = options.refreshRate;
    const fixedBudget = options.budgetMs;

    const samples: FrameSample[] = [];
    let running = false;
    let destroyed = false;
    let rafId = 0;
    let lastFrameAt: number | undefined;
    let lastStatsAt = 0;
    let yMax = 0;
    let yMaxHoldUntil = 0;

    // ── DOM ──
    const pauseButton = dom(
        "button",
        "flex-shrink:0;padding:3px 10px;border-radius:6px;border:1px solid #00000022;background:#fff;color:#111;font:11px/1.4 sans-serif;cursor:pointer;",
    );
    pauseButton.type = "button";

    const title = dom("span", "flex-shrink:0;font-size:12px;font-weight:600;color:#111;", "帧时间");
    const subtitle = dom(
        "span",
        `flex-shrink:0;font-size:10px;color:#11111199;font-family:${MONO};white-space:nowrap;`,
    );
    const header = dom(
        "div",
        "display:flex;align-items:center;gap:8px;min-width:0;",
        title,
        subtitle,
        dom("div", "flex:1 1 auto;min-width:0;"),
        pauseButton,
    );

    function statCell(label: string, tooltip: string) {
        const value = dom(
            "div",
            `font-weight:600;font-size:13px;line-height:1.2;font-family:${MONO};font-variant-numeric:tabular-nums;white-space:nowrap;color:#111;`,
        );
        value.textContent = "—";
        value.title = tooltip;
        const cell = dom(
            "div",
            "display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 64px;",
            dom("div", "font-size:10px;line-height:1.2;color:#11111188;white-space:nowrap;", label),
            value,
        );
        return { cell, value };
    }

    const currentStat = statCell("当前帧", "最近一帧与上一帧的间隔");
    const averageStat = statCell("平均帧", "滚动窗口内的平均帧间隔");
    const maxStat = statCell("最长帧", "滚动窗口内最长的一帧");
    const fpsStat = statCell("平均 FPS", "滚动窗口内的平均帧率");
    const lowStat = statCell("1% 低帧", "最差 1% 帧的平均帧率，反映卡顿");
    const longStat = statCell("长帧", "超过目标帧间隔 1.5 倍的帧数（窗口内）");
    const statsRow = dom(
        "div",
        "display:flex;gap:10px;flex-wrap:wrap;padding:0 2px;",
        currentStat.cell,
        averageStat.cell,
        maxStat.cell,
        fpsStat.cell,
        lowStat.cell,
        longStat.cell,
    );

    const canvas = dom("canvas", `display:block;width:100%;height:${height}px;border-radius:8px;background:#00000006;`);
    const ctx = canvas.getContext("2d");

    const el = dom("div", "display:flex;flex-direction:column;gap:6px;width:100%;min-width:0;color:#111;", header);
    el.append(statsRow, canvas);

    // ── 采样与统计 ──

    function budget(): number {
        const rate = typeof refreshRate === "function" ? refreshRate() : refreshRate;
        if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) return 1000 / rate;
        if (typeof fixedBudget === "number" && fixedBudget > 0) return fixedBudget;
        return 1000 / 60;
    }

    function trim(now: number) {
        const oldest = now - windowLength;
        let drop = 0;
        while (drop < samples.length && samples[drop].t < oldest) drop++;
        if (drop > 0) samples.splice(0, drop);
    }

    function computeStats(now: number, frameBudget: number): FrameChartStats | null {
        trim(now);
        const count = samples.length;
        if (count === 0) return null;

        let sum = 0;
        let max = 0;
        let longFrames = 0;
        const intervals = new Array<number>(count);
        for (let i = 0; i < count; i++) {
            const dt = samples[i].dt;
            intervals[i] = dt;
            sum += dt;
            if (dt > max) max = dt;
            if (dt > frameBudget * longFrameFactor) longFrames++;
        }
        const average = sum / count;
        intervals.sort((a, b) => a - b);
        const p99 = intervals[Math.min(count - 1, Math.floor(count * 0.99))];
        // 1% low：取最差 1% 帧（至少 1 帧）的平均帧时间换算成帧率
        const worstCount = Math.max(1, Math.round(count * 0.01));
        let worstSum = 0;
        for (let i = count - 1; i >= count - worstCount; i--) worstSum += intervals[i];
        const worstAverage = worstSum / worstCount;

        return {
            samples: count,
            current: samples[count - 1].dt,
            average,
            fps: average > 0 ? 1000 / average : 0,
            p99,
            max,
            lowFps: worstAverage > 0 ? 1000 / worstAverage : 0,
            longFrames,
            budget: frameBudget,
        };
    }

    function updateSubtitle(frameBudget: number) {
        const rate = 1000 / frameBudget;
        subtitle.textContent = `${(windowLength / 1000).toFixed(1)}s 窗口 · 目标 ${formatMs(frameBudget)} · ${Math.round(rate)} Hz`;
    }

    function updateStats(now: number) {
        const frameBudget = budget();
        updateSubtitle(frameBudget);
        const stats = computeStats(now, frameBudget);
        if (!stats) {
            for (const item of [currentStat, averageStat, maxStat, fpsStat, lowStat, longStat])
                item.value.textContent = "—";
            longStat.value.style.color = "";
            return;
        }
        currentStat.value.textContent = formatMs(stats.current);
        averageStat.value.textContent = formatMs(stats.average);
        maxStat.value.textContent = formatMs(stats.max);
        fpsStat.value.textContent = stats.fps.toFixed(1);
        lowStat.value.textContent = stats.lowFps.toFixed(1);
        longStat.value.textContent = String(stats.longFrames);
        longStat.value.style.color = stats.longFrames > 0 ? COLOR_BAD : "#111";
        longStat.value.title = `超过 ${formatMs(stats.budget * longFrameFactor)} 的帧数（窗口内 ${stats.samples} 帧）`;
    }

    // ── 绘制 ──

    function pickScale(maxDt: number, frameBudget: number, now: number) {
        const target = Math.max(frameBudget * 1.4, maxDt * 1.08);
        let next = Y_STEPS[Y_STEPS.length - 1];
        for (const step of Y_STEPS) {
            if (step >= target) {
                next = step;
                break;
            }
        }
        if (yMax === 0) {
            yMax = next;
            yMaxHoldUntil = now + SCALE_HOLD;
        } else if (next > yMax) {
            // 往上放大立即生效，往下缩回延迟一会儿，避免边界帧反复改比例
            yMax = next;
            yMaxHoldUntil = now + SCALE_HOLD;
        } else if (next < yMax && now > yMaxHoldUntil) {
            yMax = next;
            yMaxHoldUntil = now + SCALE_HOLD;
        }
        return yMax;
    }

    function barColor(dt: number, frameBudget: number) {
        if (dt > frameBudget * 2) return COLOR_BAD;
        if (dt > frameBudget * 1.25) return COLOR_WARN;
        return COLOR_NORMAL;
    }

    function draw(now: number) {
        if (!ctx) return;
        const width = canvas.clientWidth;
        const boxHeight = canvas.clientHeight;
        if (width <= 0 || boxHeight <= 0) return;

        const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const pixelWidth = Math.max(1, Math.round(width * dpr));
        const pixelHeight = Math.max(1, Math.round(boxHeight * dpr));
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, boxHeight);

        const frameBudget = budget();
        const plotLeft = 0;
        const plotRight = width - 44;
        const plotWidth = plotRight - plotLeft;
        const plotTop = 6;
        const plotBottom = boxHeight - 6;
        const plotHeight = plotBottom - plotTop;
        if (plotWidth <= 4 || plotHeight <= 4) return;

        let first = 0;
        const oldest = now - windowLength;
        while (first < samples.length && samples[first].t < oldest) first++;

        let maxDt = 0;
        for (let i = first; i < samples.length; i++) {
            if (samples[i].dt > maxDt) maxDt = samples[i].dt;
        }
        const scaleMax = pickScale(maxDt, frameBudget, now);
        const xOf = (t: number) => plotLeft + ((t - oldest) / windowLength) * plotWidth;

        // 网格
        ctx.lineWidth = 1;
        ctx.strokeStyle = COLOR_GRID;
        ctx.beginPath();
        for (const fraction of [0.5, 1]) {
            const y = Math.round(plotBottom - plotHeight * fraction) + 0.5;
            ctx.moveTo(plotLeft, y);
            ctx.lineTo(plotRight, y);
        }
        ctx.stroke();

        // 每帧一根竖条：颜色区分正常、超 1.25 倍、超 2 倍预算
        let lastColor = "";
        for (let i = first; i < samples.length; i++) {
            const sample = samples[i];
            const x1 = xOf(sample.t);
            const x0 = xOf(sample.t - sample.dt);
            const barWidth = Math.max(1, x1 - x0);
            const barHeight = Math.max(0.5, (sample.dt / scaleMax) * plotHeight);
            const color = barColor(sample.dt, frameBudget);
            if (color !== lastColor) {
                ctx.fillStyle = color;
                lastColor = color;
            }
            ctx.fillRect(x0, plotBottom - barHeight, barWidth, barHeight);
        }

        // 目标预算线
        const budgetY = plotBottom - (frameBudget / scaleMax) * plotHeight;
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = COLOR_BUDGET;
        ctx.beginPath();
        ctx.moveTo(plotLeft, Math.round(budgetY) + 0.5);
        ctx.lineTo(plotRight, Math.round(budgetY) + 0.5);
        ctx.stroke();
        ctx.restore();

        // 右侧刻度
        ctx.fillStyle = COLOR_LABEL;
        ctx.font = `9px ${MONO}`;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(formatMs(scaleMax), width - 4, plotTop + 4);
        ctx.fillText(formatMs(frameBudget), width - 4, budgetY);
    }

    // ── 采样循环 ──

    function tick(now: number) {
        rafId = 0;
        if (!running || destroyed) return;

        if (lastFrameAt !== undefined) {
            const dt = now - lastFrameAt;
            if (dt > 0 && dt <= RESUME_GAP) {
                samples.push({ t: now, dt });
                trim(now);
            }
        }
        lastFrameAt = now;

        draw(now);
        if (now - lastStatsAt >= STATS_INTERVAL) {
            lastStatsAt = now;
            updateStats(now);
        }
        rafId = requestAnimationFrame(tick);
    }

    function start() {
        if (running || destroyed) return;
        running = true;
        lastFrameAt = undefined;
        pauseButton.textContent = "暂停";
        updateSubtitle(budget());
        rafId = requestAnimationFrame(tick);
    }

    function stop() {
        if (!running) return;
        running = false;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        pauseButton.textContent = "继续";
    }

    function reset() {
        samples.length = 0;
        lastFrameAt = undefined;
        yMax = 0;
        const now = performance.now();
        draw(now);
        updateStats(now);
    }

    pauseButton.addEventListener("click", () => {
        if (running) stop();
        else start();
    });

    updateSubtitle(budget());
    if (options.autoStart ?? true) {
        start();
    } else {
        pauseButton.textContent = "开始";
        draw(performance.now());
        updateStats(performance.now());
    }

    return {
        el,
        start,
        stop,
        reset,
        setRefreshRate: (rate: number) => {
            refreshRate = rate;
            yMax = 0;
            updateSubtitle(budget());
        },
        setWindow: (ms: number) => {
            windowLength = Math.max(500, ms);
            trim(performance.now());
            updateSubtitle(budget());
        },
        get running() {
            return running;
        },
        stats: () => computeStats(performance.now(), budget()),
        destroy: () => {
            destroyed = true;
            stop();
            el.remove();
        },
    };
}
