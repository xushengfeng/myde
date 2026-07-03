import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { testRunnerApp } from "../../test_runner/test_runner";
import { mapKeyCode } from "../../input_map/web2x";

describe("keyboard app", () => {
    it("run test/simple_app/dmabuf_one_frame", { timeout: 8000 }, async () => {
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
        expect(mapKeyCode("Enter")).toBe(28);
        expect(mapKeyCode("Space")).toBe(57);
        expect(mapKeyCode("ArrowUp")).toBe(103);
        expect(mapKeyCode("ArrowDown")).toBe(108);
        expect(mapKeyCode("ArrowLeft")).toBe(105);
        expect(mapKeyCode("ArrowRight")).toBe(106);
        expect(mapKeyCode("Numpad0")).toBe(82);
        const { waitExit } = testRunnerApp(`test/electron_app/start.js ${tmpfile}`, ({ client, runner }) => {
            client.on("windowCreated", (windowId) => {
                client.win(windowId)?.focus();
                setTimeout(() => {
                    const win = client.win(windowId);
                    if (win) {
                        win.point.sendPointerEvent("move", { x: 16, y: 16, button: 0 });
                        const keys = [30, 48, 28, 57, 103, 108, 105, 106, 82];
                        for (const [i, key] of keys.entries()) {
                            setTimeout(
                                () => {
                                    client.keyboard.sendKey(key, "pressed");
                                },
                                50 * (i * 2 + 1),
                            );
                            setTimeout(
                                () => {
                                    client.keyboard.sendKey(key, "released");
                                },
                                50 * (i * 2 + 2),
                            );
                        }

                        setTimeout(
                            () => {
                                runner.kill();
                            },
                            50 * (keys.length * 2 + 1),
                        );
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
        expect(result[5].data).toBe(JSON.stringify({ key: "Enter", code: "Enter", type: "keydown" }));
        expect(result[6].data).toBe(JSON.stringify({ key: "Enter", code: "Enter", type: "keyup" }));
        expect(result[7].data).toBe(JSON.stringify({ key: " ", code: "Space", type: "keydown" }));
        expect(result[8].data).toBe(JSON.stringify({ key: " ", code: "Space", type: "keyup" }));
        expect(result[9].data).toBe(JSON.stringify({ key: "ArrowUp", code: "ArrowUp", type: "keydown" }));
        expect(result[10].data).toBe(JSON.stringify({ key: "ArrowUp", code: "ArrowUp", type: "keyup" }));
        expect(result[11].data).toBe(JSON.stringify({ key: "ArrowDown", code: "ArrowDown", type: "keydown" }));
        expect(result[12].data).toBe(JSON.stringify({ key: "ArrowDown", code: "ArrowDown", type: "keyup" }));
        expect(result[13].data).toBe(JSON.stringify({ key: "ArrowLeft", code: "ArrowLeft", type: "keydown" }));
        expect(result[14].data).toBe(JSON.stringify({ key: "ArrowLeft", code: "ArrowLeft", type: "keyup" }));
        expect(result[15].data).toBe(JSON.stringify({ key: "ArrowRight", code: "ArrowRight", type: "keydown" }));
        expect(result[16].data).toBe(JSON.stringify({ key: "ArrowRight", code: "ArrowRight", type: "keyup" }));
        expect(result[17].data).toBe(JSON.stringify({ key: "0", code: "Numpad0", type: "keydown" }));
        expect(result[18].data).toBe(JSON.stringify({ key: "0", code: "Numpad0", type: "keyup" }));
    });
});
