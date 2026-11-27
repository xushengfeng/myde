import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../../src/test_runner/desktop_runner";
import { sleep } from "../../../../src/test_runner/process_utils";
import {
    backgroundEffectAppPath,
    launchMock,
    mockAppPath,
    resetDesktop,
    state,
    waitState,
    windowByAppid,
} from "./helpers";

const entry = path.join(__dirname, "../../dist/index.js");
const hasBuild = fs.existsSync(entry) && fs.existsSync(mockAppPath());
const run = hasBuild ? it : it.skip;

/** 内容画布和它应该铺满的内容区之间允许的误差（CSS px） */
const FIT_TOLERANCE = 2;

type ContentSample = {
    phase: "maximized" | "fullscreen";
    t: number;
    frameRect: { x: number; y: number; w: number; h: number };
    contentTop: number;
    contentSize: { w: number; h: number };
    canvasRect: { x: number; y: number; w: number; h: number } | null;
    ghostSize: { w: number; h: number } | null;
    contentOpacity: number;
    ghostOpacity: number;
};

let desktop: DesktopRunner;

beforeAll(async () => {
    desktop = await startDesktopRunner({ desktop: "desktop/official", timeout: 60000, showWindow: true });
    await desktop.waitFor("document.documentElement.dataset.desktopReady === '1'", 60000);
});

afterAll(async () => {
    if (desktop) await desktop.close();
});

const clickMaximize = async (handle: string) => {
    const box = await desktop.evaluate<{ x: number; y: number; width: number; height: number } | null>(`
        (() => {
            const el = document.querySelector("[data-client-window='${handle}'] [data-client-control='maximize']");
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
        })()
    `);
    if (!box) throw new Error("窗口没有最大化按钮");
    await desktop.click(box.x + box.width / 2, box.y + box.height / 2);
};

/** 每帧记录：外框、内容区顶部偏移、根画布实际画出来的矩形 */
async function startSampler() {
    await desktop.evaluate(`
        (() => {
            const samples = (window.__contentSamples = []);
            const started = performance.now();
            const inlineOpacity = (el) => (el.style.opacity === "" ? 1 : Number.parseFloat(el.style.opacity) || 0);
            const computedOpacity = (el) => {
                const value = Number.parseFloat(getComputedStyle(el).opacity);
                return Number.isFinite(value) ? value : 1;
            };
            const loop = () => {
                const frame = document.querySelector("[data-client-frame]:not([data-pending-frame])");
                if (!frame) return;
                const content = frame.querySelector(":scope > [id]");
                const canvas = content?.querySelector("canvas");
                const phase = frame.hasAttribute("data-fullscreen")
                    ? "fullscreen"
                    : frame.hasAttribute("data-maximized")
                      ? "maximized"
                      : null;
                if (phase && content) {
                    const f = frame.getBoundingClientRect();
                    const c = canvas ? canvas.getBoundingClientRect() : null;
                    const ghost = [...frame.children].find((el) => el instanceof HTMLCanvasElement) ?? null;
                    samples.push({
                        phase,
                        t: performance.now() - started,
                        frameRect: { x: f.left, y: f.top, w: f.width, h: f.height },
                        contentTop: Number.parseFloat(content.style.top) || 0,
                        contentSize: {
                            w: Number.parseFloat(content.style.width) || 0,
                            h: Number.parseFloat(content.style.height) || 0,
                        },
                        canvasRect: c ? { x: c.left, y: c.top, w: c.width, h: c.height } : null,
                        ghostSize: ghost ? { w: ghost.width, h: ghost.height } : null,
                        contentOpacity: canvas ? computedOpacity(canvas) : 1,
                        ghostOpacity: ghost ? inlineOpacity(ghost) : 0,
                    });
                }
                requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
        })()
    `);
}

const takeSamples = () => desktop.evaluate<ContentSample[]>("window.__contentSamples ?? []");

function expectContentFitsFrame(samples: ContentSample[], label: string) {
    /** 快照来自过渡开始前的内容；用它比较宽高比，避免把旧画面按新目标判断 */
    let lastContentSize: { w: number; h: number } | undefined;
    let ghostReference: { w: number; h: number } | undefined;
    for (const sample of samples) {
        if (!sample.canvasRect) continue;
        const expectedHeight = sample.frameRect.h - sample.contentTop;
        const where = `${label} @${sample.t.toFixed(0)}ms (${sample.phase})`;
        expect(
            Math.abs(sample.canvasRect.w - sample.frameRect.w),
            `${where}：内容宽度没有跟随外框`,
        ).toBeLessThanOrEqual(FIT_TOLERANCE);
        expect(Math.abs(sample.canvasRect.h - expectedHeight), `${where}：内容高度没有跟随内容区`).toBeLessThanOrEqual(
            FIT_TOLERANCE,
        );
        expect(
            Math.abs(sample.canvasRect.y - (sample.frameRect.y + sample.contentTop)),
            `${where}：内容顶部没有贴住内容区`,
        ).toBeLessThanOrEqual(FIT_TOLERANCE);

        // 旧内容快照必须是过渡前的窗口内容本身：Firefox 的 preview 带着 shadow，整张塞进内容区会缩小
        if (sample.ghostSize) {
            ghostReference ??= lastContentSize;
            if (ghostReference && ghostReference.w > 1 && ghostReference.h > 1) {
                const ghostRatio = sample.ghostSize.w / sample.ghostSize.h;
                const referenceRatio = ghostReference.w / ghostReference.h;
                expect(
                    Math.abs(ghostRatio - referenceRatio),
                    `${where}：旧内容快照的宽高比和过渡前的内容不一致`,
                ).toBeLessThan(0.01);
            }
        } else {
            ghostReference = undefined;
            if (sample.contentSize.w > 1 && sample.contentSize.h > 1) lastContentSize = sample.contentSize;
        }
    }
}

