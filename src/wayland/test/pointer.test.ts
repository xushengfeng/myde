import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { collectAppLogs, logOfType } from "../../test_runner/applog";
import { testRunnerApp } from "../../test_runner/test_runner";

/**
 * 指针注入测试：桌面 `input.pointer`（move/down/up）、`input.scroll` 注入后，
 * 客户端（Chromium）DOM 侧应当收到对应事件，坐标、落点、按键都要对得上。
 *
 * 两个跨环境的事实要在测试里显式处理，而不是硬编码：
 * 1. `ev.x/y` 相对**窗口几何原点**，几何里还含着 CSD 标题栏（几何 640x480 − 视口 640x404），
 *    所以页面坐标 = 注入坐标 − (几何宽−视口宽, 几何高−视口高)。两边的尺寸都现取。
 * 2. `wl_pointer.axis` 的数值单位与 DOM wheel 不同（本环境 120 → 1440），
 *    只断言方向与轴，不断言绝对值。
 *
 * 注意 `testRunnerApp` 的回调是 `script.toString()` 后拼进桌面脚本里求值的，
 * 访问不到本文件的模块作用域——注入计划必须定义在回调体内，并用 `runner.sendData` 带出来。
 */

/** 客户端 DOM 侧记录到的指针事件，经 console.log → applog 回传 */
type DomPointerEvent = {
    type: "move" | "down" | "up" | "click" | "auxclick" | "contextmenu" | "wheel";
    /** 事件发生处的页面坐标（clientX/clientY），用于和注入坐标对账 */
    x: number;
    y: number;
    /** 命中的元素 id：board 被切成 4 个象限，用它验证落点；在 board 外为空串 */
    target: string;
    /** button 只在按下类事件上有；wheel 上是 deltaX/deltaY */
    button?: number;
    deltaX?: number;
    deltaY?: number;
};

/** 客户端自报的窗口/视口尺寸，用来算几何原点到页面原点的偏移 */
type Meta = { type: "meta"; outerW: number; outerH: number; innerW: number; innerH: number };

/** 一次注入计划（回调体内定义，随结果带出，外层断言据此对账） */
type Plan = {
    /** 首帧就绪到开始注入之间的等待 */
    settle: number;
    /** 悬停路径，四个点分散在不同象限 */
    moves: { x: number; y: number }[];
    /** 按键点，button：0=左 1=中 2=右 */
    clicks: { x: number; y: number; button: number }[];
    /** 滚轮点与注入的 delta */
    wheels: { x: number; y: number; deltaX: number; deltaY: number }[];
};

/** 客户端页面上的布局：400x300 的 2x2 象限，见 appJs */
const BOARD = { cellW: 200, cellH: 150, w: 400, h: 300 };

/** 按页面坐标算命中的象限；落在 board 外则为 ""（body） */
function quadrantOf(x: number, y: number): string {
    if (x < 0 || x >= BOARD.w || y < 0 || y >= BOARD.h) return "";
    const col = x < BOARD.cellW ? 0 : 1;
    const row = y < BOARD.cellH ? 0 : 1;
    return `q${row * 2 + col}`;
}

/** 注入点 → 期望的页面坐标与落点（页面原点 = 几何原点 − CSD 偏移） */
function expectPoint(
    p: { x: number; y: number },
    inset: { x: number; y: number },
): { x: number; y: number; target: string } {
    const x = p.x - inset.x;
    const y = p.y - inset.y;
    return { x, y, target: quadrantOf(x, y) };
}

/** 同坐标（1px 容差，客户端取整）且同落点 */
function atPoint(e: DomPointerEvent, p: { x: number; y: number; target: string }) {
    return e.target === p.target && Math.abs(e.x - p.x) <= 1 && Math.abs(e.y - p.y) <= 1;
}

