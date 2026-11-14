import type { OutputInfo } from "../../../src/desktop-api";
import type { display } from "../../../src/sys_api/display";

type ScreenMode = {
    name: string;
    width: number;
    height: number;
    /** Hz */
    refreshRate: number;
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
};

function normalizeScale(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.min(4, Math.max(1, value));
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
                };
            }
            // myde-wrap 的 DRM 后端报告 "DRM-*"；winit 后端报告 "winit"。
            // winit 是宿主桌面上的一个窗口，缩放交给宿主，内部不再叠一层。
            this.followsHost = this.screen === undefined || !this.screen.name.startsWith("DRM-");
            this.scale = this.followsHost ? 1 : normalizeScale(this.op.getScaleSetting());
            const mode = this.getMode();
            await this.op.display.setWindowSize(mode.width, mode.height);
            await this.op.display.renderToScreen(0, { x: 0, y: 0, width: mode.width, height: mode.height });
        } else {
            // 窗口模式的物理尺寸由宿主决定：CSS 尺寸 × DPR；不设置窗口大小
            this.screen = undefined;
            this.followsHost = true;
            this.scale = 1;
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
            refreshRate: 60,
        };
    }

    private apply(): void {
        this.op.applyOutput(this.getOutput());
    }
}
