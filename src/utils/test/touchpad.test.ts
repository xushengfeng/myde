import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputEventCodes } from "../../input_codes/types";
import { TouchpadInput } from "../touchpad";

const info = {
    path: "/dev/input/event0",
    name: "test touchpad",
    type: "touchpad",
    vendor: 1,
    product: 1,
    version: 1,
    capabilities: {
        eventTypes: [],
        keyCodes: [InputEventCodes.BTN_TOUCH, InputEventCodes.BTN_TOOL_FINGER, InputEventCodes.BTN_TOOL_DOUBLETAP],
        relAxes: [],
        absAxes: [
            InputEventCodes.ABS_MT_SLOT,
            InputEventCodes.ABS_MT_TRACKING_ID,
            InputEventCodes.ABS_MT_POSITION_X,
            InputEventCodes.ABS_MT_POSITION_Y,
        ],
        hasKeyboard: false,
        hasMouse: false,
        hasTouchpad: true,
        hasTouchscreen: false,
    },
    absInfo: {
        [InputEventCodes.ABS_MT_POSITION_X]: { min: 0, max: 4000, fuzz: 0, flat: 0, resolution: 100 },
        [InputEventCodes.ABS_MT_POSITION_Y]: { min: 0, max: 4000, fuzz: 0, flat: 0, resolution: 100 },
    },
    errors: [],
};

