import { describe, expect, it } from "vitest";
import { InputEventCodes } from "../../input_codes/types";
import type { ModuleCtx, SeatRecord, SurfaceId, WaylandObjectId2, WaylandWinId } from "../module";
import { waylandCoreModule } from "./core/wayland";
import { cursorShapeModule } from "./ext/cursor_shape";
import { assertModuleConflicts, protocolModules } from "./index";

function handler(key: string) {
    const h = cursorShapeModule.requests.get(key as never);
    if (!h) throw new Error(`未声明 ${key}`);
    return h;
}

const msg = (id: number, args: Record<string, unknown>) => ({ id, proto: {}, op: {}, args }) as never;

describe("协议模块注册", () => {
    it("所有模块的请求键互不冲突（重复会静默覆盖，所以启动即校验）", () => {
        expect(() => assertModuleConflicts()).not.toThrow();
    });

    it("core 与扩展都已注册", () => {
        const names = protocolModules.map((m) => m.name).sort();
        expect(names).toContain("wayland");
        expect(names).toContain("cursor-shape");
        expect(names).toContain("linux-dmabuf-v1");
    });

    it("core 模块不声明反向钩子，扩展才有", () => {
        const withHooks = protocolModules
            .filter((m) => m.hooks.onFrame || m.hooks.onCommit || m.hooks.onDestroy)
            .map((m) => m.name)
            .sort();
        expect(withHooks).toEqual(["text-input-unstable-v3", "viewporter", "xdg-shell"]);
    });
});

describe("桌面命令（actions）", () => {
    it("每个命令只有一个声明方，且按协议归属", () => {
        const owner = new Map<string, string>();
        for (const m of protocolModules) {
            for (const key of m.actions.keys()) {
                expect(owner.has(key), `命令 ${key} 同时由 ${owner.get(key)} 与 ${m.name} 声明`).toBe(false);
                owner.set(key, m.name);
            }
        }
        // 输入与剪贴板属 seat/data-device，即 core
        expect(owner.get("input.pointer")).toBe("wayland");
        expect(owner.get("input.scroll")).toBe("wayland");
        expect(owner.get("input.key")).toBe("wayland");
        expect(owner.get("input.text")).toBe("wayland");
        expect(owner.get("clipboard.offer")).toBe("wayland");
        // 窗口命令属 xdg-shell
        for (const key of [
            "window.focus",
            "window.blur",
            "window.close",
            "window.setBox",
            "window.setSize",
            "window.maximize",
            "window.unmaximize",
            "window.minimize",
        ]) {
            expect(owner.get(key), `命令 ${key} 没有声明方`).toBe("xdg-shell");
        }
    });

    it("input.key 组 wl_keyboard.key，修饰键才补发 wl_keyboard.modifiers", () => {
        const action = waylandCoreModule.actions.get("input.key");
        expect(action, "core 未声明 input.key").toBeDefined();

        const sent: { id: number; event: string; args: Record<string, unknown> }[] = [];
        const mods = new Set<number>();
        // per-seat：焦点、键盘、修饰键都挂在 SeatRecord 上
        const seat = {
            name: "seat0",
            keyboard: 7 as WaylandObjectId2<"wl_keyboard">,
            keyboardFocus: 100 as unknown as SurfaceId,
            mods,
        } as unknown as SeatRecord;
        const ctx = {
            domain: {
                seat: {
                    byName: (name: string) => (name === "seat0" ? seat : undefined),
                    nextSerial: () => 5,
                    addModifier: (s: SeatRecord, b: number) => s.mods.add(b),
                    removeModifier: (s: SeatRecord, b: number) => s.mods.delete(b),
                    modifierMask: (s: SeatRecord) => {
                        let mask = 0;
                        for (const b of s.mods) mask |= 1 << b;
                        return mask;
                    },
                },
            },
            sendNow: (id: number, event: string, args: Record<string, unknown>) => sent.push({ id, event, args }),
        } as unknown as ModuleCtx;

        // 普通按键：只有 wl_keyboard.key
        action?.({ winId: 1 as WaylandWinId, args: [30, "pressed"] }, ctx);
        expect(sent.map((s) => s.event)).toEqual(["wl_keyboard.key"]);
        expect(sent[0].id).toBe(7);
        expect(sent[0].args).toMatchObject({ serial: 5, key: 30 });

        // 修饰键：key 之后补发 modifiers，掩码来自该 seat
        sent.length = 0;
        action?.({ winId: 1 as WaylandWinId, args: [InputEventCodes.KEY_LEFTSHIFT, "pressed"] }, ctx);
        expect(sent.map((s) => s.event)).toEqual(["wl_keyboard.key", "wl_keyboard.modifiers"]);
        expect(sent[1].args).toMatchObject({ serial: 5, mods_depressed: 1 << 0 });

        // 该 seat 没有键盘焦点：一条都不发（客户端不该收到不属于聚焦窗口的按键）
        sent.length = 0;
        seat.keyboardFocus = null;
        action?.({ winId: 1 as WaylandWinId, args: [30, "pressed"] }, ctx);
        expect(sent).toEqual([]);
    });

    it("input.text 只是转发（带 seat），仲裁由各 text_input 模块的 onTextInput 自判", () => {
        const action = waylandCoreModule.actions.get("input.text");
        const calls: [string, string, boolean][] = [];
        const ctx = {
            domain: { seat: { byName: (name: string) => (name.startsWith("seat") ? { name } : undefined) } },
            notify: { textInput: (seat: string, text: string, preedit: boolean) => calls.push([seat, text, preedit]) },
        } as unknown as ModuleCtx;

        // 不传 seat → 缺省 seat0
        action?.({ winId: 1 as WaylandWinId, args: ["hi", true] }, ctx);
        expect(calls).toEqual([["seat0", "hi", true]]);

        // 显式另一把 seat → 透传
        action?.({ winId: 1 as WaylandWinId, args: ["hi", false, "seat1"] }, ctx);
        expect(calls[1]).toEqual(["seat1", "hi", false]);
    });
});

describe("cursor-shape 模块", () => {
    it("set_shape 把枚举名交给 CursorStore（语义光标，后到者生效）", () => {
        const shapeCalls: string[] = [];
        const errors: unknown[] = [];
        const ctx = {
            cursor: { setShape: (s: string) => shapeCalls.push(s) },
            postError: (...a: unknown[]) => errors.push(a),
        } as unknown as ModuleCtx;

        handler("wp_cursor_shape_device_v1.set_shape")(msg(11, { shape: 1 }), ctx);

        expect(errors).toHaveLength(0);
        expect(shapeCalls).toHaveLength(1);
        expect(typeof shapeCalls[0]).toBe("string");
    });

    it("非法 shape 发协议错误，不改光标", () => {
        const shapeCalls: string[] = [];
        const errors: unknown[] = [];
        const ctx = {
            cursor: { setShape: (s: string) => shapeCalls.push(s) },
            postError: (...a: unknown[]) => errors.push(a[2]),
        } as unknown as ModuleCtx;

        handler("wp_cursor_shape_device_v1.set_shape")(msg(11, { shape: 0x7ffffff0 }), ctx);

        expect(shapeCalls).toHaveLength(0);
        expect(errors).toHaveLength(1);
    });
});
