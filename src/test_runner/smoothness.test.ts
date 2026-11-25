import { describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "./desktop_runner";
import { FrameRecorder, formatReport, motionStats } from "./smoothness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 在页面上盖一层横向平移的条纹；用 CSS 动画，和桌面动画一样在合成器里推进。 */
async function startBanner(desktop: DesktopRunner, durationMs: number) {
    await desktop.evaluate(`
        (() => {
            const el = document.createElement("div");
            el.id = "smoothness-probe-banner";
            el.style.cssText =
                "position:fixed;inset:0;z-index:2147483647;" +
                "background:repeating-linear-gradient(90deg,#000,#fff 40px);will-change:transform";
            document.body.append(el);
            el.animate(
                [{ transform: "translateX(-40%)" }, { transform: "translateX(40%)" }],
                { duration: ${durationMs}, easing: "ease-out" },
            );
        })()
    `);
}

describe("smoothness recorder", () => {
    it("screencast：逐帧取像素并检测动画变化", { timeout: 60000 }, async () => {
        // 推流依赖真实合成，窗口要在私有 headless 显示里显示出来
        const desktop = await startDesktopRunner({ desktop: ":test", timeout: 30000, showWindow: true });
        try {
            await desktop.waitFor("!!document.body");
            const recorder = await FrameRecorder.start(desktop, { durationMs: 1200 });
            const markAt = recorder.mark("animate");
            await startBanner(desktop, 1000);
            await sleep(1050);
            const report = await recorder.stop();
            console.log(`\n${formatReport(report)}`);

            expect(report.sampling.fps, "合成帧推流没有达到可用采样率").toBeGreaterThan(10);
            const stats = motionStats(report, { fromMs: markAt - 20 });
            expect(stats.activeFrames, "没有检测到动画变化").toBeGreaterThanOrEqual(3);
            expect(stats.spanMs, "动画变化没有跨越多帧").toBeGreaterThanOrEqual(200);
            // 逐帧推流 + 连续位移，不应出现单帧吃掉大部分变化
            expect(stats.peakShare).toBeLessThan(0.6);
        } finally {
            await desktop.close();
        }
    });
});
