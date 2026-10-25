import { beforeEach, describe, expect, it, vi } from "vitest";
import { viewporterModule } from "../protocols/ext/viewporter";

/**
 * wp_viewport 的 source/destination 是**持续生效**的双缓冲状态：
 * commit 后必须一直用到下一次 set_*，不能只在设置它的那次 commit 生效。
 * Chrome 的 popup 收缩就是用 set_source 裁掉旧内容，读 pending 会让裁剪丢失。
 */
class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }
    getContext() {
        return { drawImage: () => {} };
    }
}

function createCtx() {
    const surface = {
        current: {} as {
            viewport?: {
                source?: { x: number; y: number; width: number; height: number };
                destination?: { width: number; height: number };
            };
        },
        pending: {} as typeof surface.current,
        canvas: { width: 768, height: 512 },
    };
    const objects = new Map<number, unknown>([
        [1, { protocol: { name: "wl_surface" }, data: surface }],
        [2, { protocol: { name: "wp_viewport" }, data: { surface: 1 } }],
    ]);
    const postError = vi.fn();
    const ctx = {
        objects: { get: (id: number) => objects.get(id) },
        postError,
    };
    const commit = () => {
        surface.current = { ...surface.current, ...surface.pending };
        surface.pending = {};
    };
    return { ctx, surface, commit, postError };
}

// biome-ignore lint/style/noNonNullAssertion: 模块固定提供这几个入口
const get_viewport = viewporterModule.requests.get("wp_viewporter.get_viewport")!;
// biome-ignore lint/style/noNonNullAssertion: 同上
const set_source = viewporterModule.requests.get("wp_viewport.set_source")!;
// biome-ignore lint/style/noNonNullAssertion: 同上
const set_destination = viewporterModule.requests.get("wp_viewport.set_destination")!;
// biome-ignore lint/style/noNonNullAssertion: 同上
const onFrame = viewporterModule.hooks.onFrame!;

describe("wp_viewport", () => {
    beforeEach(() => {
        vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    });

    it("source 在后续 commit 中持续生效，而不是一次性", () => {
        const { ctx, surface, commit, postError } = createCtx();
        get_viewport({ id: 2, args: { id: 2, surface: 1 } } as never, ctx as never);
        set_source({ id: 2, args: { x: 0, y: 0, width: 334, height: 115 } } as never, ctx as never);
        commit();
        expect(surface.current.viewport?.source).toEqual({ x: 0, y: 0, width: 334, height: 115 });

        // 后续 commit 没有再次 set_source：仍应继续按 source 裁剪（旧实现这里会丢）
        const first = onFrame(
            1 as never,
            { width: 768, height: 512 } as never,
            {} as never,
            ctx as never,
        ) as unknown as FakeOffscreenCanvas;
        expect(first.width).toBe(334);
        expect(first.height).toBe(115);
        const second = onFrame(
            1 as never,
            { width: 768, height: 512 } as never,
            {} as never,
            ctx as never,
        ) as unknown as FakeOffscreenCanvas;
        expect(second.width).toBe(334);
        expect(second.height).toBe(115);

        // 再次 set_source 应基于 current 复制 pending，并更新状态
        set_source({ id: 2, args: { x: 0, y: 0, width: 334, height: 187 } } as never, ctx as never);
        commit();
        expect(surface.current.viewport?.source).toEqual({ x: 0, y: 0, width: 334, height: 187 });
        const third = onFrame(
            1 as never,
            { width: 768, height: 512 } as never,
            {} as never,
            ctx as never,
        ) as unknown as FakeOffscreenCanvas;
        expect(third.width).toBe(334);
        expect(third.height).toBe(187);
        expect(postError).not.toHaveBeenCalled();
    });

    it("destination 参与缩放且持续生效；unset 后恢复整幅", () => {
        const { ctx, surface, commit } = createCtx();
        get_viewport({ id: 2, args: { id: 2, surface: 1 } } as never, ctx as never);
        set_source({ id: 2, args: { x: 0, y: 0, width: 334, height: 187 } } as never, ctx as never);
        set_destination({ id: 2, args: { width: 200, height: 100 } } as never, ctx as never);
        commit();
        // 同一 commit 前的 set_source/set_destination 必须都保留
        expect(surface.current.viewport?.source).toEqual({ x: 0, y: 0, width: 334, height: 187 });
        expect(surface.current.viewport?.destination).toEqual({ width: 200, height: 100 });
        const scaled = onFrame(
            1 as never,
            { width: 768, height: 512 } as never,
            {} as never,
            ctx as never,
        ) as unknown as FakeOffscreenCanvas;
        expect([scaled.width, scaled.height]).toEqual([200, 100]);

        set_source({ id: 2, args: { x: -1, y: -1, width: -1, height: -1 } } as never, ctx as never);
        set_destination({ id: 2, args: { width: -1, height: -1 } } as never, ctx as never);
        commit();
        const full = onFrame(1 as never, { width: 768, height: 512 } as never, {} as never, ctx as never);
        expect(full).toBeUndefined();
    });

    it("source 超出当前 canvas 时不在请求阶段报错，渲染时安全跳过", () => {
        const { ctx, commit, postError } = createCtx();
        get_viewport({ id: 2, args: { id: 2, surface: 1 } } as never, ctx as never);
        // 客户端先给新 buffer 设 source，再 attach；此时当前 canvas 还是旧尺寸
        set_source({ id: 2, args: { x: 0, y: 0, width: 1000, height: 600 } } as never, ctx as never);
        commit();
        expect(postError).not.toHaveBeenCalled();
        const canvas = { width: 768, height: 512 };
        const out = onFrame(1 as never, canvas as never, {} as never, ctx as never);
        expect(out).toBe(canvas);
    });
});
