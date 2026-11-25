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

describe("交互打断", () => {
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

    run("切屏动画中途反向，最终落在最后按下的屏", { timeout: 30000 }, async () => {
        const first = await launchMock(desktop, { appid: "interrupt-a", width: 480, height: 360 });
        const second = await launchMock(desktop, { appid: "interrupt-b", width: 480, height: 360 });
        expect((await state(desktop)).current).toBe(second.screen);
        const screensBefore = (await state(desktop)).screens.map((screen) => screen.id);

        await desktop.key("ArrowRight", { modifiers: META });
        await sleep(90);
        await desktop.key("ArrowLeft", { modifiers: META });

        const settled = await waitState(desktop, (value) => value.current === second.screen);
        expect(settled.screens.map((screen) => screen.id)).toEqual(screensBefore);
        expect(settled.windows.length).toBe(2);
    });

    run("切屏动画没结束就起手势：以当前屏为基准，结束后不回跳", { timeout: 30000 }, async () => {
        const first = await launchMock(desktop, { appid: "interrupt-c", width: 480, height: 360 });
        const second = await launchMock(desktop, { appid: "interrupt-d", width: 480, height: 360 });

        await desktop.key("ArrowRight", { modifiers: META });
        await sleep(30);
        const before = await state(desktop);
        expect(before.current).toBe(first.screen);

        const gesture = await startFingerGesture(desktop);
        await gesture.move(-before.stage.width * 0.08, 0, 4);
        await gesture.end();

        const settled = await waitState(desktop, (value) => value.current === first.screen);
        expect(settled.gesture).toBeUndefined();
        expect(settled.windows.some((win) => win.handle === second.handle)).toBe(true);
    });

    run("手势横滑中途反向，松手回到起点屏", { timeout: 30000 }, async () => {
        const first = await launchMock(desktop, { appid: "interrupt-e", width: 480, height: 360 });
        const second = await launchMock(desktop, { appid: "interrupt-f", width: 480, height: 360 });
        expect((await state(desktop)).current).toBe(second.screen);

        const gesture = await startFingerGesture(desktop);
        const size = (await state(desktop)).stage;
        await gesture.move(size.width * 0.1, 0, 4);
        await gesture.move(-size.width * 0.15, 0, 4);
        await gesture.end();

        const settled = await waitState(desktop, (value) => value.current === second.screen);
        expect(settled.current).toBe(second.screen);
        expect(settled.screens.some((screen) => screen.id === first.screen)).toBe(true);
    });

    run("手势中途按 Super+Tab：取消手势并进入预览", { timeout: 30000 }, async () => {
        const before = await state(desktop);
        const gesture = await startFingerGesture(desktop);
        await gesture.move(0, -before.stage.height * 0.15, 4);
        expect((await gesture.state()).gesture).toBeTruthy();

        await desktop.key("Tab", { modifiers: META });
        const cancelled = await waitState(desktop, (value) => value.gesture === undefined && value.overview);
        expect(cancelled.current).toBe(before.current);

        // 抬起手指不应再改变状态
        await gesture.end();
        const after = await waitState(
            desktop,
            (value) =>
                value.gesture === undefined &&
                value.launcher?.binding.kind === "line" &&
                value.launcher.binding.level === 1,
        );
        expect(after.overview).toBe(true);
        expect(after.current).toBe(before.current);
    });

    run("手势中途启动应用：退出预览并落到新窗口所在屏", { timeout: 40000 }, async () => {
        const before = await state(desktop);
        const gesture = await startFingerGesture(desktop);
        await gesture.move(0, -before.stage.height * 0.1, 4);

        const win = await launchMock(desktop, { appid: "interrupt-g", width: 480, height: 360 });
        const launched = await waitState(desktop, (value) => !value.overview && value.current === win.screen);
        expect(launched.gesture).toBeUndefined();

        await gesture.end();
        const after = await state(desktop);
        expect(after.current).toBe(win.screen);
        expect(after.overview).toBe(false);
        expect(after.gesture).toBeUndefined();
    });

    run("预览快速进入再退出，不残留状态", { timeout: 30000 }, async () => {
        const before = await state(desktop);
        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => value.overview);
        await desktop.key("Tab", { modifiers: META });
        const exited = await waitState(
            desktop,
            (value) => !value.overview && value.launcher?.binding.kind === "line" && value.launcher.binding.level === 0,
        );
        expect(exited.current).toBe(before.current);

        await enterOverview();
        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => !value.overview);
    });

    run("手势松手后立刻起第二次手势：从上次结果继续", { timeout: 30000 }, async () => {
        const size = (await state(desktop)).stage;
        const first = await startFingerGesture(desktop);
        await first.move(0, -size.height * 0.5, 8);
        await first.end();
        const overview = await waitState(
            desktop,
            (value) => value.overview && value.launcher?.binding.kind === "line" && value.launcher.binding.level === 1,
            8000,
            "第一次手势进入预览",
        );

        const second = await startFingerGesture(desktop);
        await second.move(0, size.height * 0.5, 8);
        await second.end();

        const search = await waitState(
            desktop,
            (value) =>
                !value.overview && value.launcher?.binding.kind === "line" && value.launcher.binding.level === -1,
            8000,
            "第二次手势滑到搜索",
        );
        expect(search.current).toBe(overview.current);
        expect(search.launcher?.visible).toBe(true);
    });

    run("预览退出动画没结束就重新进入，最终状态正确", { timeout: 30000 }, async () => {
        const before = await state(desktop);
        await enterOverview();
        await desktop.key("Escape");
        await desktop.key("Escape");
        await desktop.key("Tab", { modifiers: META });

        const reopened = await waitState(
            desktop,
            (value) => value.overview && value.launcher?.binding.kind === "line" && value.launcher.binding.level === 1,
        );
        expect(reopened.current).toBe(before.current);
        expect(reopened.gesture).toBeUndefined();

        await desktop.key("Tab", { modifiers: META });
        const closed = await waitState(desktop, (value) => !value.overview);
        expect(closed.gesture).toBeUndefined();
    });
});
