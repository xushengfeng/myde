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

function setup() {
    const dev = new EventEmitter();
    const input = new TouchpadInput(dev as never, info as never, {
        mapX: (_code, value) => value / 4,
        mapY: (_code, value) => value / 4,
    });
    const events: unknown[][] = [];
    for (const name of [
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
    it("detects a symmetric pinch", () => {
        const { events, sync, contact, move, lift } = setup();
        contact(0, 1, 1000, 2000);
        contact(1, 2, 3000, 2000);
        sync();
        move(0, 500, 2000);
        move(1, 3500, 2000);
        sync();
        expect(events.map((e) => e[0])).toContain("pinchStart");
        expect(events.map((e) => e[0])).not.toContain("scroll");
        const update = events.find((e) => e[0] === "pinchUpdate");
        expect(update?.[3]).toBeCloseTo(1.5);
        lift(0);
        lift(1);
        sync();
        expect(events.at(-1)?.[0]).toBe("pinchEnd");
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
});
