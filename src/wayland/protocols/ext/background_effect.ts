import { defineModule, type ModuleCtx, type WaylandObjectId2 } from "../../module";
import { getEnumValue } from "../../utils/wayland-proto";

/**
 * ext-background-effect-v1
 *
 * 客户端给某个 surface 指定一块「背后要模糊」的区域。区域是双缓冲状态，随
 * `wl_surface.commit` 生效（同步子 surface 也随父 surface 的事务一起生效），
 * 所以状态挂在 `WaylandSurfaceData.blurRegion` 上，而不是效果对象自己的 data。
 *
 * 合成器只负责把区域交给渲染层（`ctx.scene.setBlurRegion`）；模糊半径、算法
 * 属于合成器策略。像素本身仍然是 surface 自己的画布，渲染层把模糊垫在画布下面。
 */
declare module "../../module" {
    interface WaylandDataRegistry {
        ext_background_effect_surface_v1: {
            surface: SurfaceId;
        };
    }
    interface WaylandDomainRegistry {
        backgroundEffect: {
            /** surface → 该 surface 的 effect 对象（协议要求每个 surface 最多一个） */
            bySurface: Map<SurfaceId, WaylandObjectId2<"ext_background_effect_surface_v1">>;
            /** 反向索引：destroy 是 destructor，分发器会先删对象，只能靠它找回 surface */
            byObject: Map<WaylandObjectId2<"ext_background_effect_surface_v1">, SurfaceId>;
            /** 渲染层当前有模糊区域的 surface：没有区域后只需要通知一次清除 */
            rendered: Set<SurfaceId>;
        };
    }
}

function removeByObject(ctx: ModuleCtx, objectId: WaylandObjectId2<"ext_background_effect_surface_v1">): void {
    const domain = ctx.domain.backgroundEffect;
    const surface = domain.byObject.get(objectId);
    if (surface === undefined) return;
    domain.byObject.delete(objectId);
    if (domain.bySurface.get(surface) === objectId) domain.bySurface.delete(surface);
}

export const backgroundEffectModule = defineModule({
    name: "ext-background-effect-v1",
    globals: [
        {
            name: "ext_background_effect_manager_v1",
            onBind: (msg, ctx) => {
                // 只有 blur 一种能力；能力变化时也要重发（当前实现恒定）。
                ctx.send(
                    msg.id as WaylandObjectId2<"ext_background_effect_manager_v1">,
                    "ext_background_effect_manager_v1.capabilities",
                    {
                        flags: getEnumValue("ext_background_effect_manager_v1.capability", ["blur"]),
                    },
                );
            },
        },
    ],
    domain: {
        backgroundEffect: () => ({ bySurface: new Map(), byObject: new Map(), rendered: new Set() }),
    },
    hooks: {
        /**
         * 区域随 commit 生效：这里读的是已经合并进 `current` 的状态，所以同步子 surface
         * 的缓存提交也按事务顺序到达。surface 没有像素（未 attach / attach(nil)）时
         * 不显示模糊，避免解绑后的空白 surface 仍在背景上留一块毛玻璃。
         */
        onCommit: (surfaceId, _sizeChanged, ctx) => {
            const surface = ctx.objects.getOption(surfaceId);
            if (!surface) return;
            const current = surface.data.current;
            const mapped = current.buffer !== null && current.buffer !== undefined;
            const blurRegion = mapped ? current.blurRegion : undefined;
            const region = blurRegion && blurRegion.length > 0 ? blurRegion : undefined;
            const domain = ctx.domain.backgroundEffect;
            // 没有模糊区域的 surface 占多数：不要每次 commit 都往渲染层推一条清除。
            if (region === undefined && !domain.rendered.has(surfaceId)) return;
            if (region === undefined) domain.rendered.delete(surfaceId);
            else domain.rendered.add(surfaceId);
            ctx.scene.setBlurRegion(ctx.core.surface.idScope(surfaceId), region);
        },
        onDestroy: (surfaceId, ctx) => {
            const domain = ctx.domain.backgroundEffect;
            domain.rendered.delete(surfaceId);
            const objectId = domain.bySurface.get(surfaceId);
            if (objectId === undefined) return;
            domain.bySurface.delete(surfaceId);
            domain.byObject.delete(objectId);
        },
    },
    requests: {
        "ext_background_effect_manager_v1.get_background_effect": (x, ctx) => {
            const surfaceId = x.args.surface;
            // 无效 surface 由对象表统一报 invalid_object
            ctx.objects.get(surfaceId);
            const domain = ctx.domain.backgroundEffect;
            if (domain.bySurface.has(surfaceId)) {
                ctx.postError(
                    "ext_background_effect_manager_v1",
                    x.id,
                    "background_effect_exists",
                    "Surface already has a background effect object",
                );
                return;
            }
            const objectId = x.args.id;
            ctx.objects.get(objectId).data = { surface: surfaceId };
            domain.bySurface.set(surfaceId, objectId);
            domain.byObject.set(objectId, surfaceId);
        },
        "ext_background_effect_surface_v1.set_blur_region": (x, ctx) => {
            const surfaceId = ctx.objects.get(x.id).data.surface;
            const surface = ctx.objects.getOption(surfaceId);
            if (!surface) {
                ctx.postError(
                    "ext_background_effect_surface_v1",
                    x.id,
                    "surface_destroyed",
                    "The associated surface has been destroyed",
                );
                return;
            }
            // copy 语义：客户端可以马上去改 / 销毁 wl_region，快照不能跟着变。
            const region = ctx.objects.getOption(x.args.region);
            surface.data.pending.blurRegion = region ? region.data.rects.map((rect) => ({ ...rect })) : null;
        },
        "ext_background_effect_surface_v1.destroy": (x, ctx) => {
            const surfaceId = ctx.domain.backgroundEffect.byObject.get(x.id);
            if (surfaceId !== undefined) {
                // 协议：效果在下一个 commit 移除；只清 pending，不能直接改 current。
                const surface = ctx.objects.getOption(surfaceId);
                if (surface) surface.data.pending.blurRegion = null;
            }
            removeByObject(ctx, x.id);
        },
    },
});