function setup(options: { now?: () => number; acceleration?: { enabled(): boolean; speed(): number } } = {}) {
    const dev = new EventEmitter();
    const input = new TouchpadInput(dev as never, info as never, {
        mapX: (_code, value) => value / 4,
        mapY: (_code, value) => value / 4,
        ...options,
    });
    const events: unknown[][] = [];
    for (const name of [
        "move",
        "scroll",
        "scrollEnd",
        "pinchStart",
        "pinchUpdate",
        "pinchEnd",
        "holdStart",
        "holdEnd",
        "multiStart",
        "multiMove",
        "multiEnd",
    ]) {
        input.on(name as never, ((...args: unknown[]) => events.push([name, ...args])) as never);
    }
    const abs = (code: number, value: number) => dev.emit("absolute", code, value);
    const sync = () => dev.emit("sync");
    const contact = (slot: number, id: number, x: number, y: number) => {
        abs(InputEventCodes.ABS_MT_SLOT, slot);
        abs(InputEventCodes.ABS_MT_TRACKING_ID, id);
        abs(InputEventCodes.ABS_MT_POSITION_X, x);
        abs(InputEventCodes.ABS_MT_POSITION_Y, y);
    };
    const move = (slot: number, x: number, y: number) => {
        abs(InputEventCodes.ABS_MT_SLOT, slot);
        abs(InputEventCodes.ABS_MT_POSITION_X, x);
        abs(InputEventCodes.ABS_MT_POSITION_Y, y);
    };
    const lift = (slot: number) => {
        abs(InputEventCodes.ABS_MT_SLOT, slot);
        abs(InputEventCodes.ABS_MT_TRACKING_ID, -1);
    };
    return { input, events, sync, contact, move, lift };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("TouchpadInput gestures", () => {
    it("starts a pinch from the trigger position without a jump", () => {
        const { events, sync, contact, move, lift } = setup();
        contact(0, 1, 1000, 2000);
        contact(1, 2, 3000, 2000);
        sync();
        move(0, 500, 2000);
        move(1, 3500, 2000);
        sync();
        expect(events.map((e) => e[0])).toContain("pinchStart");
        expect(events.map((e) => e[0])).not.toContain("scroll");
        // 越过阈值前的张合不补发，否则客户端一开始就会跳一下
        expect(events.some((e) => e[0] === "pinchUpdate")).toBe(false);
        move(0, 400, 2000);
        move(1, 3600, 2000);
        sync();
        const update = events.find((e) => e[0] === "pinchUpdate");
        // 以触发时的 30mm 为起点：32/30，而不是相对最初接触时的 32/20
        expect(update?.[3]).toBeCloseTo(32 / 30);
        lift(0);
        lift(1);
        sync();
        expect(events.at(-1)?.[0]).toBe("pinchEnd");
    });

    it("prefers scrolling when two fingers converge while moving together", () => {
        const { events, sync, contact, move, lift } = setup();
        contact(0, 1, 1000, 2000);
        contact(1, 2, 3000, 2000);
        sync();
        // 一起上移 4mm、同时收拢 3mm：质心位移大于距离变化，应判为滚动而不是捏合
        move(0, 1150, 1600);
        move(1, 2850, 1600);
        sync();
        expect(events.some((e) => e[0] === "scroll")).toBe(true);
        expect(events.some((e) => e[0] === "pinchStart")).toBe(false);
        lift(0);
        lift(1);
        sync();
        expect(events.at(-1)?.[0]).toBe("scrollEnd");
    });

    it("keeps scrolling while a pinch with centroid drift is active", () => {
        const { events, sync, contact, move } = setup();
        contact(0, 1, 1000, 2000);
        contact(1, 2, 4000, 2000);
        sync();
        for (let i = 1; i <= 8; i++) {
            // 两指分开的同时整体向上移动，质心每帧 -50（0.5mm）
            move(0, 1000 - i * 100, 2000 - i * 50);
            move(1, 4000 + i * 100, 2000 - i * 50);
            sync();
        }
        expect(events.some((e) => e[0] === "pinchStart")).toBe(true);
        // 滚动不被 pinch 取消：质心漂移会同时产生 scroll
        expect(events.some((e) => e[0] === "scroll")).toBe(true);
    });

    it("emits scroll only after two fingers move together past the threshold", () => {
        const { events, sync, contact, move, lift } = setup();
        contact(0, 1, 1000, 2000);
        contact(1, 2, 4000, 2000);
        sync();
        // 两指一起上移，距离不变：第一帧 1mm 不够，第二帧累计 2mm 才判为滚动
        move(0, 1000, 1900);
        move(1, 4000, 1900);
        sync();
        expect(events.some((e) => e[0] === "scroll")).toBe(false);
        move(0, 1000, 1800);
        move(1, 4000, 1800);
        sync();
        expect(events.some((e) => e[0] === "scroll")).toBe(true);
        expect(events.some((e) => e[0] === "pinchStart")).toBe(false);
        lift(0);
        lift(1);
        sync();
        expect(events.at(-1)?.[0]).toBe("scrollEnd");
    });

    it("does not replay motion accumulated while deciding two-finger scroll", () => {
        const { events, sync, contact, move, lift } = setup();
        contact(0, 1, 1000, 2000);
        contact(1, 2, 4000, 2000);
        sync();
        // 第一帧一起上移 1mm，还没到 1.5mm 的分类阈值：先不滚动
        move(0, 1000, 1900);
        move(1, 4000, 1900);
        sync();
        expect(events.some((e) => e[0] === "scroll")).toBe(false);
        // 第二帧累计越过阈值：只发这一帧的位移，不能把上一帧攒下的补上，否则滚动会跳一下
        move(0, 1000, 1800);
        move(1, 4000, 1800);
        sync();
        const scrolls = events.filter((e) => e[0] === "scroll");
        expect(scrolls).toHaveLength(1);
        expect(scrolls[0][1]).toBe(0);
        expect(scrolls[0][2]).toBeCloseTo(25);
        lift(0);
        lift(1);
        sync();
        expect(events.at(-1)?.[0]).toBe("scrollEnd");
    });

    it("does not replay motion accumulated before a pinch starts", () => {
        const { events, sync, contact, move, lift } = setup();
        contact(0, 1, 1000, 2000);
        contact(1, 2, 3000, 2000);
        sync();
        // 两指慢慢分开、同时整体上移 1mm：还没到 pinch 阈值，既不滚动也不捏合
        move(0, 900, 1950);
        move(1, 3100, 1950);
        sync();
        expect(events.some((e) => e[0] === "pinchStart")).toBe(false);
        expect(events.some((e) => e[0] === "scroll")).toBe(false);
        // 越过阈值判为捏合：只发本帧的滚动位移，不补之前攒下的
        move(0, 800, 1900);
        move(1, 3200, 1900);
        sync();
        expect(events.some((e) => e[0] === "pinchStart")).toBe(true);
        const scrolls = events.filter((e) => e[0] === "scroll");
        expect(scrolls).toHaveLength(1);
        expect(scrolls[0][2]).toBeCloseTo(12.5);
        lift(0);
        lift(1);
        sync();
    });

    it("continues single-finger movement after a two-finger gesture loses one finger", () => {
        const { events, sync, contact, move, lift } = setup();
        contact(0, 1, 1000, 2000);
        contact(1, 2, 4000, 2000);
        sync();
        move(0, 1000, 1800);
        move(1, 4000, 1800);
        sync();
        expect(events.some((e) => e[0] === "scroll")).toBe(true);
        lift(1);
        sync();
        expect(events.at(-1)?.[0]).toBe("scrollEnd");
        const countBefore = events.length;
        move(0, 800, 1600);
        sync();
        // 2→1 是例外：剩下的单指继续移动光标
        expect(events.slice(countBefore).some((e) => e[0] === "move")).toBe(true);
        lift(0);
        sync();
    });

    it("can upgrade a single-finger move to two-finger scroll", () => {
        const { events, sync, contact, move } = setup();
        contact(0, 1, 1000, 2000);
        sync();
        move(0, 1000, 1800);
        sync();
        expect(events.some((e) => e[0] === "move")).toBe(true);
        // 第二指落下后继续两指同向移动：升级为滚动
        contact(1, 2, 4000, 1800);
        sync();
        move(0, 1000, 1600);
        move(1, 4000, 1600);
        sync();
        expect(events.some((e) => e[0] === "scroll")).toBe(true);
    });

    it("does not switch to pinch after the contact is already scrolling", () => {
        const { events, sync, contact, move, lift } = setup();
        contact(0, 1, 1000, 2000);
        contact(1, 2, 4000, 2000);
        sync();
        // 先一起上移 2mm：判为滚动
        move(0, 1000, 1800);
        move(1, 4000, 1800);
        sync();
        expect(events.some((e) => e[0] === "scroll")).toBe(true);
        // 再明显分开：本轮已经判为滚动，不再改判 pinch
        move(0, 700, 1800);
        move(1, 4300, 1800);
        sync();
        expect(events.some((e) => e[0] === "pinchStart")).toBe(false);
        lift(0);
        lift(1);
        sync();
        expect(events.at(-1)?.[0]).toBe("scrollEnd");
    });

    it("does not replay motion accumulated while deciding a tap", () => {
        const { events, sync, contact, move, lift } = setup();
        contact(0, 1, 1000, 2000);
        sync();
        // 第一帧移动 0.8mm，还没到轻触的 1.3mm 阈值：光标不动
        move(0, 1080, 2000);
        sync();
        expect(events.some((e) => e[0] === "move")).toBe(false);
        // 第二帧累计越过阈值：只发这一帧的位移，不能把上一帧攒下的补上，否则光标会跳一下
        move(0, 1160, 2000);
        sync();
        const moves = events.filter((e) => e[0] === "move");
        expect(moves).toHaveLength(1);
        expect(moves[0][1]).toBeCloseTo(20);
        expect(moves[0][2]).toBe(0);
        lift(0);
        sync();
    });

    it("does not scroll for a two-finger tap with a little drift", () => {
        const { events, sync, contact, move, lift } = setup();
        contact(0, 1, 1000, 2000);
        contact(1, 2, 4000, 2000);
        sync();
        move(0, 1000, 1900);
        move(1, 4000, 1900);
        sync();
        lift(0);
        lift(1);
        sync();
        expect(events.some((e) => e[0] === "scroll")).toBe(false);
        expect(events.some((e) => e[0] === "pinchStart")).toBe(false);
    });

    it("detects hold only after the timeout", () => {
        vi.useFakeTimers();
        const { events, sync, contact, lift } = setup();
        contact(0, 1, 1000, 2000);
        sync();
        expect(events.some((e) => e[0] === "holdStart")).toBe(false);
        vi.advanceTimersByTime(350);
        expect(events.some((e) => e[0] === "holdStart")).toBe(true);
        lift(0);
        sync();
        expect(events.at(-1)).toEqual(["holdEnd", false]);
    });

    it("detects a three-finger hold in addition to the multi gesture", () => {
        vi.useFakeTimers();
        const { events, sync, contact, lift } = setup();
        contact(0, 1, 1000, 2000);
        contact(1, 2, 2000, 2000);
        contact(2, 3, 3000, 2000);
        sync();
        expect(events[0]).toEqual(["multiStart", 3]);
        vi.advanceTimersByTime(350);
        expect(events.some((e) => e[0] === "holdStart" && e[1] === 3)).toBe(true);
        lift(0);
        lift(1);
        lift(2);
        sync();
        expect(events.some((e) => e[0] === "holdEnd")).toBe(true);
        expect(events.at(-1)?.[0]).toBe("multiEnd");
    });

    it("emits multi swipe events for three fingers", () => {
        const { events, sync, contact, move, lift } = setup();
        contact(0, 1, 1000, 2000);
        contact(1, 2, 2000, 2000);
        contact(2, 3, 3000, 2000);
        sync();
        expect(events[0]).toEqual(["multiStart", 3]);
        move(0, 900, 2000);
        move(1, 1900, 2000);
        move(2, 2900, 2000);
        sync();
        expect(events.some((e) => e[0] === "multiMove")).toBe(true);
        lift(0);
        lift(1);
        lift(2);
        sync();
        expect(events.at(-1)?.[0]).toBe("multiEnd");
    });

    it("does not start scroll, pinch or cursor move after a multi gesture loses fingers", () => {
        const { events, sync, contact, move, lift } = setup();
        contact(0, 1, 1000, 2000);
        contact(1, 2, 2000, 2000);
        contact(2, 3, 3000, 2000);
        sync();
        expect(events[0]).toEqual(["multiStart", 3]);
        move(0, 900, 2000);
        move(1, 1900, 2000);
        move(2, 2900, 2000);
        sync();
        expect(events.some((e) => e[0] === "multiMove")).toBe(true);

        // 先抬起一根，剩下两指继续移动：不应产生 scroll/pinch
        lift(2);
        sync();
        expect(events.some((e) => e[0] === "multiEnd")).toBe(true);
        move(0, 800, 2100);
        move(1, 1800, 2100);
        sync();
        expect(events.some((e) => e[0] === "scroll")).toBe(false);
        expect(events.some((e) => e[0] === "pinchStart")).toBe(false);

        // 再抬起一根，最后一根移动也不应移动光标
        lift(1);
        sync();
        move(0, 700, 2300);
        sync();
        expect(events.some((e) => e[0] === "move")).toBe(false);
        lift(0);
        sync();
    });

    it("applies touchpad acceleration to single-finger movement", () => {
        let now = 0;
        const accelerated = setup({
            now: () => now,
            acceleration: { enabled: () => true, speed: () => 0 },
        });
        accelerated.contact(0, 1, 1000, 2000);
        accelerated.sync();
        // 每 10ms 移动 1.6mm，约 160mm/s：高于平台段，稳定后应有加速
        for (let i = 1; i <= 4; i++) {
            now = i * 10;
            accelerated.move(0, 1000 + i * 160, 2000);
            accelerated.sync();
        }
        const moves = accelerated.events.filter((e) => e[0] === "move");
        expect(moves.at(-1)?.[1]).toBeGreaterThan(40);

        now = 0;
        const flat = setup({
            now: () => now,
            acceleration: { enabled: () => false, speed: () => 0 },
        });
        flat.contact(0, 1, 1000, 2000);
        flat.sync();
        for (let i = 1; i <= 4; i++) {
            now = i * 10;
            flat.move(0, 1000 + i * 160, 2000);
            flat.sync();
        }
        const flatMoves = flat.events.filter((e) => e[0] === "move");
        expect(flatMoves.at(-1)?.[1]).toBeCloseTo(40);
    });
});
