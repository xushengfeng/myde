import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { testRunnerApp } from "../../test_runner/test_runner";
import { mapKeyCode } from "../../input_map/web2x";

describe("keyboard app", () => {
    it("run test/simple_app/dmabuf_one_frame", async () => {
        const k = () => {
            const input = document.createElement("input");
            document.body.appendChild(input);
            input.onkeydown = (e) => {
                console.log(JSON.stringify({ key: e.key, code: e.code, type: "keydown" }));
            };
            input.onkeyup = (e) => {
                console.log(JSON.stringify({ key: e.key, code: e.code, type: "keyup" }));
            };
            input.focus();
            console.log("testRunnerApp started");
        };
        const tmpfile = `/tmp/test_keyboard_${Date.now()}.js`;
        fs.writeFileSync(tmpfile, `(${k.toString()})()`);
        expect(mapKeyCode("KeyA")).toBe(30);
        expect(mapKeyCode("KeyB")).toBe(48);
        const { waitExit } = testRunnerApp(`test/electron_app/start.js ${tmpfile}`, ({ client, runner }) => {
            client.on("windowCreated", (windowId) => {
                client.win(windowId)?.focus();
                setTimeout(() => {
                    const win = client.win(windowId);
                    if (win) {
                        win.point.sendPointerEvent("move", { x: 16, y: 16, button: 0 });
                        setTimeout(() => {
                            client.keyboard.sendKey(30, "pressed");
                        }, 50);
                        setTimeout(() => {
                            client.keyboard.sendKey(30, "released");
                        }, 50 * 2);
                        setTimeout(() => {
                            client.keyboard.sendKey(48, "pressed");
                        }, 50 * 3);
                        setTimeout(() => {
                            client.keyboard.sendKey(48, "released");
                        }, 50 * 4);
                        setTimeout(() => {
                            runner.kill();
                        }, 50 * 5);
                    }
                }, 200);
            });
        });
        const _result = (await waitExit()) as [{ applog: string }];
        const result = _result.map((x) => JSON.parse(x.applog)) as {
            data: string;
        }[];

        expect(result[0].data).toBe("testRunnerApp started");
        expect(result[1].data).toBe(JSON.stringify({ key: "a", code: "KeyA", type: "keydown" }));
        expect(result[2].data).toBe(JSON.stringify({ key: "a", code: "KeyA", type: "keyup" }));
        expect(result[3].data).toBe(JSON.stringify({ key: "b", code: "KeyB", type: "keydown" }));
        expect(result[4].data).toBe(JSON.stringify({ key: "b", code: "KeyB", type: "keyup" }));
    });
});
