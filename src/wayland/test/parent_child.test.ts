import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { testRunnerApp } from "../../test_runner/test_runner";

describe("parent child", () => {
    it("临时子窗口：set_parent 后 ServerEvents 里带父窗口 handle，关父窗口后子窗口被清理", {
        timeout: 40000,
    }, async () => {
        // 同一个文件既是 electron 主进程脚本，又是渲染进程脚本
        const appJs = `
module.exports = ({ createWindow }) => {
    const parent = createWindow({ js: __filename, width: 640, height: 480 });
    // Chromium 在窗口映射前后发 set_parent；留出首个窗口就绪的时间
    setTimeout(() => {
        try { createWindow({ js: __filename, width: 320, height: 200, parent }); } catch (e) {}
    }, 2500);
};
if (typeof document !== "undefined") {
    document.title = "myde-parent-child-test";
    document.body.innerHTML = '<div style="width:100%;height:100%;background:#00ff00"></div>';
}
`;
        const tmpfile = `/tmp/myde_parent_child_${Date.now()}.js`;
        fs.writeFileSync(tmpfile, appJs);

        const { waitExit } = testRunnerApp(`test/electron_app/start.js ${tmpfile}`, ({ server, runner }) => {
            // biome-ignore lint/suspicious/noExplicitAny: 端到端快照
            const s: any = { windows: [], parentChanges: 0 };
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                runner.sendData({ summary: s });
                runner.kill();
            };
            const watch = setTimeout(finish, 12000);
            const maybeFinish = () => {
                if (s.windows.length < 2) return;
                const first = s.windows[0];
                const second = s.windows[1];
                if (second.parent !== first.handle) return;
                clearTimeout(watch);
                // 父窗口关闭后子窗口不能继续挂在已死的 handle 上
                server.notify("window.close", first.handle);
                setTimeout(() => {
                    s.windows = server.windows.list().map((w) => ({ handle: w.handle, parent: w.parent }));
                    finish();
                }, 1500);
            };
            server.on("window.created", (info) => {
                s.windows.push({ handle: info.handle, parent: info.parent });
                maybeFinish();
            });
            server.on("window.changed", (info) => {
                const i = s.windows.findIndex((w: { handle: string }) => w.handle === info.handle);
                if (i >= 0) {
                    s.windows[i].parent = info.parent;
                }
                s.parentChanges++;
                maybeFinish();
            });
            server.on("window.closed", maybeFinish);
        });

        const result = (await waitExit()) as { summary?: unknown }[];
        const summary = result.find((r) => r.summary)?.summary as
            | { windows: { handle: string; parent: string | null }[]; parentChanges: number }
            | undefined;
        expect(summary, `未收到 summary，实际: ${JSON.stringify(result).slice(0, 500)}`).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: 上一行已断言
        const s = summary!;
        expect(s.windows.length).toBeGreaterThanOrEqual(2);
        expect(s.parentChanges).toBeGreaterThan(0);
        // 关掉父窗口 1.5s 后：不能有窗口还把父 handle 当成 parent
        const handles = new Set(s.windows.map((w) => w.handle));
        for (const w of s.windows) {
            if (w.parent !== null) expect(handles.has(w.parent), JSON.stringify(w)).toBe(true);
        }
    });
});
