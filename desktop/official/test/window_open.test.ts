import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../src/test_runner/desktop_runner";
import { sleep } from "../../../src/test_runner/process_utils";
import {
    FrameRecorder,
    formatReport,
    type MotionStats,
    motionStats,
    responseLatencies,
    type SmoothnessReport,
} from "../../../src/test_runner/smoothness";
import { getProjectRoot } from "../../../src/test_runner/test_runner";

const entry = path.join(__dirname, "../dist/index.js");
const binary = path.join(getProjectRoot(), "test/simple_app/target/debug/window_open");
const hasBuild = fs.existsSync(entry) && fs.existsSync(binary);
const run = hasBuild ? it : it.skip;

const APP_ID = "window-open-test";
/** 输入到第一帧变化的容忍上限；包含 CDP、进程启动和合成器出帧 */
const RESPONSE_LIMIT_MS = 500;
/** 测试窗口内容的棋盘格比白底暗，用它确认首帧真的画上来了 */
const WHITE_LUMA = 235;

type OpenCase = {
    name: string;
    /** 相对 launchApp 调用的 ms；`never` 表示不建窗 / 不出首帧 */
    create?: number | "never";
    buffer?: number | "never";
    fullscreen?: number;
    width?: number;
    height?: number;
    sizeMode?: "fixed" | "configure";
    /** 记录多久（ms）；到达后停止采样 */
    wait: number;
    /** 期望最终画面：窗口已替换面板 / 面板还是空占位 */
    expectPanel: "none" | "cover";
    /** 在这个时刻（相对 launchApp）检查空占位面板已经露出关闭按钮 */
    expectCloseAt?: number;
};

const CASES: OpenCase[] = [
    { name: "立即显示 800×600", create: 0, buffer: 0, wait: 1300, expectPanel: "none" },
    { name: "回弹结束前出首帧", create: 0, buffer: 300, wait: 1500, expectPanel: "none" },
    { name: "飞行中出首帧", create: 0, buffer: 450, wait: 1600, expectPanel: "none" },
    { name: "嵌入点出首帧", create: 0, buffer: 650, wait: 1800, expectPanel: "none" },
    { name: "淡入结束后出首帧", create: 0, buffer: 900, wait: 2100, expectPanel: "none" },
    { name: "窗口先到、首帧很晚", create: 0, buffer: 3800, wait: 4800, expectPanel: "none" },
    { name: "永不建窗", create: "never", buffer: "never", wait: 4300, expectPanel: "cover", expectCloseAt: 1600 },
    { name: "建窗但永不首帧", create: 0, buffer: "never", wait: 1600, expectPanel: "none" },
    // 窗口创建晚于面板落地（xwayland 之类要先建连接再出窗口）
    {
        name: "窗口在面板落地后才建",
        create: 2200,
        buffer: 2300,
        wait: 3600,
        expectPanel: "none",
        expectCloseAt: 1600,
    },
    {
        name: "窗口晚建（关闭按钮之后）",
        create: 2200,
        buffer: 3200,
        wait: 4200,
        expectPanel: "none",
        expectCloseAt: 1600,
    },
    {
        name: "窗口晚建但永不首帧",
        create: 2200,
        buffer: "never",
        wait: 3800,
        expectPanel: "none",
        expectCloseAt: 1600,
    },
    {
        name: "大窗 1200×900（首帧在飞行中）",
        create: 0,
        buffer: 450,
        width: 1200,
        height: 900,
        wait: 1700,
        expectPanel: "none",
    },
    {
        name: "大窗 1600×1000（首帧在嵌入点）",
        create: 0,
        buffer: 650,
        width: 1600,
        height: 1000,
        wait: 1900,
        expectPanel: "none",
    },
    {
        name: "超大窗 2560×1440（首帧在嵌入点）",
        create: 0,
        buffer: 650,
        width: 2560,
        height: 1440,
        wait: 1900,
        expectPanel: "none",
    },
    {
        name: "全屏（首帧之前）",
        create: 0,
        buffer: 300,
        fullscreen: 0,
        sizeMode: "configure",
        wait: 1700,
        expectPanel: "none",
    },
    {
        name: "全屏（首帧之后）",
        create: 0,
        buffer: 200,
        fullscreen: 450,
        sizeMode: "configure",
        wait: 1900,
        expectPanel: "none",
    },
    {
        name: "全屏（飞行中）",
        create: 0,
        buffer: 0,
        fullscreen: 450,
        sizeMode: "configure",
        wait: 1900,
        expectPanel: "none",
    },
    {
        name: "全屏（动画结束后）",
        create: 0,
        buffer: 0,
        fullscreen: 1100,
        sizeMode: "configure",
        wait: 2400,
        expectPanel: "none",
    },
];

