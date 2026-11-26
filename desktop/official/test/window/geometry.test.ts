import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../../src/test_runner/desktop_runner";
import { sleep } from "../../../../src/test_runner/process_utils";
import { launchMock, mockAppPath, resetDesktop, state } from "./helpers";

const entry = path.join(__dirname, "../../dist/index.js");
const hasBuild = fs.existsSync(entry) && fs.existsSync(mockAppPath());
const run = hasBuild ? it : it.skip;
const META = 4;

type Rect = { x: number; y: number; w: number; h: number };
type Visual = { x: number; y: number; scale: number };

type Sample = {
    t: number;
    overview: boolean;
    current: string;
    screens: { id: string; visual: Visual; target: Visual }[];
    windows: {
        handle: string;
        screen: string;
        local: Rect | undefined;
        visual: Visual | undefined;
        dom: { x: number; y: number; width: number; height: number } | null;
    }[];
};

let desktop: DesktopRunner;

const readSamples = () => desktop.evaluate<Sample[]>("window.__geomSamples ?? []");

/**
 * 页内按 rAF 采样：同一任务里读 `state()` 和窗口 DOM 矩形，避免跨进程读取时
 * 动画已经又推进一帧，导致“视觉盒 vs 屏内盒”的断言误报。
 */
async function startSampling(duration: number) {
    await desktop.evaluate(`(() => {
        const started = performance.now();
        const samples = [];
        window.__geomSamples = samples;
        const read = () => {
            const state = __mydeTest.state();
            const frames = new Map(
                [...document.querySelectorAll("[data-client-window]")].map((el) => [
                    el.getAttribute("data-client-window"),
                    el,
                ]),
            );
            samples.push({
                t: performance.now() - started,
                overview: state.overview,
                current: state.current,
                screens: state.screens.map((screen) => ({
                    id: screen.id,
                    visual: screen.visual,
                    target: screen.target,
                })),
                windows: state.windows.map((win) => {
                    const screen = state.screens.find((item) => item.id === win.screen);
                    const rect = frames.get(win.handle)?.getBoundingClientRect();
                    return {
                        handle: win.handle,
                        screen: win.screen,
                        local: win.rect,
                        visual: screen?.visual,
                        dom: rect
                            ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
                            : null,
                    };
                }),
            });
        };
        const tick = () => {
            read();
            if (performance.now() - started < ${duration}) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return true;
    })()`);
}

async function sampleAround(action: () => Promise<void>, duration = 900) {
    await startSampling(duration);
    await action();
    await sleep(duration + 150);
    return readSamples();
}

/** 每个窗口的视觉矩形都必须等于「屏 visual × 屏内盒」，包括动画中间帧 */
function expectGeometry(samples: Sample[], handles?: string[]) {
    let checked = 0;
    for (const sample of samples) {
        for (const win of sample.windows) {
            if (handles && !handles.includes(win.handle)) continue;
            if (!win.local || !win.visual || !win.dom) continue;
            const scale = win.visual.scale;
            const expected = {
                x: win.visual.x + win.local.x * scale,
                y: win.visual.y + win.local.y * scale,
                width: win.local.w * scale,
                height: win.local.h * scale,
            };
            // 浏览器布局会取整，留 1.5px；动画中的 translate/scale 也是小数
            expect(Math.abs(win.dom.x - expected.x), `${win.handle} x @${sample.t.toFixed(0)}ms`).toBeLessThan(1.5);
            expect(Math.abs(win.dom.y - expected.y), `${win.handle} y @${sample.t.toFixed(0)}ms`).toBeLessThan(1.5);
            expect(
                Math.abs(win.dom.width - expected.width),
                `${win.handle} width @${sample.t.toFixed(0)}ms`,
            ).toBeLessThan(1.5);
            expect(
                Math.abs(win.dom.height - expected.height),
                `${win.handle} height @${sample.t.toFixed(0)}ms`,
            ).toBeLessThan(1.5);
            checked++;
        }
    }
    expect(checked, "应该采集到窗口几何").toBeGreaterThan(0);
    return checked;
}

/** 采样期间这些窗口必须一直在，避免窗口提前消失导致断言空转 */
function expectWindowsPresent(samples: Sample[], handles: string[]) {
    const missing = samples.filter((sample) =>
        handles.some(
            (handle) =>
                !sample.windows.some((win) => win.handle === handle && win.local !== undefined && win.dom !== null),
        ),
    );
    expect(missing.length, `有 ${missing.length} 帧缺少窗口几何`).toBe(0);
}

