import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { mapKeyCode } from "../../input_map/web2x";
import { collectAppLogs, logOfType } from "../../test_runner/applog";
import { testRunnerApp } from "../../test_runner/test_runner";

/**
 * 按键注入测试：`input.key` 按 `mapKeyCode` 的键码下发后，客户端 DOM 收到对应的 keydown/keyup。
 *
 * 两处按旧写法会不稳定，这里显式处理：
 * 1. **注入点要落在内容区**：`ev.x/y` 相对窗口几何原点，几何里含 CSD 标题栏，
 *    旧写法的 (16,16) 在标题栏里，首个 keydown 会被丢掉。
 * 2. **不能按下标取日志**：`applog` 一个 chunk 可能含多行、也可能夹杂别的日志，
 *    先解析出按键事件再按顺序对账（见 `test_runner/applog.ts`）。
 *
 * 注意 `testRunnerApp` 的回调是 `script.toString()` 后拼进桌面脚本里求值的，
 * 访问不到本文件的模块作用域——计划写在回调体内，随结果带出来；`mapKeyCode` 同理，
 * 回调里写死键码，外层再用 `mapKeyCode` 校验这组键码没写错。
 */

/** 客户端记录的按键事件 */
type KeyEvent = { type: "keydown" | "keyup"; key: string; code: string };

/** code → Chromium 回传的 `key`（DOM 语义） */
const KEY_LABEL: Record<string, string> = {
    KeyA: "a",
    KeyB: "b",
    Enter: "Enter",
    Space: " ",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Numpad0: "0",
};

describe("keyboard", () => {
    it("input.key 注入的按键序列", { timeout: 20000 }, async () => {
        // 键码映射表本身（纯函数，不依赖进程）
        const mapExpect: [string, number][] = [
            ["KeyA", 30],
            ["KeyB", 48],
            ["Enter", 28],
            ["Space", 57],
            ["ArrowUp", 103],
            ["ArrowDown", 108],
            ["ArrowLeft", 105],
            ["ArrowRight", 106],
            ["Numpad0", 82],
        ];
        for (const [code, key] of mapExpect) expect(mapKeyCode(code)).toBe(key);

        const clientJs = `
module.exports = ({ createWindow }) => {
    createWindow({ js: __filename, width: 640, height: 480 });
};
if (typeof document !== "undefined") {
    document.title = "myde-keyboard-test";
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.onkeydown = (e) => console.log(JSON.stringify({ key: e.key, code: e.code, type: "keydown" }));
    input.onkeyup = (e) => console.log(JSON.stringify({ key: e.key, code: e.code, type: "keyup" }));
    input.focus();
    console.log(JSON.stringify({ type: "ready" }));
}
`;
        const tmpfile = `/tmp/myde_keyboard_test_${Date.now()}.js`;
        fs.writeFileSync(tmpfile, clientJs);

        const { waitExit } = testRunnerApp(`test/electron_app/start.js ${tmpfile}`, async ({ server, runner }) => {
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            /** 注入计划（外层断言的唯一来源）；键码与 code 成对写死，外层再用 mapKeyCode 校验 */
            const plan = {
                codes: ["KeyA", "KeyB", "Enter", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Numpad0"],
                keys: [30, 48, 28, 57, 103, 108, 105, 106, 82],
                /** 指针移入到首个按键之间的等待：键盘焦点随指针 enter 走 */
                settle: 300,
                gap: 60,
                /** 注入点（几何坐标）：y 要越过 CSD 标题栏，落在内容区 */
                pointer: { x: 60, y: 156 },
            };
            server.on("window.created", (info) => {
                void (async () => {
                    try {
                        server.notify("window.focus", info.handle);
                        // 等首帧：页面脚本在解析期就挂好监听，首帧 ≈ 页面就绪，
                        // 否则首个注入会赶在监听挂好之前被丢掉（preview 初始是 1x1）
                        for (let i = 0; i < 200 && (server.windows.preview(info.handle)?.width ?? 0) <= 1; i++)
                            await sleep(50);
                        server.notify("input.pointer", info.handle, {
                            type: "move",
                            x: plan.pointer.x,
                            y: plan.pointer.y,
                            button: 0,
                        });
                        await sleep(plan.settle);
                        for (let i = 0; i < plan.keys.length; i++) {
                            const key = plan.keys[i];
                            server.notify("input.key", info.handle, key, "pressed");
                            await sleep(plan.gap);
                            server.notify("input.key", info.handle, key, "released");
                            await sleep(plan.gap);
                        }
                        await sleep(200);
                        runner.sendData({ plan });
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
            plan?: { codes: string[]; keys: number[]; settle: number; gap: number; pointer: { x: number; y: number } };
        }[];
        expect(
            raw.find((r) => r.error),
            `脚本异常: ${JSON.stringify(raw).slice(0, 800)}`,
        ).toBeUndefined();
        const plan = raw.find((r) => r.plan)?.plan;
        expect(plan, `没拿到注入计划，实际: ${JSON.stringify(raw).slice(0, 800)}`).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: 上面已断言
        const p = plan!;

        const logs = collectAppLogs(raw);
        // 客户端脚本确实跑起来了
        expect(logOfType(logs, "ready").length, `客户端没启动，raw=${JSON.stringify(raw).slice(0, 800)}`).toBe(1);

        // 回调里写死的键码必须和映射表一致：注入的是 keys、期望序列按 codes 推导，对不上就各说各话
        expect(
            p.codes.map((c) => mapKeyCode(c)),
            `计划里的键码和 mapKeyCode 不一致，codes=${JSON.stringify(p.codes)} keys=${JSON.stringify(p.keys)}`,
        ).toEqual(p.keys);

        // 期望序列：每个 code 一次 keydown + 一次 keyup，按注入顺序
        const expected: KeyEvent[] = [];
        for (const code of p.codes) {
            const key = KEY_LABEL[code];
            expected.push({ key, code, type: "keydown" }, { key, code, type: "keyup" });
        }

        const got = logs.filter(
            (l): l is KeyEvent => typeof l === "object" && (l.type === "keydown" || l.type === "keyup"),
        );
        expect(got, `按键序列不符（丢了或多出事件），期望 ${expected.length} 条，实际 ${got.length} 条`).toEqual(
            expected,
        );
    });
});
