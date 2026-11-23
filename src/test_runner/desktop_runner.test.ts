import { describe, expect, it } from "vitest";
import { startDesktopRunner, testRunnerDesktop } from "./desktop_runner";

describe("desktop runner", () => {
    it("内置测试桌面：CDP 求值、截图、输入、日志", { timeout: 60000 }, async () => {
        const desktop = await startDesktopRunner({ desktop: ":test", timeout: 30000 });
        try {
            await desktop.waitFor("!!document.body");
            const shot = await desktop.screenshot();
            expect(shot.length).toBeGreaterThan(100);

            await desktop.evaluate(`
                document.title = "before";
                const button = document.createElement("button");
                button.id = "cdp-probe-button";
                button.textContent = "click";
                button.style.cssText = "position:fixed;left:0;top:0;width:100px;height:60px;z-index:2147483647";
                button.onclick = () => { document.title = "clicked"; };
                const input = document.createElement("input");
                input.id = "cdp-probe-input";
                input.style.cssText =
                    "position:fixed;left:120px;top:0;width:200px;height:40px;z-index:2147483647";
                document.body.append(button, input);
            `);
            await desktop.waitFor("!!document.getElementById('cdp-probe-button')");

            await desktop.click(30, 30);
            expect(await desktop.evaluate("document.title")).toBe("clicked");

            await desktop.click(150, 20);
            await desktop.text("hello");
            expect(await desktop.evaluate("document.getElementById('cdp-probe-input').value")).toBe("hello");

            expect(Array.isArray(desktop.logs())).toBe(true);
        } finally {
            await desktop.close();
            await desktop.close();
        }
    });

    it("testRunnerDesktop 在失败时也关闭", { timeout: 60000 }, async () => {
        await expect(
            testRunnerDesktop(
                async (desktop) => {
                    await desktop.waitFor("false", 300);
                },
                { desktop: ":test", timeout: 30000 },
            ),
        ).rejects.toThrow(/等待页面条件超时/);
    });
});
