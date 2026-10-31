import { describe, expect, it } from "vitest";
import { throttle } from "../throttle";

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("throttle", () => {
    it("首次立即执行，结束时补发最后一次", async () => {
        const calls: number[] = [];
        const t = throttle((v: number) => calls.push(v), 30);

        t(1);
        t(2);
        t(3);
        expect(calls).toEqual([1]);

        await sleep(60);
        expect(calls).toEqual([1, 3]);
    });

    it("flush 立即补发挂起的调用", () => {
        const calls: number[] = [];
        const t = throttle((v: number) => calls.push(v), 1000);

        t(1);
        t(2);
        expect(calls).toEqual([1]);

        t.flush();
        expect(calls).toEqual([1, 2]);
    });

    it("cancel 丢弃挂起的调用", async () => {
        const calls: number[] = [];
        const t = throttle((v: number) => calls.push(v), 20);

        t(1);
        t(2);
        t.cancel();

        await sleep(50);
        expect(calls).toEqual([1]);
    });

    it("leading 为 false 时首次也延迟", async () => {
        const calls: number[] = [];
        const t = throttle((v: number) => calls.push(v), 20, { leading: false });

        t(1);
        expect(calls).toEqual([]);

        await sleep(40);
        expect(calls).toEqual([1]);
    });

    it("trailing 为 false 时不补发", async () => {
        const calls: number[] = [];
        const t = throttle((v: number) => calls.push(v), 20, { trailing: false });

        t(1);
        t(2);
        await sleep(40);
        expect(calls).toEqual([1]);

        t.flush();
        expect(calls).toEqual([1]);
    });
});
