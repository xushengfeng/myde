import { describe, expect, it } from "vitest";
import type { ModuleCtx, SurfaceId, WaylandObjectId2 } from "../../module";
import { backgroundEffectModule } from "./background_effect";

type SurfaceState = {
    current: { buffer?: { id: number } | null; blurRegion?: unknown };
    pending: { blurRegion?: unknown };
};

function setup() {
    const surfaces = new Map<number, SurfaceState>();
    const objects = new Map<number, { data: any }>();
    const errors: { iface: string; code: unknown; message?: string }[] = [];
    const sent: { id: number; event: string; args: Record<string, unknown> }[] = [];
    const sceneBlur: { id: string; region: unknown }[] = [];

    const ctx = {
        objects: {
            get: (id: number) => {
                if (id === 1) {
                    if (!surfaces.has(1)) throw new Error("missing surface");
                    return { data: surfaces.get(1) };
                }
                if (!objects.has(id)) throw new Error(`missing object ${id}`);
                return objects.get(id);
            },
            getOption: (id: number | undefined) => {
                if (id === undefined) return undefined;
                if (id === 1) return surfaces.has(1) ? { data: surfaces.get(1) } : undefined;
                return objects.get(id);
            },
            has: (id: number) => (id === 1 ? surfaces.has(1) : objects.has(id)),
        },
        domain: { backgroundEffect: backgroundEffectModule.domain.backgroundEffect?.(null as never) },
        postError: (iface: string, _id: number, code: unknown, message?: string) =>
            errors.push({ iface, code, message }),
        send: (id: number, event: string, args: Record<string, unknown>) => sent.push({ id, event, args }),
        core: { surface: { idScope: (id: unknown) => `s${String(id)}` } },
        scene: { setBlurRegion: (id: string, region: unknown) => sceneBlur.push({ id, region }) },
    } as unknown as ModuleCtx;

    return { ctx, surfaces, objects, errors, sent, sceneBlur };
}

function handler(key: string) {
    const h = backgroundEffectModule.requests.get(key as never);
    if (!h) throw new Error(`未声明 ${key}`);
    return h;
}

const msg = (id: number, args: Record<string, unknown>) => ({ id, proto: {}, op: {}, args }) as never;

describe("ext-background-effect-v1", () => {
    it("bind 时广播 blur 能力", () => {
        const { ctx, sent } = setup();
        const global = backgroundEffectModule.globals.find((g) => g.name === "ext_background_effect_manager_v1");
        global?.onBind?.({ name: 10 as never, id: 30 as never, protocol: {} as never, version: 1 }, ctx);
        expect(sent).toEqual([{ id: 30, event: "ext_background_effect_manager_v1.capabilities", args: { flags: 1 } }]);
    });

    it("同一 surface 只能有一个 effect，冲突报 background_effect_exists", () => {
        const { ctx, errors, surfaces, objects } = setup();
        surfaces.set(1, { current: {}, pending: {} });
        objects.set(41, { data: {} });

        handler("ext_background_effect_manager_v1.get_background_effect")(msg(40, { id: 41, surface: 1 }), ctx);
        expect(ctx.objects.get(41 as WaylandObjectId2<"ext_background_effect_surface_v1">).data).toEqual({
            surface: 1,
        });

        objects.set(42, { data: {} });
        handler("ext_background_effect_manager_v1.get_background_effect")(msg(40, { id: 42, surface: 1 }), ctx);
        expect(errors).toEqual([
            {
                iface: "ext_background_effect_manager_v1",
                code: "background_effect_exists",
                message: expect.any(String),
            },
        ]);
    });

    it("set_blur_region 拷贝到 pending；commit 后 onCommit 把区域交给 scene", () => {
        const { ctx, surfaces, objects, sceneBlur } = setup();
        const surface: SurfaceState = { current: { buffer: { id: 9 } }, pending: {} };
        surfaces.set(1, surface);
        objects.set(41, { data: { surface: 1 } });
        objects.set(50, { data: { rects: [{ x: 1, y: 2, width: 3, height: 4, type: "+" }] } });

        handler("ext_background_effect_surface_v1.set_blur_region")(msg(41, { region: 50 }), ctx);
        expect(surface.pending.blurRegion).toEqual([{ x: 1, y: 2, width: 3, height: 4, type: "+" }]);
        // copy 语义：region 之后还能被客户端修改 / 销毁
        const regionObject = objects.get(50);
        if (!regionObject) throw new Error("region object missing");
        (regionObject.data.rects[0] as { x: number }).x = 99;
        expect(surface.pending.blurRegion).toEqual([{ x: 1, y: 2, width: 3, height: 4, type: "+" }]);

        // 应用提交状态（core 会把 pending 合进 current）
        surface.current = { ...surface.current, blurRegion: surface.pending.blurRegion };
        backgroundEffectModule.hooks.onCommit?.(1 as SurfaceId, false, ctx);
        expect(sceneBlur).toEqual([{ id: "s1", region: [{ x: 1, y: 2, width: 3, height: 4, type: "+" }] }]);
    });

    it("没有像素（attach(nil)）时移除模糊；NULL region 也移除", () => {
        const { ctx, surfaces, sceneBlur } = setup();
        const surface: SurfaceState = {
            current: { buffer: { id: 1 }, blurRegion: [{ x: 0, y: 0, width: 10, height: 10, type: "+" }] },
            pending: {},
        };
        surfaces.set(1, surface);
        backgroundEffectModule.hooks.onCommit?.(1 as SurfaceId, false, ctx);
        expect(sceneBlur[0]).toEqual({
            id: "s1",
            region: [{ x: 0, y: 0, width: 10, height: 10, type: "+" }],
        });

        surface.current = { buffer: null, blurRegion: surface.current.blurRegion };
        backgroundEffectModule.hooks.onCommit?.(1 as SurfaceId, false, ctx);
        expect(sceneBlur[1]).toEqual({ id: "s1", region: undefined });

        // 已经把区域清掉之后，后续没有模糊的 commit 不再打扰渲染层
        backgroundEffectModule.hooks.onCommit?.(1 as SurfaceId, false, ctx);
        expect(sceneBlur).toHaveLength(2);

        surface.current = { buffer: { id: 1 }, blurRegion: null };
        backgroundEffectModule.hooks.onCommit?.(1 as SurfaceId, false, ctx);
        expect(sceneBlur).toHaveLength(2);
    });

    it("destroy 在下一个 commit 清除；surface 销毁后效果对象报 surface_destroyed", () => {
        const { ctx, surfaces, objects, errors } = setup();
        const surface: SurfaceState = {
            current: { buffer: { id: 1 }, blurRegion: [{ x: 0, y: 0, width: 1, height: 1, type: "+" }] },
            pending: {},
        };
        surfaces.set(1, surface);
        objects.set(41, { data: { surface: 1 } });

        handler("ext_background_effect_manager_v1.get_background_effect")(msg(40, { id: 41, surface: 1 }), ctx);
        handler("ext_background_effect_surface_v1.destroy")(msg(41, {}), ctx);
        expect(surface.pending.blurRegion).toBeNull();
        expect(ctx.domain.backgroundEffect.bySurface.size).toBe(0);

        // effect 已销毁，协议错误只在仍存在对象上发生；这里直接验证 surface 不在对象表时的分支
        objects.set(42, { data: { surface: 1 } });
        surfaces.delete(1);
        handler("ext_background_effect_surface_v1.set_blur_region")(msg(42, { region: undefined }), ctx);
        expect(errors.at(-1)).toMatchObject({ iface: "ext_background_effect_surface_v1", code: "surface_destroyed" });
    });
});
