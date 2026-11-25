import type { DesktopRunner } from "./desktop_runner";
import { decodePng, toLuma } from "./png";
import { sleep } from "./process_utils";

/** 只分析页面的一块区域（CSS px，和页面坐标系一致）。 */
export type RecordRegion = {
    /** 传 CSS 选择器时，以它的 bounding rect 作为区域；运行时求值 */
    selector?: string;
    /** 不给时用视口宽度 */
    x?: number;
    y?: number;
    width?: number;
    height?: number;
};

export type FrameRecorderOptions = {
    /** 最长记录时间；到时间自动结束采样 */
    durationMs: number;
    /** 只分析这块区域 */
    region?: RecordRegion;
    /** 推流的最大边长，默认 800；越小解码越快、帧率越高，但小元素更不容易看清 */
    maxSide?: number;
    /** 判定一个 tile 是否“变了”的亮度差（0–255），默认 4 */
    tileThreshold?: number;
    /** 变化统计的 tile 边长（分析图上的像素），默认 8 */
    tileSize?: number;
    /** 是否估计逐帧位移（判断切屏/拖动的方向），默认 true；只看运动量时关掉能省很多分析时间 */
    flow?: boolean;
};

export type RecordedFrame = {
    index: number;
    /** 这一帧到达测试进程的时间（ms，从开始记录算起） */
    at: number;
    width: number;
    height: number;
    /** 亮度图，长度为 width * height */
    luma: Uint8Array;
};

export type FrameDiff = {
    /** 后一帧的序号 */
    index: number;
    /** 后一帧的时间 */
    at: number;
    /** 与上一帧的间隔（ms），合成器掉帧时会变大 */
    dtMs: number;
    /** 全区域平均亮度差（0–255） */
    meanDiff: number;
    /** 变化超过 tileThreshold 的 tile 占比（0–1） */
    changedRatio: number;
    /** 由粗网格 SAD 估出的全局位移（分析图像素），用来判断变动方向 */
    flowX: number;
    flowY: number;
};

export type FrameMark = {
    label: string;
    /** ms，从开始记录算起 */
    at: number;
};

export type SmoothnessReport = {
    options: Required<Omit<FrameRecorderOptions, "region">> & { region?: RecordRegion };
    /** 分析区域的实际像素尺寸 */
    size: { width: number; height: number };
    durationMs: number;
    frames: RecordedFrame[];
    diffs: FrameDiff[];
    marks: FrameMark[];
    sampling: {
        count: number;
        /** 相邻帧间隔中位数，约等于实际帧时间 */
        intervalMedianMs: number;
        intervalP95Ms: number;
        intervalMaxMs: number;
        fps: number;
    };
};

/** 一段窗口内的运动统计。所有时间都是相对开始记录的 ms。 */
export type MotionStats = {
    frameCount: number;
    activeFrames: number;
    /** 有运动的帧占窗口内所有帧的比例，连续输入时应该高 */
    activeRatio: number;
    firstMotionAt: number | undefined;
    lastMotionAt: number | undefined;
    /** 第一次运动到累计达到 95% 运动量的跨度 */
    spanMs: number;
    /** 全窗口累计“运动量”（每帧平均亮度差之和） */
    total: number;
    /** 单帧最大平均亮度差 */
    peak: number;
    /** 单帧最大运动量占总运动量的比例；跳变时接近 1 */
    peakShare: number;
    /** 运动过程中相邻帧的最大间隔；掉帧或停顿会变大 */
    maxStallMs: number;
    /** 全窗口累计位移（由逐帧 flow 累加） */
    flow: { x: number; y: number };
};

const DEFAULTS = {
    maxSide: 800,
    tileThreshold: 4,
    tileSize: 8,
    flow: true,
};

type RawFrame = {
    /** 绝对时间（ms） */
    time: number;
    width: number;
    height: number;
    png: Buffer;
};

/**
 * 通过 CDP screencast 逐帧取图，得到每帧亮度图和相邻帧差异。
 *
 * 用于测“看起来流不流畅”：真正的动画会把总变化分散到多帧，每帧变化小且连续；
 * 跳变/卡顿表现为单帧吃掉大部分变化，或者中间夹着静止帧。
 */
export class FrameRecorder {
    private raw: RawFrame[] = [];
    private readonly marks: FrameMark[] = [];
    private stopped = false;
    private running: Promise<void> = Promise.resolve();
    private startedAt = 0;
    private stopScreencast: (() => Promise<void>) | undefined;
    private regionRect: { x: number; y: number; width: number; height: number } | undefined;
    private viewport = { width: 0, height: 0 };

