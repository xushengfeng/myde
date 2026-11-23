import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { startDesktopRunner } from "../../../src/test_runner/desktop_runner";

const entry = path.join(__dirname, "../dist/index.js");
const hasBuild = fs.existsSync(entry);
const run = hasBuild ? it : it.skip;

describe("official desktop (e2e)", () => {
    run("在私有 headless 显示里加载、截图、读取日志", { timeout: 120000 }, async () => {
        const desktop = await startDesktopRunner({ desktop: "desktop/official", timeout: 60000 });
        try {
            await desktop.waitFor("document.body.children.length > 2", 60000);
            expect(await desktop.evaluate("document.title")).toBe("myde");

            const shot = await desktop.screenshot();
            expect(shot.length).toBeGreaterThan(1000);

            const logs = desktop.logs().join("\n");
            expect(logs).toContain("Wayland server listening");
        } finally {
            await desktop.close();
        }
    });
});
