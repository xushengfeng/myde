import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../../src/test_runner/desktop_runner";
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

describe("顶部工具栏", () => {
    beforeAll(async () => {
        desktop = await startDesktopRunner({ desktop: "desktop/official", timeout: 60000, showWindow: true });
        await desktop.waitFor("document.documentElement.dataset.desktopReady === '1'", 60000);
    });

    afterAll(async () => {
        if (desktop) await desktop.close();
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
