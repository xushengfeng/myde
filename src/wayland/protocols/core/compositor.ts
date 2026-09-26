import { defineModule } from "../../module";

/**
 * wl_compositor
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
export const compositorModule = defineModule({
    name: "wl_compositor",
    requests: {
        "wl_compositor.create_surface": (x, ctx) => {
            const surfaceId = x.args.id;
            const surface = ctx.objects.get(surfaceId);
            surface.data = { canvas: new OffscreenCanvas(1, 1), current: {}, pending: {} };
            ctx.core.surface.addWlSurface(surfaceId);
        },
    },
});
