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

    run("拖动标题栏不能进入顶部工具栏区域", { timeout: 30000 }, async () => {
        const win = await launchDecorated("pointer-c", 360, 260);
        const before = await state(desktop);
        const start = await titlebarPoint(desktop, win.handle);

        await drag(desktop, start, { x: 1, y: 1 }, 4);
        const value = await waitState(desktop, (next) => {
            const moved = windowByAppid(next, "pointer-c");
            return !!moved?.rect && moved.rect.x === next.available.x && moved.rect.y === next.available.y;
        });
        const rect = windowByAppid(value, "pointer-c")?.rect;
        expect(rect?.x).toBe(before.available.x);
        expect(rect?.y).toBe(before.available.y);
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
        const maximized = await waitState(desktop, (next) => windowByAppid(next, "pointer-i")?.maximized === true);
        const maxRect = windowByAppid(maximized, "pointer-i")?.rect;
        expect(maxRect).toBeTruthy();
        if (!maxRect) return;
        expect(maxRect.x).toBe(maximized.available.x);
        expect(maxRect.y).toBe(maximized.available.y);
        expect(maxRect.w).toBe(maximized.available.width);
        expect(maxRect.h).toBe(maximized.available.height);

        await clickControl(win.handle, "maximize");
        const restored = await waitState(desktop, (next) => windowByAppid(next, "pointer-i")?.maximized === false);
        const rect = windowByAppid(restored, "pointer-i")?.rect;
        expect(rect?.x).toBe(restored.available.x);
        expect(rect?.y).toBe(restored.available.y);
        expect(Math.abs((rect?.w ?? 0) - 800)).toBeLessThanOrEqual(2);
        expect(rect?.h ?? 0).toBeGreaterThan(600);
        expect(rect?.h ?? 0).toBeLessThan(660);
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