async function runFullscreenCycle(appid: string, env: Record<string, string>) {
    await resetDesktop(desktop);
    // 这个用例观察的是真实动画，不要用 resetDesktop 的加速
    await desktop.evaluate("__mydeTest.setAnimationSpeed(1)");

    const win = await launchMock(desktop, {
        appid,
        width: 480,
        height: 360,
        // 客户端按 configure 重绘；桌面先改目标尺寸时它还会晚几帧才提交
        env: { DECORATED: "1", SIZE_MODE: "configure", ...env },
    });
    await waitState(desktop, (next) => windowByAppid(next, appid)?.painted === true);
    await sleep(200);

    await clickMaximize(win.handle);
    await waitState(desktop, (next) => {
        const current = windowByAppid(next, appid);
        return !!current && current.maximized && !current.resizing;
    });
    await sleep(200);

    await startSampler();
    await desktop.key("f", { modifiers: 4 });
    await waitState(desktop, (next) => {
        const current = windowByAppid(next, appid);
        return !!current && current.fullscreen && !current.resizing;
    });
    await sleep(150);

    await desktop.key("f", { modifiers: 4 });
    await waitState(desktop, (next) => {
        const current = windowByAppid(next, appid);
        return !!current && current.maximized && !current.fullscreen && !current.resizing;
    });
    await sleep(150);

    return { handle: win.handle, samples: await takeSamples() };
}

