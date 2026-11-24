import { describe, expect, it } from "vitest";
import { ScrollAxisLock } from "../scroll_axis";

function feed(lock: ScrollAxisLock, dx: number, dy: number, start: number, frames: number) {
    let time = start;
    let allow = { x: true, y: true };
    for (let i = 0; i < frames; i++) {
        time += 10;
        allow = lock.constrain(dx, dy, time);
    }
    return { allow, time };
}

describe("ScrollAxisLock", () => {
    it("locks to the dominant vertical direction", () => {
        const lock = new ScrollAxisLock();
        lock.reset();
        const { allow } = feed(lock, 0, -2, 0, 12);
        expect(allow).toEqual({ x: false, y: true });
        // 横向抖动仍被过滤
        expect(lock.constrain(0.5, -2, 120)).toEqual({ x: false, y: true });
    });

    it("locks to the dominant horizontal direction", () => {
        const lock = new ScrollAxisLock();
        lock.reset();
        const { allow } = feed(lock, 2, 0, 0, 12);
        expect(allow).toEqual({ x: true, y: false });
    });

    it("allows both axes for a clear diagonal scroll", () => {
        const lock = new ScrollAxisLock();
        lock.reset();
        const { allow } = feed(lock, 2, -2, 0, 4);
        expect(allow).toEqual({ x: true, y: true });
    });

    it("resets for a new gesture", () => {
        const lock = new ScrollAxisLock();
        lock.reset();
        feed(lock, 0, -2, 0, 12);
        lock.reset();
        const { allow } = feed(lock, 2, 0, 200, 12);
        expect(allow).toEqual({ x: true, y: false });
    });
});
