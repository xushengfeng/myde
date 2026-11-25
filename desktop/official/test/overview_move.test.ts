import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../src/test_runner/desktop_runner";
import { decodePng, toLuma } from "../../../src/test_runner/png";
import { sleep } from "../../../src/test_runner/process_utils";
import { getProjectRoot } from "../../../src/test_runner/test_runner";

const entry = path.join(__dirname, "../dist/index.js");
const binary = path.join(getProjectRoot(), "test/simple_app/target/debug/child_window");
const hasBuild = fs.existsSync(entry) && fs.existsSync(binary);
const run = hasBuild ? it : it.skip;

/** 界面缩放取非整数，标题栏的 transform 缩放更容易暴露出缩小时留下的低分辨率栅格 */
const UI_SCALE = 1.25;

type FrameState = {
    handle: string;
    screen: string | null;
    styleLeft: string;
    styleTop: string;
    titlebar: { x: number; y: number; width: number; height: number } | null;
};

let desktop: DesktopRunner;

const frames = () =>
    desktop.evaluate<FrameState[]>(`
        [...document.querySelectorAll("[data-client-frame]")].map((f) => {
            const screen = f.closest("[data-view-id]");
            const tb = f.querySelector("[data-client-titlebar]");
            const t = tb ? tb.getBoundingClientRect() : null;
            return {
                handle: f.getAttribute("data-client-window"),
                screen: screen?.getAttribute("data-view-id") ?? null,
                styleLeft: f.style.left,
                styleTop: f.style.top,
                titlebar: t ? { x: t.left, y: t.top, width: t.width, height: t.height } : null,
            };
        })
    `);

const cards = () =>
    desktop.evaluate<
        { id: string; rect: { x: number; y: number; width: number; height: number }; isLaunchpad: boolean }[]
    >(`
        [...document.querySelectorAll("[data-view-id]")].map((el) => {
            const r = el.getBoundingClientRect();
            return {
                id: el.getAttribute("data-view-id"),
                rect: { x: r.left, y: r.top, width: r.width, height: r.height },
                isLaunchpad: el.querySelector("[data-desktop-ui='launchpad']") !== null,
            };
        })
    `);

/** 指针离开窗口，避免光标画进标题栏的采样区 */
async function parkPointer() {
    for (let i = 0; i < 3; i++) {
        await desktop.mouse({ type: "move", x: 1180 + i, y: 760 });
        await sleep(80);
    }
    await sleep(400);
}

/** 标题栏左侧文字的横向梯度均值；文字越锐利数值越大 */
async function titlebarSharpness() {
    const frame = (await frames()).find((f) => f.titlebar);
    if (!frame?.titlebar) throw new Error("没有服务端装饰标题栏");
    const rect = frame.titlebar;
    const png = decodePng(await desktop.screenshot());
    const view = await desktop.evaluate<{ width: number; height: number }>(
        "({ width: innerWidth, height: innerHeight })",
    );
    const luma = toLuma(png);
    const sx = png.width / view.width;
    const sy = png.height / view.height;
    const x0 = Math.round(rect.x * sx);
    const y0 = Math.round(rect.y * sy);
    const x1 = Math.round((rect.x + Math.min(rect.width, 320)) * sx);
    const y1 = Math.round((rect.y + rect.height) * sy);
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1 - 1; x++) {
            sum += Math.abs(luma[y * png.width + x + 1] - luma[y * png.width + x]);
            count++;
        }
    }
    return { sharpness: count ? sum / count : 0, frame };
}

/** 拖动标题栏，移开再回到原位置；坐标不变但元素会重新挂载、重绘 */
async function dragAndReturn(handle: string) {
    const frame = (await frames()).find((f) => f.handle === handle);
    if (!frame?.titlebar) throw new Error("没有服务端装饰标题栏");
    const gx = frame.titlebar.x + 100;
    const gy = frame.titlebar.y + frame.titlebar.height / 2;
    await desktop.mouse({ type: "move", x: gx, y: gy });
    await desktop.mouse({ type: "down", x: gx, y: gy });
    for (let i = 1; i <= 5; i++) {
        await desktop.mouse({ type: "move", x: gx + i * 10, y: gy + i * 5 });
        await sleep(16);
    }
    for (let i = 1; i <= 5; i++) {
        await desktop.mouse({ type: "move", x: gx + 50 - i * 10, y: gy + 25 - i * 5 });
        await sleep(16);
    }
    await desktop.mouse({ type: "up", x: gx, y: gy });
    await sleep(600);
}

