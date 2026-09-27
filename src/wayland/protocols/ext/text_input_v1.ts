import { defineModule, type WaylandObjectId2 } from "../../module";
import type { WaylandObjectId } from "../../utils/wayland-binary";

/**
 * text-input-unstable-v1
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
declare module "../../module" {
    interface WaylandDomainRegistry {
        /** 本协议的连接态（原 `ClientState.textInputV1`） */
        textInputV1: {
            focus: WaylandObjectId | null;
            m: Map<WaylandObjectId2<"zwp_text_input_v1">, { focus: boolean; serial: number }>;
        };
    }
}

export const textInputV1Module = defineModule({
    name: "text-input-unstable-v1",
    domain: {
        textInputV1: () => ({ focus: null, m: new Map() }),
    },
    hooks: {
        /** `input.text` 经 core 转发到这里；只在本协议是仲裁持有者时发（后激活者胜出） */
        onTextInput: (text, preedit, ctx) => {
            const owner = ctx.domain.textInput.owner;
            if (owner?.protocol !== "v1") return;
            const input1 = ctx.domain.textInputV1;
            const id = Array.from(input1.m).find((i) => i[0] === owner.id && i[1].focus === true);
            if (!id) return;
            if (preedit) {
                ctx.sendNow(id[0], "zwp_text_input_v1.preedit_cursor", { index: text.length });
                ctx.sendNow(id[0], "zwp_text_input_v1.preedit_string", {
                    text: text,
                    commit: text,
                    serial: id[1].serial,
                });
            } else {
                ctx.sendNow(id[0], "zwp_text_input_v1.commit_string", {
                    serial: id[1].serial,
                    text: text,
                });
                ctx.sendNow(id[0], "zwp_text_input_v1.preedit_string", {
                    text: "",
                    commit: "",
                    serial: id[1].serial,
                });
            }
        },
    },
    requests: {
        "zwp_text_input_manager_v1.create_text_input": (x, ctx) => {
            const textInputId = x.args.id;
            ctx.domain.textInputV1.m.set(textInputId, { focus: false, serial: 1 });
        },
        "zwp_text_input_v1.activate": (x, ctx) => {
            ctx.send(x.id, "zwp_text_input_v1.enter", { surface: x.args.surface });
            // v1/v3竞争仲裁：后激活者胜出
            ctx.domain.textInput.owner = { protocol: "v1", id: x.id };
            for (const [k, v] of ctx.domain.textInputV1.m) {
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
            if (ctx.domain.textInputV1.m.get(x.id)?.focus !== true) {
                return;
            }
            ctx.send(x.id, "zwp_text_input_v1.leave", {});
            const t = ctx.domain.textInputV1.m.get(x.id);
            if (t) t.focus = false;
            if (ctx.domain.textInput.owner?.id === x.id) ctx.domain.textInput.owner = null;
        },
        "zwp_text_input_v1.commit_state": (x, ctx) => {
            const xx = ctx.domain.textInputV1.m.get(x.id);
            if (xx) {
                xx.serial = x.args.serial;
            }
        },
    },
});