/** 至少有一帧屏还在动，避免只采到停稳后的终态 */
function expectScreenMotion(samples: Sample[]) {
    const moving = samples.some((sample) =>
        sample.screens.some(
            (screen) =>
                Math.abs(screen.visual.x - screen.target.x) > 0.5 ||
                Math.abs(screen.visual.scale - screen.target.scale) > 0.001,
        ),
    );
    expect(moving, "采样期间虚拟屏应该处于动画中").toBe(true);
}

describe("窗口几何", () => {
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

    run("切屏动画期间窗口视觉盒跟随虚拟屏", { timeout: 40000 }, async () => {
        const first = await launchMock(desktop, { appid: "geometry-a", width: 480, height: 360 });
        const second = await launchMock(desktop, { appid: "geometry-b", width: 480, height: 360 });
        const before = await state(desktop);
        expect(before.current).toBe(second.screen);
        await desktop.evaluate("__mydeTest.setAnimationSpeed(1)");

        const samples = await sampleAround(async () => {
            await desktop.key("ArrowLeft", { modifiers: META });
        });
        expectScreenMotion(samples);
        expectWindowsPresent(samples, [first.handle, second.handle]);
        expectGeometry(samples, [first.handle, second.handle]);
        expect(samples.some((sample) => sample.current !== before.current || sample.overview)).toBe(true);

        const after = await state(desktop);
        expect(after.windows.length).toBe(2);
    });

    run("进入和退出全局预览时窗口跟随卡片缩放", { timeout: 40000 }, async () => {
        const first = await launchMock(desktop, { appid: "geometry-c", width: 480, height: 360 });
        const second = await launchMock(desktop, { appid: "geometry-d", width: 480, height: 360 });
        await desktop.evaluate("__mydeTest.setAnimationSpeed(1)");

        const entering = await sampleAround(async () => {
            await desktop.key("Tab", { modifiers: META });
        });
        expectScreenMotion(entering);
        expectWindowsPresent(entering, [first.handle, second.handle]);
        expectGeometry(entering, [first.handle, second.handle]);
        expect(entering.some((sample) => sample.overview)).toBe(true);
        expect(
            entering.some((sample) =>
                sample.screens.some((screen) => screen.id === second.screen && screen.visual.scale < 0.9),
            ),
            "全局预览里窗口所在卡片应该缩小",
        ).toBe(true);

        const leaving = await sampleAround(async () => {
            await desktop.key("Tab", { modifiers: META });
        });
        expectWindowsPresent(leaving, [first.handle, second.handle]);
        expectGeometry(leaving, [first.handle, second.handle]);
        expect(leaving.some((sample) => !sample.overview)).toBe(true);
    });

    run("两个窗口塞进同一虚拟屏后仍按屏变换", { timeout: 40000 }, async () => {
        const first = await launchMock(desktop, { appid: "geometry-e", width: 480, height: 360 });
        const second = await launchMock(desktop, { appid: "geometry-f", width: 480, height: 360 });
        await desktop.evaluate(
            `__mydeTest.placeWindow(${JSON.stringify(first.handle)}, ${JSON.stringify(second.screen)}, 40, 120)`,
        );

        const placed = await state(desktop);
        const screen = placed.screens.find((item) => item.id === second.screen);
        expect(screen?.windows).toContain(first.handle);
        expect(screen?.windows).toContain(second.handle);
        const firstState = placed.windows.find((item) => item.handle === first.handle);
        expect(firstState?.rect).toMatchObject({ x: 40, y: 120 });
        for (const win of placed.windows) {
            expect(win.rect).toBeTruthy();
            if (!win.rect) continue;
            expect(win.rect.x).toBeGreaterThanOrEqual(placed.available.x - 0.5);
            expect(win.rect.y).toBeGreaterThanOrEqual(placed.available.y - 0.5);
            expect(win.rect.x + win.rect.w).toBeLessThanOrEqual(placed.available.x + placed.available.width + 0.5);
            expect(win.rect.y + win.rect.h).toBeLessThanOrEqual(placed.available.y + placed.available.height + 0.5);
        }

        await desktop.evaluate("__mydeTest.setAnimationSpeed(1)");
        const samples = await sampleAround(async () => {
            await desktop.key("Tab", { modifiers: META });
        });
        expectScreenMotion(samples);
        expectWindowsPresent(samples, [first.handle, second.handle]);
        expectGeometry(samples, [first.handle, second.handle]);
        expect(
            samples.some((sample) =>
                sample.screens.some((screen) => screen.id === second.screen && screen.visual.scale < 0.9),
            ),
        ).toBe(true);
    });
});
