import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { mapKeyCode } from "../../input_map/web2x";
import { collectAppLogs, logOfType } from "../../test_runner/applog";
import { testRunnerApp } from "../../test_runner/test_runner";

/**
 * 剪贴板双向测试（`wl_data_device`）：
 *
 * - **桌面 → 客户端**：`notify("clipboard.offer", handle)` offer 出去 → 客户端 Ctrl+V →
 *   `wl_data_offer.receive` → `clipboard.pasteRequested` → 桌面 `notify("clipboard.paste", clientId, text)`
 *   回填 → 编辑框里出现桌面的文案
 * - **客户端 → 桌面**：客户端 Ctrl+A/Ctrl+C → `set_selection` → 服务端读 fd → `clipboard.copy` 事件
 *
 * **顺序不能反**：Chromium 自己持有剪贴板时，粘贴直接吃本地缓存、**不会**向合成器发
 * `wl_data_offer.receive`（实测 pasteRequests=0）。所以必须先粘贴、后复制；
 * 复制的文案用 `input.text` 打进去，保证是非空内容（空选择走的读取分支不 emit `clipboard.copy`）。
 *
 * 约束同其他 e2e：回调是 `script.toString()` 求值的，计划写在回调体内、随结果带出；
 * 日志要经 `test_runner/applog.ts` 剥两层 JSON。
 */

/** 客户端编辑框的变化 */
type EditEvent = { type: "input" | "beforeinput"; inputType?: string; value: string };

