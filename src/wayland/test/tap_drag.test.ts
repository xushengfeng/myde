import { EventEmitter } from "node:events";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { InputEventCodes } from "../../input_codes/types";
import { collectAppLogs, logOfType } from "../../test_runner/applog";
import { testRunnerApp } from "../../test_runner/test_runner";
import { TouchpadInput } from "../../utils/touchpad";

/** 模拟触控板轻触后第二下拖动，产出 TouchpadInput 的语义事件序列 */
function tapDragSequence() {
    const dev = new EventEmitter() as any;
    const info: any = {
        capabilities: {
            absAxes: [
                InputEventCodes.ABS_MT_TRACKING_ID,
                InputEventCodes.ABS_MT_POSITION_X,
                InputEventCodes.ABS_MT_POSITION_Y,
            ],
            keyCodes: [InputEventCodes.BTN_TOUCH],
        },
        absInfo: {
            [InputEventCodes.ABS_MT_POSITION_X]: { min: 0, max: 10000, fuzz: 0, flat: 0, resolution: 10 },
            [InputEventCodes.ABS_MT_POSITION_Y]: { min: 0, max: 10000, fuzz: 0, flat: 0, resolution: 10 },
        },
        touchInfo: undefined,
    };
    const events: ({ type: "move"; dx: number; dy: number } | { type: "down" | "up" })[] = [];
    const tp = new TouchpadInput(dev, info, {
        mapX: (_c, v) => v / 10,
        mapY: (_c, v) => v / 10,
    });
    tp.on("move", (dx, dy) => events.push({ type: "move", dx, dy }));
    tp.on("button", (action) => events.push({ type: action }));

    const abs = (code: number, value: number) => dev.emit("absolute", code, value);
    const sync = () => dev.emit("sync");
    const down = (id: number, x = 1000, y = 1000) => {
        abs(InputEventCodes.ABS_MT_SLOT, 0);
        abs(InputEventCodes.ABS_MT_TRACKING_ID, id);
        abs(InputEventCodes.ABS_MT_POSITION_X, x);
        abs(InputEventCodes.ABS_MT_POSITION_Y, y);
        sync();
    };
    const move = (x: number) => {
        abs(InputEventCodes.ABS_MT_SLOT, 0);
        abs(InputEventCodes.ABS_MT_POSITION_X, x);
        sync();
    };
    const up = () => {
        abs(InputEventCodes.ABS_MT_SLOT, 0);
        abs(InputEventCodes.ABS_MT_TRACKING_ID, -1);
        sync();
    };

    // 轻触：按下、轻微抖动 1.2mm（低于阈值），抬起时发按下并保持拖拽窗口
    down(1);
    move(1012);
    up();
    // 第二下：先 1mm 内抖动（低于 1.3mm 阈值，不应移动），再拖到 page x=200
    down(2);
    move(1010);
    move(2000);
    up();

    return events;
}

type Sel = { type: "sel"; gesture: number; start: number; end: number; text: string };

