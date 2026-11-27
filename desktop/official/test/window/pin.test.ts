import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../../src/test_runner/desktop_runner";
import {
    drag,
    elementBox,
    frameBox,
    launchMock,
    mockAppPath,
    resetDesktop,
    screenById,
    startFingerGesture,
    state,
    waitState,
    windowByAppid,
} from "./helpers";

const entry = path.join(__dirname, "../../dist/index.js");
const hasBuild = fs.existsSync(entry) && fs.existsSync(mockAppPath());
const run = hasBuild ? it : it.skip;
const META = 4;

let desktop: DesktopRunner;

const enterOverview = async () => {
    await desktop.key("Tab", { modifiers: META });
    const value = await waitState(desktop, (state) => state.overviewProgress >= 0.999, 8000, "进入全局预览");
    // 等 grid 卡片落定后再取按钮坐标
    await new Promise((resolve) => setTimeout(resolve, 360));
    return value;
};

const pinButtonBox = (handle: string) =>
    elementBox(desktop, `[data-client-window='${handle}'] [data-desktop-ui='window-pin']`);

describe("全局置顶", () => {
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

    run("预览里置顶窗口，置顶屏在空桌面左边，退出预览后固定覆盖", { timeout: 30000 }, async () => {
        const win = await launchMock(desktop, { appid: "pin-a", width: 640, height: 420 });
        await enterOverview();
        await desktop.waitFor(
            "document.querySelector('[data-client-window] [data-desktop-ui=\\'window-pin\\']')",
            5000,
        );

        const box = await pinButtonBox(win.handle);
        expect(box).toBeTruthy();
        if (!box) return;
        await desktop.click(box.x + box.width / 2, box.y + box.height / 2);

        const pinned = await waitState(
            desktop,
            (value) => value.overview && windowByAppid(value, "pin-a")?.pinned === true,
            8000,
            "窗口置顶",
        );
        const pinnedWindow = windowByAppid(pinned, "pin-a");
        expect(pinnedWindow).toBeTruthy();
        if (!pinnedWindow) return;
        const pinnedScreen = screenById(pinned, pinnedWindow.screen);
        expect(pinnedScreen?.pinned).toBe(true);

        const emptyIndex = pinned.screens.findIndex((screen) => screen.empty);
        const pinnedIndex = pinned.screens.findIndex((screen) => screen.pinned);
        expect(pinnedIndex).toBe(emptyIndex - 1);
        expect(pinned.overview).toBe(true);

        const pinStyle = await desktop.evaluate<{ background: string; filter: string }>(`
            (() => {
                const btn = document.querySelector(
                    "[data-client-window='${win.handle}'] [data-desktop-ui='window-pin']",
                );
                const icon = btn?.querySelector("[data-window-pin-icon]");
                return {
                    background: btn ? getComputedStyle(btn).backgroundColor : "missing",
                    filter: icon ? getComputedStyle(icon).filter : "missing",
                };
            })()
        `);
        expect(pinStyle.background).toBe("rgb(17, 17, 17)");
        expect(pinStyle.filter).toContain("invert");

        // 退出预览，切到空桌面：置顶窗口不属于当前屏，但仍应固定在视口里
        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => !value.overview);
        await desktop.key("ArrowLeft", { modifiers: META });
        const empty = await waitState(
            desktop,
            (value) => !value.overview && value.screens.some((screen) => screen.current && screen.empty),
        );
        expect(empty.current).not.toBe(pinnedWindow.screen);

        // 退出预览的屏/面板动画走完，置顶窗口回到固定覆盖
        await desktop.waitFor(
            `(() => {
                const el = document.querySelector("[data-client-window='${win.handle}']");
                const slot = el?.parentElement;
                return !!slot && getComputedStyle(slot).transform === "none";
            })()`,
            5000,
        );
        const transform = await desktop.evaluate<string>(
            `(() => {
                const el = document.querySelector("[data-client-window='${win.handle}']");
                const slot = el?.parentElement;
                return slot ? getComputedStyle(slot).transform : "missing";
            })()`,
        );
        expect(transform).toBe("none");
        const frame = await frameBox(desktop, win.handle);
        expect(frame).toBeTruthy();
        expect((frame?.x ?? -1) < empty.stage.width && (frame?.y ?? -1) < empty.stage.height).toBe(true);

        // 重新进入预览并退出置顶：窗口回到新的应用屏，预览不退出
        await enterOverview();
        const box2 = await pinButtonBox(win.handle);
        expect(box2).toBeTruthy();
        if (!box2) return;
        await desktop.click(box2.x + box2.width / 2, box2.y + box2.height / 2);

        const unpinned = await waitState(
            desktop,
            (value) =>
                value.overview &&
                windowByAppid(value, "pin-a")?.pinned === false &&
                !value.screens.some((screen) => screen.pinned),
            8000,
            "退出置顶",
        );
        expect(unpinned.overview).toBe(true);
        expect(windowByAppid(unpinned, "pin-a")).toBeTruthy();
    });

    run("进入置顶时窗口留在专用屏，退出时换到新屏", { timeout: 30000 }, async () => {
        const first = await launchMock(desktop, { appid: "pin-b", width: 640, height: 420 });
        await launchMock(desktop, { appid: "pin-c", width: 640, height: 420 });
        await enterOverview();

        const box = await pinButtonBox(first.handle);
        expect(box).toBeTruthy();
        if (!box) return;
        await desktop.click(box.x + box.width / 2, box.y + box.height / 2);

        const pinned = await waitState(
            desktop,
            (value) => windowByAppid(value, "pin-b")?.pinned === true,
            8000,
            "窗口置顶",
        );
        const pinnedScreenId = windowByAppid(pinned, "pin-b")?.screen;
        expect(pinnedScreenId).toBeTruthy();
        expect(screenById(pinned, pinnedScreenId ?? "")?.pinned).toBe(true);
        expect(windowByAppid(pinned, "pin-c")?.pinned).toBe(false);
        const beforeCount = pinned.screens.length;

        // 置顶屏是新插入的卡片，等 grid 重排落定后再取按钮坐标
        await new Promise((resolve) => setTimeout(resolve, 420));
        const box2 = await pinButtonBox(first.handle);
        expect(box2).toBeTruthy();
        if (!box2) return;
        await desktop.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
        const unpinned = await waitState(
            desktop,
            (value) => windowByAppid(value, "pin-b")?.pinned === false,
            8000,
            "退出置顶",
        );
        expect(unpinned.overview).toBe(true);
        expect(screenById(unpinned, pinnedScreenId ?? "")).toBeUndefined();
        expect(windowByAppid(unpinned, "pin-b")?.screen).not.toBe(pinnedScreenId);
        expect(unpinned.screens.some((screen) => screen.pinned)).toBe(false);
        // 置顶屏回收，新应用屏接替它；其它应用屏和空桌面不变
        expect(unpinned.screens.length).toBe(beforeCount);
        expect(windowByAppid(unpinned, "pin-c")).toBeTruthy();
    });

    run("可以同时置顶多个窗口", { timeout: 40000 }, async () => {
        const first = await launchMock(desktop, { appid: "pin-m1", width: 560, height: 380 });
        const second = await launchMock(desktop, { appid: "pin-m2", width: 560, height: 380 });
        await enterOverview();

        const firstBox = await pinButtonBox(first.handle);
        expect(firstBox).toBeTruthy();
        if (!firstBox) return;
        await desktop.click(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
        await waitState(desktop, (value) => windowByAppid(value, "pin-m1")?.pinned === true, 8000, "第一个窗口置顶");

        await new Promise((resolve) => setTimeout(resolve, 420));
        const secondBox = await pinButtonBox(second.handle);
        expect(secondBox).toBeTruthy();
        if (!secondBox) return;
        await desktop.click(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);

        const both = await waitState(
            desktop,
            (value) =>
                windowByAppid(value, "pin-m1")?.pinned === true && windowByAppid(value, "pin-m2")?.pinned === true,
            8000,
            "两个窗口同时置顶",
        );
        const pinnedScreens = both.screens.filter((screen) => screen.pinned);
        expect(pinnedScreens.length).toBe(1);
        expect(windowByAppid(both, "pin-m1")?.screen).toBe(pinnedScreens[0].id);
        expect(windowByAppid(both, "pin-m2")?.screen).toBe(pinnedScreens[0].id);
        expect(pinnedScreens[0].windows.length).toBe(2);
        const emptyIndex = both.screens.findIndex((screen) => screen.empty);
        expect(both.screens[emptyIndex - 1].pinned).toBe(true);
        expect(both.overview).toBe(true);

        // 退出置顶其中一个，另一个保持置顶，预览不退出
        await new Promise((resolve) => setTimeout(resolve, 420));
        const firstBoxAgain = await pinButtonBox(first.handle);
        expect(firstBoxAgain).toBeTruthy();
        if (!firstBoxAgain) return;
        await desktop.click(firstBoxAgain.x + firstBoxAgain.width / 2, firstBoxAgain.y + firstBoxAgain.height / 2);
        const oneLeft = await waitState(
            desktop,
            (value) =>
                value.overview &&
                windowByAppid(value, "pin-m1")?.pinned === false &&
                windowByAppid(value, "pin-m2")?.pinned === true,
            8000,
            "退出其中一个置顶",
        );
        const remaining = oneLeft.screens.filter((screen) => screen.pinned);
        expect(remaining.length).toBe(1);
        expect(remaining[0].windows).toEqual([second.handle]);
        expect(windowByAppid(oneLeft, "pin-m1")?.screen).not.toBe(remaining[0].id);
        expect(oneLeft.overview).toBe(true);
    });

    run("置顶屏放不下时禁止加入", { timeout: 40000 }, async () => {
        const first = await launchMock(desktop, { appid: "pin-full-a", width: 1100, height: 700 });
        const second = await launchMock(desktop, { appid: "pin-full-b", width: 1100, height: 700 });
        await enterOverview();

        const firstBox = await pinButtonBox(first.handle);
        expect(firstBox).toBeTruthy();
        if (!firstBox) return;
        await desktop.click(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
        await waitState(desktop, (value) => windowByAppid(value, "pin-full-a")?.pinned === true);

        await new Promise((resolve) => setTimeout(resolve, 420));
        const secondBox = await pinButtonBox(second.handle);
        expect(secondBox).toBeTruthy();
        if (!secondBox) return;
        await desktop.click(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
        await new Promise((resolve) => setTimeout(resolve, 500));

        const after = await state(desktop);
        const pinnedScreens = after.screens.filter((screen) => screen.pinned);
        expect(pinnedScreens.length).toBe(1);
        expect(pinnedScreens[0].windows).toEqual([first.handle]);
        expect(windowByAppid(after, "pin-full-b")?.pinned).toBe(false);
        expect(after.overview).toBe(true);
    });

    run("置顶窗口缩放超限后换到新屏并取消置顶", { timeout: 40000 }, async () => {
        const first = await launchMock(desktop, {
            appid: "pin-resize-a",
            width: 420,
            height: 300,
            env: { DECORATED: "1" },
        });
        const second = await launchMock(desktop, {
            appid: "pin-resize-b",
            width: 420,
            height: 300,
            env: { DECORATED: "1" },
        });
        await enterOverview();

        const firstBox = await pinButtonBox(first.handle);
        expect(firstBox).toBeTruthy();
        if (!firstBox) return;
        await desktop.click(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
        await waitState(desktop, (value) => windowByAppid(value, "pin-resize-a")?.pinned === true);
        await new Promise((resolve) => setTimeout(resolve, 420));
        const secondBox = await pinButtonBox(second.handle);
        expect(secondBox).toBeTruthy();
        if (!secondBox) return;
        await desktop.click(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
        const pinned = await waitState(
            desktop,
            (value) =>
                windowByAppid(value, "pin-resize-a")?.pinned === true &&
                windowByAppid(value, "pin-resize-b")?.pinned === true,
            8000,
            "两个窗口置顶",
        );

        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => !value.overview);
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect((await state(desktop)).overview, "拖动前应仍在常规模式").toBe(false);

        const a = windowByAppid(pinned, "pin-resize-a");
        const b = windowByAppid(pinned, "pin-resize-b");
        expect(a && b).toBeTruthy();
        if (!a || !b) return;
        const pinnedScreenId = a.screen;
        // 让两个置顶窗口几乎完全重叠，任何放大都会和对方互相覆盖超过阈值
        await desktop.evaluate(
            `__mydeTest.placeWindow(${JSON.stringify(a.handle)}, ${JSON.stringify(pinnedScreenId)}, 0, 28)`,
        );
        await desktop.evaluate(
            `__mydeTest.placeWindow(${JSON.stringify(b.handle)}, ${JSON.stringify(pinnedScreenId)}, 0, 28)`,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));

        const frame = await frameBox(desktop, b.handle);
        expect(frame).toBeTruthy();
        if (!frame) return;
        // 右边热区露在窗口外的一半，两个窗口完全重叠时这里不会被画布盖住
        const from = { x: frame.x + frame.width + 1, y: frame.y + frame.height / 2 };
        await drag(desktop, from, { x: from.x + 60, y: from.y }, 6);

        const moved = await waitState(
            desktop,
            (value) =>
                windowByAppid(value, "pin-resize-b")?.pinned === false &&
                windowByAppid(value, "pin-resize-a")?.pinned === true,
            8000,
            "缩放超限后取消置顶",
        );
        const remaining = moved.screens.filter((screen) => screen.pinned);
        expect(remaining.length).toBe(1);
        expect(remaining[0].windows).toEqual([first.handle]);
        expect(windowByAppid(moved, "pin-resize-b")?.screen).not.toBe(remaining[0].id);
    });

    run("手势上滑时置顶窗口跟随缩放", { timeout: 40000 }, async () => {
        const win = await launchMock(desktop, { appid: "pin-scale", width: 560, height: 380 });
        await enterOverview();
        const box = await pinButtonBox(win.handle);
        expect(box).toBeTruthy();
        if (!box) return;
        await desktop.click(box.x + box.width / 2, box.y + box.height / 2);
        await waitState(desktop, (value) => windowByAppid(value, "pin-scale")?.pinned === true);

        // 回到常规，再用手势上滑一点点：置顶窗口应随屏一起缩小
        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => !value.overview);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await desktop.evaluate("__mydeTest.setAnimationSpeed(1)");

        const gesture = await startFingerGesture(desktop);
        await gesture.move(0, -70, 4);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const mid = await gesture.state();
        expect(mid.overviewProgress).toBeGreaterThan(0);

        const scale = await desktop.evaluate<number>(`
            (() => {
                const el = document.querySelector("[data-client-window='${win.handle}']");
                const slot = el?.parentElement;
                if (!slot) return -1;
                const transform = getComputedStyle(slot).transform;
                return transform === "none" ? 1 : new DOMMatrixReadOnly(transform).a;
            })()
        `);
        expect(scale).toBeLessThan(0.99);
        expect(scale).toBeGreaterThan(0.1);
        await gesture.end();
    });
});
