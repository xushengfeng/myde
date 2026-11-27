import * as path from "node:path";
import { InputEventCodes } from "../../../../src/input_codes/types";
import type { DesktopRunner } from "../../../../src/test_runner/desktop_runner";
import { sleep } from "../../../../src/test_runner/process_utils";
import { getProjectRoot } from "../../../../src/test_runner/test_runner";

export type Rect = { x: number; y: number; w: number; h: number };
export type Box = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

export type ScreenState = {
    id: string;
    windows: string[];
    empty: boolean;
    launchpad: boolean;
    pinned: boolean;
    used: number;
    current: boolean;
};

export type WindowState = {
    handle: string;
    screen: string;
    appid: string;
    rect: Rect | undefined;
    maximized: boolean;
    fullscreen: boolean;
    parent?: string;
    modal: boolean;
    pinned: boolean;
    resizing: boolean;
    painted: boolean;
};

export type LauncherBinding =
    | { kind: "line"; level: number }
    | { kind: "direct"; from: "n" | "t"; to: "n" | "t"; progress: number };

export type DesktopState = {
    stage: { width: number; height: number };
    available: { x: number; y: number; width: number; height: number };
    screens: ScreenState[];
    current: string;
    focus: string | undefined;
    axis: {
        level: number;
        levelTarget: number;
        focus: number;
        focusTarget: number;
        launcherRoute: "line" | "direct";
    };
    overview: boolean;
    overviewProgress: number;
    launches: {
        appid?: string;
        screen?: string;
        phase: "press" | "flying" | "embedded" | "replaced";
        frame?: string;
        replacing: boolean;
        revealed: boolean;
    }[];
    overviewFocus: string | undefined;
    gesture:
        | {
              level: number;
              startLevel: number;
              totalX: number;
              totalY: number;
              horizontalMode: "screens" | "overview";
              offset: number;
              focusPos: number;
              launcherBinding: LauncherBinding;
          }
        | undefined;
    launcher?: { binding: LauncherBinding; visible: boolean; focused: boolean };
    windows: WindowState[];
};

export const state = (desktop: DesktopRunner) => desktop.evaluate<DesktopState>("__mydeTest.state()");

export async function waitState(
    desktop: DesktopRunner,
    predicate: (value: DesktopState) => boolean,
    timeout = 8000,
    label = "桌面状态",
): Promise<DesktopState> {
    const deadline = Date.now() + timeout;
    let last: DesktopState | undefined;
    while (Date.now() < deadline) {
        last = await state(desktop);
        if (predicate(last)) return last;
        await sleep(40);
    }
    throw new Error(
        `等待${label}超时（${timeout}ms）：${JSON.stringify(last && { screens: last.screens, current: last.current, focus: last.focus, overview: last.overview, launcher: last.launcher, windows: last.windows })}`,
    );
}

export const currentScreen = (value: DesktopState) => value.screens.find((screen) => screen.current);
export const screenById = (value: DesktopState, id: string) => value.screens.find((screen) => screen.id === id);
export const windowByAppid = (value: DesktopState, appid: string) => value.windows.find((win) => win.appid === appid);

export function mockAppPath() {
    return path.join(getProjectRoot(), "test/simple_app/target/debug/window_open");
}

export function backgroundEffectAppPath() {
    return path.join(getProjectRoot(), "test/simple_app/target/debug/background_effect");
}

export type MockWindowSpec = {
    appid: string;
    name?: string;
    width?: number;
    height?: number;
    lifetimeMs?: number;
    env?: Record<string, string>;
};