describe("pointer", () => {
    it("move 命中象限、三键按下/抬起、滚轮、光标", { timeout: 20000 }, async () => {
        const appJs = `
module.exports = ({ createWindow }) => {
    createWindow({ js: __filename, width: 640, height: 480 });
};
if (typeof document !== "undefined") {
    document.title = "myde-pointer-test";
    // 400x300 的 2x2 象限：q0(0-200,0-150) q1(200-400,0-150) q2(0-200,150-300) q3(200-400,150-300)
    document.body.innerHTML =
        '<div id="board" style="display:grid;grid-template-columns:200px 200px;grid-template-rows:150px 150px;width:400px;height:300px">' +
        '<div id="q0" style="background:#f66"></div><div id="q1" style="background:#6f6"></div>' +
        '<div id="q2" style="background:#66f"></div><div id="q3" style="background:#ff6"></div></div>';
    const log = (o) => console.log(JSON.stringify(o));
    const pos = (e) => ({ x: Math.round(e.clientX), y: Math.round(e.clientY), target: (e.target && e.target.id) || "" });
    document.addEventListener("mousemove", (e) => log({ type: "move", ...pos(e) }));
    document.addEventListener("mousedown", (e) => log({ type: "down", button: e.button, ...pos(e) }));
    document.addEventListener("mouseup", (e) => log({ type: "up", button: e.button, ...pos(e) }));
    document.addEventListener("click", (e) => log({ type: "click", button: e.button, ...pos(e) }));
    document.addEventListener("auxclick", (e) => log({ type: "auxclick", button: e.button, ...pos(e) }));
    document.addEventListener("contextmenu", (e) => log({ type: "contextmenu", button: e.button, ...pos(e) }));
    document.addEventListener("wheel", (e) => log({ type: "wheel", deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY), ...pos(e) }), { passive: true });
    // 视口尺寸：和窗口几何（服务端 rect）一起换算出几何原点到页面原点的偏移；
    // outer 是含阴影的 surface 尺寸，留在日志里便于排查
    log({ type: "meta", outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight });
}
`;
        const tmpfile = `/tmp/myde_pointer_test_${Date.now()}.js`;
        fs.writeFileSync(tmpfile, appJs);

        const { waitExit } = testRunnerApp(`test/electron_app/start.js ${tmpfile}`, async ({ server, runner }) => {
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            /** 注入计划（外层断言的唯一来源）：坐标是**几何坐标**，y 要留出 CSD 高度 */
            const plan: Plan = {
                settle: 300,
                moves: [
                    { x: 60, y: 120 },
                    { x: 320, y: 140 },
                    { x: 90, y: 330 },
                    { x: 330, y: 340 },
                ],
                clicks: [
                    { x: 100, y: 156, button: 0 },
                    { x: 300, y: 176, button: 2 },
                    { x: 100, y: 276, button: 1 },
                ],
                wheels: [
                    { x: 330, y: 336, deltaX: 0, deltaY: 120 },
                    { x: 330, y: 336, deltaX: -120, deltaY: 0 },
                ],
            };
            server.on("window.created", (info) => {
                // 异常必须落进 finally 的收尾，否则只能等 20s 强杀
                void (async () => {
                    try {
                        server.notify("window.focus", info.handle);
                        // 等客户端画出首帧再注入：页面脚本在解析期就挂好监听，首帧 ≈ 页面就绪，
                        // 否则第一个 move 会赶在监听挂好之前被丢掉（preview 初始是 1x1）
                        for (let i = 0; i < 200 && (server.windows.preview(info.handle)?.width ?? 0) <= 1; i++)
                            await sleep(50);
                        await sleep(plan.settle);
                        const move = (x: number, y: number) =>
                            server.notify("input.pointer", info.handle, { type: "move", x, y, button: 0 });

                        for (const m of plan.moves) {
                            move(m.x, m.y);
                            await sleep(80);
                        }
                        for (const c of plan.clicks) {
                            move(c.x, c.y);
                            await sleep(80);
                            server.notify("input.pointer", info.handle, {
                                type: "down",
                                x: c.x,
                                y: c.y,
                                button: c.button,
                            });
                            await sleep(80);
                            server.notify("input.pointer", info.handle, {
                                type: "up",
                                x: c.x,
                                y: c.y,
                                button: c.button,
                            });
                            await sleep(80);
                        }
                        for (const w of plan.wheels) {
                            move(w.x, w.y);
                            await sleep(80);
                            server.notify("input.scroll", info.handle, {
                                deltaX: w.deltaX,
                                deltaY: w.deltaY,
                                deltaZ: 0,
                            });
                            await sleep(80);
                        }
                        // 光标是客户端对 wl_pointer.enter 的回应（wp_cursor_shape / set_cursor）
                        await sleep(200);
                        const rect = await server.request("window.getBounds", info.handle);
                        runner.sendData({ plan, rect, cursor: server.cursor.get(info.clientId) });
                    } catch (e) {
                        runner.sendData({ plan, error: String(e) });
                    } finally {
                        runner.kill();
                    }
                })();
            });
        });

        const raw = (await waitExit()) as {
            applog?: string;
            error?: string;
            cursor?: unknown;
            plan?: Plan;
            rect?: { x: number; y: number; w: number; h: number };
        }[];
        expect(
            raw.find((r) => r.error),
            `脚本异常: ${JSON.stringify(raw).slice(0, 800)}`,
        ).toBeUndefined();
        const plan = raw.find((r) => r.plan)?.plan;
        expect(plan, `没拿到注入计划，实际: ${JSON.stringify(raw).slice(0, 800)}`).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: 上面已断言
        const p = plan!;

        const logs = collectAppLogs(raw);
        const events = logs as unknown as DomPointerEvent[];
        const meta = logOfType<Meta>(logs, "meta")[0];
        expect(meta, `客户端没启动或没上报 meta，raw=${JSON.stringify(raw).slice(0, 800)}`).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: 上面已断言
        const m = meta!;
        const dump = () => `events=${JSON.stringify(events)} meta=${JSON.stringify(m)}`;

        // 窗口几何必须盖得住视口：ev.x/y 相对几何原点，而页面原点是几何原点再往下让出
        // CSD 标题栏（几何 640x480 − 视口 640x404 = 76）；盖不住就换算不回页面坐标
        const rect = raw.find((r) => r.rect)?.rect;
        expect(rect, `没拿到窗口几何，${dump()}`).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: 上面已断言
        const geo = rect!;
        expect(geo.w >= m.innerW && geo.h >= m.innerH, `几何盖不住视口 geo=${JSON.stringify(geo)} ${dump()}`).toBe(
            true,
        );

        // 注入坐标 → 页面坐标 的偏移：几何里未被视口占用的部分（标题栏）
        const inset = { x: geo.w - m.innerW, y: geo.h - m.innerH };

        expect(
            events.some((e) => e.type === "move"),
            `没收到指针事件，${dump()}`,
        ).toBe(true);

        // 悬停：每个注入点都要有一个同页面坐标、同落点的 mousemove
        for (const mv of p.moves) {
            const want = expectPoint(mv, inset);
            expect(
                events.some((e) => e.type === "move" && atPoint(e, want)),
                `move(注入 ${mv.x},${mv.y} → 页面 ${want.x},${want.y}) 没命中 ${want.target}，${dump()}`,
            ).toBe(true);
        }

        // 三键：down/up 的 button、页面坐标、落点逐一对应
        for (const c of p.clicks) {
            const want = expectPoint(c, inset);
            for (const type of ["down", "up"] as const) {
                expect(
                    events.some((e) => e.type === type && e.button === c.button && atPoint(e, want)),
                    `${type}(button=${c.button}) 没落在 ${want.target}(${want.x},${want.y})，${dump()}`,
                ).toBe(true);
            }
        }
        // 左键合成 click，右键合成 contextmenu，中键合成 auxclick
        for (const [button, synth] of [
            [0, "click"],
            [2, "contextmenu"],
            [1, "auxclick"],
        ] as const) {
            const c = p.clicks.find((x) => x.button === button);
            expect(c, `计划里没有 button=${button}`).toBeDefined();
            // 上面已断言，只为把类型收窄成非 undefined
            if (!c) continue;
            const want = expectPoint(c, inset);
            expect(
                events.some((e) => e.type === synth && e.button === button && atPoint(e, want)),
                `${synth}(button=${button}) 没在 ${want.target} 合成，${dump()}`,
            ).toBe(true);
        }

        // 滚轮：两个方向都要变成 wheel 事件，落点正确、方向不被翻转。
        // 数值单位不同（wayland axis → DOM wheel），只看符号与所在轴。
        // 两次注入落在同一点，不能按下标取事件，按「落点 + 符号」找。
        for (const w of p.wheels) {
            const want = expectPoint(w, inset);
            const hits = events.filter((e) => e.type === "wheel" && atPoint(e, want));
            expect(
                hits.length,
                `wheel(${w.deltaX},${w.deltaY}) 没到 ${want.target}(${want.x},${want.y})，${dump()}`,
            ).toBeGreaterThan(0);
            const wantAxes = [w.deltaX === 0 ? 0 : Math.sign(w.deltaX), w.deltaY === 0 ? 0 : Math.sign(w.deltaY)];
            expect(
                hits.some((e) => Math.sign(e.deltaX ?? 0) === wantAxes[0] && Math.sign(e.deltaY ?? 0) === wantAxes[1]),
                `滚轮方向/轴不对，期望轴 ${JSON.stringify(wantAxes)}，${dump()}`,
            ).toBe(true);
        }

        // 指针移入后客户端要给出可见光标（Chromium 走 wp_cursor_shape）
        const cursor = raw.find((r) => r.cursor !== undefined)?.cursor as { kind?: string } | undefined;
        expect(cursor?.kind, `cursor=${JSON.stringify(cursor)} ${dump()}`).toBe("shape");
    });
});
