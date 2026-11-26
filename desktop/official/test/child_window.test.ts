import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DesktopRunner, startDesktopRunner } from "../../../src/test_runner/desktop_runner";
import { decodePng } from "../../../src/test_runner/png";
import { sleep } from "../../../src/test_runner/process_utils";
import { getProjectRoot } from "../../../src/test_runner/test_runner";

const entry = path.join(__dirname, "../dist/index.js");
const binary = path.join(getProjectRoot(), "test/simple_app/target/debug/child_window");
const hasBuild = fs.existsSync(entry) && fs.existsSync(binary);
const run = hasBuild ? it : it.skip;

const APP_ID = "child-window-test";

type FrameInfo = {
    handle: string | null;
    maximized: boolean;
    rect: { x: number; y: number; width: number; height: number };
    stackIndex: number;
};

type Snapshot = {
    frames: FrameInfo[];
    topAtChild: string | null;
};

let desktop: DesktopRunner;

const snapshotExpr = `
    (() => {
        const list = [...document.querySelectorAll("[data-client-frame]")].map((f) => {
            const r = f.getBoundingClientRect();
            return {
                handle: f.getAttribute("data-client-window"),
                maximized: f.hasAttribute("data-maximized"),
                rect: { x: r.left, y: r.top, width: r.width, height: r.height },
                stackIndex: Number(f.closest("[data-window-slot]")?.style.zIndex ?? 0),
            };
        });
        const child = list.find((f) => !f.maximized);
        const topAtChild = child
            ? (() => {
                const el = document.elementFromPoint(
                    child.rect.x + child.rect.width / 2,
                    child.rect.y + child.rect.height / 2,
                );
                return el?.closest("[data-client-frame]")?.getAttribute("data-client-window") ?? null;
            })()
            : null;
        return { frames: list, topAtChild };
    })()
`;

/** 子窗口中心截图的 RGB；子窗口内容是红色、父窗口是绿色 */
async function centerPixel(snapshot: Snapshot, child: FrameInfo) {
    const png = decodePng(await desktop.screenshot());
    const view = await desktop.evaluate<{ width: number; height: number }>(
        "({ width: innerWidth, height: innerHeight })",
    );
    const sx = png.width / view.width;
    const sy = png.height / view.height;
    const px = Math.floor((child.rect.x + child.rect.width / 2) * sx);
    const py = Math.floor((child.rect.y + child.rect.height / 2) * sy);
    const offset = (py * png.width + px) * png.channels;
    void snapshot;
    return [png.data[offset], png.data[offset + 1], png.data[offset + 2]];
}

async function launchChildWindowApp(env: Record<string, string>) {
    await desktop.evaluate(`
        __mydeTest.launchApp({
            exec: ${JSON.stringify(binary)},
            name: "Child Window Test",
            appid: ${JSON.stringify(APP_ID)},
            env: { APP_ID: ${JSON.stringify(APP_ID)}, LIFETIME_MS: "9000", ...${JSON.stringify(env)} },
        })
    `);
    await desktop.waitFor(`document.querySelectorAll("[data-client-frame]").length === 2`, 15000);
    await sleep(1500);
    return desktop.evaluate<Snapshot>(snapshotExpr);
}

async function closeTestWindows() {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await desktop.evaluate("__mydeTest.closeWindows(); __mydeTest.closeLaunchPanels();");
        } catch {}
        try {
            await desktop.waitFor(`document.querySelectorAll("[data-client-frame]").length === 0`, 1000);
            return;
        } catch {}
        try {
            await desktop.evaluate("__mydeTest.forceCloseWindows(); __mydeTest.closeLaunchPanels();");
        } catch {}
    }
    await desktop.waitFor(`document.querySelectorAll("[data-client-frame]").length === 0`, 3000);
}

function expectChildOnTop(snapshot: Snapshot) {
    const child = snapshot.frames.find((f) => !f.maximized);
    const parent = snapshot.frames.find((f) => f.maximized);
    expect(child, "应该有一个子窗口").toBeTruthy();
    expect(parent, "应该有一个最大化父窗口").toBeTruthy();
    if (!child) throw new Error("没有子窗口");
    expect(snapshot.topAtChild, "子窗口中心最上层应该是子窗口").toBe(child.handle);
    if (parent) expect(child.stackIndex, "子窗口的层叠顺序应该在父窗口之后").toBeGreaterThan(parent.stackIndex);
    return child;
}

describe("父窗口的弹窗子窗口层叠", () => {
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

    run("父窗口最大化后创建子窗口，子窗口在父窗口之上", { timeout: 30000 }, async () => {
        const snapshot = await launchChildWindowApp({ CHILD_DELAY_MS: "800" });
        console.log("maximize then child", JSON.stringify(snapshot));
        const child = expectChildOnTop(snapshot);
        const rgb = await centerPixel(snapshot, child);
        expect(rgb[0], "子窗口中心应该是子窗口的红色内容").toBeGreaterThan(150);
        expect(rgb[1], "子窗口中心应该是子窗口的红色内容").toBeLessThan(120);
        await closeTestWindows();
    });

    run("父窗口没有最大化时创建子窗口，子窗口同样在父窗口之上", { timeout: 30000 }, async () => {
        const snapshot = await launchChildWindowApp({ CHILD_DELAY_MS: "800", MAXIMIZE: "0" });
        console.log("no maximize", JSON.stringify(snapshot));
        // 没有最大化状态就按尺寸区分：子窗口是较小的那个
        const child = snapshot.frames.toSorted((a, b) => a.rect.width - b.rect.width)[0];
        expect(child, "应该有一个子窗口").toBeTruthy();
        if (!child) return;
        expect(snapshot.topAtChild, "子窗口中心最上层应该是子窗口").toBe(child.handle);
        const parent = snapshot.frames.find((f) => f !== child);
        if (parent) expect(child.stackIndex, "子窗口的层叠顺序应该在父窗口之后").toBeGreaterThan(parent.stackIndex);
        const rgb = await centerPixel(snapshot, child);
        expect(rgb[0], "子窗口中心应该是子窗口的红色内容").toBeGreaterThan(150);
        await closeTestWindows();
    });

    run("父窗口最大化后创建子窗口，子窗口晚设置 parent 也在父窗口之上", { timeout: 30000 }, async () => {
        const snapshot = await launchChildWindowApp({ CHILD_DELAY_MS: "600", LATE_PARENT: "1" });
        console.log("late parent", JSON.stringify(snapshot));
        const child = expectChildOnTop(snapshot);
        const rgb = await centerPixel(snapshot, child);
        expect(rgb[0], "子窗口中心应该是子窗口的红色内容").toBeGreaterThan(150);
        expect(rgb[1], "子窗口中心应该是子窗口的红色内容").toBeLessThan(120);
        await closeTestWindows();
    });

    run("先创建子窗口再最大化父窗口，子窗口仍在父窗口之上", { timeout: 30000 }, async () => {
        const snapshot = await launchChildWindowApp({
            CHILD_DELAY_MS: "300",
            MAXIMIZE_AFTER_CHILD: "1",
        });
        console.log("child then maximize", JSON.stringify(snapshot));
        const child = expectChildOnTop(snapshot);
        const rgb = await centerPixel(snapshot, child);
        expect(rgb[0], "子窗口中心应该是子窗口的红色内容").toBeGreaterThan(150);
        expect(rgb[1], "子窗口中心应该是子窗口的红色内容").toBeLessThan(120);
        await closeTestWindows();
    });
});
