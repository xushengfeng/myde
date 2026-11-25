import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../src/test_runner/desktop_runner";
import { getProjectRoot } from "../../../src/test_runner/test_runner";

const entry = path.join(__dirname, "../dist/index.js");
const mockApp = path.join(getProjectRoot(), "test/simple_app/target/debug/window_open");
const hasBuild = fs.existsSync(entry) && fs.existsSync(mockApp);
const run = hasBuild ? it : it.skip;

type ScreenState = {
    id: string;
    windows: string[];
    empty: boolean;
    launchpad: boolean;
    current: boolean;
};

type DesktopState = {
    screens: ScreenState[];
    current: string;
    focus: string | undefined;
    launcher?: { visible: boolean; focused: boolean };
    windows: { handle: string; screen: string; appid: string }[];
};

let desktop: DesktopRunner;

const state = () => desktop.evaluate<DesktopState>("__mydeTest.state()");

/** 假应用：exec 指向可控制的 mock 客户端，点启动时走真实的启动动画和 Wayland 窗口链路 */
const apps = () => [
    {
        name: "Mock Editor",
        nameLocal: "Mock Editor",
        comment: "",
        commentLocal: "",
        icon: "",
        exec: mockApp,
        env: { APP_ID: "mock-editor", LIFETIME_MS: "60000", WIDTH: "640", HEIGHT: "420" },
        desktopFile: "mock-editor",
    },
    {
        name: "Mock Terminal",
        nameLocal: "Mock Terminal",
        comment: "",
        commentLocal: "",
        icon: "",
        exec: mockApp,
        env: { APP_ID: "mock-terminal", LIFETIME_MS: "60000", WIDTH: "800", HEIGHT: "600" },
        desktopFile: "mock-terminal",
    },
];

describe("mock 应用", () => {
    beforeAll(async () => {
        desktop = await startDesktopRunner({ desktop: "desktop/official", timeout: 60000, showWindow: true });
        await desktop.waitFor("document.documentElement.dataset.desktopReady === '1'", 60000);
    });

    afterAll(async () => {
        if (desktop) await desktop.close();
    });

    run("假应用列表进入启动台和搜索，点击后打开 mock 窗口", { timeout: 60000 }, async () => {
        await desktop.evaluate(`__mydeTest.setApps(${JSON.stringify(apps())})`);
        await desktop.waitFor(
            `document.querySelector("[data-desktop-ui='launchpad']")?.textContent.includes("Mock Editor")`,
            10000,
        );
        const launchpad = await desktop.evaluate<string>(
            `document.querySelector("[data-desktop-ui='launchpad']")?.textContent ?? ""`,
        );
        expect(launchpad).toContain("Mock Terminal");

        await desktop.key("Space", { modifiers: 1 });
        await desktop.waitFor("__mydeTest.state().launcher?.focused === true", 10000);
        await desktop.text("mock editor");
        await desktop.waitFor(
            `document.querySelector("[data-launcher-input]")?.textContent.includes("Mock Editor")`,
            10000,
        );

        // 走真实结果：启动动画、窗口创建、appid 认领、占空桌面并补一张新的空桌面
        await desktop.key("Enter");
        await desktop.waitFor(`document.querySelectorAll("[data-client-frame]").length === 1`, 15000);
        await desktop.waitFor("__mydeTest.state().focus !== undefined", 15000);

        const opened = await state();
        const occupied = opened.screens.filter((screen) => screen.windows.length > 0);
        expect(occupied.length, "窗口应该只占一张虚拟屏").toBe(1);
        expect(occupied[0].windows.length).toBe(1);
        expect(opened.focus).toBe(occupied[0].windows[0]);
        expect(opened.screens.length, "应用屏 + 补出来的空桌面 + 启动台").toBe(3);
        expect(opened.screens.filter((screen) => screen.empty).length).toBe(1);
        expect(
            opened.windows.map((win) => win.appid),
            "应该是假应用启动的 mock 窗口",
        ).toEqual(["mock-editor"]);

        await desktop.evaluate("__mydeTest.closeWindows(); __mydeTest.closeLaunchPanels();");
        try {
            await desktop.waitFor("__mydeTest.state().screens.length === 2", 1500);
        } catch {
            await desktop.evaluate("__mydeTest.forceCloseWindows(); __mydeTest.closeLaunchPanels();");
            await desktop.waitFor("__mydeTest.state().screens.length === 2", 3000);
        }
        const closed = await state();
        expect(closed.screens.some((screen) => screen.windows.length > 0)).toBe(false);
    });
});
