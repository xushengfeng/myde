import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../../src/test_runner/desktop_runner";
import { sleep } from "../../../../src/test_runner/process_utils";
import { currentScreen, launchMock, mockAppPath, resetDesktop, startFingerGesture, state, waitState } from "./helpers";

const entry = path.join(__dirname, "../../dist/index.js");
const hasBuild = fs.existsSync(entry) && fs.existsSync(mockAppPath());
const run = hasBuild ? it : it.skip;
const META = 4;
const ALT = 1;

let desktop: DesktopRunner;

const openSearch = async () => {
    await desktop.key("Space", { modifiers: ALT });
    return waitState(
        desktop,
        (value) =>
            value.launcher?.visible === true &&
            value.launcher.binding.kind === "line" &&
            value.launcher.binding.level === -1 &&
            value.launcher.focused === true,
        8000,
        "打开搜索",
    );
};

const enterOverview = async () => {
    await desktop.key("Tab", { modifiers: META });
    return waitState(
        desktop,
        (value) => value.overview && value.launcher?.binding.kind === "line" && value.launcher.binding.level === 1,
        8000,
        "进入全局预览",
    );
};

describe("搜索与全局模式", () => {
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

    run("Alt+Space 打开和收起搜索", { timeout: 30000 }, async () => {
        await openSearch();
        await desktop.key("Space", { modifiers: ALT });
        const closed = await waitState(
            desktop,
            (value) => value.launcher?.binding.kind === "line" && value.launcher.binding.level === 0,
        );
        expect(closed.launcher?.visible).toBe(false);
        expect(closed.overview).toBe(false);
    });

    run("搜索打开时 Super+←/→ 仍然切虚拟屏", { timeout: 30000 }, async () => {
        const opened = await openSearch();
        const launchpad = opened.screens.find((screen) => screen.launchpad);
        expect(launchpad).toBeTruthy();
        if (!launchpad) return;

        await desktop.key("ArrowLeft", { modifiers: META });
        const switched = await waitState(desktop, (value) => value.current === launchpad.id);
        expect(switched.launcher?.visible).toBe(true);
        expect(switched.overview).toBe(false);
        expect(switched.launcher?.binding).toEqual({ kind: "line", level: -1 });
    });

    run("搜索打开时三指横滑切虚拟屏", { timeout: 30000 }, async () => {
        const opened = await openSearch();
        const launchpad = opened.screens.find((screen) => screen.launchpad);
        expect(launchpad).toBeTruthy();
        if (!launchpad) return;

        const gesture = await startFingerGesture(desktop);
        await gesture.move(-opened.stage.width * 0.2, 0);
        await gesture.end();

        const switched = await waitState(desktop, (value) => value.current === launchpad.id);
        expect(switched.launcher?.visible).toBe(true);
        expect(switched.overview).toBe(false);
        expect(switched.gesture).toBeUndefined();
    });

    run("Esc 收起搜索", { timeout: 30000 }, async () => {
        await openSearch();
        await desktop.key("Escape");
        const closed = await waitState(
            desktop,
            (value) => value.launcher?.binding.kind === "line" && value.launcher.binding.level === 0,
        );
        expect(closed.launcher?.visible).toBe(false);
    });

    run("搜索中 Super+Tab 走 N-T 直连，退出回到 1/3 搜索", { timeout: 30000 }, async () => {
        await openSearch();
        const entered = await enterOverview();
        expect(entered.overview).toBe(true);

        const brief = await state(desktop);
        expect(
            brief.launcher?.binding.kind === "direct" ||
                (brief.launcher?.binding.kind === "line" && brief.launcher.binding.level === 1),
            "直连切换应该已经发生",
        ).toBe(true);

        await desktop.key("Tab", { modifiers: META });
        const exited = await waitState(
            desktop,
            (value) =>
                !value.overview && value.launcher?.binding.kind === "line" && value.launcher.binding.level === -1,
            8000,
            "从直连退出到搜索",
        );
        expect(exited.launcher?.visible).toBe(true);
        expect(exited.current).toBe(entered.current);

        await desktop.key("Escape");
        const closed = await waitState(
            desktop,
            (value) => value.launcher?.binding.kind === "line" && value.launcher.binding.level === 0,
        );
        expect(closed.launcher?.visible).toBe(false);
    });

    run("直连进入预览后经过布局重算，退出仍回 1/3 搜索", { timeout: 40000 }, async () => {
        const win = await launchMock(desktop, { appid: "direct-a", width: 480, height: 360 });
        await openSearch();
        await enterOverview();

        // 预览里改窗口落点会走一次 render(false)；直连来源不能被这次重算冲掉
        await desktop.evaluate(
            `__mydeTest.placeWindow(${JSON.stringify(win.handle)}, ${JSON.stringify(win.screen)}, 80, 120)`,
        );
        await sleep(200);

        await desktop.key("Tab", { modifiers: META });
        const exited = await waitState(
            desktop,
            (value) =>
                !value.overview && value.launcher?.binding.kind === "line" && value.launcher.binding.level === -1,
            8000,
            "布局重算后从直连退出到搜索",
        );
        expect(exited.launcher?.visible).toBe(true);

        await desktop.key("Escape");
        const closed = await waitState(
            desktop,
            (value) => value.launcher?.binding.kind === "line" && value.launcher.binding.level === 0,
        );
        expect(closed.launcher?.visible).toBe(false);
    });

    run("搜索结果跳到另一个虚拟屏上的窗口", { timeout: 40000 }, async () => {
        const first = await launchMock(desktop, { appid: "search-a", width: 640, height: 420 });
        const second = await launchMock(desktop, { appid: "search-b", width: 640, height: 420 });
        expect((await state(desktop)).current).toBe(second.screen);

        await openSearch();
        await desktop.text("search-a");
        await desktop.waitFor(
            `document.querySelector("[data-launcher-input]")?.textContent.includes("search-a")`,
            10000,
        );
        await desktop.key("Enter");

        const jumped = await waitState(
            desktop,
            (value) =>
                value.current === first.screen &&
                value.launcher?.binding.kind === "line" &&
                value.launcher.binding.level === 0,
        );
        expect(jumped.focus).toBe(first.handle);
        expect(jumped.overview).toBe(false);
        expect(jumped.launcher?.visible).toBe(false);
        expect(jumped.windows.find((win) => win.handle === second.handle)?.screen).toBe(second.screen);
    });

    run("搜索结果可以切到启动台和空桌面", { timeout: 30000 }, async () => {
        const opened = await openSearch();
        const launchpad = opened.screens.find((screen) => screen.launchpad);
        const empty = opened.screens.find((screen) => screen.empty);
        expect(launchpad && empty).toBeTruthy();
        if (!launchpad || !empty) return;

        await desktop.text("launchpad");
        await desktop.waitFor(`document.querySelector("[data-launcher-input]")?.textContent.includes("启动台")`, 10000);
        await desktop.key("Enter");
        await waitState(
            desktop,
            (value) =>
                value.current === launchpad.id &&
                !value.overview &&
                value.launcher?.binding.kind === "line" &&
                value.launcher.binding.level === 0,
        );

        const openedAgain = await openSearch();
        expect(openedAgain.current).toBe(launchpad.id);
        await desktop.text("empty desktop");
        await desktop.waitFor(`document.querySelector("[data-launcher-input]")?.textContent.includes("空桌面")`, 10000);
        await desktop.key("Enter");
        const switched = await waitState(
            desktop,
            (value) =>
                value.current === empty.id &&
                !value.overview &&
                value.launcher?.binding.kind === "line" &&
                value.launcher.binding.level === 0,
        );
        expect(currentScreen(switched)?.empty).toBe(true);
        expect(switched.launcher?.visible).toBe(false);
    });

    run("预览里搜索栏固定顶部，Alt+Space 收不起，Esc 只失焦", { timeout: 30000 }, async () => {
        await enterOverview();
        await waitState(desktop, (value) => value.launcher?.focused === true);

        await desktop.key("Space", { modifiers: ALT });
        await sleep(250);
        const stillOpen = await state(desktop);
        expect(stillOpen.overview).toBe(true);
        expect(stillOpen.launcher?.binding).toEqual({ kind: "line", level: 1 });
        expect(stillOpen.launcher?.visible).toBe(true);

        await desktop.key("Escape");
        const blurred = await waitState(desktop, (value) => value.overview && value.launcher?.focused === false);
        expect(blurred.launcher?.binding).toEqual({ kind: "line", level: 1 });

        await desktop.key("Escape");
        const exited = await waitState(
            desktop,
            (value) => !value.overview && value.launcher?.binding.kind === "line" && value.launcher.binding.level === 0,
        );
        expect(exited.launcher?.visible).toBe(false);
    });
});
