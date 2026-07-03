import { describe, expect, it } from "vitest";
import { testRunnerApp } from "../../test_runner/test_runner";

describe("dma-buf", () => {
    it("run test/simple_app/dmabuf_one_frame", async () => {
        const { waitExit } = testRunnerApp("test/simple_app/target/debug/dmabuf_one_frame", ({ client, runner }) => {
            client.on("windowCreated", (windowId) => {
                client.win(windowId)?.focus();
                setTimeout(() => {
                    const win = client.win(windowId);
                    if (win) {
                        const canvas = win.getPreview();
                        // biome-ignore lint/style/noNonNullAssertion: ig
                        const ctx = canvas.getContext("2d")!;
                        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                        const data = imageData.data;
                        runner.sendData({
                            data: Array.from(data).slice(0, 200),
                            size: imageData.data.byteLength,
                            everyZero: Array.from(data).every((v) => v === 0),
                            width: canvas.width,
                            height: canvas.height,
                        });
                        runner.kill();
                    }
                }, 200);
            });
        });
        const result = (await waitExit()) as [
            { data: number[]; everyZero: boolean; size: number; width: number; height: number },
        ];
        expect(result[0].data.slice(0, 12)).toEqual([0, 0, 0, 255, 1, 0, 1, 255, 2, 0, 2, 255]);
        expect(result[0].everyZero).toBe(false);
        expect(result[0].size).toBe(256 * 256 * 4);
        expect(result[0].width).toBe(256);
        expect(result[0].height).toBe(256);
    });
});
