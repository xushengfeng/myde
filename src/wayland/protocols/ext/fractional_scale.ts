import { defineModule, type ModuleCtx, type WaylandObjectId2 } from "../../module";

/**
 * fractional-scale-v1
 *
 * 客户端按 `preferred_scale / 120` 渲染 buffer，再用 wp_viewport 把
 * destination 设成 surface 逻辑尺寸。surface 坐标本身不放大。
 */
declare module "../../module" {
    interface WaylandDataRegistry {
        wp_fractional_scale_v1: {
            surface: SurfaceId;
        };
    }
    interface WaylandDomainRegistry {
        fractionalScale: {
            /** surface → 该 surface 的 fractional_scale 对象 */
            bySurface: Map<SurfaceId, WaylandObjectId2<"wp_fractional_scale_v1">>;
            /** 反向索引：destroy 是 destructor，分发器会先删对象，只能靠它找回 surface */
            byObject: Map<WaylandObjectId2<"wp_fractional_scale_v1">, SurfaceId>;
        };
    }
}

/** 协议里 scale 的分母固定为 120。 */
function preferredScale(ctx: ModuleCtx): number {
    const scale = ctx.client.output().scale;
    return Math.max(1, Math.round(scale * 120));
}

function removeByObject(ctx: ModuleCtx, objectId: WaylandObjectId2<"wp_fractional_scale_v1">): void {
    const domain = ctx.domain.fractionalScale;
    const surface = domain.byObject.get(objectId);
    if (surface === undefined) return;
    domain.byObject.delete(objectId);
    if (domain.bySurface.get(surface) === objectId) domain.bySurface.delete(surface);
}

export const fractionalScaleModule = defineModule({
    name: "fractional-scale-v1",
    globals: [{ name: "wp_fractional_scale_manager_v1" }],
    domain: {
        fractionalScale: () => ({ bySurface: new Map(), byObject: new Map() }),
    },
    hooks: {
        /** 输出缩放变化：把新的 preferred_scale 推给这张 surface。 */
        onOutput: (ctx) => {
            const domain = ctx.domain.fractionalScale;
            const scale = preferredScale(ctx);
            for (const [surface, objectId] of domain.bySurface) {
                if (!ctx.objects.has(objectId)) {
                    domain.bySurface.delete(surface);
                    domain.byObject.delete(objectId);
                    continue;
                }
                ctx.sendNow(objectId, "wp_fractional_scale_v1.preferred_scale", { scale });
            }
        },
        /** surface 销毁后不再有 preferred_scale 的接收方。 */
        onDestroy: (surfaceId, ctx) => {
            const domain = ctx.domain.fractionalScale;
            const objectId = domain.bySurface.get(surfaceId);
            if (objectId === undefined) return;
            domain.bySurface.delete(surfaceId);
            domain.byObject.delete(objectId);
        },
    },
    requests: {
        "wp_fractional_scale_manager_v1.get_fractional_scale": (x, ctx) => {
            const surfaceId = x.args.surface;
            // 无效 surface 由对象表统一报 invalid_object
            ctx.objects.get(surfaceId);
            const domain = ctx.domain.fractionalScale;
            if (domain.bySurface.has(surfaceId)) {
                ctx.postError(
                    "wp_fractional_scale_manager_v1",
                    x.id,
                    "fractional_scale_exists",
                    "Surface already has a fractional_scale object",
                );
                return;
            }
            const objectId = x.args.id;
            ctx.objects.get(objectId).data = { surface: surfaceId };
            domain.bySurface.set(surfaceId, objectId);
            domain.byObject.set(objectId, surfaceId);
            ctx.send(objectId, "wp_fractional_scale_v1.preferred_scale", { scale: preferredScale(ctx) });
        },
        "wp_fractional_scale_v1.destroy": (x, ctx) => {
            removeByObject(ctx, x.id);
        },
    },
});
