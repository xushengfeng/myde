import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../../src/test_runner/desktop_runner";
import { sleep } from "../../../../src/test_runner/process_utils";
import {
    drag,
    elementBox,
    forceCloseWindow,
    launchMock,
    mockAppPath,
    resetDesktop,
    screenById,
    state,
    titlebarPoint,
    waitCloseRequest,
    waitState,
    windowByAppid,
} from "./helpers";

const entry = path.join(__dirname, "../../dist/index.js");
const hasBuild = fs.existsSync(entry) && fs.existsSync(mockAppPath());
const run = hasBuild ? it : it.skip;

let desktop: DesktopRunner;

const launchDecorated = (appid: string, width = 320, height = 240) =>
    launchMock(desktop, { appid, width, height, env: { DECORATED: "1" } });

const clickControl = async (handle: string, control: "close" | "maximize") => {
    const box = await elementBox(desktop, `[data-client-window='${handle}'] [data-client-control='${control}']`);
    if (!box) throw new Error(`窗口 ${handle} 没有 ${control} 按钮`);
    await desktop.click(box.x + box.width / 2, box.y + box.height / 2);
};

describe("鼠标窗口操作", () => {
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

    run("点标题栏聚焦并提升窗口", { timeout: 30000 }, async () => {
        const first = await launchDecorated("pointer-a", 360, 260);
        const second = await launchDecorated("pointer-b", 360, 260);
        await desktop.evaluate(
            `__mydeTest.placeWindow(${JSON.stringify(first.handle)}, ${JSON.stringify(second.screen)}, 40, 120)`,
        );

        let value = await waitState(desktop, (next) => windowByAppid(next, "pointer-a")?.screen === second.screen);
        expect(screenById(value, second.screen)?.windows).toEqual([second.handle, first.handle]);

        const firstPoint = await titlebarPoint(desktop, first.handle);
        await desktop.click(firstPoint.x, firstPoint.y);
        value = await waitState(desktop, (next) => next.focus === first.handle);
        expect(screenById(value, second.screen)?.windows).toEqual([second.handle, first.handle]);

        const secondPoint = await titlebarPoint(desktop, second.handle);
        await desktop.click(secondPoint.x, secondPoint.y);
        value = await waitState(desktop, (next) => next.focus === second.handle);
        expect(screenById(value, second.screen)?.windows).toEqual([first.handle, second.handle]);
    });

    run("拖动标题栏跟随指针移动", { timeout: 30000 }, async () => {
        const win = await launchDecorated("pointer-c", 360, 260);
        await sleep(250);
        const before = windowByAppid(await state(desktop), "pointer-c")?.rect;
        expect(before).toBeTruthy();
        if (!before) return;
        const start = await titlebarPoint(desktop, win.handle);
        await drag(desktop, start, { x: start.x + 120, y: start.y + 80 }, 6);

        const after = await waitState(
            desktop,
            (next) => (windowByAppid(next, "pointer-c")?.rect?.x ?? 0) > before.x + 100,
        );
        const moved = windowByAppid(after, "pointer-c")?.rect;
        expect(moved).toBeTruthy();
        if (!moved) return;
        expect(Math.abs(moved.x - before.x - 120)).toBeLessThanOrEqual(10);
        expect(Math.abs(moved.y - before.y - 80)).toBeLessThanOrEqual(10);
    });

    run("拖到左上角被顶部工具栏夹住", { timeout: 30000 }, async () => {
        const win = await launchDecorated("pointer-c2", 360, 260);
        await sleep(250);
        const before = await state(desktop);
        const start = await titlebarPoint(desktop, win.handle);

        await drag(desktop, start, { x: 1, y: 1 }, 4);
        const value = await waitState(desktop, (next) => {
            const moved = windowByAppid(next, "pointer-c2");
            return !!moved?.rect && moved.rect.x === next.available.x && moved.rect.y === next.available.y;
        });
        const rect = windowByAppid(value, "pointer-c2")?.rect;
        expect(rect?.x).toBe(before.available.x);
        expect(rect?.y).toBe(before.available.y);
    });

    run("拖到右下角被可用区边界夹住", { timeout: 30000 }, async () => {
        const win = await launchDecorated("pointer-c3", 360, 260);
        await sleep(250);
        const start = await titlebarPoint(desktop, win.handle);
        const stage = (await state(desktop)).stage;

        await drag(desktop, start, { x: stage.width - 2, y: stage.height - 2 }, 6);
        const value = await waitState(desktop, (next) => {
            const moved = windowByAppid(next, "pointer-c3");
            if (!moved?.rect) return false;
            return (
                moved.rect.x === next.available.x + next.available.width - moved.rect.w &&
                moved.rect.y === next.available.y + next.available.height - moved.rect.h
            );
        });
        const rect = windowByAppid(value, "pointer-c3")?.rect;
        expect(rect?.x).toBe(value.available.x + value.available.width - (rect?.w ?? 0));
        expect(rect?.y).toBe(value.available.y + value.available.height - (rect?.h ?? 0));
    });

    run("拖动窗口时下层窗口躲开覆盖", { timeout: 30000 }, async () => {
        const first = await launchDecorated("pointer-d");
        const second = await launchDecorated("pointer-e");
        await desktop.evaluate(
            `__mydeTest.placeWindow(${JSON.stringify(second.handle)}, ${JSON.stringify(second.screen)}, 120, 140)`,
        );
        await desktop.evaluate(
            `__mydeTest.placeWindow(${JSON.stringify(first.handle)}, ${JSON.stringify(second.screen)}, 120, 140)`,
        );
        await sleep(100);

        const before = await state(desktop);
        const otherBefore = windowByAppid(before, "pointer-e")?.rect;
        const start = await titlebarPoint(desktop, first.handle);
        await drag(desktop, start, { x: start.x + 40, y: start.y + 30 }, 4);

        const after = await waitState(desktop, (next) => {
            const other = windowByAppid(next, "pointer-e");
            return !!other?.rect && JSON.stringify(other.rect) !== JSON.stringify(otherBefore);
        });
        const otherAfter = windowByAppid(after, "pointer-e")?.rect;
        expect(otherAfter).toBeTruthy();
        expect(JSON.stringify(otherAfter)).not.toBe(JSON.stringify(otherBefore));
        const movedSelf = windowByAppid(after, "pointer-d")?.rect;
        if (otherAfter && movedSelf) {
            const width = Math.max(
                0,
                Math.min(movedSelf.x + movedSelf.w, otherAfter.x + otherAfter.w) - Math.max(movedSelf.x, otherAfter.x),
            );
            const height = Math.max(
                0,
                Math.min(movedSelf.y + movedSelf.h, otherAfter.y + otherAfter.h) - Math.max(movedSelf.y, otherAfter.y),
            );
            // 躲避只保证覆盖不超过阈值，不要求完全不重叠
            expect((width * height) / Math.max(1, otherAfter.w * otherAfter.h)).toBeLessThanOrEqual(0.8);
        }
    });

    run("屏内躲不开时拖动停在最后一个合法位置", { timeout: 30000 }, async () => {
        // 800×600 的窗口在可用区里放不下第二个：下层没有可躲的位置
        const lower = await launchMock(desktop, {
            appid: "pointer-k",
            width: 800,
            height: 600,
            env: { DECORATED: "1" },
        });
        const upper = await launchMock(desktop, {
            appid: "pointer-l",
            width: 800,
            height: 600,
            env: { DECORATED: "1" },
        });
        await desktop.evaluate(
            `__mydeTest.placeWindow(${JSON.stringify(lower.handle)}, ${JSON.stringify(lower.screen)}, 0, 28)`,
        );
        await desktop.evaluate(
            `__mydeTest.placeWindow(${JSON.stringify(upper.handle)}, ${JSON.stringify(lower.screen)}, 0, 28)`,
        );
        await sleep(100);

        const before = await state(desktop);
        const beforeUpper = windowByAppid(before, "pointer-k")?.rect;
        const beforeLower = windowByAppid(before, "pointer-l")?.rect;
        expect(beforeUpper && beforeLower).toBeTruthy();
        if (!beforeUpper || !beforeLower) return;

        const start = await titlebarPoint(desktop, upper.handle);
        await drag(desktop, start, { x: start.x + 40, y: start.y + 30 }, 4);
        await sleep(200);

        const after = await state(desktop);
        expect(windowByAppid(after, "pointer-k")?.rect).toEqual(beforeUpper);
        expect(windowByAppid(after, "pointer-l")?.rect).toEqual(beforeLower);
    });

    run("下层被大幅覆盖时点击只换焦点，不提升", { timeout: 30000 }, async () => {
        const covered = await launchDecorated("pointer-f");
        const cover = await launchDecorated("pointer-g");
        await desktop.evaluate(
            `__mydeTest.placeWindow(${JSON.stringify(covered.handle)}, ${JSON.stringify(covered.screen)}, 120, 140)`,
        );
        await desktop.evaluate(
            `__mydeTest.placeWindow(${JSON.stringify(cover.handle)}, ${JSON.stringify(covered.screen)}, 120, 150)`,
        );
        await sleep(100);

        const before = await state(desktop);
        expect(screenById(before, covered.screen)?.windows).toEqual([covered.handle, cover.handle]);

        // covered 只露出顶部 10px；点它应该只换焦点，层序不变（否则会盖住 cover）
        const rect = windowByAppid(before, "pointer-f")?.rect;
        expect(rect).toBeTruthy();
        if (!rect) return;
        await desktop.click(rect.x + rect.w / 2, rect.y + 4);

        const after = await waitState(desktop, (next) => next.focus === covered.handle);
        expect(screenById(after, covered.screen)?.windows).toEqual([covered.handle, cover.handle]);
    });

    run("标题栏关闭按钮发出关窗请求并回收虚拟屏", { timeout: 30000 }, async () => {
        const win = await launchDecorated("pointer-h");
        await desktop.evaluate("__mydeTest.clearCloseRequests()");
        await clickControl(win.handle, "close");
        await waitCloseRequest(desktop, win.handle);
        // 客户端退出后的 peer end 在测试环境里可能延迟很久；桌面侧强制回收后断言结果
        await forceCloseWindow(desktop, win.handle);

        const closed = await waitState(desktop, (next) => next.windows.length === 0);
        expect(closed.screens.length).toBe(2);
        expect(closed.screens[0].empty).toBe(true);
        expect(closed.screens[1].launchpad).toBe(true);
    });

    run("最大化按钮按可用区铺满，恢复回 800×600", { timeout: 30000 }, async () => {
        const win = await launchDecorated("pointer-i");

        await clickControl(win.handle, "maximize");
        const maximized = await waitState(desktop, (next) => {
            const win = windowByAppid(next, "pointer-i");
            return win?.maximized === true && !win.resizing;
        });
        const maxRect = windowByAppid(maximized, "pointer-i")?.rect;
        expect(maxRect).toBeTruthy();
        if (!maxRect) return;
        expect(maxRect.x).toBe(maximized.available.x);
        expect(maxRect.y).toBe(maximized.available.y);
        expect(maxRect.w).toBe(maximized.available.width);
        expect(maxRect.h).toBe(maximized.available.height);

        await clickControl(win.handle, "maximize");
        const restored = await waitState(desktop, (next) => {
            const win = windowByAppid(next, "pointer-i");
            return win?.maximized === false && !win.resizing;
        });
        const rect = windowByAppid(restored, "pointer-i")?.rect;
        // 动画结束后由居中管理器接管：800×600 在可用区里居中
        expect(rect?.x).toBe(Math.round(restored.available.x + (restored.available.width - (rect?.w ?? 0)) / 2));
        expect(rect?.y).toBe(Math.round(restored.available.y + (restored.available.height - (rect?.h ?? 0)) / 2));
        expect(Math.abs((rect?.w ?? 0) - 800)).toBeLessThanOrEqual(2);
        expect(rect?.h ?? 0).toBeGreaterThan(600);
        expect(rect?.h ?? 0).toBeLessThan(660);
    });

    run("最大化用整框过渡和内容淡化", { timeout: 30000 }, async () => {
        const win = await launchDecorated("pointer-anim", 480, 360);
        await desktop.evaluate("__mydeTest.setAnimationSpeed(1)");
        await desktop.evaluate(`(() => {
            const samples = [];
            window.__autoResizeSamples = samples;
            const started = performance.now();
            const tick = () => {
                const frame = document.querySelector("[data-client-frame]");
                const content = frame
                    ? [...frame.children].find(
                          (el) => el.id && !el.hasAttribute("data-desktop-ui") && !el.hasAttribute("data-client-titlebar"),
                      )
                    : null;
                const ghostEl = frame
                    ? ([...frame.children].find((el) => el.tagName === "CANVAS") ?? null)
                    : null;
                const surface = content?.querySelector("canvas") ?? null;
                const rect = frame?.getBoundingClientRect();
                samples.push({
                    t: performance.now() - started,
                    x: rect?.left ?? 0,
                    w: rect?.width ?? 0,
                    ghost: ghostEl ? 1 : 0,
                    ghostOpacity: ghostEl ? Number(getComputedStyle(ghostEl).opacity) : null,
                    opacity: surface ? Number(getComputedStyle(surface).opacity) : null,
                });
                if (performance.now() - started < 900) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        })()`);
        await clickControl(win.handle, "maximize");
        await sleep(950);
        const samples = await desktop.evaluate<
            {
                t: number;
                x: number;
                w: number;
                ghost: number;
                ghostOpacity: number | null;
                opacity: number | null;
            }[]
        >("window.__autoResizeSamples ?? []");
        const after = await state(desktop);
        const target = after.available.width;

        // 盒在一段动画里长到可用区：有中间宽度，不是瞬间切换
        const widths = samples.map((sample) => sample.w);
        expect(
            widths.filter((width) => width > 500 && width < target - 4).length,
            "应该有中间尺寸",
        ).toBeGreaterThanOrEqual(2);
        expect(Math.max(...widths) - Math.min(...widths), "尺寸应该真的在动画里变化").toBeGreaterThan(400);
        expect(Math.max(...widths), "最终应该铺满可用区").toBeGreaterThanOrEqual(target - 2);

        // 位置和尺寸一起走：过程中能看到中间 x
        const xs = samples.map((sample) => sample.x);
        expect(
            xs.some((x) => x > after.available.x + 4 && x < 300),
            "位置应该有中间值",
        ).toBe(true);

        // 不透明窗口：只淡出旧内容快照，内容层始终不透明
        const fading = samples.filter((sample) => sample.ghost > 0);
        expect(fading.length, "应该有旧内容快照在淡出").toBeGreaterThan(0);
        expect(
            fading.some((sample) => (sample.ghostOpacity ?? 1) > 0.1 && (sample.ghostOpacity ?? 1) < 0.9),
            "旧内容快照应该在淡出",
        ).toBe(true);
        for (const sample of fading) {
            expect(sample.opacity, "不透明窗口的内容层不应变透明").toBeGreaterThan(0.99);
        }

        const final = await desktop.evaluate<{ ghost: number; opacity: number | null; w: number }>(`(() => {
            const frame = document.querySelector("[data-client-frame]");
            const content = frame
                ? [...frame.children].find(
                      (el) => el.id && !el.hasAttribute("data-desktop-ui") && !el.hasAttribute("data-client-titlebar"),
                  )
                : null;
            const surface = content?.querySelector("canvas") ?? null;
            return {
                ghost: frame ? [...frame.children].filter((el) => el.tagName === "CANVAS").length : 0,
                opacity: surface ? Number(getComputedStyle(surface).opacity) : null,
                w: frame?.getBoundingClientRect().width ?? 0,
            };
        })()`);
        expect(final.ghost, "结束后旧内容快照应移除").toBe(0);
        expect(final.opacity, "结束后内容应恢复不透明").toBe(1);
        expect(final.w, "结束后盒应铺满可用区").toBeGreaterThanOrEqual(target - 2);
        await desktop.evaluate("__mydeTest.closeWindows();");
    });

    run("最大化时被同屏窗口大面积覆盖，会移到新虚拟屏", { timeout: 40000 }, async () => {
        const small = await launchMock(desktop, {
            appid: "pointer-m",
            width: 400,
            height: 300,
            env: { DECORATED: "1" },
        });
        const big = await launchMock(desktop, {
            appid: "pointer-n",
            width: 1200,
            height: 600,
            env: { DECORATED: "1" },
        });
        await desktop.evaluate(
            `__mydeTest.placeWindow(${JSON.stringify(big.handle)}, ${JSON.stringify(big.screen)}, 0, 28)`,
        );
        await desktop.evaluate(
            `__mydeTest.placeWindow(${JSON.stringify(small.handle)}, ${JSON.stringify(big.screen)}, 0, 400)`,
        );
        await sleep(100);

        await clickControl(small.handle, "maximize");
        const maximized = await waitState(
            desktop,
            (next) => {
                const win = windowByAppid(next, "pointer-m");
                return win?.maximized === true && win.screen !== big.screen;
            },
            8000,
            "被覆盖的最大化窗口换屏",
        );
        const moved = windowByAppid(maximized, "pointer-m");
        expect(moved?.screen).not.toBe(big.screen);
        expect(maximized.current).toBe(moved?.screen);
        expect(
            maximized.screens.filter((screen) => !screen.empty && !screen.launchpad).length,
            "原屏还有大窗口，不能回收",
        ).toBe(2);
        expect(windowByAppid(maximized, "pointer-n")?.screen).toBe(big.screen);
    });

    run("拖动右边缩放热区改变窗口尺寸", { timeout: 30000 }, async () => {
        const win = await launchMock(desktop, {
            appid: "pointer-j",
            width: 320,
            height: 240,
            env: { DECORATED: "1", SIZE_MODE: "configure" },
        });
        // configure 模式下客户端要等桌面下发 800×600 后才稳定，先等外框收尾
        const settled = await waitState(
            desktop,
            (next) => windowByAppid(next, "pointer-j")?.rect?.w === 800,
            8000,
            "窗口尺寸稳定",
        );
        const beforeRect = windowByAppid(settled, "pointer-j")?.rect;
        expect(beforeRect).toBeTruthy();
        if (!beforeRect) return;

        const handles = await desktop.evaluate<{ x: number; y: number; width: number; height: number }[]>(`
            [...document.querySelectorAll("[data-client-window='${win.handle}'] [data-resize-cursor='ew-resize']")]
                .map((el) => { const rect = el.getBoundingClientRect(); return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }; })
        `);
        // 左右两条边共用 ew-resize 光标，取 x 最大的右边
        const handle = handles.toSorted((a, b) => b.x - a.x)[0];
        expect(handle).toBeTruthy();
        if (!handle) return;
        const from = { x: handle.x + 1, y: handle.y + handle.height / 2 };
        await drag(desktop, from, { x: from.x + 100, y: from.y }, 5);

        const after = await waitState(
            desktop,
            (next) => (windowByAppid(next, "pointer-j")?.rect?.w ?? 0) > beforeRect.w + 40,
            8000,
            "缩放窗口",
        );
        expect(windowByAppid(after, "pointer-j")?.rect?.w ?? 0).toBeGreaterThan(beforeRect.w + 40);
    });
});