/** 启动一个可控制的 mock 客户端窗口，等它完成启动动画并拿到焦点 */
export async function launchMock(desktop: DesktopRunner, spec: MockWindowSpec): Promise<WindowState> {
    const value = await state(desktop);
    const left = value.stage.width / 2 - 32;
    const top = value.stage.height / 2 - 32;
    await desktop.evaluate(`
        __mydeTest.launchApp({
            exec: ${JSON.stringify(mockAppPath())},
            name: ${JSON.stringify(spec.name ?? spec.appid)},
            appid: ${JSON.stringify(spec.appid)},
            sourceRect: { left: ${left}, top: ${top}, width: 64, height: 64 },
            env: ${JSON.stringify({
                APP_ID: spec.appid,
                LIFETIME_MS: String(spec.lifetimeMs ?? 60000),
                WIDTH: String(spec.width ?? 800),
                HEIGHT: String(spec.height ?? 600),
                ...spec.env,
            })},
        })
    `);
    const opened = await waitState(
        desktop,
        (next) => {
            const win = windowByAppid(next, spec.appid);
            return !!win && next.focus === win.handle && !next.overview;
        },
        15000,
        `启动 ${spec.appid}`,
    );
    // pendingLaunch 删除后才算启动收尾完成；frame 从第一帧就存在，窗口创建只填 content
    await desktop.waitFor("__mydeTest.state().launches.length === 0", 15000);
    const win = windowByAppid(opened, spec.appid);
    if (!win) throw new Error(`没有找到 ${spec.appid} 的窗口`);
    return win;
}

/** 关掉所有窗口、取消手势、退出预览、收起搜索并回到空桌面 */
export async function resetDesktop(desktop: DesktopRunner) {
    await desktop.evaluate(
        "__mydeTest.touchpadDetach(); __mydeTest.setAnimationSpeed(6); __mydeTest.resetView(); __mydeTest.setReorderDelay(3000)",
    );
    await waitState(
        desktop,
        (value) =>
            value.screens.length === 2 &&
            value.screens[0].empty &&
            value.screens[0].current &&
            !value.overview &&
            value.windows.length === 0 &&
            value.launcher?.visible === false,
        8000,
        "复位桌面",
    );
    // 关闭淡出是异步的；等 DOM 也收干净，避免下一用例的计数看到旧窗口
    await desktop.waitFor("document.querySelectorAll('[data-client-frame]').length === 0", 5000).catch(() => {});
}

/** 等桌面收到某个窗口的关窗请求（标题栏按钮或 __mydeTest.closeWindow） */
export async function waitCloseRequest(desktop: DesktopRunner, handle: string, timeout = 5000) {
    await desktop.waitFor(`__mydeTest.closeRequests().includes(${JSON.stringify(handle)})`, timeout);
}

/** 桌面侧直接移除窗口，不依赖客户端退出后 peer end 的时序 */
export async function forceCloseWindow(desktop: DesktopRunner, handle: string) {
    await desktop.evaluate(`__mydeTest.forceCloseWindow(${JSON.stringify(handle)})`);
}

/** 发出真实关窗通知、确认桌面收到后再移除窗口，供需要确定结果的用例使用 */
export async function closeWindow(desktop: DesktopRunner, handle: string) {
    await desktop.evaluate(`__mydeTest.clearCloseRequests(); __mydeTest.closeWindow(${JSON.stringify(handle)})`);
    await waitCloseRequest(desktop, handle);
    await forceCloseWindow(desktop, handle);
}

export async function elementBox(desktop: DesktopRunner, selector: string): Promise<Box | undefined> {
    return desktop.evaluate<Box | undefined>(`
        (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return undefined;
            const rect = el.getBoundingClientRect();
            return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
        })()
    `);
}

export const frameBox = (desktop: DesktopRunner, handle: string) =>
    elementBox(desktop, `[data-client-window='${handle}']`);

export async function titlebarPoint(desktop: DesktopRunner, handle: string): Promise<Point> {
    const box = await elementBox(desktop, `[data-client-window='${handle}'] [data-client-titlebar]`);
    if (!box) throw new Error(`窗口 ${handle} 没有标题栏`);
    return { x: box.x + Math.min(120, box.width * 0.4), y: box.y + box.height / 2 };
}