type AppEvent = { event: string; t: number; extra?: { width?: number; height?: number; appid?: string } };

type FrameSnapshot = {
    screens: number;
    frames: number;
    panels: number;
    frameRect: { x: number; y: number; width: number; height: number } | null;
    fullscreen: boolean;
    screenId: string | null;
    closeVisible: boolean;
};

let desktop: DesktopRunner;
let viewport = { width: 0, height: 0 };
let tmpDir = "";

function readEvents(file: string): AppEvent[] {
    if (!fs.existsSync(file)) return [];
    return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line) as AppEvent;
            } catch {
                return undefined;
            }
        })
        .filter((e): e is AppEvent => !!e);
}

const screenCount = () => desktop.evaluate<number>(`document.querySelectorAll("[data-view-id]").length`);

const frameSnapshot = () =>
    desktop.evaluate<FrameSnapshot>(`
        (() => {
            const frame = document.querySelector("[data-client-frame]");
            const rect = frame ? frame.getBoundingClientRect() : null;
            return {
                screens: document.querySelectorAll("[data-view-id]").length,
                frames: document.querySelectorAll("[data-client-frame]").length,
                panels: document.querySelectorAll("[data-desktop-ui='launch-panel']").length,
                frameRect: rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null,
                fullscreen: !!document.querySelector("[data-client-frame][data-fullscreen]"),
                screenId: frame ? frame.closest("[data-view-id]")?.getAttribute("data-view-id") ?? null : null,
                closeVisible: (() => {
                    const btn = document.querySelector("[data-desktop-ui='launch-panel'] [data-desktop-ui='window-control']");
                    return !!btn && getComputedStyle(btn).display !== "none";
                })(),
            };
        })()
    `);

async function watchScreens() {
    await desktop.evaluate(`
        (() => {
            window.__windowOpenObserver?.disconnect();
            window.__windowOpenCounts = [{ t: Date.now(), n: document.querySelectorAll("[data-view-id]").length }];
            let last = window.__windowOpenCounts[0].n;
            window.__windowOpenObserver = new MutationObserver(() => {
                const n = document.querySelectorAll("[data-view-id]").length;
                if (n !== last) {
                    last = n;
                    window.__windowOpenCounts.push({ t: Date.now(), n });
                }
            });
            window.__windowOpenObserver.observe(document.documentElement, { childList: true, subtree: true });
        })()
    `);
}

async function takeScreenCounts(): Promise<{ t: number; n: number }[]> {
    return desktop.evaluate<{ t: number; n: number }[]>("window.__windowOpenCounts ?? []");
}

/** 冷启动一次应用，让 Xwayland 预热，避免第一个用例把 Xwayland 启动时间算进“即时”。 */
async function warmUp() {
    const t0 = Date.now();
    await desktop.evaluate(`
        __mydeTest.launchApp({
            exec: ${JSON.stringify(binary)},
            name: "Window Open Warmup",
            appid: ${JSON.stringify(APP_ID)},
            env: ${JSON.stringify({
                APP_ID,
                CREATE_AT: String(t0),
                BUFFER_AT: String(t0),
                WIDTH: "800",
                HEIGHT: "600",
                SIZE_MODE: "fixed",
                LIFETIME_MS: "1500",
            })},
        })
    `);
    await desktop.waitFor(`!!document.querySelector("[data-client-frame]")`, 5000);
    // 等启动动画稳定再关；太早关闭会和认领/挂载竞争
    await sleep(900);
    await closeTestWindows();
}

async function closeTestWindows() {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await desktop.evaluate("__mydeTest.closeWindows(); __mydeTest.closeLaunchPanels();");
        } catch {}
        try {
            await desktop.waitFor(`document.querySelectorAll("[data-view-id]").length === 2`, 1500);
            await sleep(100);
            return;
        } catch {}
        try {
            await desktop.evaluate("__mydeTest.forceCloseWindows(); __mydeTest.closeLaunchPanels();");
        } catch {}
    }
    await desktop.waitFor(`document.querySelectorAll("[data-view-id]").length === 2`, 3000);
}

function eventTime(events: AppEvent[], name: string): number | undefined {
    return events.find((e) => e.event === name)?.t;
}

function reportTime(launchEpoch: number, markAt: number, epoch: number) {
    return markAt + (epoch - launchEpoch);
}

function latenciesOf(report: SmoothnessReport) {
    return Object.fromEntries(responseLatencies(report).map((item) => [item.label, item.latencyMs] as const)) as Record<
        string,
        number | undefined
    >;
}

