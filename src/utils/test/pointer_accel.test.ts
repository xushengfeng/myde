import { describe, expect, it } from "vitest";
import {
    normalizePointerSpeed,
    PointerVelocityTracker,
    pointerSpeedFactor,
    TOUCHPAD_ACCEL_MAX,
    TOUCHPAD_ACCEL_MIN,
    TouchpadAccelerator,
    touchpadAccelFactor,
} from "../pointer_accel";

describe("pointer acceleration", () => {
    it("maps the libinput speed setting", () => {
        expect(normalizePointerSpeed(-2)).toBe(-1);
        expect(normalizePointerSpeed(2)).toBe(1);
        expect(normalizePointerSpeed(undefined)).toBe(0);
        expect(pointerSpeedFactor(0)).toBeCloseTo(1);
        expect(pointerSpeedFactor(-1)).toBeCloseTo(0.05);
        expect(pointerSpeedFactor(1)).toBeCloseTo(4.9951, 3);
    });

    it("follows the libinput touchpad curve, normalized at the plateau", () => {
        // 慢速减速到约 1/3，平台段保持 1:1
        expect(touchpadAccelFactor(0)).toBeCloseTo(TOUCHPAD_ACCEL_MIN);
        expect(touchpadAccelFactor(7)).toBeCloseTo(1);
        expect(touchpadAccelFactor(130)).toBeCloseTo(1);
        // 4 倍阈值处封顶
        expect(touchpadAccelFactor(520)).toBeCloseTo(TOUCHPAD_ACCEL_MAX);
        expect(touchpadAccelFactor(1000)).toBeCloseTo(TOUCHPAD_ACCEL_MAX);
    });

    it("only scales by the speed setting when acceleration is off", () => {
        expect(touchpadAccelFactor(500, 0, false)).toBeCloseTo(1);
        expect(touchpadAccelFactor(500, 0.5, false)).toBeCloseTo(pointerSpeedFactor(0.5));
    });
});

describe("pointer velocity tracker", () => {
    it("estimates velocity from recent movement", () => {
        const tracker = new PointerVelocityTracker();
        tracker.reset(0);
        for (let i = 1; i <= 6; i++) tracker.feed(1, 0, i * 10);
        // 每 10ms 移动 1mm，约 100mm/s
        expect(tracker.velocity(60)).toBeCloseTo(100, 0);
    });

    it("drops the average after a direction change", () => {
        const tracker = new PointerVelocityTracker();
        tracker.reset(0);
        for (let i = 1; i <= 4; i++) tracker.feed(2, 0, i * 10);
        const forward = tracker.velocity(40);
        tracker.feed(-0.5, 0, 50);
        expect(tracker.velocity(50)).toBeLessThan(forward);
    });

    it("accelerates fast moves and slows slow moves", () => {
        const slow = new TouchpadAccelerator();
        slow.reset(0);
        const slowFactor = slow.factor(0.05, 0, 190, true, 0);
        const fast = new TouchpadAccelerator();
        fast.reset(0);
        let factor = 1;
        for (let i = 1; i <= 6; i++) factor = fast.factor(2, 0, i * 10, true, 0);
        expect(slowFactor).toBeLessThan(1);
        expect(factor).toBeGreaterThan(1);
    });
});
