import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../src/test_runner/desktop_runner";
import {
    FrameRecorder,
    formatReport,
    type MotionWindow,
    motionStats,
    responseLatencies,
    type SmoothnessReport,
} from "../../../src/test_runner/smoothness";

const entry = path.join(__dirname, "../dist/index.js");
const hasBuild = fs.existsSync(entry);
const run = hasBuild ? it : it.skip;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * “输入到第一帧变化”的容忍上限。
 *
 * 这条链路包含 CDP 发按键/鼠标（一次按下是多个协议往返）、合成器出帧、
 * 推流到测试进程，所以比应用自身延迟大；超过它说明动画确实没有立即响应。
 */
const RESPONSE_LIMIT_MS = 350;

/**
 * 官方桌面流畅度测试。
 *
 * 判定依据全部来自逐帧像素变化：
 * - 好的动画把总变化分散到多帧，单帧变化占比（peakShare）低；
 * - 输入后应尽快出现第一帧变化（响应延迟）；
 * - 动画过程中不应长时间静止（maxStall）；
 * - 连续输入/打断时，变化方向（flow）应立即跟着改。
 */
async function withDesktop(test: (desktop: DesktopRunner) => Promise<void>) {
    const desktop = await startDesktopRunner({
        desktop: "desktop/official",
        timeout: 60000,
        // 逐帧推流需要窗口真正合成；窗口只出现在私有 headless 显示里
        showWindow: true,
    });
    try {
        await desktop.waitFor("document.documentElement.dataset.desktopReady === '1'", 60000);
        // 等首屏绘制和预加载稳定，避免把初始化帧算进动画
        await sleep(400);
        await test(desktop);
    } finally {
        await desktop.close();
    }
}

function logReport(name: string, report: SmoothnessReport, window: MotionWindow = {}) {
    console.log(`\n[${name}] 采样 ${report.sampling.fps.toFixed(1)} fps\n${formatReport(report, window)}`);
}

function latenciesOf(report: SmoothnessReport) {
    return Object.fromEntries(responseLatencies(report).map((item) => [item.label, item.latencyMs] as const)) as Record<
        string,
        number | undefined
    >;
}

function expectResponded(latency: number | undefined, message: string) {
    expect(latency, message).toBeTypeOf("number");
    expect(latency, message).toBeLessThanOrEqual(RESPONSE_LIMIT_MS);
}

/** 采样太慢时报告的“帧”不代表真实动画，先挡住这种无效结论。 */
function expectUsableSampling(report: SmoothnessReport) {
    expect(report.sampling.fps, "采样率过低，无法判断动画是否平滑").toBeGreaterThan(15);
}

/**
 * 动画中途允许的最大停顿。
 *
 * 测试机器本身会抖（CDP、合成器、推流都在同一条链路上），允许连续掉几帧；
 * 真正“动画停下等下一段”通常在百毫秒以上，仍会被抓住。
 */
function expectNoStall(report: SmoothnessReport, stats: ReturnType<typeof motionStats>, message: string) {
    const limit = Math.max(120, report.sampling.intervalMedianMs * 7);
    expect(stats.maxStallMs, `${message}（上限 ${limit.toFixed(0)}ms）`).toBeLessThanOrEqual(limit);
}

