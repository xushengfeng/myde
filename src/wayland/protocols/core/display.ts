import { defineModule } from "../../module";

/**
 * wl_display
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
export const displayModule = defineModule({
    name: "wl_display",
    requests: {
        "wl_display.sync": (x, ctx) => {
            const callbackId = x.args.callback;
            ctx.sendNow(ctx.client.displayId, "wl_display.delete_id", { id: callbackId });

            ctx.send(callbackId, "wl_callback.done", { callback_data: 0 });
        },
        "wl_display.get_registry": (x, ctx) => {
            const registryId = x.args.registry;
            for (const { name, protocol } of ctx.core.registry.globals()) {
                ctx.send(registryId, "wl_registry.global", {
                    name,
                    interface: protocol.name,
                    version: protocol.version,
                });
            }
        },
    },
});
