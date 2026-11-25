import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "./desktop_runner";
import { FrameRecorder, formatReport, motionStats } from "./smoothness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let desktop: DesktopRunner;

/** 盖在页面最上层的探针；每个用例开始前清掉 */
async function clearProbes() {
    await desktop.evaluate(`document.querySelectorAll("[data-smoothness-probe]").forEach((el) => el.remove())`);
}

/** 横向平移的条纹；用 CSS 动画，和桌面动画一样在合成器里推进。 */
async function startBanner(durationMs: number) {
    await desktop.evaluate(`
        (() => {
            const el = document.createElement("div");
            el.setAttribute("data-smoothness-probe", "");
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

/** 先放好静态条纹，单独开始动画：避免“条纹出现”本身被当成一次跳变 */
async function addBanner() {
    await desktop.evaluate(`
        (() => {
            const el = document.createElement("div");
            el.setAttribute("data-smoothness-probe", "");
            el.style.cssText =
                "position:fixed;inset:0;z-index:2147483647;" +
                "background:repeating-linear-gradient(90deg,#000,#fff 40px);will-change:transform";
            document.body.append(el);
        })()
    `);
}

async function animateBanner(durationMs: number) {
    await desktop.evaluate(`
        document.querySelector("[data-smoothness-probe]").animate(
            [{ transform: "translateX(-40%)" }, { transform: "translateX(40%)" }],
            { duration: ${durationMs}, easing: "ease-out" },
        )
    `);
}

/** 整屏底色；用来做一次 commit 直接跳变的对照 */
async function addCover() {
    await desktop.evaluate(`
        (() => {
            const el = document.createElement("div");
            el.setAttribute("data-smoothness-probe", "");
            el.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#fff";
            document.body.append(el);
        })()
    `);
}

async function setCover(color: string) {
    await desktop.evaluate(`document.querySelector("[data-smoothness-probe]").style.background = "${color}"`);
}

describe("smoothness recorder", () => {
    beforeAll(async () => {
        // 推流依赖真实合成，窗口要在私有 headless 显示里显示出来
        desktop = await startDesktopRunner({ desktop: ":test", timeout: 30000, showWindow: true });
        await desktop.waitFor("!!document.body");
    }, 60000);

    afterAll(async () => {
        if (desktop) await desktop.close();
    });

    it("screencast：逐帧取像素并检测动画变化", { timeout: 60000 }, async () => {
        await clearProbes();
        const recorder = await FrameRecorder.start(desktop, { durationMs: 1200 });
        const markAt = recorder.mark("animate");
        await startBanner(1000);
        await sleep(1050);
        const report = await recorder.stop();
        console.log(`\n${formatReport(report)}`);

        expect(report.sampling.fps, "合成帧推流没有达到可用采样率").toBeGreaterThan(10);
        const stats = motionStats(report, { fromMs: markAt - 20 });
        expect(stats.activeFrames, "没有检测到动画变化").toBeGreaterThanOrEqual(3);
        expect(stats.spanMs, "动画变化没有跨越多帧").toBeGreaterThanOrEqual(200);
        // 逐帧推流 + 连续位移，不应出现单帧吃掉大部分变化
        expect(stats.peakShare).toBeLessThan(0.6);
    });

    // 反例：判定标准必须能把“一帧直接跳过去”和平滑动画区分开，否则上面的 peakShare 断言没有意义。
    // 同时用窗口动画测试的配置（flow:false、maxSide:480）再验证一次，确认省掉位移估计不削弱跳变检测。
    it("flow:false、maxSide:480 下仍能区分平滑动画和瞬时跳变", { timeout: 60000 }, async () => {
        await clearProbes();
        await addBanner();
        await sleep(150);
        const smooth = await FrameRecorder.start(desktop, { durationMs: 1000, maxSide: 480, flow: false });
        const smoothAt = smooth.mark("smooth");
        await animateBanner(800);
        await sleep(850);
        const smoothReport = await smooth.stop();
        console.log(`\n${formatReport(smoothReport)}`);
        const smoothStats = motionStats(smoothReport, { fromMs: smoothAt - 20 });
        expect(smoothStats.activeFrames, "没有检测到平滑动画的变化").toBeGreaterThanOrEqual(3);
        expect(smoothStats.peakShare, "平滑动画不应被判成跳变").toBeLessThan(0.6);
        expect(smoothStats.flow, "flow:false 时不做位移估计").toEqual({ x: 0, y: 0 });

        // 同一配置下做一次真正的跳变：整屏颜色在两次 commit 之间切换
        await clearProbes();
        await addCover();
        await sleep(250);
        const jump = await FrameRecorder.start(desktop, { durationMs: 1200, maxSide: 480, flow: false });
        await sleep(100);
        const jumpAt = jump.mark("jump");
        await setCover("#202020");
        await sleep(300);
        const jumpReport = await jump.stop();
        console.log(`\n${formatReport(jumpReport)}`);
        const jumpStats = motionStats(jumpReport, {
            fromMs: jumpAt - 100,
            toMs: jumpAt + 300,
            activeChangedRatio: 0.001,
        });
        expect(jumpStats.activeFrames, "跳变应只落在很少的帧上").toBeLessThanOrEqual(3);
        expect(jumpStats.peakShare, "瞬时跳变应被判为单帧吃掉大部分变化").toBeGreaterThan(0.6);
    });
});