    private constructor(
        private readonly desktop: DesktopRunner,
        private readonly options: Required<Omit<FrameRecorderOptions, "region">> & { region?: RecordRegion },
    ) {}

    static async start(desktop: DesktopRunner, options: FrameRecorderOptions): Promise<FrameRecorder> {
        const recorder = new FrameRecorder(desktop, {
            maxSide: DEFAULTS.maxSide,
            tileThreshold: DEFAULTS.tileThreshold,
            tileSize: DEFAULTS.tileSize,
            flow: DEFAULTS.flow,
            ...options,
        });
        await recorder.begin();
        return recorder;
    }

    private async begin() {
        await this.resolveRegion();
        this.startedAt = Date.now();
        await this.beginScreencast();
    }

    private async resolveRegion() {
        this.viewport = await this.desktop.evaluate<{ width: number; height: number }>(
            "({ width: window.innerWidth, height: window.innerHeight })",
        );
        const region = this.options.region;
        if (!region) return;
        if (!region.selector) {
            this.regionRect = {
                x: region.x ?? 0,
                y: region.y ?? 0,
                width: region.width ?? this.viewport.width,
                height: region.height ?? this.viewport.height,
            };
            return;
        }
        const rect = await this.desktop.evaluate<{ x: number; y: number; width: number; height: number } | null>(`
            (() => {
                const el = document.querySelector(${JSON.stringify(region.selector)});
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.left, y: r.top, width: r.width, height: r.height };
            })()
        `);
        if (!rect) throw new Error(`记录区域的选择器没有命中元素: ${region.selector}`);
        this.regionRect = rect;
    }

    private async beginScreencast() {
        const scale = Math.min(1, this.options.maxSide / Math.max(1, this.viewport.width, this.viewport.height));
        const maxWidth = Math.max(1, Math.round(this.viewport.width * scale));
        const maxHeight = Math.max(1, Math.round(this.viewport.height * scale));
        const firstFrame = Promise.withResolvers<void>();
        const off = this.desktop.on("Page.screencastFrame", (params) => {
            const data = params.data as string | undefined;
            if (!data) return;
            const png = Buffer.from(data, "base64");
            const image = decodePngDimensions(png);
            // 用到达时间而不是 metadata.timestamp：后者由合成器给，偶尔会比上一帧倒退
            // 十几毫秒（同一帧的捕获/呈现时间差异），会让相邻帧间隔出现负数。
            this.raw.push({ time: Date.now(), ...image, png });
            firstFrame.resolve();
            void this.desktop.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
        });
        await this.desktop.send("Page.startScreencast", {
            format: "png",
            maxWidth,
            maxHeight,
            everyNthFrame: 1,
        });
        this.stopScreencast = async () => {
            off();
            try {
                await this.desktop.send("Page.stopScreencast");
            } catch {}
        };

        // 静态页面也会先推一帧；迟迟没有就自己截一张，保证有基准帧
        const timeout = sleep(500).then(() => undefined);
        await Promise.race([firstFrame.promise, timeout]);
        if (this.raw.length === 0) {
            const png = await this.desktop.screenshot({
                format: "png",
                fromSurface: true,
                clip: { x: 0, y: 0, width: this.viewport.width, height: this.viewport.height, scale },
            });
            const image = decodePngDimensions(png);
            this.raw.push({ time: Date.now(), ...image, png });
        }
        this.running = this.waitDuration();
    }

    private async waitDuration() {
        const deadline = this.startedAt + this.options.durationMs;
        while (!this.stopped && Date.now() < deadline) {
            await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
        }
    }

    /** 记一个时间点（输入事件、操作开始等），分析时用来算响应延迟。 */
    mark(label = "mark"): number {
        const at = Date.now();
        this.marks.push({ label, at });
        return at - this.startedAt;
    }

    async stop(): Promise<SmoothnessReport> {
        this.stopped = true;
        if (this.stopScreencast) await this.stopScreencast();
        await this.running;
        return analyze(this.raw, this.marks, this.options, this.regionRect, this.viewport, this.startedAt);
    }
}

function decodePngDimensions(png: Buffer) {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
}

