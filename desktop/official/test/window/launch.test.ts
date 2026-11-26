import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../../src/test_runner/desktop_runner";
import { sleep } from "../../../../src/test_runner/process_utils";
import { launchMock, mockAppPath, resetDesktop, state } from "./helpers";

const entry = path.join(__dirname, "../../dist/index.js");
const hasBuild = fs.existsSync(entry) && fs.existsSync(mockAppPath());
const run = hasBuild ? it : it.skip;

type Rect = { x: number; y: number; width: number; height: number };

type Sample = {
    t: number;
    panel: Rect | null;
    panelLocal: { width: number; height: number } | null;
    panelInSlot: boolean;
    frame: Rect | null;
    frameSlot: string | null;
    frameEl: Rect | null;
    frameElInSlot: boolean;
    pending: boolean | null;
    contentTransform: string | null;
    content: Rect | null;
    maskOpacity: number | null;
    launchPhase: string | null;
    painted: boolean;
    slotScale: number | null;
    screen: { id: string; rect: Rect; visual: { x: number; y: number; scale: number } } | null;
    launches: number;
};

let desktop: DesktopRunner;

const collectExpr = `(() => {
    const state = __mydeTest.state();
    const current = state.current;
    const screenEl = document.querySelector("[data-view-id='" + current + "']");
    const panel = document.querySelector("[data-desktop-ui='pending-frame']");
    const frame = document.querySelector("[data-client-window]");
    const frameEl = document.querySelector("[data-client-frame]");
    const contentEl = frameEl
        ? [...frameEl.children].find((el) => el.id && !el.hasAttribute("data-desktop-ui") && !el.hasAttribute("data-client-titlebar"))
        : null;
    const handle = frame?.getAttribute("data-client-window");
    const painted = !!state.windows.find((w) => w.handle === handle)?.painted;
    const toRect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    const slotScaleOf = (el) => {
        const slot = el?.closest("[data-window-slot]");
        if (!slot) return null;
        const t = getComputedStyle(slot).transform;
        if (!t || t === "none") return 1;
        const m = t.match(/^matrix\\(([^)]+)\\)$/);
        if (!m) return null;
        const v = m[1].split(",").map(Number);
        return Math.hypot(v[0], v[1]);
    };
    return {
        panel: toRect(panel),
        panelLocal: panel ? { width: panel.offsetWidth, height: panel.offsetHeight } : null,
        panelInSlot: !!panel?.closest("[data-window-slot]"),
        frame: toRect(frame),
        frameSlot: frame?.closest("[data-window-slot]")?.getAttribute("data-window-screen") ?? null,
        frameEl: toRect(frameEl),
        frameElInSlot: !!frameEl?.closest("[data-window-slot]"),
        pending: frameEl ? frameEl.hasAttribute("data-pending-frame") : null,
        contentTransform: contentEl ? getComputedStyle(contentEl).transform : null,
        content: toRect(contentEl ?? null),
        maskOpacity: panel ? Number.parseFloat(getComputedStyle(panel).opacity || "1") : null,
        launchPhase: state.launches[0]?.phase ?? null,
        painted,
        slotScale: slotScaleOf(panel ?? frame),
        screen: screenEl
            ? { id: current, rect: toRect(screenEl), visual: state.screens.find((s) => s.id === current)?.visual }
            : null,
        launches: state.launches.length,
    };
})()`;

async function sampleLaunch(duration: number) {
    await desktop.evaluate(`(() => {
        const started = performance.now();
        const samples = [];
        window.__launchSamples = samples;
        const tick = () => {
            const value = ${collectExpr};
            samples.push({ t: performance.now() - started, ...value });
            if (performance.now() - started < ${duration}) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return true;
    })()`);
}

