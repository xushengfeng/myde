import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { collectAppLogs } from "../../test_runner/applog";
import { testRunnerApp } from "../../test_runner/test_runner";

type Evt = { type: "evt"; name: string; effect?: string; effectAllowed?: string; dropEffect?: string; data?: string };

describe("web drag api", () => {
    it("copy 和 move 两种 effect", { timeout: 40000 }, async () => {
        const appJs = `
module.exports = ({ createWindow }) => {
    createWindow({ js: __filename, width: 640, height: 480, frame: false });
};
if (typeof document !== "undefined") {
    document.title = "myde-web-dnd-test";
    const html =
        '<div id="src1" draggable="true" style="position:absolute;left:50px;top:50px;width:120px;height:40px;background:#f88">COPY</div>' +
        '<div id="dst1" style="position:absolute;left:300px;top:50px;width:140px;height:60px;background:#8f8">DROP COPY</div>' +
        '<div id="src2" draggable="true" style="position:absolute;left:50px;top:150px;width:120px;height:40px;background:#88f">MOVE</div>' +
        '<div id="dst2" style="position:absolute;left:300px;top:150px;width:140px;height:60px;background:#ff8">DROP MOVE</div>';
    document.body.innerHTML = html;
    const log = (o) => console.log(JSON.stringify(o));
    const setup = (src, dst, effect) => {
        src.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", effect);
            e.dataTransfer.effectAllowed = effect;
            log({ type: "evt", name: "dragstart", effectAllowed: e.dataTransfer.effectAllowed });
        });
        src.addEventListener("dragend", (e) => log({ type: "evt", name: "dragend", dropEffect: e.dataTransfer.dropEffect }));
        dst.addEventListener("dragenter", (e) => { e.preventDefault(); log({ type: "evt", name: "dragenter", effect }); });
        dst.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = effect;
            log({ type: "evt", name: "dragover", effect, dropEffect: e.dataTransfer.dropEffect });
        });
        dst.addEventListener("drop", (e) => {
            e.preventDefault();
            log({ type: "evt", name: "drop", effect, dropEffect: e.dataTransfer.dropEffect, data: e.dataTransfer.getData("text/plain") });
        });
    };
    setup(document.getElementById("src1"), document.getElementById("dst1"), "copy");
    setup(document.getElementById("src2"), document.getElementById("dst2"), "move");
    log({ type: "log", msg: "ready" });
}
`;
        const tmpfile = `/tmp/myde_web_dnd_${Date.now()}.js`;
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
                        const drag = async (y: number) => {
                            move(100, y);
                            await sleep(80);
                            down(100, y);
                            await sleep(80);
                            for (const x of [140, 180, 220, 260, 300, 340]) {
                                move(x, y + 10);
                                await sleep(80);
                            }
                            up(340, y + 10);
                            await sleep(800);
                        };
                        await drag(70);
                        await drag(170);
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
        const logs = collectAppLogs(raw);
        fs.writeFileSync("/tmp/opencode/webdnd-logs.json", JSON.stringify({ logs, raw }, null, 2));
        const evts = logs.filter((l) => (l as Evt).type === "evt") as Evt[];
        console.log("DND EVENTS", JSON.stringify(evts));
        expect(evts.some((e) => e.name === "drop" && e.effect === "copy")).toBe(true);
        expect(evts.some((e) => e.name === "drop" && e.effect === "move")).toBe(true);
    });
});
