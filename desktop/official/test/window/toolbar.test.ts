import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../../src/test_runner/desktop_runner";
import { sleep } from "../../../../src/test_runner/process_utils";
import { currentScreen, resetDesktop, waitState } from "./helpers";

const entry = path.join(__dirname, "../../dist/index.js");
const hasBuild = fs.existsSync(entry);
const run = hasBuild ? it : it.skip;

let desktop: DesktopRunner;

/** 模拟一次真实点击：先 pointerdown（会走“点击外部收起搜索栏”），再 click */
const clickTool = (tool: string) =>
    desktop.evaluate(`(() => {
        const el = document.querySelector('[data-tool=${JSON.stringify(tool)}]');
        if (!el) return false;
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, button: 0 }));
        el.click();
        return true;
    })()`);

/** 在工具栏按钮上滚轮 */
const wheelTool = (tool: string, deltaY: number) =>
    desktop.evaluate(`(() => {
        const el = document.querySelector('[data-tool=${JSON.stringify(tool)}]');
        if (!el) return false;
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: ${deltaY}, bubbles: true, cancelable: true }));
        return true;
    })()`);

describe("顶部工具栏", () => {
    beforeAll(async () => {
        desktop = await startDesktopRunner({ desktop: "desktop/official", timeout: 60000, showWindow: true });
        await desktop.waitFor("document.documentElement.dataset.desktopReady === '1'", 60000);
    });

    afterAll(async () => {
        if (desktop) await desktop.close();
    });

    run("全局预览按钮滚轮切换虚拟屏", { timeout: 60000 }, async () => {
        await resetDesktop(desktop);

        await wheelTool("overview", 120);
        await waitState(desktop, (value) => currentScreen(value)?.launchpad === true, 5000, "滚轮切到启动台");
        await sleep(150);
        await wheelTool("overview", -120);
        await waitState(desktop, (value) => currentScreen(value)?.empty === true, 5000, "滚轮切回空桌面");
    });

    run("Super+滚轮切换虚拟屏", { timeout: 60000 }, async () => {
        await resetDesktop(desktop);
        const meta = {
            key: "Meta",
            code: "MetaLeft",
            windowsVirtualKeyCode: 91,
            nativeVirtualKeyCode: 91,
        };
        await desktop.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...meta, modifiers: 4 });
        // 避开上一个用例滚轮留下的 120ms 节流
        await sleep(150);
        try {
            await desktop.send("Input.dispatchMouseEvent", {
                type: "mouseWheel",
                x: 600,
                y: 300,
                deltaX: 0,
                deltaY: 120,
                modifiers: 4,
            });
            await waitState(desktop, (value) => currentScreen(value)?.launchpad === true, 5000, "Super+滚轮切到启动台");
            await sleep(150);
            await desktop.send("Input.dispatchMouseEvent", {
                type: "mouseWheel",
                x: 600,
                y: 300,
                deltaX: 0,
                deltaY: -120,
                modifiers: 4,
            });
            await waitState(desktop, (value) => currentScreen(value)?.empty === true, 5000, "Super+滚轮切回空桌面");
        } finally {
            await desktop.send("Input.dispatchKeyEvent", { type: "keyUp", ...meta, modifiers: 0 });
        }
    });

    run("搜索按钮开关搜索栏，启动台按钮切到启动台", { timeout: 60000 }, async () => {
        await resetDesktop(desktop);

        await clickTool("search");
        await waitState(
            desktop,
            (value) => value.launcher?.visible === true && value.launcher.focused === true,
            5000,
            "打开搜索栏",
        );
        // 搜索栏已经显示时，再点一次搜索按钮收起；pointerdown 不能被“点击外部隐藏”提前关掉
        await clickTool("search");
        await waitState(desktop, (value) => value.launcher?.visible === false, 5000, "收起搜索栏");

        await clickTool("launchpad");
        await waitState(desktop, (next) => currentScreen(next)?.launchpad === true, 5000, "切换到启动台");
    });
});
