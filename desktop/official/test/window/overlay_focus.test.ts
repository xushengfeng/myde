import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../../src/test_runner/desktop_runner";
import { launchMock, mockAppPath, resetDesktop, startFingerGesture, state, waitState } from "./helpers";

const entry = path.join(__dirname, "../../dist/index.js");
const hasBuild = fs.existsSync(entry) && fs.existsSync(mockAppPath());
const run = hasBuild ? it : it.skip;
const META = 4;
const ALT = 1;

let desktop: DesktopRunner;

/**
 * 搜索栏/总览接管键盘时客户端必须失焦（core 在 leave 前补 release），退出后再把焦点还回来。
 * 这里只看桌面侧下发的焦点，客户端是否收到 keyup 由 wayland 的 keyboard 测试覆盖。
 */
describe("桌面模式焦点", () => {
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

    run("进入总览/搜索栏时失焦，退出后焦点还给原窗口", { timeout: 30000 }, async () => {
        const win = await launchMock(desktop, { appid: "tmp.overlay-focus" });
        expect((await state(desktop)).focus).toBe(win.handle);

        // 总览完全展开、搜索栏拿到输入焦点后，客户端失焦
        await desktop.key("Tab", { modifiers: META });
        await waitState(
            desktop,
            (value) => value.overview && value.launcher?.focused === true && value.focus === undefined,
            8000,
            "总览收起客户端焦点",
        );
        // 退出总览回到常规，焦点还给原窗口
        await desktop.key("Tab", { modifiers: META });
        await waitState(
            desktop,
            (value) => !value.overview && value.launcher?.visible === false && value.focus === win.handle,
            8000,
            "总览退出后恢复客户端焦点",
        );

        // 搜索栏单独打开/关闭走同一套
        await desktop.key("Space", { modifiers: ALT });
        await waitState(
            desktop,
            (value) => value.launcher?.focused === true && value.focus === undefined,
            8000,
            "搜索栏收起客户端焦点",
        );
        await desktop.key("Escape");
        await waitState(
            desktop,
            (value) => value.launcher?.visible === false && value.focus === win.handle,
            8000,
            "搜索栏关闭后恢复客户端焦点",
        );
    });

    run("总览横滑选屏只改选择，退出后焦点落到该屏的窗口", { timeout: 30000 }, async () => {
        const first = await launchMock(desktop, { appid: "tmp.overlay-first" });
        const second = await launchMock(desktop, { appid: "tmp.overlay-second" });
        expect((await state(desktop)).current).toBe(second.screen);

        await desktop.key("Tab", { modifiers: META });
        await waitState(
            desktop,
            (value) => value.overview && value.launcher?.focused === true && value.focus === undefined,
            8000,
            "总览收起客户端焦点",
        );

        const gesture = await startFingerGesture(desktop);
        await gesture.move((await state(desktop)).stage.width * 0.2, 0, 6);
        await gesture.end();
        const selected = await waitState(
            desktop,
            (value) => value.overview && value.current === first.screen,
            8000,
            "横滑选中另一屏",
        );
        expect(selected.focus, "总览完全展开时横滑只改选择").toBeUndefined();

        await desktop.key("Tab", { modifiers: META });
        await waitState(
            desktop,
            (value) => !value.overview && value.launcher?.visible === false && value.focus === first.handle,
            8000,
            "退出总览后聚焦选中屏的窗口",
        );
    });
});