describe("official desktop smoothness", () => {
    run("启动器展开/收起：动画分散、不跳变、输入立即响应", { timeout: 120000 }, async () => {
        await withDesktop(async (desktop) => {
            // 只看顶部区域：启动器滑入/滑出的变化都集中在这里
            const recorder = await FrameRecorder.start(desktop, {
                durationMs: 1000,
                region: { x: 0, y: 0, width: 4000, height: 400 },
            });
            await sleep(120);
            const openAt = recorder.mark("open");
            await desktop.key("Space", { modifiers: 1 });
            await sleep(380);
            const closeAt = recorder.mark("close");
            await desktop.key("Space", { modifiers: 1 });
            await sleep(400);
            const report = await recorder.stop();
            logReport("launcher", report);

            expectUsableSampling(report);
            const latency = latenciesOf(report);
            expectResponded(latency.open, "按下 Alt+Space 后画面应很快变化");
            expectResponded(latency.close, "再按一次后画面应很快变化");

            const opening = motionStats(report, { fromMs: openAt - 20, toMs: closeAt - 20 });
            const closing = motionStats(report, { fromMs: closeAt - 20 });
            for (const [phase, stats] of [
                ["展开", opening],
                ["收起", closing],
            ] as const) {
                // 160ms 的动画至少要看到几帧，而不是一帧跳到位
                expect(stats.activeFrames, `${phase}动画几乎没有中间帧`).toBeGreaterThanOrEqual(3);
                expect(stats.spanMs, `${phase}动画应持续一段时间`).toBeGreaterThanOrEqual(60);
                expect(stats.peakShare, `${phase}动画单帧变化占比过高，看起来是跳变`).toBeLessThanOrEqual(0.6);
                expectNoStall(report, stats, `${phase}动画中间停顿过长`);
            }
        });
    });

    run("全局预览进入/退出：动画分散、不跳变", { timeout: 120000 }, async () => {
        await withDesktop(async (desktop) => {
            const enter = await FrameRecorder.start(desktop, { durationMs: 900 });
            await sleep(120);
            const enterAt = enter.mark("enter");
            await desktop.key("Tab", { modifiers: 4 });
            await sleep(450);
            const enterReport = await enter.stop();
            logReport("overview-enter", enterReport);

            // 预览里启动器输入框会拿到焦点，Escape 会先被它消费（只失焦），先手动失焦
            await desktop.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()");
            const exit = await FrameRecorder.start(desktop, { durationMs: 900 });
            await sleep(120);
            const exitAt = exit.mark("exit");
            await desktop.key("Escape");
            await sleep(450);
            const exitReport = await exit.stop();
            logReport("overview-exit", exitReport);

            for (const [name, report, markAt] of [
                ["进入预览", enterReport, enterAt],
                ["退出预览", exitReport, exitAt],
            ] as const) {
                expectUsableSampling(report);
                const stats = motionStats(report, { fromMs: markAt - 20 });
                expectResponded(latenciesOf(report)[name === "进入预览" ? "enter" : "exit"], `${name}没有立即响应`);
                // 320ms 的缩放/位移动画，95% 运动量至少跨过半个动画时长
                expect(stats.activeFrames, `${name}几乎没有中间帧`).toBeGreaterThanOrEqual(5);
                expect(stats.spanMs, `${name}动画持续时间太短，像瞬间切过去`).toBeGreaterThanOrEqual(150);
                expect(stats.peakShare, `${name}单帧变化占比过高，看起来是跳变`).toBeLessThanOrEqual(0.5);
                expectNoStall(report, stats, `${name}动画中间停顿过长`);
            }
        });
    });

    run("切屏动画平滑，且中途反向立即响应", { timeout: 120000 }, async () => {
        await withDesktop(async (desktop) => {
            const normal = await FrameRecorder.start(desktop, { durationMs: 800 });
            await sleep(120);
            const normalAt = normal.mark("switch");
            await desktop.key("ArrowLeft", { modifiers: 4 });
            await sleep(600);
            const normalReport = await normal.stop();
            logReport("screen-switch", normalReport);

            expectUsableSampling(normalReport);
            expectResponded(latenciesOf(normalReport).switch, "切屏输入后画面应很快开始移动");
            const whole = motionStats(normalReport, { fromMs: normalAt - 20 });
            // 320ms 的横滑动画至少跨过半个时长，而不是一帧切过去
            expect(whole.activeFrames, "切屏动画几乎没有中间帧").toBeGreaterThanOrEqual(5);
            expect(whole.spanMs, "切屏动画持续时间太短").toBeGreaterThanOrEqual(100);
            expect(whole.peakShare, "切屏动画单帧变化占比过高").toBeLessThanOrEqual(0.5);
            expectNoStall(normalReport, whole, "切屏动画中间停顿过长");
            expect(whole.flow.x, "切到右屏时内容应整体左移").toBeLessThan(-40);

            // 回到起始屏，等动画结束
            await desktop.key("ArrowRight", { modifiers: 4 });
            await sleep(600);

            const interrupted = await FrameRecorder.start(desktop, { durationMs: 1000 });
            await sleep(120);
            const leftAt = interrupted.mark("left");
            await desktop.key("ArrowLeft", { modifiers: 4 });
            // 320ms 动画进行到约 1/3 时反向
            await sleep(110);
            const rightAt = interrupted.mark("right");
            await desktop.key("ArrowRight", { modifiers: 4 });
            await sleep(500);
            const report = await interrupted.stop();
            logReport("screen-interrupt", report);

            expectUsableSampling(report);
            const latency = latenciesOf(report);
            expectResponded(latency.left, "切屏输入后画面应很快开始移动");
            expectResponded(latency.right, "打断后画面应继续更新，而不是停住等上一段动画");

            const forward = motionStats(report, { fromMs: leftAt - 20, toMs: rightAt - 1 });
            // 全屏横滑的方向应明确：去右屏时内容整体左移
            expect(forward.flow.x, "第一次切屏应向左移动").toBeLessThan(-40);

            // 反向的判定用逐帧方向，而不是把整段位移加起来：按键送达前
            // 还有几帧仍在向左走，累计和会被这段尾巴抵消。
            const afterReverse = report.diffs.filter((d) => d.at > rightAt && d.meanDiff >= 0.2);
            const movingRight = afterReverse.filter((d) => d.flowX > 0);
            const movingLeft = afterReverse.filter((d) => d.flowX < 0);
            expect(movingRight.length, "打断后画面没有再往右移动").toBeGreaterThanOrEqual(3);
            const lastLeftAt = movingLeft.length > 0 ? Math.max(...movingLeft.map((d) => d.at)) : rightAt;
            // 真正可打断的实现会在一两帧内停止向左；等上一段 320ms 动画放完再反向会超过这个上限
            expect(lastLeftAt - rightAt, "反向被推迟到上一段动画结束之后").toBeLessThanOrEqual(200);
            const flipAt = movingRight[0].at;
            expect(flipAt - rightAt, "打断后没有及时改方向").toBeLessThanOrEqual(250);
            const reversed = motionStats(report, { fromMs: flipAt - 1 });
            expect(reversed.flow.x, "反向阶段累计位移应向右").toBeGreaterThan(40);

            // 打断点不能出现单帧跳变：整段运动仍应分散在多帧
            const overall = motionStats(report);
            expect(overall.peakShare, "反向过程出现单帧跳变").toBeLessThanOrEqual(0.4);
            expectNoStall(report, overall, "反向过程中间停顿过长");
        });
    });

    run("拖拽窗口跟手：连续输入持续响应、反向立即生效", { timeout: 120000 }, async () => {
        await withDesktop(async (desktop) => {
            // 用搜索打开设置窗口（内部窗口，标题栏可以直接拖）
            await desktop.key("Space", { modifiers: 1 });
            await desktop.waitFor(
                `getComputedStyle(document.querySelector("[data-launcher-input]")).opacity === "1"`,
                5000,
            );
            await desktop.text("shezhi");
            await desktop.waitFor(
                `[...document.querySelectorAll("[data-desktop-ui='launcher'] *")].some((el) => el.textContent.includes("设置"))`,
                5000,
            );
            await desktop.key("Enter");
            await desktop.waitFor(`!!document.querySelector("[data-internal-window]")`, 5000);
            await sleep(600);

            const rect = await desktop.evaluate<{ x: number; y: number; width: number; height: number }>(`
                (() => {
                    const el = document.querySelector("[data-internal-window]");
                    const r = el.getBoundingClientRect();
                    return { x: r.left, y: r.top, width: r.width, height: r.height };
                })()
            `);
            const startX = rect.x + rect.width / 2;
            const startY = rect.y + 24;

            const recorder = await FrameRecorder.start(desktop, { durationMs: 1400 });
            await sleep(120);
            const downAt = recorder.mark("down");
            await desktop.mouse({ type: "down", x: startX, y: startY });
            for (let i = 1; i <= 10; i++) {
                await sleep(16);
                await desktop.mouse({ type: "move", x: startX + i * 20, y: startY });
            }
            const reverseAt = recorder.mark("reverse");
            for (let i = 9; i >= -10; i--) {
                await sleep(16);
                await desktop.mouse({ type: "move", x: startX + i * 20, y: startY });
            }
            const upAt = recorder.mark("up");
            await desktop.mouse({ type: "up", x: startX - 200, y: startY });
            const report = await recorder.stop();
            logReport("window-drag", report);

            expectUsableSampling(report);
            const latency = latenciesOf(report);
            expectResponded(latency.down, "按下标题栏后窗口应很快跟手");
            expectResponded(latency.reverse, "反向拖动应立即改变方向");

            const forward = motionStats(report, { fromMs: downAt - 20, toMs: reverseAt - 1 });
            const backward = motionStats(report, { fromMs: reverseAt - 1, toMs: upAt });
            // 连续拖动期间不应该有“输入了但画面没动”的采样帧
            expect(forward.activeRatio, "向右拖动过程中出现静止帧").toBeGreaterThanOrEqual(0.6);
            expect(backward.activeRatio, "向左拖动过程中出现静止帧").toBeGreaterThanOrEqual(0.6);
            expect(forward.flow.x, "向右拖动时内容应右移").toBeGreaterThan(0);
            expect(backward.flow.x, "反向拖动后内容应左移").toBeLessThan(0);
            // 跟手是逐帧小位移，单帧吃掉大部分运动说明出现了跳变
            expect(forward.peakShare, "拖动过程出现跳变").toBeLessThanOrEqual(0.4);
            expect(backward.peakShare, "反向拖动出现跳变").toBeLessThanOrEqual(0.4);
            expectNoStall(report, forward, "向右拖动过程中停顿过长");
            expectNoStall(report, backward, "向左拖动过程中停顿过长");
        });
    });
});