async function launchWindow() {
    await desktop.evaluate(`
        __mydeTest.launchApp({
            exec: ${JSON.stringify(binary)},
            name: "Overview Move",
            appid: "overview-move-test",
            env: {
                APP_ID: "overview-move-test",
                MAXIMIZE: "0",
                CHILD_DELAY_MS: "999999",
                LIFETIME_MS: "60000",
            },
        })
    `);
    await desktop.waitFor(`document.querySelectorAll("[data-client-frame]").length === 1`, 15000);
    await sleep(1200);
}

describe("全局预览把窗口搬到其他屏", () => {
    beforeAll(async () => {
        desktop = await startDesktopRunner({
            desktop: "desktop/official",
            timeout: 60000,
            showWindow: true,
        });
        await desktop.waitFor("document.documentElement.dataset.desktopReady === '1'", 60000);
        await sleep(400);
    });

    afterAll(async () => {
        if (desktop) await desktop.close();
    });

    run("松手后窗口坐标是整数，顶栏按 1x 重新栅格化不发虚", { timeout: 60000 }, async () => {
        await launchWindow();
        // 窗口先在 1x 下创建，再切到非整数缩放；和实际修改显示缩放后的状态一致
        await desktop.evaluate(`__mydeTest.applyUiScale(${UI_SCALE})`);
        await sleep(600);
        const handle = (await frames())[0]?.handle;
        expect(handle, "应该有一个窗口").toBeTruthy();
        if (!handle) return;

        await desktop.key("Tab", { modifiers: 4 });
        await sleep(1200);
        const source = (await frames()).find((f) => f.handle === handle);
        const list = await cards();
        const sourceCard = list.find((c) => c.id === source?.screen);
        const targetCard = list.find((c) => c.id !== source?.screen && !c.isLaunchpad) ?? list[1];
        expect(sourceCard, "应该找到窗口所在的卡片").toBeTruthy();
        expect(targetCard, "应该找到另一张卡片").toBeTruthy();
        if (!sourceCard || !targetCard) return;

        const sx = sourceCard.rect.x + 14;
        const sy = sourceCard.rect.y + 14;
        const tx = targetCard.rect.x + targetCard.rect.width * 0.36;
        const ty = targetCard.rect.y + targetCard.rect.height * 0.4;
        await desktop.mouse({ type: "move", x: sx, y: sy });
        await desktop.mouse({ type: "down", x: sx, y: sy });
        for (let i = 1; i <= 5; i++) {
            await desktop.mouse({ type: "move", x: sx + ((tx - sx) * i) / 5, y: sy + ((ty - sy) * i) / 5 });
            await sleep(20);
        }
        await desktop.mouse({ type: "up", x: tx, y: ty });
        await sleep(700);

        await desktop.key("Escape");
        await sleep(1600);

        const moved = (await frames()).find((f) => f.handle === handle);
        expect(moved?.screen, "窗口应该在目标屏上").toBe(targetCard.id);
        expect(Number.parseFloat(moved?.styleLeft ?? "NaN"), "窗口横坐标应该是整数").toBe(
            Math.round(Number.parseFloat(moved?.styleLeft ?? "NaN")),
        );
        expect(Number.parseFloat(moved?.styleTop ?? "NaN"), "窗口纵坐标应该是整数").toBe(
            Math.round(Number.parseFloat(moved?.styleTop ?? "NaN")),
        );

        await parkPointer();
        const afterOverview = await titlebarSharpness();
        await dragAndReturn(handle);
        await parkPointer();
        const afterDrag = await titlebarSharpness();

        // 缩小预览里重新绘制过的窗口要按 1x 重新栅格化；修复前这里只有拖动后的 70% 左右
        expect(
            afterOverview.sharpness,
            `预览移动后顶栏文字应该和拖动后一样清晰（${afterOverview.sharpness.toFixed(2)} vs ${afterDrag.sharpness.toFixed(2)}）`,
        ).toBeGreaterThan(afterDrag.sharpness * 0.92);
    });
});
