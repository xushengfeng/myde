import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { collectAppLogs, logOfType } from "../../test_runner/applog";
import { testRunnerApp } from "../../test_runner/test_runner";

type Sel = { type: "sel"; gesture: number; start: number; end: number; text: string };
type Meta = { type: "meta"; innerW: number; innerH: number };

describe("text drag", () => {
    it("drag extends selection and dropping on a selection does not collapse it", { timeout: 30000 }, async () => {
        const appJs = `
module.exports = ({ createWindow }) => {
    createWindow({ js: __filename, width: 640, height: 480, frame: false });
};
if (typeof document !== "undefined") {
    document.title = "myde-text-drag-test";
    document.body.innerHTML =
        '<textarea id="ta" style="position:absolute;inset:0;font:20px monospace;line-height:28px;padding:20px;border:0;outline:0">' +
        'abcdefghijklmnopqrstuvwxyz0123456789\\nABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\\nabcdefghijklmnopqrstuvwxyz0123456789</textarea>';
    const ta = document.getElementById("ta");
    let gesture = 0;
    const log = (o) => console.log(JSON.stringify(o));
    const snap = () => log({ type: "sel", gesture, start: ta.selectionStart, end: ta.selectionEnd, text: ta.value.slice(ta.selectionStart, ta.selectionEnd) });
    document.addEventListener("mousedown", () => { gesture++; });
    document.addEventListener("selectionchange", () => { if (document.activeElement === ta) snap(); });
    document.addEventListener("mouseup", () => setTimeout(snap, 0));
    ta.addEventListener("dragover", (e) => e.preventDefault());
    ta.addEventListener("drop", (e) => e.preventDefault());
    for (const t of ["mousedown", "mouseup", "click", "dragstart", "dragenter", "dragover", "drop", "dragend"]) {
        ta.addEventListener(t, (e) => log({ type: "evt", name: t, x: e.clientX, y: e.clientY, buttons: e.buttons, start: ta.selectionStart, end: ta.selectionEnd }));
    }
    log({ type: "meta", innerW: window.innerWidth, innerH: window.innerHeight });
}
`;
        const tmpfile = `/tmp/myde_text_drag_${Date.now()}.js`;
        fs.writeFileSync(tmpfile, appJs);

        const { waitExit } = testRunnerApp(`test/electron_app/start.js ${tmpfile}`, async ({ server, runner }) => {
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            server.on("window.created", (info) => {
                void (async () => {
                    try {
                        server.notify("window.focus", info.handle);
                        for (let i = 0; i < 200 && (server.windows.preview(info.handle)?.width ?? 0) <= 1; i++)
                            await sleep(50);
                        await sleep(400);
                        const move = (x: number, y: number) =>
                            server.notify("input.pointer", info.handle, { type: "move", x, y, button: 0 });
                        const down = (x: number, y: number) =>
                            server.notify("input.pointer", info.handle, { type: "down", x, y, button: 0 });
                        const up = (x: number, y: number) =>
                            server.notify("input.pointer", info.handle, { type: "up", x, y, button: 0 });

                        // 第一次：按住拖过文字，选中 100 → 300
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

                        // 第二次：在选区中间按下往左拖（模拟触控板 tap-drag 的语义事件）
                        move(200, 100);
                        await sleep(60);
                        down(200, 100);
                        await sleep(60);
                        for (const x of [180, 160, 140]) {
                            move(x, 100);
                            await sleep(60);
                        }
                        up(140, 100);
                        await sleep(700);

                        // 第三次：单击，应该塌缩成光标
                        down(250, 100);
                        await sleep(60);
                        up(250, 100);
                        await sleep(300);

                        runner.sendData({ ok: true });
                    } catch (e) {
                        runner.sendData({ error: String(e) });
                    } finally {
                        runner.kill();
                    }
                })();
            });
        });

        const raw = (await waitExit()) as any[];
        const err = raw.find((r) => r.error);
        expect(err, JSON.stringify(raw).slice(0, 1000)).toBeUndefined();
        const logs = collectAppLogs(raw);
        const sels = logOfType<Sel>(logs, "sel");
        const meta = logOfType<Meta>(logs, "meta")[0];
        const dump = () =>
            `meta=${JSON.stringify(meta)} sels=${JSON.stringify(sels)} raw=${JSON.stringify(raw).slice(0, 800)}`;

        expect(meta, dump()).toBeDefined();
        const g1 = sels.filter((s) => s.gesture === 1).at(-1);
        // 第二次是在选区上按下拖动，客户端会进入 DnD；选区不应被点击塌缩
        const drop = logs.find(
            (l) => typeof l === "object" && l !== null && (l as any).type === "evt" && (l as any).name === "drop",
        ) as { start: number; end: number } | undefined;
        expect(g1, `第一次拖拽没有选区 ${dump()}`).toBeDefined();
        expect(g1!.end, `第一次拖拽应选中文字 ${dump()}`).toBeGreaterThan(g1!.start);
        expect(drop, `第二次拖拽没有完成 drop（DnD 失败） ${dump()}`).toBeDefined();
        expect(drop!.end, `在选区上拖拽不应塌缩成点击 ${dump()}`).toBeGreaterThan(drop!.start);
    });
});
