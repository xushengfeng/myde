import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setting } from "./setting";

describe("setting", () => {
    let tmpDir: string;
    let testPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "setting-test-"));
        testPath = path.join(tmpDir, "settings.json");
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe("基本读写", () => {
        it("set 和 get 基本值", () => {
            type MainSetting = { a: number; b: string };
            const s = new setting<MainSetting>({
                version: "1.0",
                filePath: testPath,
                transform: (data) => data,
                defaultSetting: { a: 0, b: "" },
            });
            const se = s.init({ version: "1.0", defaultNsSetting: {} });

            se.set("a", 42);
            se.set("b", "hello");

            expect(se.get("a")).toBe(42);
            expect(se.get("b")).toBe("hello");
        });

        it("值持久化到文件", () => {
            type MainSetting = { x: number };
            const s = new setting<MainSetting>({
                version: "1.0",
                filePath: testPath,
                transform: (data) => data,
                defaultSetting: { x: 0 },
            });
            const se = s.init({ version: "1.0", defaultNsSetting: {} });

            se.set("x", 100);

            const stored = JSON.parse(fs.readFileSync(testPath, "utf-8"));
            expect(stored.x).toBe(100);
            expect(stored.version).toBe("1.0");
        });

        it("未设置的 key 返回默认值", () => {
            type MainSetting = { a: number; b: string };
            const s = new setting<MainSetting>({
                version: "1.0",
                filePath: testPath,
                transform: (data) => data,
                defaultSetting: { a: 99, b: "default" },
            });
            const se = s.init({ version: "1.0", defaultNsSetting: {} });

            expect(se.get("a")).toBe(99);
            expect(se.get("b")).toBe("default");
        });

        it("默认值不写入文件", () => {
            type MainSetting = { key: string };
            const s = new setting<MainSetting>({
                version: "1.0",
                filePath: testPath,
                transform: (data) => data,
                defaultSetting: { key: "default_value" },
            });
            s.init({ version: "1.0", defaultNsSetting: {} });

            const stored = JSON.parse(fs.readFileSync(testPath, "utf-8"));
            expect(stored.key).toBeUndefined();
        });
    });

    describe("命名空间隔离", () => {
        it("不同命名空间的值互相隔离", () => {
            type NsSetting = { val: string };
            const s = new setting({
                version: "1.0",
                filePath: testPath,
                transform: (data) => data,
                defaultSetting: {},
            });
            const ns1 = s.init<NsSetting>({ version: "1.0", nameSpace: "ns1", defaultNsSetting: { val: "" } });
            const ns2 = s.init<NsSetting>({ version: "1.0", nameSpace: "ns2", defaultNsSetting: { val: "" } });

            ns1.nset("val", "value1");
            ns2.nset("val", "value2");

            expect(ns1.nget("val")).toBe("value1");
            expect(ns2.nget("val")).toBe("value2");
        });

        it("命名空间不影响主设置", () => {
            type MainSetting = { key: string };
            type NsSetting = { nsKey: number };
            const s = new setting<MainSetting>({
                version: "1.0",
                filePath: testPath,
                transform: (data) => data,
                defaultSetting: { key: "" },
            });
            const se = s.init<NsSetting>({ version: "1.0", nameSpace: "test", defaultNsSetting: { nsKey: 0 } });

            se.set("key", "main");
            se.nset("nsKey", 999);

            expect(se.get("key")).toBe("main");
            expect(se.nget("nsKey")).toBe(999);

            const stored = JSON.parse(fs.readFileSync(testPath, "utf-8"));
            expect(stored.key).toBe("main");
            expect(stored.namespace.test.nsKey).toBe(999);
        });

        it("默认命名空间为 default", () => {
            type NsSetting = { val: number };
            const s = new setting({
                version: "1.0",
                filePath: testPath,
                transform: (data) => data,
                defaultSetting: {},
            });
            const se = s.init<NsSetting>({ version: "1.0", defaultNsSetting: { val: 0 } });

            se.nset("val", 42);

            const stored = JSON.parse(fs.readFileSync(testPath, "utf-8"));
            expect(stored.namespace.default.val).toBe(42);
        });

        it("未设置的命名空间 key 返回默认值", () => {
            type NsSetting = { opt: boolean };
            const s = new setting({
                version: "1.0",
                filePath: testPath,
                transform: (data) => data,
                defaultSetting: {},
            });
            const se = s.init<NsSetting>({ version: "1.0", nameSpace: "myNs", defaultNsSetting: { opt: true } });

            expect(se.nget("opt")).toBe(true);
        });
    });

    describe("主设置版本升级", () => {
        it("构造时自动升级存储版本", () => {
            fs.writeFileSync(testPath, JSON.stringify({ version: "1.0", count: 5, namespace: {} }));

            type MainSetting = { count: number };
            const transform = (data: Record<string, unknown>, from: string, to: string) => {
                if (from === "1.0" && to === "2.0") {
                    return { ...data, count: (data.count as number) * 10 };
                }
                return data;
            };

            new setting<MainSetting>({ version: "2.0", filePath: testPath, transform, defaultSetting: { count: 0 } });

            const stored = JSON.parse(fs.readFileSync(testPath, "utf-8"));
            expect(stored.version).toBe("2.0");
            expect(stored.count).toBe(50);
        });

        it("get 时通过 transform 转换到目标版本", () => {
            fs.writeFileSync(testPath, JSON.stringify({ version: "1.0", value: "old", namespace: {} }));

            type MainSetting = { value: string };
            const transform = (data: Record<string, unknown>, from: string, to: string) => {
                if (from === "1.0" && to === "2.0") {
                    return { ...data, value: `${data.value}_v2` };
                }
                return data;
            };

            const s = new setting<MainSetting>({
                version: "1.0",
                filePath: testPath,
                transform,
                defaultSetting: { value: "" },
            });
            const se = s.init({ version: "2.0", defaultNsSetting: {} });

            expect(se.get("value")).toBe("old_v2");
        });

        it("字段重命名迁移", () => {
            fs.writeFileSync(testPath, JSON.stringify({ version: "1.0", oldName: "data", namespace: {} }));

            type MainSetting = { newName: string };
            const transform = (data: Record<string, unknown>, from: string, to: string) => {
                if (from === "1.0" && to === "2.0") {
                    const { oldName, ...rest } = data;
                    return { ...rest, newName: oldName };
                }
                return data;
            };

            const s = new setting<MainSetting>({
                version: "2.0",
                filePath: testPath,
                transform,
                defaultSetting: { newName: "" },
            });
            const se = s.init({ version: "2.0", defaultNsSetting: {} });

            expect(se.get("newName")).toBe("data");
        });
    });

    describe("命名空间版本升级", () => {
        it("通过 transform 转换命名空间数据", () => {
            fs.writeFileSync(testPath, JSON.stringify({ version: "1.0", namespace: { myNs: { oldKey: "nsValue" } } }));

            type NsSetting = { newKey: string };
            const s = new setting({
                version: "1.0",
                filePath: testPath,
                transform: (data) => data,
                defaultSetting: {},
            });
            const se = s.init<NsSetting>({
                version: "2.0",
                nameSpace: "myNs",
                defaultNsSetting: { newKey: "" },
                transform: (old: Record<string, unknown>) => {
                    return { newKey: `${old.oldKey}_migrated` };
                },
            });

            expect(se.nget("newKey")).toBe("nsValue_migrated");
        });

        it("命名空间不存在时 transform 接收空对象", () => {
            fs.writeFileSync(testPath, JSON.stringify({ version: "1.0", namespace: {} }));

            let received: Record<string, unknown> | null = null;
            type NsSetting = { defaultValue: number };
            const s = new setting({
                version: "1.0",
                filePath: testPath,
                transform: (data) => data,
                defaultSetting: {},
            });
            const se = s.init<NsSetting>({
                version: "1.0",
                nameSpace: "newNs",
                defaultNsSetting: { defaultValue: 0 },
                transform: (old: Record<string, unknown>) => {
                    received = old;
                    return { defaultValue: 42 };
                },
            });

            expect(received).toEqual({});
            expect(se.nget("defaultValue")).toBe(42);
        });

        it("转换后的数据被持久化", () => {
            fs.writeFileSync(testPath, JSON.stringify({ version: "1.0", namespace: { myNs: { old: "data" } } }));

            type NsSetting = { converted: string };
            const s = new setting({
                version: "1.0",
                filePath: testPath,
                transform: (data) => data,
                defaultSetting: {},
            });
            s.init<NsSetting>({
                version: "2.0",
                nameSpace: "myNs",
                defaultNsSetting: { converted: "" },
                transform: (old: Record<string, unknown>) => ({
                    converted: `${old.old}_new`,
                }),
            });

            const stored = JSON.parse(fs.readFileSync(testPath, "utf-8"));
            expect(stored.namespace.myNs.converted).toBe("data_new");
        });
    });
});
