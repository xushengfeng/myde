import { defineModule } from "../../module";
import { waylandObjectId } from "../../utils/wayland-proto";

/**
 * wl_subcompositor/wl_subsurface
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
export const subsurfaceModule = defineModule({
    name: "wl_subcompositor/wl_subsurface",
    requests: {
        "wl_subcompositor.get_subsurface": (x, ctx) => {
            const r = ctx.core.subsurface.setWlSubSurface(
                x.args.id,
                waylandObjectId(x.args.parent, "wl_surface"),
                waylandObjectId(x.args.surface, "wl_surface"),
            );

            if (r === "bad_surface")
                ctx.postError("wl_subcompositor", x.id, "bad_surface", "Surface already has a role");
            else if (r === "bad_parent")
                ctx.postError("wl_subcompositor", x.id, "bad_parent", "Parent cannot be itself");
            if (r !== true) return;
        },
        "wl_subsurface.set_position": (x, ctx) => {
            ctx.core.subsurface.setPosition(x.id, x.args.x, x.args.y);
        },
        "wl_subsurface.destroy": (x, ctx) => {
            ctx.core.subsurface.destroySubSurface(x.id);
        },
    },
});
