import {
    defineModule,
    type ClientState,
    type ModuleCtx,
    type SurfaceId,
    type TextInputV3Data,
} from "../../module";
import { newTextInputV3State } from "../../utils/text_input";
import { getEnumName } from "../../utils/wayland-proto";

// TODO 待补 import（server.ts 顶层）: newTextInputV3State

/**
 * text-input-unstable-v3
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
/** 键盘焦点跟随：enter 发给所有 text_input 对象（协议要求），leave 后状态失效 */
function v3Focus(ti: ClientState["textInputV3"], surface: SurfaceId, ctx: ModuleCtx): void {
    if (ti.focus === surface) return;
    if (ti.focus !== null) v3Blur(ti, ti.focus, ctx);
    ti.focus = surface;
    for (const [id, t] of ti.m) {
        t.entered = true;
        ctx.sendNow(id, "zwp_text_input_v3.enter", { surface });
    }
}

function v3Blur(ti: ClientState["textInputV3"], surface: SurfaceId, ctx: ModuleCtx): void {
    if (ti.focus !== surface) return;
    for (const [id, t] of ti.m) {
        if (!t.entered) continue;
        t.entered = false;
        ctx.sendNow(id, "zwp_text_input_v3.leave", { surface });
        t.current = newTextInputV3State();
        t.pending = newTextInputV3State();
    }
    ti.focus = null;
}

export const textInputV3Module = defineModule({
    name: "text-input-unstable-v3",
    hooks: {
        /** 键盘焦点变化由 core 触发；v3 的 enter/leave 跟随键盘焦点（v1 不跟） */
        onFocus: (surfaceId, ctx) => {
            const ti = ctx.client.state.textInputV3;
            if (surfaceId === undefined) {
                if (ti.focus !== null) v3Blur(ti, ti.focus, ctx);
                return;
            }
            v3Focus(ti, surfaceId, ctx);
        },
    },
    requests: {
        "zwp_text_input_manager_v3.get_text_input": (x, ctx) => {
            const textInputId = x.args.id;
            // todo seat参数，目前只有单seat
            const data: TextInputV3Data = {
                entered: false,
                commitCount: 0,
                current: newTextInputV3State(),
                pending: newTextInputV3State(),
            };
            ctx.client.state.textInputV3.m.set(textInputId, data);
            // 对象创建晚于焦点变化时补发enter
            const focus = ctx.client.state.textInputV3.focus;
            if (focus !== null) {
                data.entered = true;
                ctx.sendNow(textInputId, "zwp_text_input_v3.enter", { surface: focus });
            }
        },
        "zwp_text_input_v3.destroy": (x, ctx) => {
            ctx.client.state.textInputV3.m.delete(x.id);
            if (ctx.client.state.textInputOwner?.id === x.id) ctx.client.state.textInputOwner = null;
        },
        "zwp_text_input_v3.enable": (x, ctx) => {
            const t = ctx.client.state.textInputV3.m.get(x.id);
            if (!t) return;
            // enable会重置所有状态，客户端需重新提交
            t.pending = newTextInputV3State();
            t.pending.enabled = true;
            // v1/v3竞争仲裁：后激活者胜出
            ctx.client.state.textInputOwner = { protocol: "v3", id: x.id };
        },
        "zwp_text_input_v3.disable": (x, ctx) => {
            const t = ctx.client.state.textInputV3.m.get(x.id);
            if (!t) return;
            // disable同样使状态失效
            t.pending = newTextInputV3State();
            if (ctx.client.state.textInputOwner?.id === x.id) ctx.client.state.textInputOwner = null;
        },
        "zwp_text_input_v3.set_surrounding_text": (x, ctx) => {
            const t = ctx.client.state.textInputV3.m.get(x.id);
            if (!t) return;
            t.pending.surroundingText = { text: x.args.text, cursor: x.args.cursor, anchor: x.args.anchor };
        },
        "zwp_text_input_v3.set_text_change_cause": (x, ctx) => {
            const t = ctx.client.state.textInputV3.m.get(x.id);
            if (!t) return;
            const cause = getEnumName("zwp_text_input_v3.change_cause", x.args.cause);
            t.pending.textChangeCause = cause === "other" ? "other" : "input_method";
        },
        "zwp_text_input_v3.set_content_type": (x, ctx) => {
            const t = ctx.client.state.textInputV3.m.get(x.id);
            if (!t) return;
            t.pending.contentHint = x.args.hint;
            t.pending.contentPurpose = x.args.purpose;
        },
        "zwp_text_input_v3.set_cursor_rectangle": (x, ctx) => {
            const t = ctx.client.state.textInputV3.m.get(x.id);
            if (!t) return;
            t.pending.cursorRect = { x: x.args.x, y: x.args.y, width: x.args.width, height: x.args.height };
        },
        "zwp_text_input_v3.commit": (x, ctx) => {
            const t = ctx.client.state.textInputV3.m.get(x.id);
            if (!t) return;
            t.current = { ...t.pending };
            // change_cause只作用于本次commit，应用后重置
            t.pending.textChangeCause = "input_method";
            t.commitCount++;
            ctx.sendNow(x.id, "zwp_text_input_v3.done", { serial: t.commitCount });
        },
    },
});
