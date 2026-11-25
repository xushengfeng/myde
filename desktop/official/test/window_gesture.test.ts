import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InputEventCodes } from "../../../src/input_codes/types";
import { type DesktopRunner, startDesktopRunner } from "../../../src/test_runner/desktop_runner";
import { sleep } from "../../../src/test_runner/process_utils";

const entry = path.join(__dirname, "../dist/index.js");
const hasBuild = fs.existsSync(entry);
const run = hasBuild ? it : it.skip;

type ScreenState = {
    id: string;
    windows: string[];
    empty: boolean;
    launchpad: boolean;
    used: number;
    current: boolean;
};

type DesktopState = {
    stage: { width: number; height: number };
    screens: ScreenState[];
    current: string;
    focus: string | undefined;
    overview: boolean;
    gesture:
        | {
              level: number;
              startLevel: number;
              horizontalMode: "screens" | "overview";
          }
        | undefined;
    windows: { handle: string; screen: string }[];
};

type FeedEvent = { type: "abs" | "rel" | "key"; code: number; value: number } | { type: "sync" };

let desktop: DesktopRunner;

const state = () => desktop.evaluate<DesktopState>("__mydeTest.state()");
const feed = (events: FeedEvent[]) => desktop.evaluate<number>(`__mydeTest.touchpadFeed(${JSON.stringify(events)})`);

const ABS = InputEventCodes;

function contact(slot: number, id: number, x: number, y: number): FeedEvent[] {
    return [
        { type: "abs", code: ABS.ABS_MT_SLOT, value: slot },
        { type: "abs", code: ABS.ABS_MT_TRACKING_ID, value: id },
        { type: "abs", code: ABS.ABS_MT_POSITION_X, value: x },
        { type: "abs", code: ABS.ABS_MT_POSITION_Y, value: y },
    ];
}

function move(slot: number, x: number, y: number): FeedEvent[] {
    return [
        { type: "abs", code: ABS.ABS_MT_SLOT, value: slot },
        { type: "abs", code: ABS.ABS_MT_POSITION_X, value: x },
        { type: "abs", code: ABS.ABS_MT_POSITION_Y, value: y },
    ];
}

function lift(slot: number): FeedEvent[] {
    return [
        { type: "abs", code: ABS.ABS_MT_SLOT, value: slot },
        { type: "abs", code: ABS.ABS_MT_TRACKING_ID, value: -1 },
    ];
}

/** 三指一起平移 dx/dy（视口 px），按帧喂进真实 evdev → TouchpadInput 链路 */
async function threeFingerSwipe(dx: number, dy: number, frames = 8) {
    const { stage } = await state();
    const unitX = (px: number) => Math.round((px / Math.max(1, stage.width - 1)) * 4000);
    const unitY = (px: number) => Math.round((px / Math.max(1, stage.height - 1)) * 4000);
    const base = [
        { x: 1600, y: 2000 },
        { x: 2000, y: 2000 },
        { x: 2400, y: 2000 },
    ];

    await feed([...base.flatMap((p, slot) => contact(slot, slot + 1, p.x, p.y)), { type: "sync" }]);
    await sleep(30);
    for (let i = 1; i <= frames; i++) {
        const ox = unitX((dx * i) / frames);
        const oy = unitY((dy * i) / frames);
        await feed([...base.flatMap((p, slot) => move(slot, p.x + ox, p.y + oy)), { type: "sync" }]);
        await sleep(16);
    }
    await feed([...base.flatMap((_, slot) => lift(slot)), { type: "sync" }]);
    await sleep(400);
}

describe("三指手势 / state 快照", () => {
    beforeAll(async () => {
        desktop = await startDesktopRunner({ desktop: "desktop/official", timeout: 60000 });
        await desktop.waitFor("document.documentElement.dataset.desktopReady === '1'", 60000);
        await sleep(400);
    });

    afterAll(async () => {
        if (desktop) await desktop.close();
    });

    run("三指上滑进预览、下滑退出、横滑切屏", { timeout: 60000 }, async () => {
        const initial = await state();
        expect(initial.screens.length, "启动时应该有空桌面和启动台两张屏").toBe(2);
        expect(initial.screens[0].current, "空桌面是当前屏").toBe(true);
        expect(initial.overview).toBe(false);
        expect(initial.gesture).toBeUndefined();

        await threeFingerSwipe(0, -initial.stage.height * 0.4);
        const overview = await state();
        expect(overview.overview, "三指上滑应该进入全局预览").toBe(true);
        expect(overview.gesture, "松手后手势状态应该清掉").toBeUndefined();

        await threeFingerSwipe(0, initial.stage.height * 0.4);
        const normal = await state();
        expect(normal.overview, "三指下滑应该退出全局预览").toBe(false);

        await threeFingerSwipe(-initial.stage.width * 0.4, 0);
        const switched = await state();
        expect(switched.current, "三指横滑应该切到另一张虚拟屏").not.toBe(initial.current);
        expect(
            switched.screens.find((screen) => screen.id === switched.current)?.current,
            "快照里的当前屏应该和 current 一致",
        ).toBe(true);
    });
});