export async function cardPoint(desktop: DesktopRunner, screenId: string, fx = 0.5, fy = 0.5): Promise<Point> {
    const box = await elementBox(desktop, `[data-view-id='${screenId}']`);
    if (!box) throw new Error(`没有虚拟屏卡片 ${screenId}`);
    return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

export async function drag(desktop: DesktopRunner, from: Point, to: Point, steps = 6) {
    await desktop.mouse({ type: "move", x: from.x, y: from.y });
    await desktop.mouse({ type: "down", x: from.x, y: from.y });
    for (let i = 1; i <= steps; i++) {
        await desktop.mouse({
            type: "move",
            x: from.x + ((to.x - from.x) * i) / steps,
            y: from.y + ((to.y - from.y) * i) / steps,
        });
        await sleep(16);
    }
    await desktop.mouse({ type: "up", x: to.x, y: to.y });
}

type FeedEvent = { type: "abs" | "rel" | "key"; code: number; value: number } | { type: "sync" };

const feed = (desktop: DesktopRunner, events: FeedEvent[]) =>
    desktop.evaluate<number>(`__mydeTest.touchpadFeed(${JSON.stringify(events)})`);

const ABS = InputEventCodes;

const contactEvents = (slot: number, id: number, x: number, y: number): FeedEvent[] => [
    { type: "abs", code: ABS.ABS_MT_SLOT, value: slot },
    { type: "abs", code: ABS.ABS_MT_TRACKING_ID, value: id },
    { type: "abs", code: ABS.ABS_MT_POSITION_X, value: x },
    { type: "abs", code: ABS.ABS_MT_POSITION_Y, value: y },
];

const moveEvents = (slot: number, x: number, y: number): FeedEvent[] => [
    { type: "abs", code: ABS.ABS_MT_SLOT, value: slot },
    { type: "abs", code: ABS.ABS_MT_POSITION_X, value: x },
    { type: "abs", code: ABS.ABS_MT_POSITION_Y, value: y },
];

const liftEvents = (slot: number): FeedEvent[] => [
    { type: "abs", code: ABS.ABS_MT_SLOT, value: slot },
    { type: "abs", code: ABS.ABS_MT_TRACKING_ID, value: -1 },
];

export type GestureController = {
    /** 相对上一帧再平移 dx/dy（视口 px），可分成多帧喂入 */
    move(dx: number, dy: number, frames?: number): Promise<void>;
    /** 抬起全部手指；触发 endGesture */
    end(): Promise<void>;
    /** 当前快照，用来断言手势中的连续状态 */
    state(): Promise<DesktopState>;
};

/** 三指及以上手势；三指走桌面手势，四指及以上作为 swipe 发给应用 */
export async function startFingerGesture(desktop: DesktopRunner, fingers = 3): Promise<GestureController> {
    const { stage } = await state(desktop);
    const spacing = 500;
    const startX = 2000 - ((fingers - 1) * spacing) / 2;
    const base = Array.from({ length: fingers }, (_, index) => ({
        x: Math.round(startX + index * spacing),
        y: 2000,
    }));
    const unitX = (px: number) => Math.round((px / Math.max(1, stage.width - 1)) * 4000);
    const unitY = (px: number) => Math.round((px / Math.max(1, stage.height - 1)) * 4000);
    let movedX = 0;
    let movedY = 0;

    await feed(desktop, [
        ...base.flatMap((point, slot) => contactEvents(slot, slot + 1, point.x, point.y)),
        { type: "sync" },
    ]);
    await sleep(25);

    return {
        async move(dx, dy, frames = 1) {
            for (let frame = 1; frame <= frames; frame++) {
                movedX += dx / frames;
                movedY += dy / frames;
                const ox = unitX(movedX);
                const oy = unitY(movedY);
                await feed(desktop, [
                    ...base.flatMap((point, slot) => moveEvents(slot, point.x + ox, point.y + oy)),
                    { type: "sync" },
                ]);
                if (frames > 1) await sleep(16);
            }
        },
        async end() {
            await feed(desktop, [...base.flatMap((_, slot) => liftEvents(slot)), { type: "sync" }]);
            await sleep(60);
        },
        async state() {
            return state(desktop);
        },
    };
}
