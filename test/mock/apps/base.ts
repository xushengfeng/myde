import type { renderTools } from "../../../src/wayland/render_tools";
import type { MockWaylandClient, MockWaylandWindow } from "../myde-mock";
import { createMockWindow } from "../myde-mock";

export interface MockAppConfig {
    id: string;
    name: string;
    icon: string;
    width: number;
    height: number;
}

const TITLE_BAR_HEIGHT = 32;

export abstract class MockApp {
    protected canvas: OffscreenCanvas;
    protected ctx: OffscreenCanvasRenderingContext2D;
    protected animationId: number | null = null;
    protected width: number;
    protected height: number;
    protected client: MockWaylandClient | null = null;
    protected window: MockWaylandWindow | null = null;
    public windowId: string | null = null;
    protected renderTools: renderTools | null = null;
    protected surfaceId: string | null = null;
    protected title: string;
    protected isMaximized = false;

    constructor(protected config: MockAppConfig) {
        this.width = config.width;
        this.height = config.height;
        this.title = config.name;
        // canvas总高度 = 标题栏高度 + 内容高度
        this.canvas = new OffscreenCanvas(this.width, this.height + TITLE_BAR_HEIGHT);
        this.ctx = this.canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    }

    abstract init(): void;
    abstract renderContent(): void;
    abstract handlePointerInContent(event: "move" | "down" | "up", x: number, y: number): void;
    abstract handleKey(key: string, state: "pressed" | "released"): void;

    setClient(client: MockWaylandClient): void {
        this.client = client;
    }

    setRenderTools(renderTools: renderTools): void {
        this.renderTools = renderTools;
    }

    createWindow(): string | null {
        if (!this.client) return null;

        this.windowId = `win-${Date.now()}`;
        this.window = createMockWindow(this.windowId);

        this.window.setWinBoxData({ width: this.width, height: this.height + TITLE_BAR_HEIGHT });

        // 创建wayland surface
        if (this.renderTools) {
            this.surfaceId = `surface-${this.windowId}`;
            this.renderTools.bindCanvas(this.surfaceId);
            this.renderTools.createXdgSurfaceEle(this.surfaceId, this.surfaceId);
            this.renderTools.asToplevel(this.surfaceId);
            this.renderTools.setXdgSurfaceGeo(this.surfaceId, this.width, this.height + TITLE_BAR_HEIGHT, 0, 0);

            // 设置renderId
            (this.window as any).setRenderId(this.surfaceId);
        }

        this.window.point.sendPointerEvent = (type, p) => {
            this.handlePointer(type, p.x, p.y);
        };

        this.client.getWindows().set(this.windowId, this.window);

        this.client.on("windowClosed", (id: string) => {
            if (id === this.windowId) {
                this.destroy();
            }
        });

        this.client.on("windowResized", (id: string, width: number, height: number) => {
            if (id === this.windowId) {
                this.resize(width, height - TITLE_BAR_HEIGHT);
            }
        });

        this.client.on("windowMaximized", (id: string) => {
            if (id === this.windowId) {
                this.isMaximized = true;
            }
        });

        this.client.on("windowUnMaximized", (id: string) => {
            if (id === this.windowId) {
                this.isMaximized = false;
            }
        });

        this.init();
        this.startAnimation();

        return this.surfaceId || this.windowId;
    }

    protected drawTitleBar(): void {
        const ctx = this.ctx;

        // 标题栏背景
        const gradient = ctx.createLinearGradient(0, 0, 0, TITLE_BAR_HEIGHT);
        gradient.addColorStop(0, "#4a4a6a");
        gradient.addColorStop(1, "#3a3a5a");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, this.width, TITLE_BAR_HEIGHT);

        // 标题文本
        ctx.fillStyle = "#ffffff";
        ctx.font = "13px system-ui, -apple-system, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(this.title, 12, TITLE_BAR_HEIGHT / 2);

        // 按钮
        const buttonRadius = 7;
        const buttonY = TITLE_BAR_HEIGHT / 2;
        const buttonSpacing = 24;
        const buttonsStartX = this.width - 12 - buttonSpacing * 2;

