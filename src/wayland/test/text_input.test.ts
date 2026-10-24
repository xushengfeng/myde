import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { collectAppLogs, logOfType } from "../../test_runner/applog";
import { testRunnerApp } from "../../test_runner/test_runner";

/**
 * 文本注入测试：桌面 `input.text` 走 `zwp_text_input_v3`（preedit=false 时 commit_string + done），
 * 客户端编辑框里应当真的出现这段文字。
 *
 * 依赖链：指针移入窗口 → `wl_keyboard.enter` → v3 的 `enter`，客户端提交 `enable` 之后
 * 注入才生效——所以指针 move 后必须留出一个往返时间。
 *
 * 注意 `testRunnerApp` 的回调是 `script.toString()` 后拼进桌面脚本里求值的，
 * 访问不到本文件的模块作用域，文案与等待时长都定义在回调体内并随结果带出。
 */

/** 客户端 DOM 侧记录到的编辑事件 */
type EditEvent = {
    type: "input" | "beforeinput";
    inputType?: string;
    data?: string;
    /** 该时刻编辑框里的完整内容 */
    value: string;
};

describe("text input", () => {
    it("input.text 提交到编辑框", { timeout: 20000 }, async () => {
        const appJs = `
module.exports = ({ createWindow }) => {
    createWindow({ js: __filename, width: 640, height: 480 });
};
if (typeof document !== "undefined") {
    document.title = "myde-text-input-test";
    document.body.innerHTML = '<input id="box" style="font-size:24px;padding:8px">';
    const log = (o) => console.log(JSON.stringify(o));
    const box = document.getElementById("box");
    box.addEventListener("beforeinput", (e) => log({ type: "beforeinput", inputType: e.inputType, data: e.data, value: box.value }));
    box.addEventListener("input", (e) => log({ type: "input", inputType: e.inputType, data: e.data, value: box.value }));
    box.focus();
    log({ type: "ready" });
}
`;
        const tmpfile = `/tmp/myde_text_input_test_${Date.now()}.js`;
        fs.writeFileSync(tmpfile, appJs);

        const { waitExit } = testRunnerApp(`test/electron_app/start.js ${tmpfile}`, async ({ server, runner }) => {
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            /** 两次注入的文案与等待时长（外层断言的唯一来源） */
            const texts = ["hello", " myde"];
            const settle = 600;
            server.on("window.created", (info) => {
                void (async () => {
                    try {
                        server.notify("window.focus", info.handle);
                        // 等首帧：页面脚本在解析期就挂好监听，首帧 ≈ 页面就绪
                        for (let i = 0; i < 200 && (server.windows.preview(info.handle)?.width ?? 0) <= 1; i++)
                            await sleep(50);
                        // 指针移入才会给键盘焦点，v3 的 enter/enable 随之而来
                        server.notify("input.pointer", info.handle, { type: "move", x: 60, y: 156, button: 0 });
                        await sleep(settle);
                        const ti = await server.request("textInput.get", info.handle);
                        for (const t of texts) {
                            server.notify("input.text", info.handle, t, false);
                            await sleep(settle);
                        }
                        runner.sendData({ texts, settle, ti });
                    } catch (e) {
                        runner.sendData({ texts, error: String(e) });
                    } finally {
                        runner.kill();
                    }
                })();
            });
        });

        const raw = (await waitExit()) as {
            applog?: string;
            error?: string;
            texts?: string[];
            ti?: { supported: boolean; protocol?: string; enabled: boolean; cursorRect: unknown };
        }[];
        expect(
            raw.find((r) => r.error),
            `脚本异常: ${JSON.stringify(raw).slice(0, 800)}`,
        ).toBeUndefined();
        const texts = raw.find((r) => r.texts)?.texts;
        expect(texts, `没拿到注入文案，实际: ${JSON.stringify(raw).slice(0, 800)}`).toBeDefined();

        // textInput.get 应能查到当前窗口的文本焦点（输入法靠它决定是否拦截按键）
        const ti = raw.find((r) => r.ti)?.ti;
        expect(ti?.supported, `textInput.get 没报告支持: ${JSON.stringify(ti)}`).toBe(true);
        expect(ti?.protocol).toBe("v3");
        expect(ti?.enabled, `textInput.get 没报告启用: ${JSON.stringify(ti)}`).toBe(true);
        // biome-ignore lint/style/noNonNullAssertion: 上面已断言
        const injected = texts!;

        const logs = collectAppLogs(raw);
        expect(logOfType(logs, "ready").length > 0, `客户端没启动，raw=${JSON.stringify(raw).slice(0, 800)}`).toBe(
            true,
        );
        const edits = logs.filter(
            (l): l is EditEvent => typeof l === "object" && (l.type === "input" || l.type === "beforeinput"),
        );
        const dump = () => `edits=${JSON.stringify(edits)} raw=${JSON.stringify(raw).slice(0, 600)}`;

        // 两次提交都要落到编辑框里，最终内容是两次文案的拼接
        const want = injected.join("");
        expect(
            edits.some((e) => e.value === want),
            `编辑框里没出现 "${want}"（${injected.length} 次注入只认最终拼接值），${dump()}`,
        ).toBe(true);
        // 每次注入都要产生一次 input 事件（zwp_text_input_v3 的 commit_string 走 IME 路径）
        expect(edits.length, `编辑事件太少，${dump()}`).toBeGreaterThanOrEqual(injected.length);
    });
});
