import { defineModule } from "../../module";

/**
 * wl_pointer
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
export const pointerModule = defineModule({
    name: "wl_pointer",
    requests: {
        "wl_pointer.set_cursor": (x, ctx) => {
            // todo serial
            // todo wlsurface.offset
            const surfaceId = x.args.surface;
            if (!surfaceId) {
                // surface为null时隐藏光标
                ctx.state.cursor.hide();
                return;
            }
            // 校验 surface 存在（无效 id 走 postError）
            ctx.objects.get(surfaceId);
            if (!ctx.core.surface.setRole(surfaceId, "cursor")) {
                ctx.postError("wl_pointer", x.id, "role", "Surface already has another role");
                return;
            }
            ctx.state.cursor.setSurface(
                surfaceId,
                { x: x.args.hotspot_x, y: x.args.hotspot_y },
                ctx.core.surface.getWlSurface(surfaceId).frame,
            );
        },
    },
});
