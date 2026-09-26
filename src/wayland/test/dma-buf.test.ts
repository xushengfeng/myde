import { describe, expect, it } from "vitest";
import { testRunnerApp } from "../../test_runner/test_runner";

describe("dma-buf", () => {
    it("run test/simple_app/dmabuf_one_frame", { timeout: 15000 }, async () => {
        const { waitExit } = testRunnerApp("test/simple_app/target/debug/dmabuf_one_frame", ({ server, runner }) => {
            server.on("window.created", (info) => {
                server.notify("window.focus", info.handle);
                setTimeout(() => {
                    const canvas = server.windows.preview(info.handle);
                    if (canvas) {
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
        const result = (await waitExit()) as {
            data?: number[];
            everyZero?: boolean;
            size?: number;
            width?: number;
            height?: number;
            applog?: string;
        }[];
        // 应用 stdout（applog）与 sendData 载荷混在同一数组里，且到达顺序不稳定，
        // 不能按下标取，按字段筛选
        const preview = result.find((r) => Array.isArray(r.data));
        expect(preview, `未收到预览数据，实际收到: ${JSON.stringify(result).slice(0, 300)}`).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: 上面已断言存在
        const p = preview!;
        expect(p.data!.slice(0, 12)).toEqual([0, 0, 0, 255, 1, 0, 1, 255, 2, 0, 2, 255]);
        expect(p.everyZero).toBe(false);
        expect(p.size).toBe(256 * 256 * 4);
        expect(p.width).toBe(256);
        expect(p.height).toBe(256);
    });
});
