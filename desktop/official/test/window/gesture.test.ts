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
            value.launcher.binding.level === -1,
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

describe("三指手势", () => {
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

    run("横滑一张屏：左滑到启动台，右滑回空桌面", { timeout: 30000 }, async () => {
        const initial = await state(desktop);
        const launchpad = initial.screens.find((screen) => screen.launchpad);
        expect(launchpad).toBeTruthy();
        if (!launchpad) return;

        let gesture = await startFingerGesture(desktop);
        await gesture.move(-initial.stage.width * 0.2, 0, 8);
        await gesture.end();
        await waitState(desktop, (value) => value.current === launchpad.id);

        gesture = await startFingerGesture(desktop);
        await gesture.move(initial.stage.width * 0.2, 0, 8);
        await gesture.end();
        const back = await waitState(desktop, (value) => currentScreen(value)?.empty === true);
        expect(back.current).toBe(initial.current);
    });

    run("横滑吸附阈值：不到半屏回弹，超过半屏切屏", { timeout: 30000 }, async () => {
        const initial = await state(desktop);
        const launchpad = initial.screens.find((screen) => screen.launchpad);
        expect(launchpad).toBeTruthy();
        if (!launchpad) return;

        let gesture = await startFingerGesture(desktop);
        await gesture.move(-initial.stage.width * 0.08, 0, 4);
        await gesture.end();
        await sleep(150);
        expect((await state(desktop)).current, "不到半屏应该回弹").toBe(initial.current);

        gesture = await startFingerGesture(desktop);
        await gesture.move(-initial.stage.width * 0.2, 0, 8);
        await gesture.end();
        await waitState(desktop, (value) => value.current === launchpad.id);
    });

    run("一次横滑跨过多张应用屏", { timeout: 40000 }, async () => {
        const first = await launchMock(desktop, { appid: "gesture-a", width: 480, height: 360 });
        const second = await launchMock(desktop, { appid: "gesture-b", width: 480, height: 360 });
        await desktop.key("ArrowRight", { modifiers: META });
        const start = await waitState(desktop, (value) => value.current === first.screen);

        const gesture = await startFingerGesture(desktop);
        await gesture.move(-start.stage.width * 0.4, 0, 8);
        await gesture.end();

        const crossed = await waitState(desktop, (value) => currentScreen(value)?.empty === true);
        expect(crossed.current).not.toBe(first.screen);
        expect(crossed.current).not.toBe(second.screen);
    });

    run("到达最左/最右后继续滑不越界", { timeout: 30000 }, async () => {
        const initial = await state(desktop);
        const launchpad = initial.screens.find((screen) => screen.launchpad);
        expect(launchpad).toBeTruthy();
        if (!launchpad) return;

        await desktop.key("ArrowLeft", { modifiers: META });
        await waitState(desktop, (value) => value.current === launchpad.id);

        let gesture = await startFingerGesture(desktop);
        await gesture.move(-initial.stage.width * 0.4, 0, 8);
        await gesture.end();
        await sleep(200);
        expect((await state(desktop)).current, "启动台已经是最右").toBe(launchpad.id);

        gesture = await startFingerGesture(desktop);
        await gesture.move(initial.stage.width * 0.8, 0, 12);
        await gesture.end();
        const left = await waitState(desktop, (value) => value.current === initial.screens[0].id);
        expect(left.current).toBe(initial.screens[0].id);
    });

    run("纵轴：下滑进搜索，上滑进预览", { timeout: 30000 }, async () => {
        const initial = await state(desktop);
        let gesture = await startFingerGesture(desktop);
        await gesture.move(0, initial.stage.height * 0.3, 8);
        await gesture.end();
        const search = await waitState(
            desktop,
            (value) => value.launcher?.visible === true && value.launcher.binding.kind === "line",
            8000,
            "下滑打开搜索",
        );
        expect(search.overview).toBe(false);
        expect(search.launcher?.binding).toEqual({ kind: "line", level: -1 });

        gesture = await startFingerGesture(desktop);
        await gesture.move(0, -initial.stage.height * 0.5, 8);
        await gesture.end();
        const overview = await waitState(
            desktop,
            (value) => value.overview && value.launcher?.binding.kind === "line" && value.launcher.binding.level === 1,
            8000,
            "上滑进入预览",
        );
        expect(overview.launcher?.binding).toEqual({ kind: "line", level: 1 });
    });

    run("一次手势从搜索穿过常规进入预览，再滑回搜索", { timeout: 30000 }, async () => {
        const opened = await openSearch();
        let gesture = await startFingerGesture(desktop);
        await gesture.move(0, -opened.stage.height * 0.5, 8);
        await gesture.end();
        const overview = await waitState(desktop, (value) => value.overview, 8000, "搜索滑到预览");
        expect(overview.launcher?.binding).toEqual({ kind: "line", level: 1 });

        gesture = await startFingerGesture(desktop);
        await gesture.move(0, opened.stage.height * 0.5, 8);
        await gesture.end();
        const search = await waitState(
            desktop,
            (value) =>
                !value.overview && value.launcher?.binding.kind === "line" && value.launcher.binding.level === -1,
            8000,
            "预览滑回搜索",
        );
        expect(search.launcher?.visible).toBe(true);
    });

    run("预览横滑移动焦点，松手落到聚焦屏", { timeout: 40000 }, async () => {
        const first = await launchMock(desktop, { appid: "gesture-c", width: 480, height: 360 });
        const second = await launchMock(desktop, { appid: "gesture-d", width: 480, height: 360 });
        const entered = await enterOverview();
        await sleep(400);
        expect(entered.overviewFocus).toBe(second.screen);

        const gesture = await startFingerGesture(desktop);
        await gesture.move(entered.stage.width * 0.2, 0, 6);
        const mid = await gesture.state();
        expect(mid.gesture?.horizontalMode).toBe("overview");
        expect(mid.current).toBe(first.screen);
        expect(mid.overviewFocus).toBe(first.screen);

        await gesture.end();
        const settled = await waitState(desktop, (value) => value.current === first.screen);
        expect(settled.overview).toBe(true);
        expect(settled.overviewFocus).toBe(first.screen);
    });

    run("横轴在常规和预览之间切换作用对象", { timeout: 30000 }, async () => {
        const initial = await state(desktop);
        const gesture = await startFingerGesture(desktop);
        await gesture.move(-initial.stage.width * 0.05, 0, 4);
        let current = await gesture.state();
        expect(current.gesture?.horizontalMode).toBe("screens");
        expect(current.gesture?.level).toBe(0);

        await gesture.move(0, -initial.stage.height * 0.2, 6);
        current = await gesture.state();
        expect(current.gesture?.horizontalMode, "进入 grid 后横轴改为选窗").toBe("overview");

        await gesture.end();
        await waitState(desktop, (value) => value.overview);
    });

    run("四指滑动不改变桌面状态", { timeout: 30000 }, async () => {
        const before = await state(desktop);
        const gesture = await startFingerGesture(desktop, 4);
        await gesture.move(-before.stage.width * 0.2, -before.stage.height * 0.2, 8);
        await gesture.end();
        await sleep(200);

        const after = await state(desktop);
        expect(after.overview).toBe(false);
        expect(after.current).toBe(before.current);
        expect(after.screens.map((screen) => screen.id)).toEqual(before.screens.map((screen) => screen.id));
        expect(after.gesture).toBeUndefined();
        expect(after.windows).toEqual(before.windows);
    });
});
