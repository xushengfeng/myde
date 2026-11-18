import type { OutputInfo } from "../../../src/desktop-api";
import type { ScreenMode as DisplayScreenMode, display } from "../../../src/sys_api/display";

type ScreenMode = {
    name: string;
    width: number;
    height: number;
    /** Hz */
    refreshRate: number;
    /** wrap 报告的可切换模式 */
    modes: DisplayScreenMode[];
};

export type ScreenManagerOptions = {
    display: display;
    /** 从设置读取缩放 */
    getScaleSetting(): number;
    /** 把缩放写回设置 */
    setScaleSetting(scale: number): void;
    /** 输出信息变化（桌面调用 server.outputs.set） */
    applyOutput(output: OutputInfo): void;
    /** 缩放变更后，桌面据此重新最大化窗口等 */
    onScaleChanged?(scale: number): void;
    /** 分辨率/刷新率变更后，桌面据此重新布局窗口 */
    onModeChanged?(): void;
};

function normalizeScale(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.min(4, Math.max(1, value));
}

const COMMON_REFRESH_RATES = [24, 25, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240, 360];

/** 实测值有计时噪声，接近常见刷新率时归到整数值（如 119.8 → 120）。 */
function snapRefreshRate(rate: number): number {
    let best = Math.round(rate);
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const candidate of COMMON_REFRESH_RATES) {
        const diff = Math.abs(candidate - rate) / candidate;
        if (diff < bestDiff) {
            best = candidate;
            bestDiff = diff;
        }
    }
    return bestDiff <= 0.05 ? best : Math.round(rate);
}

/**
 * 窗口模式没有 `wl_output` 可读，用宿主窗口的 rAF 实测刷新率。
 * 不测的话只能写死 60，动态 presentation 会把内部客户端也压到 60。
 */
async function measureRefreshRate(samples = 20): Promise<number> {
    // KDE 等宿主下新窗口前约 1 秒的 rAF 会被压到 60，等首帧/缩放稳定再测；
    // 否则动态 presentation 会拿着 60/80Hz 的假输出刷新率跑一整次会话。
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    return new Promise((resolve) => {
        const intervals: number[] = [];
        let last: number | undefined;
        const tick = (now: number) => {
            if (last !== undefined) intervals.push(now - last);
            last = now;
            if (intervals.length < samples) {
                requestAnimationFrame(tick);
                return;
            }
            const average = intervals.reduce((a, b) => a + b, 0) / intervals.length;
            resolve(average > 0 ? snapRefreshRate(1000 / average) : 60);
        };
        requestAnimationFrame(tick);
    });
}

/**
 * 屏幕数据管理器（当前单屏）。
 *
 * - 桌面模式从 myde-wrap 的 `display.getScreens()` 取物理模式；
 * - 窗口模式用当前窗口的 CSS 尺寸 × DPR 造一个虚拟模式；
 * - 缩放记录在设置里，并转换成 wayland 的 `OutputInfo` 交给 server；
 * - 仅 DRM 后端由 myde 管理缩放；winit / 普通窗口跟随宿主，固定 1x。
 */
export class ScreenManager {
    private readonly op: ScreenManagerOptions;
    private screen: ScreenMode | undefined;
    /** 窗口模式实测到的宿主刷新率（Hz） */
    private hostRefreshRate = 60;
    private scale: number;
    /**
     * winit / 普通窗口模式由宿主桌面负责缩放，myde 内部强制 1x。
     * DRM 模式下才是 myde 自己管理输出的像素密度。
     */
    private followsHost: boolean;

    constructor(op: ScreenManagerOptions) {
        this.op = op;
        this.followsHost = op.display.getType() !== "desktop";
        // 屏幕信息到达前先按 1x 与 server 默认输出保持一致；refresh 再决定是否使用设置值
        this.scale = 1;
    }

    async init(): Promise<void> {
        await this.refresh();
    }

    /** 重新读取屏幕并应用输出配置。 */
    async refresh(): Promise<void> {
        if (this.op.display.getType() === "desktop") {
            const screens = await this.op.display.getScreens();
            const first = screens[0];
            if (first) {
                this.screen = {
                    name: first.name || "output0",
                    width: first.width,
                    height: first.height,
                    refreshRate: first.refresh_rate || 60,
                    modes: first.modes ?? [],
                };
            }
            // myde-wrap 的 DRM 后端报告 "DRM-*"；winit 后端报告 "winit"。
            // winit 是宿主桌面上的一个窗口，缩放交给宿主，内部不再叠一层。
            this.followsHost = this.screen === undefined || !this.screen.name.startsWith("DRM-");
            if (this.followsHost && this.screen) {
                // winit 后端的 wl_output.refresh 是 wrap 写死的 60，实际窗口在宿主的刷新率上
                this.screen.refreshRate = await measureRefreshRate();
            }
            this.scale = this.followsHost ? 1 : normalizeScale(this.op.getScaleSetting());
            const mode = this.getMode();
            await this.op.display.setWindowSize(mode.width, mode.height);
            await this.op.display.renderToScreen(0, { x: 0, y: 0, width: mode.width, height: mode.height });
        } else {
            // 窗口模式的物理尺寸由宿主决定：CSS 尺寸 × DPR；不设置窗口大小
            this.screen = undefined;
            this.followsHost = true;
            this.scale = 1;
            this.hostRefreshRate = await measureRefreshRate();
        }
        this.apply();
    }

