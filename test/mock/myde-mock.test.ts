import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockMyde, setupMydeMock, clearMydeMock, createObservableMock } from "./myde-mock";

describe("myde mock", () => {
    afterEach(() => {
        clearMydeMock();
    });

    it("创建基本mock对象", () => {
        const myde = createMockMyde();
        expect(myde).toBeDefined();
        expect(myde.MSysApi).toBeDefined();
        expect(myde.MInputMap).toBeDefined();
        expect(myde.MUtils).toBeDefined();
        expect(myde.MSetting).toBeDefined();
        expect(myde.MConnect).toBeDefined();
    });

    it("设置和清除全局mock", () => {
        expect((globalThis as any).myde).toBeUndefined();
        setupMydeMock();
        expect((globalThis as any).myde).toBeDefined();
        clearMydeMock();
        expect((globalThis as any).myde).toBeUndefined();
    });

    it("自定义MSysApi实现", () => {
        const customEntries = [
            { name: "TestApp", exec: "test-app", icon: "test-icon" },
        ];

        const myde = createMockMyde({
            sysApi: {
                getDesktopEntries: async () => customEntries as any,
            },
        });

        expect(myde.MSysApi.getDesktopEntries()).resolves.toEqual(customEntries);
    });

    it("verbose模式记录调用", () => {
        const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const myde = createMockMyde({ verbose: true });

        myde.MInputMap.mapKeyCode("Space");

        expect(consoleSpy).toHaveBeenCalledWith("[Mock] mapKeyCode", "Space");
        consoleSpy.mockRestore();
    });

    it("可观察mock记录调用", () => {
        const { myde, calls } = createObservableMock();

        myde.MInputMap.mapKeyCode("Space");
        myde.MInputMap.mapKeyCode("Enter");

        expect(calls).toHaveLength(2);
        expect(calls[0].method).toBe("mapKeyCode");
        expect(calls[0].args).toEqual(["Space"]);
        expect(calls[1].method).toBe("mapKeyCode");
        expect(calls[1].args).toEqual(["Enter"]);
    });

    it("mock setting支持get/set", () => {
        const myde = createMockMyde();
        const setting = myde.MSetting.init({ version: "1.0", defaultNsSetting: {} });

        setting.set("testKey", "testValue");
        expect(setting.get("testKey")).toBe("testValue");
    });

    it("mock fs支持文件操作", async () => {
        const myde = createMockMyde();

        const exists = await myde.MSysApi.fs.exists("/test.txt");
        expect(exists).toBe(false);

        const content = await myde.MSysApi.fs.readTextFile("/test.txt");
        expect(content).toBe("");
    });

    it("mock appControl支持进程操作", async () => {
        const myde = createMockMyde();

        const tree = await myde.MSysApi.appControl.getPidTree(123);
        expect(tree.pid).toBe(123);
        expect(tree.name).toBe("mock");

        const pid = myde.MSysApi.appControl.getPid(456);
        expect(pid.getPriority()).toBe(0);
    });
});
