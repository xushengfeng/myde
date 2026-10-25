import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { testRunnerApp } from "../../test_runner/test_runner";

/**
 * 窗口关闭/客户端断线后的 DOM 清理回归。
 *
 * 覆盖两条完全不同的路径：
 * 1. 客户端进程直接退出（socket 对端结束）：myde-unix-socket 只发 `end` 不发 `close`，
 *    server 必须自己收敛连接并把该连接的 xdg 元素/画布撤掉。
 * 2. 客户端正常 `xdg_toplevel.destroy`：renderer 要以 `onToplevelRemove` 为通知，
 *    但即使桌面没注册回调，元素也不能残留在 DOM。
 *
 * 用真实 konsole：它的 `--separate` 会 fork，测试通过 socket 的 peer pid 杀掉真正持有
 * Wayland 连接的进程（`server.clients` 的 pid 只在测试里作为内部字段读取）。
 */
const KONSOLE = "/usr/bin/konsole";

describe.skipIf(!fs.existsSync(KONSOLE))("window close", () => {
    it("客户端断线后撤掉 canvas DOM", { timeout: 30000 }, async () => {
        const { waitExit } = testRunnerApp("/bin/true", ({ server, render, runner }) => {
            const cp = require("node:child_process");
            const dumpDom = (renderId: string) => {
                const el = render.getXdgSurfaceEle(renderId) as HTMLElement | null;
                return {
                    exists: !!el,
                    connected: !!el && el.isConnected,
                    canvases: el ? el.querySelectorAll("canvas").length : 0,
                };
            };
            let finished = false;
            let peerPid: number | undefined;
            const finish = (result: unknown) => {
                if (finished) return;
                finished = true;
                runner.sendData({ result });
                try {
                    if (peerPid) process.kill(peerPid, "SIGKILL");
                } catch {}
                try {
                    proc.kill("SIGKILL");
                } catch {}
                runner.kill();
            };
            const proc = cp.spawn("/usr/bin/konsole", ["--separate"], {
                env: {
                    ...process.env,
                    XDG_SESSION_TYPE: "wayland",
                    XDG_RUNTIME_DIR: server.socketDir,
                    WAYLAND_DISPLAY: server.socketName,
                    QT_QPA_PLATFORM: "wayland",
                },
                stdio: ["ignore", "pipe", "pipe"],
            });
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            server.on("window.created", (info) => {
                void (async () => {
                    try {
                        for (let i = 0; i < 200 && (server.windows.preview(info.handle)?.width ?? 0) <= 1; i++)
                            await sleep(50);
                        // 像真实桌面一样把 toplevel 元素挂进 document，才有 isConnected 可断言
                        const el = render.getXdgSurfaceEle(info.renderId) as HTMLElement | null;
                        if (el) document.body.appendChild(el);
                        const before = dumpDom(info.renderId);
                        let closed = false;
                        server.on("client.closed", () => {
                            closed = true;
                        });
                        // konsole --separate 会 fork：杀 socket 对端而不是外层进程
                        peerPid = (server.clients.get(info.clientId) as unknown as { pid?: number }).pid;
                        if (peerPid) process.kill(peerPid, "SIGKILL");
                        else proc.kill("SIGKILL");
                        for (let i = 0; i < 50 && !closed; i++) await sleep(100);
                        // client.closed 早于 close() 里的渲染清理，等一拍
                        await sleep(400);
                        finish({ before, closed, after: dumpDom(info.renderId) });
                    } catch (e) {
                        finish({ error: String(e) });
                    }
                })();
            });
            setTimeout(() => finish({ error: "timeout" }), 15000);
        });
        const raw = (await waitExit()) as {
            result?: { error?: string; before?: unknown; after?: unknown; closed?: boolean };
        }[];
        const r = raw.find((x) => x.result)?.result;
        expect(r, JSON.stringify(raw).slice(0, 1500)).toBeDefined();
        if (!r) throw new Error("no result");
        expect(r.error, JSON.stringify(raw).slice(0, 1500)).toBeUndefined();
        expect(r.closed).toBe(true);
        expect(r.after).toMatchObject({ exists: false, connected: false, canvases: 0 });
    });

    it("客户端销毁 toplevel 后撤掉 canvas DOM", { timeout: 30000 }, async () => {
        const { waitExit } = testRunnerApp("/bin/true", ({ server, render, runner }) => {
            const cp = require("node:child_process");
            const dumpDom = (renderId: string) => {
                const el = render.getXdgSurfaceEle(renderId) as HTMLElement | null;
                return {
                    exists: !!el,
                    connected: !!el && el.isConnected,
                    canvases: el ? el.querySelectorAll("canvas").length : 0,
                };
            };
            let finished = false;
            let peerPid: number | undefined;
            const finish = (result: unknown) => {
                if (finished) return;
                finished = true;
                runner.sendData({ result });
                try {
                    if (peerPid) process.kill(peerPid, "SIGKILL");
                } catch {}
                try {
                    proc.kill("SIGKILL");
                } catch {}
                runner.kill();
            };
            const proc = cp.spawn("/usr/bin/konsole", ["--separate"], {
                env: {
                    ...process.env,
                    XDG_SESSION_TYPE: "wayland",
                    XDG_RUNTIME_DIR: server.socketDir,
                    WAYLAND_DISPLAY: server.socketName,
                    QT_QPA_PLATFORM: "wayland",
                },
                stdio: ["ignore", "pipe", "pipe"],
            });
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            server.on("window.created", (info) => {
                void (async () => {
                    try {
                        for (let i = 0; i < 200 && (server.windows.preview(info.handle)?.width ?? 0) <= 1; i++)
                            await sleep(50);
                        const el = render.getXdgSurfaceEle(info.renderId) as HTMLElement | null;
                        if (el) document.body.appendChild(el);
                        const before = dumpDom(info.renderId);
                        let closed = false;
                        server.on("window.closed", () => {
                            closed = true;
                        });
                        peerPid = (server.clients.get(info.clientId) as unknown as { pid?: number }).pid;
                        server.notify("window.close", info.handle);
                        for (let i = 0; i < 50 && !closed; i++) await sleep(100);
                        await sleep(400);
                        finish({ before, closed, after: dumpDom(info.renderId) });
                    } catch (e) {
                        finish({ error: String(e) });
                    }
                })();
            });
            setTimeout(() => finish({ error: "timeout" }), 15000);
        });
        const raw = (await waitExit()) as {
            result?: { error?: string; before?: unknown; after?: unknown; closed?: boolean };
        }[];
        const r = raw.find((x) => x.result)?.result;
        expect(r, JSON.stringify(raw).slice(0, 1500)).toBeDefined();
        if (!r) throw new Error("no result");
        expect(r.error, JSON.stringify(raw).slice(0, 1500)).toBeUndefined();
        expect(r.closed).toBe(true);
        expect(r.after).toMatchObject({ exists: false, connected: false, canvases: 0 });
    });
});