describe("应用启动槽", () => {
    beforeAll(async () => {
        desktop = await startDesktopRunner({ desktop: "desktop/official", timeout: 60000, showWindow: true });
        await desktop.waitFor("document.documentElement.dataset.desktopReady === '1'", 60000);
    });

    beforeEach(async () => {
        await resetDesktop(desktop);
    });

    afterEach(async () => {
        await resetDesktop(desktop);
    });

    afterAll(async () => {
        if (desktop) await desktop.close();
    });

    run("启动外壳和真实窗口共用同一个窗口槽", { timeout: 30000 }, async () => {
        const createAt = Date.now() + 2500;
        await desktop.evaluate(`
            __mydeTest.launchApp({
                exec: ${JSON.stringify(mockAppPath())},
                name: "launch-slot",
                appid: "launch-slot",
                sourceRect: { left: 600, top: 400, width: 64, height: 64 },
                env: {
                    APP_ID: "launch-slot",
                    LIFETIME_MS: "60000",
                    WIDTH: "640",
                    HEIGHT: "420",
                    CREATE_AT: String(${createAt}),
                },
            })
        `);
        await sampleLaunch(4000);
        await sleep(4200);
        const samples = await desktop.evaluate<Sample[]>("window.__launchSamples ?? []");
        expect(samples.length).toBeGreaterThan(10);

        // 外壳从第一帧起就在舞台槽里，不再挂到虚拟屏卡片下
        expect(samples.some((sample) => sample.panel && sample.panelInSlot)).toBe(true);
        // 真实窗口出现后也在同一个槽里，并最终由该屏驱动
        expect(samples.some((sample) => sample.frame && sample.frameSlot !== null)).toBe(true);
        // 渲染轴的 frame 从第一帧就存在，窗口到达只是去掉 pending，不换元素
        expect(samples[0]?.frameEl, "第一帧就应该有 frame").toBeTruthy();
        expect(
            samples.every((sample) => sample.frameEl !== null),
            "frame 元素不能中途消失",
        ).toBe(true);
        expect(
            samples.some((sample) => sample.frameElInSlot),
            "frame 从第一帧起就在舞台槽里",
        ).toBe(true);
        expect(
            samples.some((sample) => sample.pending === true),
            "应该采到等待客户端的 pending 阶段",
        ).toBe(true);
        expect(
            samples.some((sample) => sample.pending === false),
            "应该采到窗口接管后的阶段",
        ).toBe(true);

        const settled = await state(desktop);
        expect(settled.launches.length).toBe(0);
        expect(settled.windows.length).toBe(1);
        const final = await desktop.evaluate<Sample>(collectExpr);
        expect(final.panel).toBeNull();
        expect(final.frame).toBeTruthy();
        expect(final.frameSlot).toBe(settled.windows[0].screen);
        if (final.frame && final.screen) {
            expect(final.frame.x).toBeGreaterThanOrEqual(final.screen.rect.x - 1);
            expect(final.frame.y).toBeGreaterThanOrEqual(final.screen.rect.y - 1);
            expect(final.frame.x + final.frame.width).toBeLessThanOrEqual(
                final.screen.rect.x + final.screen.rect.width + 1,
            );
            expect(final.frame.y + final.frame.height).toBeLessThanOrEqual(
                final.screen.rect.y + final.screen.rect.height + 1,
            );
        }
        await desktop.evaluate("__mydeTest.closeWindows(); __mydeTest.closeLaunchPanels();");
    });

    run("没有窗口时进入全局预览，外壳跟随卡片缩放", { timeout: 30000 }, async () => {
        await desktop.evaluate(`
            __mydeTest.launchApp({
                exec: ${JSON.stringify(mockAppPath())},
                name: "launch-overview",
                appid: "launch-overview",
                sourceRect: { left: 600, top: 400, width: 64, height: 64 },
                env: {
                    APP_ID: "launch-overview",
                    LIFETIME_MS: "60000",
                    WIDTH: "640",
                    HEIGHT: "420",
                    CREATE_AT: "never",
                },
            })
        `);
        await desktop.waitFor("__mydeTest.state().launches.some((x) => x.phase === 'embedded')", 8000);
        await sampleLaunch(900);
        await desktop.key("Tab", { modifiers: 4 });
        await sleep(1050);
        const samples = await desktop.evaluate<Sample[]>("window.__launchSamples ?? []");
        const embedded = samples.filter((sample) => sample.panel && sample.screen);
        expect(embedded.length).toBeGreaterThan(5);
        for (const sample of embedded) {
            if (!sample.panel || !sample.panelLocal || !sample.screen) continue;
            const expected = sample.panelLocal.width * sample.screen.visual.scale;
            expect(
                Math.abs(sample.panel.width - expected),
                `外壳宽度应等于屏内盒 × 屏 scale @${sample.t.toFixed(0)}ms`,
            ).toBeLessThan(2);
        }
        expect(
            samples.some((sample) => sample.screen?.visual.scale !== undefined && sample.screen.visual.scale < 0.9),
        ).toBe(true);
        await desktop.key("Tab", { modifiers: 4 });
        await desktop.evaluate("__mydeTest.closeLaunchPanels()");
    });

    run("服务端绘制标题栏时启动白底在首帧后撤掉", { timeout: 30000 }, async () => {
        const win = await launchMock(desktop, {
            appid: "launch-decorated",
            width: 480,
            height: 360,
            env: { DECORATED: "1" },
        });
        const info = await desktop.evaluate<{
            background: string;
            decorated: boolean;
            titlebar: string;
            bar: number;
            gap: { top: number; right: number; bottom: number; left: number };
        }>(
            `(() => {
                const frame = document.querySelector("[data-client-window='${win.handle}']");
                if (!frame) return { background: "missing", decorated: false, titlebar: "missing" };
                const bar = frame.querySelector("[data-client-titlebar]");
                const content = [...frame.children].find(
                    (el) => el.id && !el.hasAttribute("data-desktop-ui") && !el.hasAttribute("data-client-titlebar"),
                );
                const f = frame.getBoundingClientRect();
                const b = bar?.getBoundingClientRect();
                const c = content?.getBoundingClientRect();
                return {
                    background: getComputedStyle(frame).backgroundColor,
                    decorated: frame.hasAttribute("data-decorated"),
                    titlebar: bar ? getComputedStyle(bar).display : "missing",
                    bar: b ? b.height : 0,
                    gap: c
                        ? { top: c.top - f.top, right: f.right - c.right, bottom: f.bottom - c.bottom, left: c.left - f.left }
                        : { top: -1, right: -1, bottom: -1, left: -1 },
                };
            })()`,
        );
        expect(info.background).toBe("rgba(0, 0, 0, 0)");
        expect(info.decorated).toBe(true);
        expect(info.titlebar).toBe("flex");
        // 内容正好铺满标题栏以下：没有顶部空缺，也不溢出
        expect(info.bar, "标题栏应该有高度").toBeGreaterThan(20);
        expect(Math.abs(info.gap.top - info.bar), "内容应该从标题栏下方开始").toBeLessThan(1);
        expect(Math.abs(info.gap.left), "内容左边缘应贴住外框").toBeLessThan(1);
        expect(Math.abs(info.gap.right), "内容右边缘应贴住外框").toBeLessThan(1);
        expect(Math.abs(info.gap.bottom), "内容底边应贴住外框").toBeLessThan(1);
    });

    run("应用自绘装饰时没有启动白底，也不显示桌面标题栏", { timeout: 30000 }, async () => {
        const win = await launchMock(desktop, {
            appid: "launch-client-decorated",
            width: 480,
            height: 360,
            env: { DECORATED: "0" },
        });
        const info = await desktop.evaluate<{ background: string; decorated: boolean; titlebar: string }>(
            `(() => {
                const frame = document.querySelector("[data-client-window='${win.handle}']");
                if (!frame) return { background: "missing", decorated: false, titlebar: "missing" };
                const bar = frame.querySelector("[data-client-titlebar]");
                return {
                    background: getComputedStyle(frame).backgroundColor,
                    decorated: frame.hasAttribute("data-decorated"),
                    titlebar: bar ? getComputedStyle(bar).display : "missing",
                };
            })()`,
        );
        expect(info.background).toBe("rgba(0, 0, 0, 0)");
        expect(info.decorated).toBe(false);
        expect(info.titlebar).toBe("none");
    });

    run("飞行只动位置，盒自己长大，槽不缩放", { timeout: 30000 }, async () => {
        await desktop.evaluate(`
            __mydeTest.launchApp({
                exec: ${JSON.stringify(mockAppPath())},
                name: "launch-box",
                appid: "launch-box",
                sourceRect: { left: 600, top: 400, width: 64, height: 64 },
                env: {
                    APP_ID: "launch-box",
                    LIFETIME_MS: "60000",
                    WIDTH: "640",
                    HEIGHT: "420",
                },
            })
        `);
        await sampleLaunch(1400);
        await sleep(1500);
        const samples = await desktop.evaluate<Sample[]>("window.__launchSamples ?? []");
        const flying = samples.filter((sample) => sample.frameEl && sample.frameEl.width > 1);
        expect(flying.length).toBeGreaterThan(8);
        // 槽保持恒等：盒的大小变化只来自渲染轴
        for (const sample of flying) {
            expect(sample.slotScale, `槽在飞行中不应缩放 @${sample.t.toFixed(0)}ms`).not.toBeNull();
            expect(sample.slotScale, `槽在飞行中不应缩放 @${sample.t.toFixed(0)}ms`).toBeCloseTo(1, 3);
        }
        const widths = flying.flatMap((sample) => (sample.frameEl ? [sample.frameEl.width] : []));
        expect(Math.min(...widths), "盒应该从图标大小开始").toBeLessThan(200);
        expect(Math.max(...widths), "盒应该长大到目标尺寸").toBeGreaterThan(400);
        // 起点就是图标本身的矩形（默认 64×64），不是目标比例的缩小版
        const early = flying.find((sample) => sample.frameEl && sample.frameEl.width < 100);
        expect(early?.frameEl, "应该采到盒刚开始的样子").toBeTruthy();
        if (early?.frameEl) {
            expect(Math.abs(early.frameEl.width - early.frameEl.height), "盒从图标矩形开始").toBeLessThan(6);
        }

        // 飞行中内容用 transform 非等比拉伸铺满盒（不重排、不裁切，也不留空边）。
        // 拿到首帧真实尺寸前用的是占位尺寸，会被 mask 盖住，不参与铺满断言。
        const filled = samples.filter((sample) => sample.content && sample.frameEl && sample.painted);
        expect(filled.length, "窗口内容应该已经在盒里").toBeGreaterThan(0);
        for (const sample of filled) {
            if (!sample.content || !sample.frameEl) continue;
            expect(
                Math.abs(sample.content.width - sample.frameEl.width),
                `内容宽度应铺满盒 @${sample.t.toFixed(0)}ms`,
            ).toBeLessThan(2);
            expect(
                Math.abs(sample.content.height - sample.frameEl.height),
                `内容高度应铺满盒 @${sample.t.toFixed(0)}ms`,
            ).toBeLessThan(2);
        }
        const transformed = samples.filter((sample) => sample.contentTransform && sample.contentTransform !== "none");
        expect(transformed.length, "飞行中内容应该被拉伸").toBeGreaterThan(0);
        await desktop.waitFor("__mydeTest.state().launches.length === 0", 8000);
        await desktop.waitFor("__mydeTest.state().windows.every((w) => !w.resizing)", 8000);
        const final = await desktop.evaluate<Sample>(collectExpr);
        expect(final.contentTransform, "收尾后取消缩放").toBe("none");
        if (final.content && final.frameEl) {
            expect(Math.abs(final.content.width - final.frameEl.width), "收尾后内容正好填满").toBeLessThan(2);
        }
        await desktop.evaluate("__mydeTest.closeWindows()");
    });

    run("首帧出来才替换 mask，替换和 resize 同时结束", { timeout: 40000 }, async () => {
        // 这段要看清淡出过程，用真实动画时长
        await desktop.evaluate("__mydeTest.setAnimationSpeed(1)");
        const epoch = Date.now();
        await desktop.evaluate(`
            __mydeTest.launchApp({
                exec: ${JSON.stringify(mockAppPath())},
                name: "launch-reveal",
                appid: "launch-reveal",
                sourceRect: { left: 600, top: 400, width: 64, height: 64 },
                env: {
                    APP_ID: "launch-reveal",
                    LIFETIME_MS: "60000",
                    CREATE_AT: String(${epoch}),
                    BUFFER_AT: String(${epoch + 1400}),
                    WIDTH: "1000",
                    HEIGHT: "700",
                    SIZE_MODE: "fixed",
                },
            })
        `);
        await sampleLaunch(3200);
        await sleep(3400);
        const samples = await desktop.evaluate<Sample[]>("window.__launchSamples ?? []");

        // 支配之后、首帧之前：mask 还盖着，盒停在占位的 800×600
        const covered = samples.filter(
            (sample) => sample.launchPhase === "embedded" && sample.maskOpacity !== null && sample.maskOpacity > 0.99,
        );
        expect(covered.length, "首帧之前支配后 mask 仍应盖着").toBeGreaterThan(0);
        if (covered[0]?.frameEl) {
            expect(covered[0].frameEl.width, "首帧之前盒还是占位尺寸").toBeLessThan(900);
        }

        // 首帧到达：mask 开始淡出，同一刻盒开始从占位尺寸长到真实尺寸
        const fading = samples.filter((sample) => sample.maskOpacity !== null && sample.maskOpacity < 0.98);
        expect(fading.length, "应该采到 mask 淡出").toBeGreaterThan(0);
        const firstFade = fading[0];
        expect(firstFade?.frameEl?.width, "淡出开始时盒还没到真实尺寸").toBeLessThan(950);
        const lastFade = [...fading].reverse().find((sample) => sample.frameEl);
        expect(lastFade?.frameEl?.width, "淡出结束时盒应该已经到真实尺寸").toBeGreaterThan(980);

        const final = await desktop.evaluate<Sample>(collectExpr);
        expect(final.panel, "替换结束后 mask 应该移除").toBeNull();
        expect(final.launches, "启动应该已经收尾").toBe(0);
        expect(Math.abs((final.frameEl?.width ?? 0) - 1000), "窗口最终是真实尺寸").toBeLessThan(2);
        await desktop.evaluate("__mydeTest.closeWindows()");
    });

    run("启动收尾后 resize 仍独立继续", { timeout: 30000 }, async () => {
        const epoch = Date.now();
        await desktop.evaluate(`
            __mydeTest.launchApp({
                exec: ${JSON.stringify(mockAppPath())},
                name: "launch-resize",
                appid: "launch-resize",
                sourceRect: { left: 600, top: 400, width: 64, height: 64 },
                env: {
                    APP_ID: "launch-resize",
                    LIFETIME_MS: "60000",
                    BUFFER_AT: String(${epoch + 600}),
                    WIDTH: "1000",
                    HEIGHT: "700",
                    SIZE_MODE: "fixed",
                },
            })
        `);
        await desktop.waitFor(
            "(() => { const s = __mydeTest.state(); return s.launches.length === 0 && s.windows.some((w) => w.appid === 'launch-resize' && w.rect && w.rect.w > 800); })()",
            8000,
        );
        const value = await state(desktop);
        const win = value.windows.find((item) => item.appid === "launch-resize");
        expect(win).toBeTruthy();
        expect(value.launches.length, "启动应该已经收尾").toBe(0);
        if (win?.rect && win.rect.w < 990) {
            expect(win.resizing, "收尾后盒子应该还在独立 resize").toBe(true);
            await desktop.waitFor(
                "(() => { const w = __mydeTest.state().windows.find((x) => x.appid === 'launch-resize'); return !!w && !!w.rect && w.rect.w > 990; })()",
                4000,
            );
        }
        await desktop.evaluate("__mydeTest.closeWindows();");
    });
});