        // 关闭按钮（红色）
        ctx.beginPath();
        ctx.arc(buttonsStartX + buttonSpacing * 2, buttonY, buttonRadius, 0, Math.PI * 2);
        ctx.fillStyle = "#ff6b6b";
        ctx.fill();

        // 最大化按钮（绿色）
        ctx.beginPath();
        ctx.arc(buttonsStartX + buttonSpacing, buttonY, buttonRadius, 0, Math.PI * 2);
        ctx.fillStyle = this.isMaximized ? "#4ecdc4" : "#4ecdc4";
        ctx.fill();

        // 最小化按钮（黄色）
        ctx.beginPath();
        ctx.arc(buttonsStartX, buttonY, buttonRadius, 0, Math.PI * 2);
        ctx.fillStyle = "#feca57";
        ctx.fill();
    }

    protected handlePointer(event: "move" | "down" | "up", x: number, y: number): void {
        // 检查是否在标题栏区域
        if (y < TITLE_BAR_HEIGHT) {
            if (event === "down") {
                // 检查是否点击了按钮
                const buttonRadius = 7;
                const buttonY = TITLE_BAR_HEIGHT / 2;
                const buttonSpacing = 24;
                const buttonsStartX = this.width - 12 - buttonSpacing * 2;

                // 关闭按钮
                const closeBtnX = buttonsStartX + buttonSpacing * 2;
                if (Math.sqrt((x - closeBtnX) ** 2 + (y - buttonY) ** 2) <= buttonRadius) {
                    this.destroy();
                    return;
                }

                // 最大化按钮
                const maximizeBtnX = buttonsStartX + buttonSpacing;
                if (Math.sqrt((x - maximizeBtnX) ** 2 + (y - buttonY) ** 2) <= buttonRadius) {
                    this.toggleMaximize();
                    return;
                }

                // 最小化按钮
                const minimizeBtnX = buttonsStartX;
                if (Math.sqrt((x - minimizeBtnX) ** 2 + (y - buttonY) ** 2) <= buttonRadius) {
                    this.minimize();
                    return;
                }

                // 标题栏拖拽
                this.startDrag();
            }
            return;
        }

        // 内容区域的事件
        this.handlePointerInContent(event, x, y - TITLE_BAR_HEIGHT);
    }

    protected toggleMaximize(): void {
        if (this.isMaximized) {
            // 取消最大化
            this.client?.emit("windowUnMaximized", this.windowId);
        } else {
            // 最大化
            this.client?.emit("windowMaximized", this.windowId);
        }
    }

    protected minimize(): void {
        // 最小化逻辑
    }

    protected startDrag(): void {
        // 拖拽逻辑，触发windowStartMove事件
        this.client?.emit("windowStartMove", this.windowId);
    }

    resize(width: number, height: number): void {
        this.width = width;
        this.height = height;
        this.canvas.width = width;
        this.canvas.height = height + TITLE_BAR_HEIGHT;
        if (this.renderTools && this.surfaceId) {
            this.renderTools.setXdgSurfaceGeo(this.surfaceId, width, height + TITLE_BAR_HEIGHT, 0, 0);
        }
    }

    render(): void {
        // 清空canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // 绘制标题栏
        this.drawTitleBar();

        // 绘制内容
        this.ctx.save();
        this.ctx.translate(0, TITLE_BAR_HEIGHT);
        this.renderContent();
        this.ctx.restore();
    }

    startAnimation(): void {
        const animate = () => {
            this.render();
            // 渲染到wayland surface
            if (this.renderTools && this.surfaceId) {
                this.renderTools.renderCanvas(this.canvas, this.surfaceId);
            }
            this.animationId = requestAnimationFrame(animate);
        };
        animate();
    }

    stopAnimation(): void {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    getCanvas(): OffscreenCanvas {
        return this.canvas;
    }

    getSize(): { width: number; height: number } {
        return { width: this.width, height: this.height };
    }

    destroy(): void {
        this.stopAnimation();
        if (this.renderTools && this.surfaceId) {
            this.renderTools.destroyXdgSurfaceEle(this.surfaceId, "toplevel");
            this.renderTools.destroyCanvas(this.surfaceId);
        }
        if (this.client && this.windowId) {
            this.client.getWindows().delete(this.windowId);
        }
    }
}
