import { defineModule } from "../../module";

/**
 * text-input-unstable-v1
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
export const textInputV1Module = defineModule({
    name: "text-input-unstable-v1",
    requests: {
        "zwp_text_input_manager_v1.create_text_input": (x, ctx) => {
            const textInputId = x.args.id;
            if (!ctx.client.state.textInputV1) ctx.client.state.textInputV1 = { focus: null, m: new Map() };
            ctx.client.state.textInputV1.m.set(textInputId, { focus: false, serial: 1 });
        },
        "zwp_text_input_v1.activate": (x, ctx) => {
            ctx.send(x.id, "zwp_text_input_v1.enter", { surface: x.args.surface });
            // v1/v3竞争仲裁：后激活者胜出
            ctx.client.state.textInputOwner = { protocol: "v1", id: x.id };
            if (!ctx.client.state.textInputV1) return;
            for (const [k, v] of ctx.client.state.textInputV1.m) {
                if (k !== x.id && v.focus) {
                    ctx.send(k, "zwp_text_input_v1.leave", {});
                    v.focus = false;
                }
                if (k === x.id) {
                    v.focus = true;
                }
            }
        },
        "zwp_text_input_v1.deactivate": (x, ctx) => {
            if (ctx.client.state.textInputV1?.m.get(x.id)?.focus !== true) {
                return;
            }
            ctx.send(x.id, "zwp_text_input_v1.leave", {});
            if (!ctx.client.state.textInputV1) return;
            const t = ctx.client.state.textInputV1.m.get(x.id);
            if (t) t.focus = false;
            if (ctx.client.state.textInputOwner?.id === x.id) ctx.client.state.textInputOwner = null;
        },
        "zwp_text_input_v1.commit_state": (x, ctx) => {
            const xx = ctx.client.state.textInputV1?.m.get(x.id);
            if (xx) {
                xx.serial = x.args.serial;
            }
        },
    },
});
