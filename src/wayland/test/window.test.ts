import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { testRunnerApp } from "../../test_runner/test_runner";

/** 桌面侧收集到的窗口生命周期快照 */
type WinSummary = {
    created: number;
    renderId?: string;
    titles: string[];
    /** windowResized 事件收到的 (width, height) */
    resized: { width: number; height: number }[];
    maximized: number;
    closed: number;
    clientClosed: number;
    /** cursor 形态：shape=语义枚举、image=表面图像、hidden=隐藏 */
    cursors: { kind: "shape" | "image" | "hidden"; hx: number; hy: number }[];
    preview?: { greenPixels: number; sampled: number; width: number; height: number };
    /** 提前收尾的原因，正常走完 windowClosed 时为空 */
    stopReason?: string;
};

describe("window", () => {
    it("创建、内容显示、resize、maximize、cursor、关闭", { timeout: 40000 }, async () => {
        // 同一个文件既当 electron 主进程脚本（含 module.exports），又当渲染进程脚本（typeof document）
        const appJs = `
module.exports = ({ createWindow }) => {
    const win = createWindow({ js: __filename, width: 640, height: 480 });
    // 客户端主动请求最大化 → xdg_toplevel.set_maximized → 桌面收到 windowMaximized
    setTimeout(() => {
        try { win.maximize(); } catch (e) {}
    }, 3500);
};
if (typeof document !== "undefined") {
    document.title = "myde-window-test";
    document.body.innerHTML = '<div style="width:100%;height:100%;background:#00ff00"></div>';
}
`;
        const tmpfile = `/tmp/myde_window_test_${Date.now()}.js`;
        fs.writeFileSync(tmpfile, appJs);

        const { waitExit } = testRunnerApp(`test/electron_app/start.js ${tmpfile}`, ({ client, render, runner }) => {
            const s: WinSummary = {
                created: 0,
                titles: [],
                resized: [],
                maximized: 0,
                closed: 0,
                clientClosed: 0,
                cursors: [],
            };
            let closing = false;
            const finish = (reason?: string) => {
                if (closing) return;
                closing = true;
                if (reason) s.stopReason = reason;
                runner.sendData({ summary: s });
                runner.kill();
            };
            /** 无论后续事件是否到达，都要把已有结果交出去 */
            const watchdog = setTimeout(() => finish("watchdog"), 12000);

            client.on("windowCreated", (id, renderId) => {
                s.created++;
                s.renderId = renderId;
                client.win(id)?.focus();

                setTimeout(() => {
                    const win = client.win(id);
                    if (!win) {
                        clearTimeout(watchdog);
                        finish("win-lookup-failed");
                        return;
                    }
                    // 内容是否真的画出来了：采样预览找绿色
                    try {
                        const canvas = win.getPreview();
                        const ctx = canvas.getContext("2d")!;
                        const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                        let greenPixels = 0;
                        let sampled = 0;
                        for (let i = 0; i < img.length; i += 4 * 37) {
                            sampled++;
                            if (img[i + 1] > 200 && img[i] < 60 && img[i + 2] < 60) greenPixels++;
                        }
                        s.preview = { greenPixels, sampled, width: canvas.width, height: canvas.height };
                    } catch (e) {
                        s.stopReason = `preview-failed:${String(e)}`;
                    }
                    // 桌面主动改尺寸 → xdg_toplevel.configure → 客户端 ack + commit → windowResized
                    win.setSize(500, 400);
                    // 指针移入，触发 wl_pointer.enter，客户端才可能上报光标形态
                    win.point.sendPointerEvent("move", { x: 120, y: 120, button: 0 });
                }, 400);

                // 收尾：优先等 windowClosed，超时则带 stopReason 返回
                clearTimeout(watchdog);
                setTimeout(() => {
                    if (!closing) {
                        client.win(id)?.close();
                        setTimeout(() => finish("close-timeout"), 3000);
                    }
                }, 6500);
            });

            client.on("windowResized", (_id, width, height) => {
                s.resized.push({ width, height });
            });
            client.on("windowMaximized", () => {
                s.maximized++;
            });
            client.on("title", (_id, title) => {
                s.titles.push(title);
            });
            client.on("windowClosed", () => {
                s.closed++;
                clearTimeout(watchdog);
                finish();
            });
            client.on("close", () => {
                s.clientClosed++;
                clearTimeout(watchdog);
                finish("client-disconnect");
            });
            render.on({
                onCursorUpdata: (canvas, hx, hy) => {
                    s.cursors.push({ kind: canvas === undefined ? "hidden" : typeof canvas === "string" ? "shape" : "image", hx, hy });
                },
            });
        });

        const result = (await waitExit()) as { summary?: WinSummary }[];
        const sum = result.find((r) => r.summary)?.summary;
        expect(sum, `未收到 summary，实际: ${JSON.stringify(result).slice(0, 500)}`).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: 上面已断言
        const w = sum!;

        // 窗口创建恰好一次，且拿到渲染 id
        expect(w.created).toBe(1);
        expect(w.renderId).toBeTruthy();

        // 内容确实显示出来了（预览里能找到绿色像素）
        expect(w.preview?.greenPixels ?? 0, `preview=${JSON.stringify(w.preview)} stop=${w.stopReason}`).toBeGreaterThan(0);

        // 桌面 resize 生效：客户端回传了新的窗口几何
        expect(w.resized, `stop=${w.stopReason} resized 为空，titles=${JSON.stringify(w.titles)}`).not.toHaveLength(0);

        // 关闭走完 windowClosed
        expect(w.closed, `stop=${w.stopReason} clientClosed=${w.clientClosed}`).toBe(1);

        // 以下两项依赖客户端主动发起，是本次要观察的能力边界：
        // - maximize：electron 的 BrowserWindow.maximize() 是否真的发 xdg_toplevel.set_maximized
        // - cursor：Chromium 是否使用 wp_cursor_shape（而非 wl_pointer.set_cursor 表面图像）
        expect(w.maximized, `stop=${w.stopReason}`).toBeGreaterThan(0);
        expect(
            w.cursors.some((c) => c.kind === "shape"),
            `cursors=${JSON.stringify(w.cursors)} stop=${w.stopReason}`,
        ).toBe(true);
    });
});