function percentile(values: number[], p: number) {
    if (values.length === 0) return 0;
    const sorted = values.toSorted((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
}

function analyze(
    raw: RawFrame[],
    rawMarks: FrameMark[],
    options: SmoothnessReport["options"],
    regionRect: { x: number; y: number; width: number; height: number } | undefined,
    viewport: { width: number; height: number },
    origin: number,
): SmoothnessReport {
    const frames: RecordedFrame[] = raw.map((frame, index) => {
        const image = decodePng(frame.png);
        let luma = toLuma(image);
        let width = image.width;
        let height = image.height;
        if (regionRect) {
            // 区域按 CSS px 给出；每帧尺寸可能因推流缩放不同，用这一帧自己的比例换算
            const scaleX = image.width / Math.max(1, viewport.width);
            const scaleY = image.height / Math.max(1, viewport.height);
            const x0 = Math.max(0, Math.floor(regionRect.x * scaleX));
            const y0 = Math.max(0, Math.floor(regionRect.y * scaleY));
            const x1 = Math.min(image.width, Math.ceil((regionRect.x + regionRect.width) * scaleX));
            const y1 = Math.min(image.height, Math.ceil((regionRect.y + regionRect.height) * scaleY));
            const croppedWidth = Math.max(1, x1 - x0);
            const croppedHeight = Math.max(1, y1 - y0);
            const cropped = new Uint8Array(croppedWidth * croppedHeight);
            for (let y = 0; y < croppedHeight; y++) {
                const from = (y0 + y) * image.width + x0;
                cropped.set(luma.subarray(from, from + croppedWidth), y * croppedWidth);
            }
            luma = cropped;
            width = croppedWidth;
            height = croppedHeight;
        }
        return { index, at: frame.time - origin, width, height, luma };
    });

    const marks: FrameMark[] = rawMarks.map((m) => ({ label: m.label, at: m.at - origin }));
    const diffs: FrameDiff[] = [];
    for (let i = 1; i < frames.length; i++) {
        const prev = frames[i - 1];
        const next = frames[i];
        const { meanDiff, changedRatio } = compareLuma(prev, next, options.tileSize, options.tileThreshold);
        const flow = options.flow ? estimateFlow(prev, next) : { x: 0, y: 0 };
        diffs.push({
            index: next.index,
            at: next.at,
            dtMs: next.at - prev.at,
            meanDiff,
            changedRatio,
            flowX: flow.x,
            flowY: flow.y,
        });
    }
    const intervals = diffs.map((d) => d.dtMs);
    const durationMs = frames.length > 0 ? frames[frames.length - 1].at : 0;
    const size = frames[0] ? { width: frames[0].width, height: frames[0].height } : { width: 0, height: 0 };
    return {
        options,
        size,
        durationMs,
        frames,
        diffs,
        marks,
        sampling: {
            count: frames.length,
            intervalMedianMs: percentile(intervals, 50),
            intervalP95Ms: percentile(intervals, 95),
            intervalMaxMs: intervals.length > 0 ? Math.max(...intervals) : 0,
            fps: durationMs > 0 ? ((frames.length - 1) / durationMs) * 1000 : 0,
        },
    };
}

/** 两帧亮度图的平均差、变化 tile 比例。 */
function compareLuma(prev: RecordedFrame, next: RecordedFrame, tileSize: number, tileThreshold: number) {
    const width = Math.min(prev.width, next.width);
    const height = Math.min(prev.height, next.height);
    if (width <= 0 || height <= 0) return { meanDiff: 0, changedRatio: 0 };
    const a = prev.luma;
    const b = next.luma;
    let sum = 0;
    let changed = 0;
    let tiles = 0;
    for (let tileY = 0; tileY < height; tileY += tileSize) {
        const maxY = Math.min(height, tileY + tileSize);
        for (let tileX = 0; tileX < width; tileX += tileSize) {
            const maxX = Math.min(width, tileX + tileSize);
            let tileSum = 0;
            let count = 0;
            for (let y = tileY; y < maxY; y++) {
                let offset = y * width + tileX;
                for (let x = tileX; x < maxX; x++, offset++) {
                    tileSum += Math.abs(a[offset] - b[offset]);
                    count++;
                }
            }
            tiles++;
            sum += tileSum;
            if (count > 0 && tileSum / count >= tileThreshold) changed++;
        }
    }
    return {
        meanDiff: sum / (width * height),
        changedRatio: tiles > 0 ? changed / tiles : 0,
    };
}

/**
 * 粗略的全局位移估计：把亮度降采样成粗网格，再在 ±maxShift 个网格内找 SAD 最小的位移。
 *
 * 只用于判断“往哪个方向动”，精度到几个像素就够；全屏滑动、缩放、淡入淡出都能用。
 * 分析图已经是推流缩放后的尺寸，返回值单位是分析图像素。
 */
function estimateFlow(prev: RecordedFrame, next: RecordedFrame): { x: number; y: number } {
    const width = Math.min(prev.width, next.width);
    const height = Math.min(prev.height, next.height);
    if (width < 32 || height < 32) return { x: 0, y: 0 };
    const tile = Math.max(4, Math.floor(Math.max(width, height) / 64));
    const cols = Math.floor(width / tile);
    const rows = Math.floor(height / tile);
    const grid = (frame: RecordedFrame) => {
        const values = new Float32Array(cols * rows);
        for (let gy = 0; gy < rows; gy++) {
            for (let gx = 0; gx < cols; gx++) {
                let sum = 0;
                for (let y = 0; y < tile; y++) {
                    const offset = (gy * tile + y) * width + gx * tile;
                    for (let x = 0; x < tile; x++) sum += frame.luma[offset + x];
                }
                values[gy * cols + gx] = sum / (tile * tile);
            }
        }
        return values;
    };
    const a = grid(prev);
    const b = grid(next);
    const maxShift = Math.min(8, Math.max(2, Math.floor(Math.min(cols, rows) / 6)));
    let bestScore = Number.POSITIVE_INFINITY;
    let bestDx = 0;
    let bestDy = 0;
    for (let dy = -maxShift; dy <= maxShift; dy++) {
        for (let dx = -maxShift; dx <= maxShift; dx++) {
            const startX = Math.max(0, dx);
            const endX = Math.min(cols, cols + dx);
            const startY = Math.max(0, dy);
            const endY = Math.min(rows, rows + dy);
            if (endX - startX < cols / 2 || endY - startY < rows / 2) continue;
            let sum = 0;
            let count = 0;
            for (let y = startY; y < endY; y++) {
                for (let x = startX; x < endX; x++) {
                    sum += Math.abs(a[(y - dy) * cols + (x - dx)] - b[y * cols + x]);
                    count++;
                }
            }
            // 轻微惩罚大位移，画面没动时不要随机挑一个方向
            const score = sum / count + (Math.abs(dx) + Math.abs(dy)) * 0.05;
            if (score < bestScore) {
                bestScore = score;
                bestDx = dx;
                bestDy = dy;
            }
        }
    }
    return { x: bestDx * tile, y: bestDy * tile };
}

export type MotionWindow = {
    /** 统计起点（ms，相对开始记录），默认从第一帧算起 */
    fromMs?: number;
    /** 统计终点（ms），默认到最后一帧 */
    toMs?: number;
    /** 一帧算“动了”的阈值：平均亮度差，默认 max(0.05, peak * 0.02) */
    activeThreshold?: number;
    /** 变化 tile 占比达到这个值也算“动了”；小面积动画（图标、面板）主要靠它 */
    activeChangedRatio?: number;
};

/** 统计一段窗口内的运动，用来判断动画是否分散、是否卡顿。 */
export function motionStats(report: SmoothnessReport, window: MotionWindow = {}): MotionStats {
    const from = window.fromMs ?? 0;
    const to = window.toMs ?? Number.POSITIVE_INFINITY;
    const diffs = report.diffs.filter((d) => d.at > from && d.at <= to);
    const peak = diffs.reduce((max, d) => Math.max(max, d.meanDiff), 0);
    const threshold = window.activeThreshold ?? Math.max(0.05, peak * 0.02);
    const ratioThreshold = window.activeChangedRatio ?? 0;
    const active = diffs.filter(
        (d) => d.meanDiff >= threshold || (ratioThreshold > 0 && d.changedRatio >= ratioThreshold),
    );
    const total = diffs.reduce((sum, d) => sum + d.meanDiff, 0);
    let flowX = 0;
    let flowY = 0;
    for (const d of diffs) {
        flowX += d.flowX;
        flowY += d.flowY;
    }

    const firstMotionAt = active[0]?.at;
    const lastMotionAt = active.length > 0 ? active[active.length - 1].at : undefined;

    // 累计运动量到 95% 的时间跨度：比首尾差更能排除收尾的小抖动。
    // 停顿也只统计到这一刻为止，否则动画结束后偶发的杂点会拉出一个假的大停顿。
    let spanMs = 0;
    let coreEndAt = lastMotionAt ?? 0;
    if (active.length > 0 && total > 0) {
        let accumulated = 0;
        for (const d of diffs) {
            accumulated += d.meanDiff;
            if (accumulated >= total * 0.95) {
                coreEndAt = d.at;
                break;
            }
        }
        spanMs = coreEndAt - (firstMotionAt ?? 0);
    }

    let maxStallMs = 0;
    let previousActiveAt: number | undefined;
    for (const d of active) {
        if (d.at > coreEndAt) break;
        if (previousActiveAt !== undefined) maxStallMs = Math.max(maxStallMs, d.at - previousActiveAt);
        previousActiveAt = d.at;
    }

    return {
        frameCount: diffs.length,
        activeFrames: active.length,
        activeRatio: diffs.length > 0 ? active.length / diffs.length : 0,
        firstMotionAt,
        lastMotionAt,
        spanMs,
        total,
        peak,
        peakShare: total > 0 ? peak / total : 0,
        maxStallMs,
        flow: { x: flowX, y: flowY },
    };
}

/**
 * 每个输入标记到“画面第一次响应”的延迟（ms）。
 *
 * 只找标记之后、下一个标记之前的帧，避免把后续动作算到当前输入头上。
 */
export function responseLatencies(report: SmoothnessReport) {
    const marks = report.marks;
    return marks.map((mark, index) => {
        const nextMark = marks[index + 1]?.at ?? Number.POSITIVE_INFINITY;
        const window = report.diffs.filter((d) => d.at > mark.at && d.at < nextMark);
        const peak = window.reduce((max, d) => Math.max(max, d.meanDiff), 0);
        const threshold = Math.max(0.05, peak * 0.02);
        const hit = window.find((d) => d.meanDiff >= threshold);
        return {
            label: mark.label,
            markAt: mark.at,
            latencyMs: hit ? Math.max(0, hit.at - mark.at) : undefined,
        };
    });
}

/** 把记录结果整理成便于贴进失败信息的文本表格。 */
export function formatReport(report: SmoothnessReport, window: MotionWindow = {}): string {
    const stats = motionStats(report, window);
    const from = window.fromMs ?? 0;
    const to = window.toMs ?? Number.POSITIVE_INFINITY;
    const diffs = report.diffs.filter((d) => d.at > from && d.at <= to);
    const lines = [
        `${report.size.width}x${report.size.height}：` +
            `${report.frames.length} 帧 / ${report.durationMs.toFixed(0)}ms ` +
            `(${report.sampling.fps.toFixed(1)} fps，间隔中位 ${report.sampling.intervalMedianMs.toFixed(1)}ms，` +
            `最大 ${report.sampling.intervalMaxMs.toFixed(0)}ms)`,
        `运动: 帧 ${stats.activeFrames}/${stats.frameCount}，跨度 ${stats.spanMs.toFixed(0)}ms，` +
            `峰值占比 ${(stats.peakShare * 100).toFixed(1)}%，最大停顿 ${stats.maxStallMs.toFixed(0)}ms，` +
            `累计位移 (${stats.flow.x.toFixed(0)}, ${stats.flow.y.toFixed(0)})px`,
        "  t(ms)   dt  平均差  变化%   flow(x,y)",
    ];
    for (const d of diffs) {
        lines.push(
            `${d.at.toFixed(0).padStart(7)} ${d.dtMs.toFixed(0).padStart(4)} ` +
                `${d.meanDiff.toFixed(2).padStart(7)} ${(d.changedRatio * 100).toFixed(1).padStart(6)} ` +
                `(${d.flowX.toFixed(0)}, ${d.flowY.toFixed(0)})`,
        );
    }
    const marks = report.marks
        .filter((m) => m.at >= from && m.at <= to)
        .map((m) => `${m.label}@${m.at.toFixed(0)}ms`)
        .join("  ");
    if (marks) lines.push(`标记: ${marks}`);
    const latencies = responseLatencies(report)
        .filter((r) => r.markAt >= from && r.markAt <= to)
        .map((r) => `${r.label}: ${r.latencyMs === undefined ? "无响应" : `${r.latencyMs.toFixed(0)}ms`}`)
        .join("，");
    if (latencies) lines.push(`响应延迟: ${latencies}`);
    return lines.join("\n");
}
