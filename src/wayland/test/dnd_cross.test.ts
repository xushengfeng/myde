import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { collectAppLogs } from "../../test_runner/applog";
import { testRunnerApp } from "../../test_runner/test_runner";
import type { DragStartInfo } from "../../wayland";

declare const ipcRenderer: { send(channel: string, data: unknown): void };

/**
 * 跨客户端拖拽：A 里选中文字拖出，桌面（测试脚本）用 `dnd.move/drop` 指到 B 的窗口，
 * B 的 drop 处理器应该拿到同一段文字。
 */
describe("cross-client dnd", () => {
    it("drag text from client A to client B", { timeout: 40000 }, async () => {
        const sourceJs = `
module.exports = ({ createWindow }) => {
    createWindow({ js: __filename, width: 640, height: 480, frame: false });
};
if (typeof document !== "undefined") {
    document.title = "dnd-source";
    document.body.innerHTML =
        '<textarea id="ta" style="position:absolute;inset:0;font:20px monospace;line-height:28px;padding:20px;border:0;outline:0">' +
        'abcdefghijklmnopqrstuvwxyz0123456789\\nABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\\nabcdefghijklmnopqrstuvwxyz0123456789</textarea>';
}
`;
        const targetJs = `
module.exports = ({ createWindow }) => {
    createWindow({ js: __filename, width: 480, height: 360, frame: false });
};
if (typeof document !== "undefined") {
    document.title = "dnd-target";
    document.body.innerHTML = '<div id="drop" style="position:absolute;inset:0;background:#eee"></div>';
    const log = (o) => console.log(JSON.stringify(o));
    const onOver = (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e) => {
        e.preventDefault();
        log({ type: "drop", text: e.dataTransfer?.getData("text/plain") ?? "" });
    };
    document.addEventListener("dragover", onOver);
    document.addEventListener("drop", onDrop);
}
`;
        const srcfile = `/tmp/myde_dnd_src_${Date.now()}.js`;
        const dstfile = "/tmp/myde_dnd_target.js";
        fs.writeFileSync(srcfile, sourceJs);
        fs.writeFileSync(dstfile, targetJs);

        const { waitExit } = testRunnerApp(
            `test/electron_app/start.js ${srcfile}`,
            async ({ server, serverX, runner }) => {
                const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
                let drag: DragStartInfo | undefined;
                server.on("dnd.started", (d) => {
                    drag = d;
                });

                const waitWindow = async (title: string) => {
                    for (let i = 0; i < 200; i++) {
                        const info = server.windows.list().find((w) => w.title === title);
                        if (info) return info;
                        await sleep(50);
                    }
                    throw new Error(`window ${title} not found`);
                };

                try {
                    const src = await waitWindow("dnd-source");
                    for (let i = 0; i < 200 && (server.windows.preview(src.handle)?.width ?? 0) <= 1; i++)
                        await sleep(50);
                    await sleep(300);
                    server.notify("window.focus", src.handle);
                    const move = (x: number, y: number) =>
                        server.notify("input.pointer", src.handle, { type: "move", x, y, button: 0 });
                    const down = (x: number, y: number) =>
                        server.notify("input.pointer", src.handle, { type: "down", x, y, button: 0 });
                    const up = (x: number, y: number) =>
                        server.notify("input.pointer", src.handle, { type: "up", x, y, button: 0 });

                    // 1. 先把一段文字选中
                    move(100, 100);
                    await sleep(60);
                    down(100, 100);
                    await sleep(60);
                    for (const x of [140, 180, 220, 260, 300]) {
                        move(x, 100);
                        await sleep(60);
                    }
                    up(300, 100);
                    await sleep(400);

                    // 2. 在选区上按下拖动，Chromium 进入 DnD
                    move(200, 100);
                    await sleep(60);
                    down(200, 100);
                    await sleep(60);
                    for (const x of [180, 160, 140]) {
                        move(x, 100);
                        await sleep(80);
                    }
                    for (let i = 0; i < 60 && !drag; i++) await sleep(50);
                    if (!drag) throw new Error("no dnd.started");

                    // 3. 拖拽进行中再启动 B，桌面对准 B 的窗口放下
                    const targetApp = serverX.runApp(
                        `${process.cwd()}/test/electron_app/start.js /tmp/myde_dnd_target.js`,
                    );
                    targetApp.stdout?.on("data", (data) =>
                        ipcRenderer.send("test", { type: "applog", data: data.toString() }),
                    );
                    targetApp.stderr?.on("data", (data) =>
                        ipcRenderer.send("test", { type: "applog", data: data.toString() }),
                    );
                    const dst = await waitWindow("dnd-target");
                    for (let i = 0; i < 200 && (server.windows.preview(dst.handle)?.width ?? 0) <= 1; i++)
                        await sleep(50);
                    await sleep(300);
                    server.notify("window.focus", dst.handle);
                    await sleep(200);

                    server.notify("dnd.move", drag.token, { handle: dst.handle, x: 100, y: 100 });
                    await sleep(500);
                    server.notify("dnd.move", drag.token, { handle: dst.handle, x: 130, y: 120 });
                    await sleep(500);
                    server.notify("dnd.drop", drag.token, { handle: dst.handle, x: 130, y: 120 });
                    await sleep(1500);

                    runner.sendData({ ok: true });
                } catch (e) {
                    runner.sendData({ error: String(e) });
                } finally {
                    runner.kill();
                }
            },
        );

        const raw = (await waitExit()) as any[];
        expect(
            raw.find((r) => r.error),
            JSON.stringify(raw).slice(0, 1000),
        ).toBeUndefined();
        const logs = collectAppLogs(raw);
        const drop = logs.find(
            (l): l is { type: "drop"; text: string } =>
                typeof l === "object" && l !== null && (l as any).type === "drop",
        );
        expect(drop, `B 没收到 drop，raw=${JSON.stringify(raw).slice(0, 1200)}`).toBeDefined();
        expect(drop?.text.length ?? 0).toBeGreaterThan(0);
    });
});
