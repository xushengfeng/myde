import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../../src/test_runner/desktop_runner";

const entry = path.join(__dirname, "../../dist/index.js");
const hasBuild = fs.existsSync(entry);
const run = hasBuild ? it : it.skip;
const META = 4;

let desktop: DesktopRunner;

type LockState = { state?: string; sub?: string; password: string };

const lockState = () => desktop.evaluate<LockState>("__mydeTest.lock()");
const waitSub = (sub: LockState["sub"], timeout = 5000) =>
    desktop.waitFor(`__mydeTest.lock().sub === ${JSON.stringify(sub)}`, timeout);

describe("锁屏键盘", () => {
    beforeAll(async () => {
        desktop = await startDesktopRunner({ desktop: "desktop/official", timeout: 60000, showWindow: true });
        await desktop.waitFor("document.documentElement.dataset.desktopReady === '1'", 60000);
    });

    afterAll(async () => {
        if (desktop) await desktop.close();
    });

    run("时钟界面 Enter 进密码、其它键直接输入，Esc 逐级退到熄屏", { timeout: 60000 }, async () => {
        await desktop.key("l", { modifiers: META });
        await waitSub("lock");
        expect((await lockState()).state).toBe("lock");

        // 时钟界面 Esc 熄屏
        await desktop.key("Escape");
        await waitSub("xipin");

        // 熄屏时任意键只唤醒回时钟界面，不进入密码
        await desktop.key("Escape");
        await waitSub("lock");
        expect((await lockState()).sub).toBe("lock");

        // Enter 进入密码界面，密码为空
        await desktop.key("Enter");
        await waitSub("passwd");
        expect((await lockState()).password).toBe("");

        // 密码界面 Esc 回时钟界面
        await desktop.key("Escape");
        await waitSub("lock");

        // 非 Enter 键直接进入密码界面并输入该字符
        await desktop.key("a");
        await waitSub("passwd");
        expect((await lockState()).password).toBe("a");
        await desktop.key("b");
        await desktop.waitFor("__mydeTest.lock().password === 'ab'", 5000);

        // 回时钟时清空密码，再进入从头输入
        await desktop.key("Escape");
        await waitSub("lock");
        expect((await lockState()).password).toBe("");
        await desktop.key("Enter");
        await waitSub("passwd");
        expect((await lockState()).password).toBe("");
        await desktop.key("c");
        await desktop.waitFor("__mydeTest.lock().password === 'c'", 5000);
    });
});
