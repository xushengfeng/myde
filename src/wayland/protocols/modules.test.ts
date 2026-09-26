import { describe, expect, it } from "vitest";
import type { ModuleCtx } from "../module";
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
        expect(names).toContain("wl_surface");
        expect(names).toContain("wl_registry");
        expect(names).toContain("viewporter");
        expect(names).toContain("cursor-shape");
        expect(names).toContain("linux-dmabuf-v1");
    });

    it("core 模块不声明反向钩子，扩展才有", () => {
        const withHooks = protocolModules
            .filter((m) => m.hooks.onFrame || m.hooks.onCommit || m.hooks.onDestroy)
            .map((m) => m.name)
            .sort();
        expect(withHooks).toEqual(["viewporter", "xdg-shell"]);
    });
});

describe("cursor-shape 模块", () => {
    it("set_shape 把枚举名交给 CursorStore（语义光标，后到者生效）", () => {
        const shapeCalls: string[] = [];
        const errors: unknown[] = [];
        const ctx = {
            state: { cursor: { setShape: (s: string) => shapeCalls.push(s) } },
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
            state: { cursor: { setShape: (s: string) => shapeCalls.push(s) } },
            postError: (...a: unknown[]) => errors.push(a[2]),
        } as unknown as ModuleCtx;

        handler("wp_cursor_shape_device_v1.set_shape")(msg(11, { shape: 0x7ffffff0 }), ctx);

        expect(shapeCalls).toHaveLength(0);
        expect(errors).toHaveLength(1);
    });
});
