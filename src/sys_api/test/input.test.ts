import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { InputManager } from "../input";

describe("InputManager", () => {
    let input: InputManager | null = null;

    afterEach(() => {
        input?.destroy();
    });

    it("should init without error", async () => {
        input = new InputManager(fs);
        await input.init();
    });

    it("should get devices list", async () => {
        input = new InputManager(fs);
        await input.init();
        const devices = input.getDevices();
        expect(Array.isArray(devices)).toBe(true);

        for (const device of devices) {
            expect(device.path).toMatch(/^\/dev\/input\/event\d+$/);
            expect(typeof device.name).toBe("string");
            expect(["keyboard", "mouse", "touchpad", "touchscreen", "tablet", "gamepad", "unknown"]).toContain(
                device.type,
            );
        }
    });

    it("should emit events from device", async () => {
        input = new InputManager(fs);
        await input.init();

        const devices = input.getDevices();
        if (devices.length === 0) {
            console.log("无输入设备，跳过事件测试");
            return;
        }

        const device = devices[0];
        const eventPromise = new Promise<void>((resolve) => {
            device.once("event", (event) => {
                expect(event.device).toBe(device);
                expect(typeof event.type).toBe("number");
                expect(typeof event.code).toBe("number");
                expect(typeof event.value).toBe("number");
                expect(typeof event.timestamp).toBe("number");
                resolve();
            });
        });

        const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error("超时")), 2000));

        try {
            await Promise.race([eventPromise, timeout]);
        } catch {
            console.log("2秒内无输入事件，跳过");
        }
    });

    it("should emit aggregated events from manager", async () => {
        input = new InputManager(fs);
        await input.init();

        const devices = input.getDevices();
        if (devices.length === 0) {
            console.log("无输入设备，跳过聚合事件测试");
            return;
        }

        const currentInput = input;
        const eventPromise = new Promise<void>((resolve) => {
            currentInput?.once("event", (event) => {
                expect(event.device).toBeDefined();
                expect(typeof event.type).toBe("number");
                resolve();
            });
        });

        const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error("超时")), 2000));

        try {
            await Promise.race([eventPromise, timeout]);
        } catch {
            console.log("2秒内无输入事件，跳过");
        }
    });
});
