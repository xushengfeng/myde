import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { testRunnerApp } from "../../test_runner/test_runner";

/**
 * xdg_popup 端到端回归：用真实的 Qt/KDE 客户端（konsole）右键开菜单，检查 popup 首帧。
 *
 * 为什么不是搭一个最小 Wayland 客户端：Qt/KDE 对 xdg-shell 的时序最严格——它要求
 * 初始 commit 之后才收到**非零 serial** 的 xdg_surface.configure，否则不 ack、不 attach
 * buffer（GTK/Chromium 宽容，所以之前的测试覆盖不到）。konsole 是最省事的严格客户端。
 *
 * 没有安装 konsole 的环境直接跳过。
 */
const KONSOLE = process.env.MYDE_POPUP_APP ?? "/usr/bin/konsole";

describe.skipIf(!fs.existsSync(KONSOLE))("xdg_popup", () => {
    it("konsole 右键菜单提交首帧并落在窗口内", { timeout: 40000 }, async () => {
        const { waitExit } = testRunnerApp("/bin/true", ({ server, render, runner }) => {
            const cp = require("node:child_process");
            const logs: string[] = [];
            let finished = false;
            const log = (s: string) => {
                logs.push(s);
                if (logs.length > 200) logs.shift();
            };
            const finish = (result: unknown) => {
                if (finished) return;
                finished = true;
                runner.sendData({ result, logs });
                try {
                    proc.kill("SIGKILL");
                } catch {}
                setTimeout(() => runner.kill(), 300);
            };

            const proc = cp.spawn(process.env.MYDE_POPUP_APP || "/usr/bin/konsole", ["--separate"], {
                env: {
                    ...process.env,
                    XDG_SESSION_TYPE: "wayland",
                    XDG_RUNTIME_DIR: server.socketDir,
                    WAYLAND_DISPLAY: server.socketName,
                    QT_QPA_PLATFORM: "wayland",
                },
                stdio: ["ignore", "pipe", "pipe"],
            });
            // 客户端报错（协议错误、map 失败）在断言失败时能直接看到
            proc.stderr.on("data", (d: Buffer) => log(d.toString().slice(-2000)));
            proc.on("error", (e: Error) => log(`spawn error: ${String(e)}`));

            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

            /** 取 toplevel 元素下直挂的 popup：带 id、且内含 canvas（自身 canvas 的包裹 div 没有 id） */
            const readPopups = (renderId: string) => {
                const root = render.getXdgSurfaceEle(renderId) as HTMLElement | null | undefined;
                if (!root) return [];
                const out: {
                    left: number;
                    top: number;
                    w: number;
                    h: number;
                    canvasW: number;
                    canvasH: number;
                    nonEmpty: number;
                }[] = [];
                for (const child of Array.from(root.children)) {
                    if (!(child instanceof HTMLElement) || child.id === "" || child.id === renderId) continue;
                    const canvas = child.querySelector("canvas") as HTMLCanvasElement | null;
                    if (!canvas) continue;
                    let nonEmpty = 0;
                    if (canvas.width > 0 && canvas.height > 0) {
                        const ctx = canvas.getContext("2d");
                        if (ctx) {
                            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                            for (let i = 3; i < data.length; i += 4 * 13) if (data[i] !== 0) nonEmpty++;
                        }
                    }
                    out.push({
                        left: Number.parseFloat(child.style.left) || 0,
                        top: Number.parseFloat(child.style.top) || 0,
                        w: Number.parseFloat(child.style.width) || canvas.width,
                        h: Number.parseFloat(child.style.height) || canvas.height,
                        canvasW: canvas.width,
                        canvasH: canvas.height,
                        nonEmpty,
                    });
                }
                return out;
            };

            server.on("window.created", (info) => {
                void (async () => {
                    try {
                        server.notify("window.focus", info.handle);
                        // 首帧就绪（preview 初始是 1x1）
                        for (let i = 0; i < 200; i++) {
                            if ((server.windows.preview(info.handle)?.width ?? 0) > 1) break;
                            await sleep(50);
                        }
                        await sleep(300);
                        const win = server.windows.get(info.handle);
                        if (!win) throw new Error("window gone");
                        const rect = win.rect;
                        // 靠近窗口右下角：顺带验证 constraint_adjustment(slide) 把菜单挪回窗口内
                        const pt = { x: Math.max(10, rect.w - 120), y: Math.max(10, rect.h - 80) };
                        server.notify("input.pointer", info.handle, {
                            type: "move",
                            x: pt.x,
                            y: pt.y,
                            button: 0,
                        });
                        await sleep(100);
                        server.notify("input.pointer", info.handle, {
                            type: "down",
                            x: pt.x,
                            y: pt.y,
                            button: 2,
                        });
                        await sleep(100);
                        server.notify("input.pointer", info.handle, {
                            type: "up",
                            x: pt.x,
                            y: pt.y,
                            button: 2,
                        });

                        // 等 popup 画出非空首帧；Qt 收到无效 configure 时会永远停在 300x150 空画布
                        let popups: ReturnType<typeof readPopups> = [];
                        for (let i = 0; i < 100; i++) {
                            popups = readPopups(info.renderId);
                            if (popups.some((p) => p.canvasW > 1 && p.canvasH > 1 && p.nonEmpty > 0)) break;
                            await sleep(100);
                        }
                        finish({ rect, clicked: pt, popups });
                    } catch (e) {
                        finish({ error: String(e) });
                    }
                })();
            });

            setTimeout(() => finish({ error: "global-timeout" }), 30000);
        });

        const raw = (await waitExit()) as {
            result?: {
                error?: string;
                rect?: { x: number; y: number; w: number; h: number };
                clicked?: { x: number; y: number };
                popups?: {
                    left: number;
                    top: number;
                    w: number;
                    h: number;
                    canvasW: number;
                    canvasH: number;
                    nonEmpty: number;
                }[];
            };
            logs?: string[];
        }[];
        const dump = () => JSON.stringify(raw).slice(0, 4000);
        const result = raw.find((r) => r.result)?.result;
        expect(result, `没拿到运行结果: ${dump()}`).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: 上面已断言
        const r = result!;
        expect(r.error, `运行异常: ${r.error} ${dump()}`).toBeUndefined();
        const geo = r.rect;
        if (!geo) throw new Error(`没拿到窗口几何: ${dump()}`);
        const popups = r.popups ?? [];
        expect(popups.length, `右键后没有 xdg_popup: ${dump()}`).toBeGreaterThan(0);

        const drawn = popups.find((p) => p.canvasW > 1 && p.canvasH > 1 && p.nonEmpty > 0);
        expect(drawn, `popup 没有提交首帧（画布仍为空）: ${dump()}`).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: 上面已断言
        const p = drawn!;

        // 约束：菜单必须整个落在窗口几何内（konsole 请求了 slide_x|slide_y）
        expect(p.left, `popup 左边界越界: ${dump()}`).toBeGreaterThanOrEqual(0);
        expect(p.top, `popup 上边界越界: ${dump()}`).toBeGreaterThanOrEqual(0);
        expect(p.left + p.w, `popup 右边界越界: ${dump()}`).toBeLessThanOrEqual(geo.w + 1);
        expect(p.top + p.h, `popup 下边界越界: ${dump()}`).toBeLessThanOrEqual(geo.h + 1);
    });
});
