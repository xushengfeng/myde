import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../../src/test_runner/desktop_runner";
import { sleep } from "../../../../src/test_runner/process_utils";
import { mockAppPath, resetDesktop } from "./helpers";

const entry = path.join(__dirname, "../../dist/index.js");
const hasBuild = fs.existsSync(entry) && fs.existsSync(mockAppPath());
const run = hasBuild ? it : it.skip;

let desktop: DesktopRunner;

/** 面板是否已经嵌进虚拟屏，以及当前屏是否还在滑动 */
const sample = () =>
    desktop.evaluate<{ panel: boolean; inScreen: boolean; moving: boolean }>(`(() => {
        const panel = document.querySelector("[data-desktop-ui='launch-panel']");
        const state = __mydeTest.state();
        const current = state.screens.find((screen) => screen.current);
        return {
            panel: !!panel,
            inScreen: !!panel?.closest("[data-view-id]"),
            moving:
                !!current &&
                (Math.abs(current.visual.x - current.target.x) > 0.5 ||
                    Math.abs(current.visual.scale - current.target.scale) > 0.001),
        };
    })()`);

describe("应用启动嵌入", () => {
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

    run("虚拟屏滑动停稳前面板不嵌入", { timeout: 30000 }, async () => {
        // 窗口晚点建，保证面板嵌入后还有足够时间采样
        const createAt = Date.now() + 2000;
        await desktop.evaluate(`
            __mydeTest.launchApp({
                exec: ${JSON.stringify(mockAppPath())},
                name: "launch-probe",
                appid: "launch-probe",
                sourceRect: { left: 600, top: 400, width: 64, height: 64 },
                env: {
                    APP_ID: "launch-probe",
                    LIFETIME_MS: "60000",
                    WIDTH: "640",
                    HEIGHT: "420",
                    CREATE_AT: String(${createAt}),
                },
            })
        `);

        const samples: { panel: boolean; inScreen: boolean; moving: boolean }[] = [];
        const started = Date.now();
        while (Date.now() - started < 1400) {
            const value = await sample();
            samples.push(value);
            if (value.panel && value.inScreen) break;
            await sleep(16);
        }

        expect(
            samples.some((value) => value.panel),
            "启动面板应该出现",
        ).toBe(true);
        expect(
            samples.some((value) => value.panel && !value.inScreen && value.moving),
            "屏还在滑动时面板应该留在屏外",
        ).toBe(true);
        const embedded = samples.find((value) => value.panel && value.inScreen);
        expect(embedded, "面板最终应该嵌入虚拟屏").toBeTruthy();
        expect(embedded?.moving, "嵌入时虚拟屏应该已经停稳").toBe(false);

        await desktop.evaluate("__mydeTest.closeWindows(); __mydeTest.closeLaunchPanels();");
    });
});