describe("全屏动画", () => {
    run("最大化 → 全屏 → 最大化时，旧内容始终铺满动画中的外框", { timeout: 60000 }, async () => {
        const { handle, samples } = await runFullscreenCycle("fullscreen-anim", {});
        expect(samples.length, "没有采到动画帧").toBeGreaterThan(10);
        expect(
            samples.some((sample) => sample.phase === "fullscreen"),
            "没有采到全屏阶段",
        ).toBe(true);
        // 确认确实采到了 ghost 淡出，而不是只有静止帧
        const ghosting = samples.filter((sample) => sample.ghostSize);
        expect(ghosting.length, "没有采到旧内容快照").toBeGreaterThan(0);
        expect(
            ghosting.some((sample) => sample.ghostOpacity > 0.1 && sample.ghostOpacity < 0.9),
            "没有采到 ghost 淡出过程",
        ).toBe(true);
        // 测试窗口是不透明的：内容层应始终为 1，只有 ghost 在淡出
        for (const sample of ghosting) {
            expect(sample.contentOpacity, `@${sample.t.toFixed(0)}ms 不透明窗口的内容层不应变透明`).toBeGreaterThan(
                0.99,
            );
        }

        expectContentFitsFrame(samples, "全屏动画");

        // 结束后客户端已经提交新尺寸，不应再保留拉伸或 surface 淡化
        const contentStyle = await desktop.evaluate<{ transform: string; fading: boolean; opacity: number }>(`
            (() => {
                const frame = document.querySelector("[data-client-window='${handle}']");
                const content = frame?.querySelector(":scope > [id]");
                const canvas = content?.querySelector("canvas");
                const opacity = canvas ? Number.parseFloat(getComputedStyle(canvas).opacity) : 1;
                return {
                    transform: content?.style.transform ?? "",
                    fading: content?.hasAttribute("data-content-fade") ?? false,
                    opacity,
                };
            })()
        `);
        expect(contentStyle.transform).toBe("");
        expect(contentStyle.fading).toBe(false);
        expect(contentStyle.opacity).toBe(1);

        const settled = await state(desktop);
        const current = windowByAppid(settled, "fullscreen-anim");
        expect(current?.maximized).toBe(true);
        expect(current?.fullscreen).toBe(false);
    });

    run("半透明窗口淡化时合成 alpha 保持稳定", { timeout: 60000 }, async () => {
        const alpha = 128 / 255;
        const { samples } = await runFullscreenCycle("fullscreen-alpha", { ALPHA: "128" });
        const ghosting = samples.filter((sample) => sample.ghostSize);
        expect(ghosting.length, "没有采到旧内容快照").toBeGreaterThan(0);
        expect(
            ghosting.some((sample) => sample.ghostOpacity > 0.1 && sample.ghostOpacity < 0.9),
            "没有采到 ghost 淡出过程",
        ).toBe(true);
        expect(
            ghosting.some((sample) => sample.contentOpacity > 0.1 && sample.contentOpacity < 0.9),
            "没有采到半透明内容的补偿曲线",
        ).toBe(true);

        for (const sample of samples) {
            const composite = sample.ghostSize
                ? alpha * sample.ghostOpacity + alpha * sample.contentOpacity * (1 - alpha * sample.ghostOpacity)
                : sample.contentOpacity * alpha;
            expect(
                Math.abs(composite - alpha),
                `@${sample.t.toFixed(0)}ms 合成 alpha 偏离了 ${alpha.toFixed(3)}`,
            ).toBeLessThan(0.02);
        }

        expectContentFitsFrame(samples, "半透明全屏动画");
    });

    run("背景模糊窗口过渡时 blur 层保持常亮", { timeout: 60000 }, async () => {
        await resetDesktop(desktop);
        await desktop.evaluate("__mydeTest.setAnimationSpeed(1)");
        await desktop.evaluate(`
            __mydeTest.launchApp({
                exec: ${JSON.stringify(backgroundEffectAppPath())},
                name: "Background Effect",
                appid: "background_effect_test",
            })
        `);
        const opened = await waitState(
            desktop,
            (next) => windowByAppid(next, "background_effect_test")?.painted === true,
        );
        const win = windowByAppid(opened, "background_effect_test");
        if (!win) throw new Error("background_effect 窗口没有出现");
        await sleep(400);
        await desktop.waitFor(
            `(() => {
                const content = document.querySelector("[data-client-frame] > [id]");
                return !!content && [...content.querySelectorAll("div")].some(
                    (el) => getComputedStyle(el).backdropFilter !== "none",
                );
            })()`,
            5000,
        );

        await desktop.evaluate(`
            (() => {
                const samples = (window.__blurSamples = []);
                const started = performance.now();
                const number = (value) => {
                    const parsed = Number.parseFloat(value);
                    return Number.isFinite(parsed) ? parsed : null;
                };
                const loop = () => {
                    const frame = document.querySelector("[data-client-frame]:not([data-pending-frame])");
                    if (!frame) return;
                    const content = frame.querySelector(":scope > [id]");
                    const canvas = content?.querySelector("canvas");
                    const ghost = [...frame.children].find((el) => el instanceof HTMLCanvasElement) ?? null;
                    const blur = content
                        ? [...content.querySelectorAll("div")].find(
                              (el) => getComputedStyle(el).backdropFilter !== "none",
                          ) ?? null
                        : null;
                    samples.push({
                        t: performance.now() - started,
                        ghost: !!ghost,
                        ghostOpacity: ghost ? number(getComputedStyle(ghost).opacity) : null,
                        surfaceOpacity: canvas ? number(getComputedStyle(canvas).opacity) : null,
                        blurOpacity: blur ? number(getComputedStyle(blur).opacity) : null,
                        blurFilter: blur ? getComputedStyle(blur).backdropFilter : null,
                    });
                    requestAnimationFrame(loop);
                };
                requestAnimationFrame(loop);
            })()
        `);

        await desktop.evaluate(`__mydeTest.toggleMaximize(${JSON.stringify(win.handle)})`);
        await waitState(desktop, (next) => {
            const current = windowByAppid(next, "background_effect_test");
            return !!current && current.maximized && !current.resizing;
        });
        await sleep(150);

        const samples =
            await desktop.evaluate<
                {
                    t: number;
                    ghost: boolean;
                    ghostOpacity: number | null;
                    surfaceOpacity: number | null;
                    blurOpacity: number | null;
                    blurFilter: string | null;
                }[]
            >("window.__blurSamples ?? []");
        const ghosting = samples.filter((sample) => sample.ghost);
        expect(ghosting.length, "没有采到背景模糊窗口的旧内容快照").toBeGreaterThan(0);
        expect(
            ghosting.some((sample) => (sample.ghostOpacity ?? 1) > 0.1 && (sample.ghostOpacity ?? 1) < 0.9),
            "没有采到背景模糊窗口的 ghost 淡出",
        ).toBe(true);
        expect(
            ghosting.some((sample) => sample.surfaceOpacity !== null && sample.surfaceOpacity < 0.99),
            "半透明内容应该出现淡化",
        ).toBe(true);
        for (const sample of ghosting) {
            expect(sample.blurOpacity, `@${sample.t.toFixed(0)}ms blur 层不应消失`).toBe(1);
            expect(sample.blurFilter, `@${sample.t.toFixed(0)}ms blur 层应保持生效`).not.toBe("none");
        }
    });
});
