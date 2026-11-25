import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../../src/test_runner/desktop_runner";
import { sleep } from "../../../../src/test_runner/process_utils";
import {
    cardPoint,
    currentScreen,
    drag,
    elementBox,
    forceCloseWindow,
    launchMock,
    mockAppPath,
    resetDesktop,
    screenById,
    state,
    waitCloseRequest,
    waitState,
    windowByAppid,
} from "./helpers";

const entry = path.join(__dirname, "../../dist/index.js");
const hasBuild = fs.existsSync(entry) && fs.existsSync(mockAppPath());
const run = hasBuild ? it : it.skip;
const META = 4;
const ALT = 1;

let desktop: DesktopRunner;

const enterOverview = async () => {
    await desktop.key("Tab", { modifiers: META });
    return waitState(
        desktop,
        (value) => value.overview && value.launcher?.binding.kind === "line" && value.launcher.binding.level === 1,
        8000,
        "进入全局预览",
    );
};

describe("全局预览", () => {
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

    run("Super+Tab 进入和退出预览，当前屏不变", { timeout: 30000 }, async () => {
        const before = await state(desktop);

        const entered = await enterOverview();
        expect(entered.current).toBe(before.current);
        expect(entered.launcher?.focused).toBe(true);

        await desktop.key("Tab", { modifiers: META });
        const exited = await waitState(
            desktop,
            (value) => !value.overview && value.launcher?.binding.kind === "line" && value.launcher.binding.level === 0,
        );
        expect(exited.current).toBe(before.current);
        expect(exited.launcher?.visible).toBe(false);
    });

    run("预览里 Esc 第一次只失焦，第二次退出", { timeout: 30000 }, async () => {
        await enterOverview();
        const focused = await waitState(desktop, (value) => value.launcher?.focused === true);

        await desktop.key("Escape");
        const blurred = await waitState(desktop, (value) => value.overview && value.launcher?.focused === false);
        expect(blurred.overview).toBe(true);
        expect(blurred.launcher?.binding).toEqual(focused.launcher?.binding);

        await desktop.key("Escape");
        const exited = await waitState(
            desktop,
            (value) => !value.overview && value.launcher?.binding.kind === "line" && value.launcher.binding.level === 0,
        );
        expect(exited.overview).toBe(false);
    });

    run("点击应用卡片退出预览并切到该屏", { timeout: 30000 }, async () => {
        const first = await launchMock(desktop, { appid: "overview-a" });
        const second = await launchMock(desktop, { appid: "overview-b" });
        expect((await state(desktop)).current).toBe(second.screen);

        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => value.overview);
        await sleep(400);
        const point = await cardPoint(desktop, first.screen);
        await desktop.click(point.x, point.y);

        const selected = await waitState(desktop, (value) => !value.overview);
        expect(selected.current).toBe(first.screen);
        expect(screenById(selected, second.screen)?.windows, "另一张屏不受影响").toEqual([second.handle]);
    });

    run("点击空桌面和启动台卡片可以切换过去", { timeout: 30000 }, async () => {
        const before = await state(desktop);
        const launchpad = before.screens.find((screen) => screen.launchpad);
        const empty = before.screens.find((screen) => screen.empty);
        expect(launchpad && empty).toBeTruthy();
        if (!launchpad || !empty) return;

        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => value.overview);
        await sleep(400);
        const padPoint = await cardPoint(desktop, launchpad.id);
        await desktop.click(padPoint.x, padPoint.y);
        await waitState(desktop, (value) => !value.overview && value.current === launchpad.id);

        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => value.overview);
        await sleep(400);
        const emptyPoint = await cardPoint(desktop, empty.id);
        await desktop.click(emptyPoint.x, emptyPoint.y);
        const selected = await waitState(desktop, (value) => !value.overview && value.current === empty.id);
        expect(currentScreen(selected)?.empty).toBe(true);
    });

    run("点击预览空白退出，当前屏不变", { timeout: 30000 }, async () => {
        const before = await state(desktop);
        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => value.overview);
        await sleep(400);

        const blank = await desktop.evaluate<{ x: number; y: number }>(`
            (() => {
                const rects = [...document.querySelectorAll("[data-view-id]")].map((el) => el.getBoundingClientRect());
                for (let y = innerHeight - 8; y > 8; y -= 8) {
                    for (let x = 8; x < innerWidth; x += 8) {
                        if (!rects.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) {
                            return { x, y };
                        }
                    }
                }
                return { x: 5, y: 5 };
            })()
        `);
        await desktop.click(blank.x, blank.y);
        const exited = await waitState(desktop, (value) => !value.overview);
        expect(exited.current).toBe(before.current);
    });

    run("预览里桌面快捷键被吞掉", { timeout: 30000 }, async () => {
        const win = await launchMock(desktop, { appid: "overview-c", width: 640, height: 420 });
        await desktop.key("Tab", { modifiers: META });
        const before = await waitState(desktop, (value) => value.overview);
        await desktop.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()");

        for (const [key, modifiers] of [
            ["ArrowLeft", META],
            ["ArrowRight", META],
            ["KeyD", META],
            ["KeyF", META],
            ["Space", ALT],
        ] as const) {
            await desktop.key(key, { modifiers });
        }
        await sleep(300);

        const after = await state(desktop);
        expect(after.overview).toBe(true);
        expect(after.current).toBe(before.current);
        expect(windowByAppid(after, "overview-c")?.handle).toBe(win.handle);
        expect(windowByAppid(after, "overview-c")?.fullscreen).toBe(false);
        expect(after.screens.map((screen) => screen.id)).toEqual(before.screens.map((screen) => screen.id));
    });

    run("预览里关闭按钮关窗并回收屏，预览保持", { timeout: 30000 }, async () => {
        const win = await launchMock(desktop, { appid: "overview-d" });
        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => value.overview);
        await sleep(400);

        const button = await elementBox(desktop, `[data-view-id='${win.screen}'] [data-desktop-ui='window-close']`);
        expect(button, "预览里应该有窗口关闭按钮").toBeTruthy();
        if (!button) return;
        await desktop.evaluate("__mydeTest.clearCloseRequests()");
        await desktop.click(button.x + button.width / 2, button.y + button.height / 2);
        await waitCloseRequest(desktop, win.handle);
        // 客户端退出后的 peer end 在测试环境里可能延迟，先确认请求再回收桌面侧窗口
        await forceCloseWindow(desktop, win.handle);

        const closed = await waitState(desktop, (value) => !value.windows.some((item) => item.handle === win.handle));
        expect(closed.overview).toBe(true);
        expect(closed.screens.some((screen) => screen.id === win.screen)).toBe(false);
    });

    run("把卡片拖到另一张卡片：窗口换屏，预览保持", { timeout: 40000 }, async () => {
        const first = await launchMock(desktop, { appid: "overview-e", width: 640, height: 420 });
        const second = await launchMock(desktop, { appid: "overview-f", width: 640, height: 420 });
        expect((await state(desktop)).current).toBe(second.screen);

        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => value.overview);
        await sleep(400);

        const from = await cardPoint(desktop, first.screen, 0.2, 0.5);
        const to = await cardPoint(desktop, second.screen, 0.5, 0.5);
        await drag(desktop, from, to, 8);
        await sleep(400);

        const moved = await waitState(
            desktop,
            (value) => windowByAppid(value, "overview-e")?.screen === second.screen,
            8000,
            "卡片拖动换屏",
        );
        expect(moved.overview).toBe(true);
        expect(moved.current).toBe(second.screen);
        expect(
            moved.screens.some((screen) => screen.id === first.screen),
            "拖空的源屏应该回收",
        ).toBe(false);
        expect(screenById(moved, second.screen)?.windows).toEqual([second.handle, first.handle]);
    });

    run("预览中启动应用：自动退出预览并落到新屏", { timeout: 40000 }, async () => {
        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => value.overview);

        const win = await launchMock(desktop, { appid: "overview-g", width: 640, height: 420 });
        const value = await waitState(desktop, (next) => !next.overview && next.current === win.screen);
        expect(currentScreen(value)?.windows).toEqual([win.handle]);
    });
});