describe("touchpad tap drag", () => {
    it("轻触后拖动的起点和物理拖动一致，不会变成点击", { timeout: 30000 }, async () => {
        const seq = tapDragSequence();
        // 轻触抖动不能变成 move 发出去，否则按下点会偏移
        expect(seq[0].type).toBe("down");
        const seqFile = "/tmp/myde_tap_drag_seq.json";
        fs.writeFileSync(seqFile, JSON.stringify(seq));

        const appJs = `
module.exports = ({ createWindow }) => {
    createWindow({ js: __filename, width: 640, height: 480, frame: false });
};
if (typeof document !== "undefined") {
    document.title = "myde-tap-drag-test";
    document.body.innerHTML =
        '<textarea id="ta" style="position:absolute;inset:0;font:20px monospace;line-height:28px;padding:20px;border:0;outline:0">' +
        'abcdefghijklmnopqrstuvwxyz0123456789\\nABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\\nabcdefghijklmnopqrstuvwxyz0123456789</textarea>';
    const ta = document.getElementById("ta");
    let gesture = 0;
    const log = (o) => console.log(JSON.stringify(o));
    document.addEventListener("mousedown", () => { gesture++; });
    document.addEventListener("selectionchange", () => {
        if (document.activeElement === ta) log({ type: "sel", gesture, start: ta.selectionStart, end: ta.selectionEnd, text: ta.value.slice(ta.selectionStart, ta.selectionEnd) });
    });
    document.addEventListener("mouseup", () => setTimeout(() => {
        if (document.activeElement === ta) log({ type: "sel", gesture, start: ta.selectionStart, end: ta.selectionEnd, text: ta.value.slice(ta.selectionStart, ta.selectionEnd) });
    }, 0));
}
`;
        const appFile = `/tmp/myde_tap_drag_app_${Date.now()}.js`;
        fs.writeFileSync(appFile, appJs);

        const { waitExit } = testRunnerApp(`test/electron_app/start.js ${appFile}`, async ({ server, runner }) => {
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            server.on("window.created", (info) => {
                void (async () => {
                    try {
                        server.notify("window.focus", info.handle);
                        for (let i = 0; i < 200 && (server.windows.preview(info.handle)?.width ?? 0) <= 1; i++)
                            await sleep(50);
                        await sleep(400);
                        // 用 Node 侧模拟出的 FSM 事件序列；这里只负责按语义事件注入
                        const seq = JSON.parse(
                            require("node:fs").readFileSync("/tmp/myde_tap_drag_seq.json", "utf8"),
                        ) as ({ type: "move"; dx: number; dy: number } | { type: "down" | "up" })[];
                        let x = 100;
                        let y = 100;
                        const notify = (type: "move" | "down" | "up") =>
                            server.notify("input.pointer", info.handle, { type, x, y, button: 0 });

                        const moveTo = async (nx: number, ny: number) => {
                            x = nx;
                            y = ny;
                            notify("move");
                            await sleep(60);
                        };
                        const down = async () => {
                            notify("down");
                            await sleep(60);
                        };
                        const up = async () => {
                            notify("up");
                            await sleep(60);
                        };

                        // 参照：物理拖动 100 → 200
                        await moveTo(100, 100);
                        await down();
                        for (const nx of [140, 180, 200]) await moveTo(nx, 100);
                        await up();
                        await sleep(300);
                        // 清掉选区
                        await moveTo(300, 100);
                        await down();
                        await up();
                        await sleep(300);
                        // 轻触 FSM：起点 100，拖到 200
                        await moveTo(100, 100);
                        for (const ev of seq) {
                            if (ev.type === "move") {
                                x += ev.dx;
                                y += ev.dy;
                                notify("move");
                                await sleep(60);
                            } else {
                                notify(ev.type);
                                await sleep(60);
                            }
                        }
                        await sleep(600);
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
        const g1 = sels.filter((s) => s.gesture === 1).at(-1);
        const g2 = sels.filter((s) => s.gesture === 2).at(-1);
        const g3 = sels.filter((s) => s.gesture === 3).at(-1);
        const dump = () => `sels=${JSON.stringify(sels)} raw=${JSON.stringify(raw).slice(0, 800)}`;
        expect(g1, `物理拖动没有选区 ${dump()}`).toBeDefined();
        expect(g1!.end, `物理拖动应选中文字 ${dump()}`).toBeGreaterThan(g1!.start);
        expect(g2, `清选区点击没有事件 ${dump()}`).toBeDefined();
        expect(g2!.start, `点击应塌缩 ${dump()}`).toBe(g2!.end);
        expect(g3, `轻触拖动没有选区 ${dump()}`).toBeDefined();
        expect(g3!.end, `轻触拖动不应塌缩成点击 ${dump()}`).toBeGreaterThan(g3!.start);
        // 起点与物理拖动一致（允许 1 个字符的取整误差）
        expect(Math.abs(g3!.start - g1!.start), `轻触起点错位 ${dump()}`).toBeLessThanOrEqual(1);
        expect(Math.abs(g3!.end - g1!.end), `轻触终点错位 ${dump()}`).toBeLessThanOrEqual(1);
    });
});
