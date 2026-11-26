import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../../src/test_runner/desktop_runner";
import { sleep } from "../../../../src/test_runner/process_utils";
import {
    closeWindow,
    currentScreen,
    type DesktopState,
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

const appScreens = (value: DesktopState) => value.screens.filter((screen) => !screen.empty && !screen.launchpad);

let desktop: DesktopRunner;

describe("虚拟屏与启动", () => {
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

    run("初始布局：空桌面在启动台左边", { timeout: 30000 }, async () => {
        const value = await state(desktop);
        expect(value.screens.length).toBe(2);
        expect(value.screens[0].empty).toBe(true);
        expect(value.screens[1].launchpad).toBe(true);
        expect(value.current).toBe(value.screens[0].id);
        expect(value.windows).toEqual([]);
    });

    run("最左和最右边界不会越界", { timeout: 30000 }, async () => {
        const initial = await state(desktop);
        const launchpad = initial.screens[1].id;

        await desktop.key("ArrowRight", { modifiers: META });
        expect(currentScreen(await state(desktop))?.id, "空桌面右边没有屏").toBe(initial.screens[0].id);

        await desktop.key("ArrowLeft", { modifiers: META });
        expect(currentScreen(await waitState(desktop, (value) => value.current === launchpad))?.launchpad).toBe(true);

        await desktop.key("ArrowLeft", { modifiers: META });
        expect(currentScreen(await state(desktop))?.id, "启动台已经是最右").toBe(launchpad);

        await desktop.key("ArrowRight", { modifiers: META });
        expect(currentScreen(await waitState(desktop, (value) => value.current === initial.screens[0].id))?.empty).toBe(
            true,
        );
    });

    run("空桌面启动应用：占用空桌面并补一张新的", { timeout: 30000 }, async () => {
        const win = await launchMock(desktop, { appid: "screen-a" });
        const value = await state(desktop);

        expect(value.screens.length).toBe(3);
        expect(value.screens[0].windows).toEqual([win.handle]);
        expect(value.screens[1].empty).toBe(true);
        expect(value.screens[2].launchpad).toBe(true);
        expect(value.current).toBe(win.screen);
        expect(appScreens(value).length).toBe(1);
    });

    run("从启动台启动应用：当前屏跳到应用屏，启动台仍在最右", { timeout: 30000 }, async () => {
        await desktop.key("ArrowLeft", { modifiers: META });
        await waitState(desktop, (value) => currentScreen(value)?.launchpad === true);

        const win = await launchMock(desktop, { appid: "screen-b" });
        const value = await state(desktop);
        expect(value.screens.at(-1)?.launchpad).toBe(true);
        expect(value.current).toBe(win.screen);
        expect(currentScreen(value)?.launchpad).toBe(false);
        expect(screenById(value, win.screen)?.windows).toEqual([win.handle]);
    });

    run("从最左应用屏启动新应用：仍然占最右空桌面", { timeout: 40000 }, async () => {
        const first = await launchMock(desktop, { appid: "screen-c" });
        const second = await launchMock(desktop, { appid: "screen-d" });

        await desktop.key("ArrowRight", { modifiers: META });
        await waitState(desktop, (value) => value.current === first.screen);

        const third = await launchMock(desktop, { appid: "screen-e" });
        const value = await state(desktop);
        expect(value.current).toBe(third.screen);
        expect(value.screens[0].id).toBe(first.screen);
        expect(value.screens[1].id).toBe(second.screen);
        expect(appScreens(value).map((screen) => screen.id)).toEqual([first.screen, second.screen, third.screen]);
        expect(value.screens.at(-2)?.empty).toBe(true);
        expect(value.screens.at(-1)?.launchpad).toBe(true);
    });

    run("关闭当前屏最后一个窗口：落到相邻虚拟屏并回收空屏", { timeout: 40000 }, async () => {
        const first = await launchMock(desktop, { appid: "screen-f" });
        const second = await launchMock(desktop, { appid: "screen-g" });

        await desktop.key("ArrowRight", { modifiers: META });
        await waitState(desktop, (value) => value.current === first.screen);

        await closeWindow(desktop, first.handle);
        const afterFirst = await waitState(
            desktop,
            (value) => !value.windows.some((win) => win.handle === first.handle),
        );
        expect(afterFirst.screens.some((screen) => screen.id === first.screen)).toBe(false);
        expect(afterFirst.current, "最左屏关掉后落到右边那张").toBe(second.screen);

        await closeWindow(desktop, second.handle);
        const afterSecond = await waitState(
            desktop,
            (value) => !value.windows.some((win) => win.handle === second.handle),
        );
        expect(afterSecond.screens.length).toBe(2);
        expect(afterSecond.screens[0].empty).toBe(true);
        expect(afterSecond.screens[1].launchpad).toBe(true);
        expect(afterSecond.current).toBe(afterSecond.screens[0].id);
    });

    run("关闭中间屏最后一个窗口：落到左邻，右屏不动", { timeout: 40000 }, async () => {
        const first = await launchMock(desktop, { appid: "screen-o" });
        const second = await launchMock(desktop, { appid: "screen-p" });
        const third = await launchMock(desktop, { appid: "screen-q" });

        await desktop.key("ArrowRight", { modifiers: META });
        await waitState(desktop, (value) => value.current === second.screen);

        await closeWindow(desktop, second.handle);
        const after = await waitState(
            desktop,
            (value) => !value.windows.some((win) => win.handle === second.handle) && value.current === first.screen,
        );
        expect(after.screens.some((screen) => screen.id === second.screen)).toBe(false);
        expect(after.screens.map((screen) => screen.id).slice(0, 2)).toEqual([first.screen, third.screen]);
        expect(screenById(after, third.screen)?.windows).toEqual([third.handle]);
    });

    run("Super+D 在空桌面和最近使用应用之间切换", { timeout: 40000 }, async () => {
        const emptyOnly = await state(desktop);
        await desktop.key("KeyD", { modifiers: META });
        await sleep(120);
        expect((await state(desktop)).current, "没有应用屏时 Super+D 不动").toBe(emptyOnly.current);

        const first = await launchMock(desktop, { appid: "screen-h" });
        const second = await launchMock(desktop, { appid: "screen-i" });
        const third = await launchMock(desktop, { appid: "screen-j" });
        expect((await state(desktop)).current).toBe(third.screen);

        await desktop.key("KeyD", { modifiers: META });
        const onEmpty = await waitState(desktop, (value) => currentScreen(value)?.empty === true);
        expect(onEmpty.current).not.toBe(third.screen);

        await desktop.key("KeyD", { modifiers: META });
        const back = await waitState(desktop, (value) => value.current === third.screen);
        expect(back.current).toBe(third.screen);
        expect(appScreens(back).map((screen) => screen.id)).toEqual([first.screen, second.screen, third.screen]);

        await desktop.key("ArrowLeft", { modifiers: META });
        await waitState(desktop, (value) => currentScreen(value)?.empty === true);
        await desktop.key("ArrowLeft", { modifiers: META });
        await waitState(desktop, (value) => currentScreen(value)?.launchpad === true);
        await desktop.key("KeyD", { modifiers: META });
        const fromLaunchpad = await waitState(desktop, (value) => currentScreen(value)?.empty === true);
        expect(fromLaunchpad.current).not.toBe(third.screen);
    });

    run("切屏缓冲：只记录最终停留屏，途经屏不改变顺序", { timeout: 40000 }, async () => {
        await desktop.evaluate("__mydeTest.setReorderDelay(300)");
        const first = await launchMock(desktop, { appid: "screen-k" });
        const second = await launchMock(desktop, { appid: "screen-l" });
        const third = await launchMock(desktop, { appid: "screen-m" });

        expect(appScreens(await state(desktop)).map((screen) => screen.id)).toEqual([
            first.screen,
            second.screen,
            third.screen,
        ]);

        await desktop.key("ArrowRight", { modifiers: META });
        await waitState(desktop, (value) => value.current === second.screen);
        await desktop.key("ArrowRight", { modifiers: META });
        await waitState(desktop, (value) => value.current === first.screen);

        await sleep(500);
        const reordered = await state(desktop);
        expect(appScreens(reordered).map((screen) => screen.id)).toEqual([second.screen, third.screen, first.screen]);
        expect(screenById(reordered, second.screen)?.used).toBeLessThan(screenById(reordered, third.screen)?.used ?? 0);
        expect(screenById(reordered, third.screen)?.used).toBeLessThan(screenById(reordered, first.screen)?.used ?? 0);

        await desktop.key("KeyD", { modifiers: META });
        await waitState(desktop, (value) => currentScreen(value)?.empty === true);
        await desktop.key("KeyD", { modifiers: META });
        await waitState(desktop, (value) => value.current === first.screen);
    });

    run("Super+F 全屏把窗口移到新屏，退出全屏留在该屏", { timeout: 30000 }, async () => {
        const win = await launchMock(desktop, { appid: "screen-n", width: 640, height: 420 });
        const before = await state(desktop);
        expect(appScreens(before).length).toBe(1);

        await desktop.key("KeyF", { modifiers: META });
        const fullscreen = await waitState(desktop, (value) => windowByAppid(value, "screen-n")?.fullscreen === true);
        const fullWin = windowByAppid(fullscreen, "screen-n");
        expect(fullWin).toBeTruthy();
        if (!fullWin) return;
        expect(fullWin.screen).not.toBe(win.screen);
        expect(fullscreen.current).toBe(fullWin.screen);
        expect(appScreens(fullscreen).length, "全屏换屏时回收原屏，不增加屏数").toBe(1);

        // 全屏铺满整块输出，不能按可用区（工具栏内缩）居中
        const fsSettled = await waitState(desktop, (value) => {
            const win = windowByAppid(value, "screen-n");
            return win?.fullscreen === true && !win.resizing;
        });
        const fsWin = windowByAppid(fsSettled, "screen-n");
        expect(fsWin?.rect?.x).toBe(0);
        expect(fsWin?.rect?.y).toBe(0);
        expect(fsWin?.rect?.w).toBe(fsSettled.stage.width);
        expect(fsWin?.rect?.h).toBe(fsSettled.stage.height);

        // 全屏画面停稳后工具栏隐藏
        await desktop.waitFor(
            `document.querySelector('[data-desktop-ui="tools"]')?.hasAttribute("data-fullscreen-toolbars") === true`,
            3000,
        );

        // 稍微进入全局预览：全屏被带偏，工具栏立即显示
        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => value.overview === true);
        await desktop.waitFor(
            `(() => {
                const el = document.querySelector('[data-desktop-ui="tools"]');
                return !!el && !el.hasAttribute("data-fullscreen-toolbars") && Number(getComputedStyle(el).opacity) > 0.9;
            })()`,
            3000,
        );

        // 退出预览、回到全屏屏并停稳后重新隐藏
        await desktop.key("Tab", { modifiers: META });
        await waitState(desktop, (value) => value.overview === false);
        await desktop.waitFor(
            `document.querySelector('[data-desktop-ui="tools"]')?.hasAttribute("data-fullscreen-toolbars") === true`,
            3000,
        );

        // 触控板只是稍微往上滑、还没松手：overviewProgress 已经大于 0，工具栏应立即显示
        const gestureState = await state(desktop);
        const gesture = await startFingerGesture(desktop);
        await gesture.move(0, -gestureState.stage.height * 0.08, 4);
        await desktop.waitFor(
            `(() => {
                const el = document.querySelector('[data-desktop-ui="tools"]');
                return !!el && !el.hasAttribute("data-fullscreen-toolbars") && Number(getComputedStyle(el).opacity) > 0.5;
            })()`,
            1500,
        );
        await gesture.end();
        await waitState(desktop, (value) => value.overview === false);
        await desktop.waitFor(
            `document.querySelector('[data-desktop-ui="tools"]')?.hasAttribute("data-fullscreen-toolbars") === true`,
            3000,
        );

        await desktop.key("KeyF", { modifiers: META });
        const restored = await waitState(desktop, (value) => windowByAppid(value, "screen-n")?.fullscreen === false);
        expect(windowByAppid(restored, "screen-n")?.screen).toBe(fullWin.screen);
    });
});