function expectNoStall(report: SmoothnessReport, stats: MotionStats, message: string) {
    const limit = Math.max(200, report.sampling.intervalMedianMs * 10);
    expect(stats.maxStallMs, `${message}（上限 ${limit.toFixed(0)}ms）`).toBeLessThanOrEqual(limit);
}

/** 最后一帧里窗口矩形内的平均亮度，用来判断白底还是客户端内容 */
function frameLuma(report: SmoothnessReport, rect: FrameSnapshot["frameRect"]): number | undefined {
    const frame = report.frames[report.frames.length - 1];
    if (!frame || !rect) return undefined;
    const scaleX = frame.width / viewport.width;
    const scaleY = frame.height / viewport.height;
    const x0 = Math.max(0, Math.min(frame.width - 1, Math.floor(rect.x * scaleX)));
    const y0 = Math.max(0, Math.min(frame.height - 1, Math.floor(rect.y * scaleY)));
    const x1 = Math.max(x0 + 1, Math.min(frame.width, Math.ceil((rect.x + rect.width) * scaleX)));
    const y1 = Math.max(y0 + 1, Math.min(frame.height, Math.ceil((rect.y + rect.height) * scaleY)));
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            sum += frame.luma[y * frame.width + x];
            count++;
        }
    }
    return count > 0 ? sum / count : undefined;
}