describe("clipboard", () => {
    it("桌面 offer 粘贴、客户端复制回传", { timeout: 30000 }, async () => {
        const appJs = `
module.exports = ({ createWindow }) => {
    createWindow({ js: __filename, width: 640, height: 480 });
};
if (typeof document !== "undefined") {
    document.title = "myde-clipboard-test";
    document.body.innerHTML = '<input id="box" style="font-size:24px;padding:8px" value="hello clipboard">';
    const log = (o) => console.log(JSON.stringify(o));
    const box = document.getElementById("box");
    box.addEventListener("beforeinput", (e) => log({ type: "beforeinput", inputType: e.inputType, data: e.data, value: box.value }));
    box.addEventListener("input", (e) => log({ type: "input", inputType: e.inputType, data: e.data, value: box.value }));
    box.focus();
    log({ type: "ready" });
}
`;
        const tmpfile = `/tmp/myde_clipboard_test_${Date.now()}.js`;
        fs.writeFileSync(tmpfile, appJs);

        const { waitExit } = testRunnerApp(`test/electron_app/start.js ${tmpfile}`, async ({ server, runner }) => {
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            /** 注入计划与文案（外层断言的唯一来源）；键码与 code 成对写死，外层用 mapKeyCode 校验 */
            const plan = {
                codes: ["ControlLeft", "KeyA", "KeyC", "KeyV", "Delete"],
                keys: [29, 30, 46, 47, 111],
                /** 桌面侧剪贴板内容，期望出现在编辑框里 */
                pasteText: "from desktop",
                /** 清空编辑框后用 input.text 打进去的文案，期望被复制回桌面 */
                typed: "copy me",
                /** 注入点（几何坐标）：y 要越过 CSD 标题栏，落在内容区 */
                pointer: { x: 60, y: 156 },
                settle: 600,
                gap: 60,
            };
            const [CTRL, A, C, V, DEL] = plan.keys;

            const seen = { copied: [] as string[], pasteRequests: 0 };
            server.on("clipboard.copy", (_clientId, text) => seen.copied.push(text));
            // 客户端 Ctrl+V 会挂起一个 receive，必须立刻回填（服务端有 10s 超时）
            server.on("clipboard.pasteRequested", (clientId) => {
                seen.pasteRequests++;
                server.notify("clipboard.paste", clientId, plan.pasteText);
            });

            server.on("window.created", (info) => {
                void (async () => {
                    try {
                        server.notify("window.focus", info.handle);
                        // 等首帧：页面脚本在解析期就挂好监听，首帧 ≈ 页面就绪，
                        // 否则首个注入会赶在监听挂好之前被丢掉（preview 初始是 1x1）
                        for (let i = 0; i < 200 && (server.windows.preview(info.handle)?.width ?? 0) <= 1; i++)
                            await sleep(50);
                        // 指针移入才有键盘焦点，快捷键才会被 Chromium 当成加速键
                        server.notify("input.pointer", info.handle, {
                            type: "move",
                            x: plan.pointer.x,
                            y: plan.pointer.y,
                            button: 0,
                        });
                        await sleep(plan.settle);

                        const tap = async (key: number) => {
                            server.notify("input.key", info.handle, key, "pressed");
                            await sleep(plan.gap);
                            server.notify("input.key", info.handle, key, "released");
                            await sleep(plan.gap);
                        };
                        /** 修饰键组合：mod 按下 → key 按下/抬起 → mod 抬起（modifiers 在 mod 按下时就发了） */
                        const combo = async (mod: number, key: number) => {
                            server.notify("input.key", info.handle, mod, "pressed");
                            await sleep(plan.gap);
                            await tap(key);
                            server.notify("input.key", info.handle, mod, "released");
                            await sleep(plan.gap);
                        };

                        // 1. 桌面 offer 剪贴板 → 客户端粘贴（此时客户端还没复制过，只能问合成器要）
                        server.notify("clipboard.offer", info.handle);
                        await sleep(300);
                        await combo(CTRL, V);
                        await sleep(800);

                        // 2. 清空编辑框，给复制留一个确定的内容
                        await combo(CTRL, A);
                        await tap(DEL);
                        await sleep(200);

                        // 3. 打入已知文案 → 全选 → 复制 → set_selection → clipboard.copy
                        server.notify("input.text", info.handle, plan.typed, false);
                        await sleep(400);
                        await combo(CTRL, A);
                        await sleep(150);
                        await combo(CTRL, C);
                        // 服务端读 selection fd 前有 200ms 延时，多留一点
                        await sleep(900);

                        runner.sendData({ plan, ...seen });
                    } catch (e) {
                        runner.sendData({ plan, error: String(e) });
                    } finally {
                        runner.kill();
                    }
                })();
            });
        });

        const raw = (await waitExit()) as {
            applog?: string;
            error?: string;
            plan?: { codes: string[]; keys: number[]; pasteText: string; typed: string };
            copied?: string[];
            pasteRequests?: number;
        }[];
        expect(
            raw.find((r) => r.error),
            `脚本异常: ${JSON.stringify(raw).slice(0, 800)}`,
        ).toBeUndefined();
        const plan = raw.find((r) => r.plan)?.plan;
        expect(plan, `没拿到注入计划，实际: ${JSON.stringify(raw).slice(0, 800)}`).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: 上面已断言
        const p = plan!;
        expect(
            p.codes.map((c) => mapKeyCode(c)),
            `计划里的键码和 mapKeyCode 不一致`,
        ).toEqual(p.keys);

        const logs = collectAppLogs(raw);
        expect(logOfType(logs, "ready").length, `客户端没启动，raw=${JSON.stringify(raw).slice(0, 800)}`).toBe(1);
        const edits = logs.filter(
            (l): l is EditEvent => typeof l === "object" && (l.type === "input" || l.type === "beforeinput"),
        );
        const dump = () =>
            `edits=${JSON.stringify(edits)} copied=${JSON.stringify(raw.find((r) => r.copied)?.copied)} ` +
            `pasteRequests=${raw.find((r) => r.pasteRequests !== undefined)?.pasteRequests}`;

        // 中间态：编辑框被清空过（否则粘贴/复制的断言分不清是哪一步产生的内容）
        expect(
            edits.some((e) => e.value === ""),
            `编辑框没被清空，${dump()}`,
        ).toBe(true);

        // 方向一：桌面 offer → 客户端请求 → 桌面回填，编辑框里出现桌面文案
        expect(
            raw.find((r) => r.pasteRequests !== undefined)?.pasteRequests ?? 0,
            `桌面没收到 clipboard.pasteRequested，${dump()}`,
        ).toBeGreaterThan(0);
        expect(
            edits.some((e) => e.value.includes(p.pasteText)),
            `编辑框里没出现桌面文案 "${p.pasteText}"，${dump()}`,
        ).toBe(true);

        // 方向二：客户端 Ctrl+C → 桌面收到 clipboard.copy
        const copied = raw.find((r) => r.copied)?.copied ?? [];
        expect(copied, `桌面没收到 clipboard.copy，${dump()}`).toContain(p.typed);
    });
});
