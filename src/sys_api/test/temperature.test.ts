import { afterEach, describe, expect, it } from "vitest";
import { temperature } from "../temperature";

describe("temperature", () => {
    let instance: temperature | undefined;

    afterEach(() => {
        instance?.destroy();
        instance = undefined;
    });

    it("should scan sensors and emit the initial list", async () => {
        const monitor = new temperature({ interval: 60_000 });
        instance = monitor;
        const first = await new Promise<Awaited<ReturnType<typeof monitor.refresh>>>((resolve) => {
            monitor.once("changed", resolve);
            void monitor.init();
        });

        expect(Array.isArray(first)).toBe(true);
        expect(monitor.getSensors()).toEqual(first);
        for (const sensor of first) {
            expect(sensor.id).toBeTypeOf("string");
            expect(sensor.name).toBeTypeOf("string");
            expect(sensor.value).toBeTypeOf("number");
            expect(Number.isFinite(sensor.value)).toBe(true);
        }
    });

    it("should refresh on demand", async () => {
        const monitor = new temperature({ interval: 60_000 });
        instance = monitor;
        await monitor.init();
        const first = monitor.getSensors();
        const second = await monitor.refresh();

        expect(Array.isArray(second)).toBe(true);
        expect(second.length).toBe(first.length);
    });
});