describe("official desktop window open animation", () => {
    beforeAll(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myde-window-open-"));
        desktop = await startDesktopRunner({
            desktop: "desktop/official",
            timeout: 60000,
            showWindow: true,
        });
        await desktop.waitFor("document.documentElement.dataset.desktopReady === '1'", 60000);
        viewport = await desktop.evaluate<{ width: number; height: number }>(
            "({ width: window.innerWidth, height: window.innerHeight })",
        );
        await sleep(400);
        await warmUp();
    });

    // 上一个用例失败时也要把桌面恢复到初始状态，避免后面全部连锁失败
    beforeEach(async () => {
        if (desktop) await closeTestWindows();
    });

    afterAll(async () => {
        if (desktop) await desktop.close();
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    for (const openCase of CASES) {
        run(`打开动画：${openCase.name}`, { timeout: 30000 }, async () => {
            const eventsFile = path.join(tmpDir, `${openCase.name.replace(/[^\w\u4e00-\u9fa5]+/g, "_")}.jsonl`);
            fs.rmSync(eventsFile, { force: true });
            const before = await screenCount();
            expect(before, "每个用例开始前应该回到初始虚拟屏数量").toBe(2);
            await watchScreens();

            const recorder = await FrameRecorder.start(desktop, {
                durationMs: openCase.wait + 500,
                // 关注整个舞台；窗口尺寸最大 2560×1440，缩小后仍能看清运动
                maxSide: 800,
            });
            await sleep(100);
            const launchEpoch = Date.now();
            const markAt = recorder.mark("launch");
            const env: Record<string, string> = {
                EVENTS_FILE: eventsFile,
                APP_ID,
                CREATE_AT: openCase.create === "never" ? "never" : String(launchEpoch + (openCase.create ?? 0)),
                BUFFER_AT: openCase.buffer === "never" ? "never" : String(launchEpoch + (openCase.buffer ?? 0)),
                WIDTH: String(openCase.width ?? 800),
                HEIGHT: String(openCase.height ?? 600),
                SIZE_MODE: openCase.sizeMode ?? "fixed",
                LIFETIME_MS: String(openCase.wait + 3000),
                ...(openCase.fullscreen !== undefined
                    ? { FULLSCREEN_AT: String(launchEpoch + openCase.fullscreen) }
                    : {}),
            };

            await desktop.evaluate(`
                    __mydeTest.launchApp({
                        exec: ${JSON.stringify(binary)},
                        name: "Window Open ${openCase.name}",
                        appid: ${JSON.stringify(APP_ID)},
                        env: ${JSON.stringify(env)},
                    })
                `);

            if (openCase.expectCloseAt !== undefined) {
                await sleep(Math.max(0, launchEpoch + openCase.expectCloseAt - Date.now()));
                const mid = await frameSnapshot();
                expect(mid.closeVisible, "空占位面板落地后应立刻可以取消").toBe(true);
                expect(mid.panels, "还没有窗口时面板应保留").toBe(1);
                expect(mid.frames, "还没有窗口时不应有客户端窗口").toBe(0);
            }
            await sleep(Math.max(0, openCase.wait - (Date.now() - launchEpoch)));
            const report = await recorder.stop();
            const events = readEvents(eventsFile);
            const snapshot = await frameSnapshot();
            const counts = await takeScreenCounts();
            console.log(
                `\n[${openCase.name}] screens ${before} -> ${counts.map((c) => c.n).join(" -> ")}` +
                    ` | frame ${snapshot.frames} panel ${snapshot.panels} fullscreen ${snapshot.fullscreen}` +
                    ` | events ${events.map((e) => `${e.event}@${e.t - launchEpoch}`).join(", ")}\n${formatReport(report)}\n` +
                    `frameRect ${JSON.stringify(snapshot.frameRect)} luma ${frameLuma(report, snapshot.frameRect)?.toFixed(1)}`,
            );

            // ── 虚拟屏只增长一个 ──
            const values = counts.map((c) => c.n);
            expect(values.length, "没有记录到虚拟屏数量变化").toBeGreaterThan(0);
            expect(snapshot.screens, `收尾后虚拟屏应只增加一个`).toBe(before + 1);
            expect(Math.min(...values), "虚拟屏不应被回收重建").toBeGreaterThanOrEqual(before);
            if (openCase.fullscreen === undefined) {
                expect(Math.max(...values), "不能产生多余的虚拟屏").toBe(before + 1);
            } else {
                // moveWindowToNewScreen 会先建新屏再收旧屏，允许一帧的过渡
                expect(Math.max(...values), "全屏最多出现一张临时屏").toBeLessThanOrEqual(before + 2);
            }
            const growth = counts.find((c) => c.n > before);
            if (!growth) throw new Error("没有出现应用屏");
            expect(growth.t - launchEpoch, "应用屏创建得太晚").toBeLessThanOrEqual(1200);
            expect(growth.t - launchEpoch, "应用屏创建早于启动").toBeGreaterThanOrEqual(-50);

            const bufferAt = eventTime(events, "first_buffer");
            const bufferRel = bufferAt === undefined ? undefined : reportTime(launchEpoch, markAt, bufferAt);

            // ── 启动动画整体 ──
            const openingEnd = markAt + Math.min(openCase.wait, 750);
            const opening = motionStats(report, {
                fromMs: markAt - 50,
                // 覆盖按下、飞行、切屏和面板替换；首帧是客户端自己整块画的，只用于确认画上来了
                toMs: openingEnd,
                activeChangedRatio: 0.001,
            });
            const latency = latenciesOf(report);
            expect(latency.launch, "启动后画面应很快变化").toBeTypeOf("number");
            expect(latency.launch, "启动后画面应很快变化").toBeLessThanOrEqual(RESPONSE_LIMIT_MS);
            expect(opening.activeFrames, "启动动画几乎没有中间帧").toBeGreaterThanOrEqual(6);
            expect(opening.spanMs, "启动动画持续时间太短").toBeGreaterThanOrEqual(250);
            expectNoStall(report, opening, "启动动画中间停顿过长");
            // 面板在窗口创建时就换成窗口，之后整块出现的是客户端自己的首帧；
            // 这里只要求桌面动画有足够中间帧、没有长时间停顿（单帧跳变由交互流畅度测试覆盖）

            // ── 首帧出现 ──
            if (openCase.buffer === "never") {
                expect(bufferAt, "不应出现首帧").toBeUndefined();
            } else {
                if (bufferRel === undefined) throw new Error("没有收到首帧事件");
                const appearance = motionStats(report, {
                    fromMs: bufferRel - 150,
                    toMs: bufferRel + 500,
                    activeChangedRatio: 0.0005,
                });
                // 面板在窗口创建时就替换掉了；这里只看客户端自己的首帧确实画上来了
                expect(appearance.activeFrames, "首帧出现时画面没有变化").toBeGreaterThanOrEqual(1);
            }

            // ── 结构 ──
            if (openCase.create === "never") {
                expect(snapshot.frames, "永不建窗不应有客户端窗口").toBe(0);
                expect(snapshot.panels, "应保留占位面板").toBe(1);
            } else {
                expect(snapshot.frames, "应只有一个客户端窗口").toBe(1);
                expect(snapshot.screenId, "窗口应挂在应用屏上").not.toBeNull();
            }
            if (openCase.expectPanel === "none") {
                expect(snapshot.panels, "启动面板应已撤掉").toBe(0);
            } else {
                expect(snapshot.panels, "没有窗口时应保留占位面板").toBe(1);
            }

            // ── 首帧内容 / 尺寸 ──
            const luma = frameLuma(report, snapshot.frameRect);
            if (!snapshot.frameRect) {
                // 永不建窗：没有窗口可看
            } else if (openCase.buffer === "never") {
                expect(luma, "没有首帧时应是白色窗口").toBeGreaterThan(WHITE_LUMA);
            } else {
                expect(luma, "客户端内容没有真正显示").toBeLessThan(220);
                const width = openCase.width ?? 800;
                const height = openCase.height ?? 600;
                if (openCase.fullscreen === undefined && openCase.sizeMode !== "configure") {
                    expect(snapshot.frameRect.width, "窗口宽度应来自客户端 buffer").toBeCloseTo(width, -1);
                    expect(snapshot.frameRect.height, "窗口高度应来自客户端 buffer").toBeCloseTo(height, -1);
                }
            }

            // ── 全屏 ──
            if (openCase.fullscreen !== undefined) {
                expect(snapshot.fullscreen, "窗口应进入全屏").toBe(true);
                const fsRect = snapshot.frameRect;
                if (!fsRect) throw new Error("全屏窗口没有外框");
                expect(fsRect.width, "全屏窗口应铺满输出").toBeGreaterThanOrEqual(viewport.width - 2);
                const fsAt = eventTime(events, "fullscreen");
                if (fsAt === undefined) throw new Error("没有收到全屏事件");
                const fsRel = reportTime(launchEpoch, markAt, fsAt);
                const transition = motionStats(report, {
                    fromMs: fsRel - 100,
                    toMs: fsRel + 900,
                    activeChangedRatio: 0.001,
                });
                expect(transition.activeFrames, "切全屏时画面没有变化").toBeGreaterThanOrEqual(2);
                expect(transition.total, "切全屏几乎没有可见动画").toBeGreaterThan(0.3);
                expect(transition.peakShare, "切全屏出现单帧跳变").toBeLessThanOrEqual(0.65);
            }

            if (openCase.create === "never") {
                expect(snapshot.closeVisible, "空占位面板应一直可以取消").toBe(true);
            }

            // ── 静止期 ──
            if (openCase.create === "never" || openCase.buffer === "never") {
                // 关闭按钮露出、窗口替换面板都是可见变化，静止期从它们之后算
                const quietStart =
                    markAt +
                    Math.max(
                        1200,
                        (openCase.expectCloseAt ?? 0) + 500,
                        typeof openCase.create === "number" ? openCase.create + 600 : 0,
                    );
                const quiet = motionStats(report, {
                    fromMs: quietStart,
                    toMs: markAt + openCase.wait,
                    activeChangedRatio: 0.001,
                });
                expect(quiet.total, "动画结束后不应持续变化").toBeLessThan(0.2);
            }

            await closeTestWindows();
        });
    }

    // 输出缩放重新应用时，还没拿到客户端几何（首帧之前 rect 是 0×0）的窗口
    // 不能按 0 重新摆外框，否则会缩成 1×1，等下一次尺寸上报才恢复。
    run("界面缩放重算不缩小还没有首帧的窗口", { timeout: 20000 }, async () => {
        expect(await screenCount(), "每个用例开始前应该回到初始虚拟屏数量").toBe(2);
        const eventsFile = path.join(tmpDir, "scale-before-first-frame.jsonl");
        fs.rmSync(eventsFile, { force: true });
        const launchEpoch = Date.now();
        await desktop.evaluate(`
            __mydeTest.launchApp({
                exec: ${JSON.stringify(binary)},
                name: "Window Open Scale",
                appid: ${JSON.stringify(APP_ID)},
                env: ${JSON.stringify({
                    EVENTS_FILE: eventsFile,
                    APP_ID,
                    CREATE_AT: String(launchEpoch),
                    BUFFER_AT: "never",
                    WIDTH: "800",
                    HEIGHT: "600",
                    SIZE_MODE: "fixed",
                    LIFETIME_MS: "5000",
                })},
            })
        `);
        await desktop.waitFor(
            `document.querySelectorAll("[data-client-frame]").length === 1 &&
             !document.querySelector("[data-desktop-ui='launch-panel']")`,
            5000,
        );
        const beforeRect = (await frameSnapshot()).frameRect;
        expect(beforeRect?.width, "窗口应保持客户端到来前的默认尺寸").toBeCloseTo(800, -1);
        expect(beforeRect?.height, "窗口应保持客户端到来前的默认尺寸").toBeCloseTo(600, -1);

        await desktop.evaluate("__mydeTest.applyUiScale(1)");
        await sleep(150);
        const afterRect = (await frameSnapshot()).frameRect;
        expect(afterRect?.width, "缩放重算不应改变还没有首帧的窗口").toBeCloseTo(800, -1);
        expect(afterRect?.height, "缩放重算不应改变还没有首帧的窗口").toBeCloseTo(600, -1);
        await closeTestWindows();
    });
});