    getScale(): number {
        return this.scale;
    }

    /** 缩放是否跟随宿主（winit / 普通窗口模式） */
    scaleFollowsHost(): boolean {
        return this.followsHost;
    }

    setScale(scale: number): void {
        if (this.followsHost) return;
        const next = normalizeScale(scale);
        if (next === this.scale) return;
        this.scale = next;
        this.op.setScaleSetting(next);
        this.apply();
        this.op.onScaleChanged?.(next);
    }

    /** 当前分辨率 */
    getResolution(): { width: number; height: number } {
        const mode = this.getMode();
        return { width: mode.width, height: mode.height };
    }

    /** 可切换的分辨率（按面积从大到小；窗口模式或旧版 wrap 为空） */
    getResolutions(): { width: number; height: number }[] {
        const seen = new Set<string>();
        const list: { width: number; height: number }[] = [];
        for (const mode of this.getMode().modes) {
            const key = `${mode.width}x${mode.height}`;
            if (seen.has(key)) continue;
            seen.add(key);
            list.push({ width: mode.width, height: mode.height });
        }
        return list.sort((a, b) => b.width * b.height - a.width * a.height);
    }

    /** 当前刷新率（Hz） */
    getRefreshRate(): number {
        return this.getMode().refreshRate;
    }

    /**
     * 当前分辨率下可切换的刷新率（Hz，升序）。
     * 窗口模式或旧版 wrap 没有模式列表时为空。
     */
    getRefreshRates(): number[] {
        const mode = this.getMode();
        const rates = mode.modes
            .filter((m) => m.width === mode.width && m.height === mode.height)
            .map((m) => m.refresh_rate);
        return [...new Set(rates)].sort((a, b) => a - b);
    }

    /** 切换分辨率；优先保留当前刷新率，没有则取该分辨率下最高刷新率 */
    async setResolution(width: number, height: number): Promise<boolean> {
        const screen = this.screen;
        if (this.followsHost || !screen) return false;
        const candidates = screen.modes.filter((m) => m.width === width && m.height === height);
        if (candidates.length === 0) return false;
        const mode =
            candidates.find((m) => m.refresh_rate === screen.refreshRate) ??
            candidates.reduce((a, b) => (a.refresh_rate >= b.refresh_rate ? a : b));
        return this.applyMode(mode);
    }

    /** 切换刷新率（分辨率不变） */
    async setRefreshRate(refreshRate: number): Promise<boolean> {
        const screen = this.screen;
        if (this.followsHost || !screen) return false;
        const mode = screen.modes.find(
            (m) => m.width === screen.width && m.height === screen.height && m.refresh_rate === refreshRate,
        );
        if (!mode) return false;
        return this.applyMode(mode);
    }

    private async applyMode(mode: DisplayScreenMode): Promise<boolean> {
        const screen = this.screen;
        if (!screen) return false;
        const result = await this.op.display.setScreenMode(0, mode);
        if (!result) return false;
        const sizeChanged = screen.width !== result.width || screen.height !== result.height;
        screen.width = result.width;
        screen.height = result.height;
        screen.refreshRate = result.refresh_rate;
        if (sizeChanged) {
            await this.op.display.setWindowSize(result.width, result.height);
            await this.op.display.renderToScreen(0, {
                x: 0,
                y: 0,
                width: result.width,
                height: result.height,
            });
        }
        this.apply();
        this.op.onModeChanged?.();
        return true;
    }

    getOutput(): OutputInfo {
        const mode = this.getMode();
        return {
            name: mode.name,
            description: mode.name,
            mode: {
                width: mode.width,
                height: mode.height,
                refresh: Math.max(0, Math.round(mode.refreshRate * 1000)),
            },
            scale: this.scale,
            transform: "normal",
        };
    }

    private getMode(): ScreenMode {
        if (this.screen) return this.screen;
        const dpr = window.devicePixelRatio || 1;
        return {
            name: "output0",
            width: Math.max(1, Math.round(window.innerWidth * dpr)),
            height: Math.max(1, Math.round(window.innerHeight * dpr)),
            refreshRate: this.hostRefreshRate,
            modes: [],
        };
    }

    private apply(): void {
        this.op.applyOutput(this.getOutput());
    }
}
