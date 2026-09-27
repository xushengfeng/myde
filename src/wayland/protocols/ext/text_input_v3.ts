import {
    defineModule,
    type ModuleCtx,
    type SurfaceId,
    type TextInputV3Data,
    type WaylandDomainRegistry,
    type WaylandObjectId2,
} from "../../module";
import { newTextInputV3State } from "../../utils/text_input";
import { getEnumName } from "../../utils/wayland-proto";

// TODO 待补 import（server.ts 顶层）: newTextInputV3State

/**
 * text-input-unstable-v3
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
declare module "../../module" {
    interface WaylandDomainRegistry {
        /** 本协议的连接态（原 `ClientState.textInputV3`）；焦点跟随**每把 seat** 的键盘焦点 */
        textInputV3: {
            /** seat 名 → 该 seat 键盘焦点的 surface（多 seat 各跟各的，互不干扰） */
            focus: Map<string, SurfaceId | null>;
            m: Map<WaylandObjectId2<"zwp_text_input_v3">, TextInputV3Data>;
        };
    }
}

/**
 * 键盘焦点跟随：enter 发给**该 seat 的**所有 text_input 对象（协议要求逐对象发），leave 后状态失效。
 * 两把 seat 的焦点分开记，否则 seat1 的聚焦会把 seat0 的 enter 挤掉。
 */
function v3Focus(ti: WaylandDomainRegistry["textInputV3"], seat: string, surface: SurfaceId, ctx: ModuleCtx): void {
    const prev = ti.focus.get(seat) ?? null;
    if (prev === surface) return;
    if (prev !== null) v3Blur(ti, seat, prev, ctx);
    ti.focus.set(seat, surface);
    for (const [id, t] of ti.m) {
        if (t.seat !== seat) continue;
        t.entered = true;
        ctx.sendNow(id, "zwp_text_input_v3.enter", { surface });
    }
}

function v3Blur(ti: WaylandDomainRegistry["textInputV3"], seat: string, surface: SurfaceId, ctx: ModuleCtx): void {
    if ((ti.focus.get(seat) ?? null) !== surface) return;
    for (const [id, t] of ti.m) {
        if (t.seat !== seat || !t.entered) continue;
        t.entered = false;
        // surface 可能已被客户端销毁（那种路径只静默清槽），引用死对象会把连接打死
        if (ctx.objects.has(surface)) ctx.sendNow(id, "zwp_text_input_v3.leave", { surface });
        t.current = newTextInputV3State();
        t.pending = newTextInputV3State();
    }
    ti.focus.set(seat, null);
}

export const textInputV3Module = defineModule({
    name: "text-input-unstable-v3",
    domain: {
        textInputV3: () => ({ focus: new Map<string, SurfaceId | null>(), m: new Map() }),
    },
    hooks: {
        /** 键盘焦点变化由 core 触发；v3 的 enter/leave 跟随**该把 seat** 的键盘焦点（v1 不跟） */
        onFocus: (seat, surfaceId, ctx) => {
            const ti = ctx.domain.textInputV3;
            if (surfaceId === undefined) {
                const prev = ti.focus.get(seat) ?? null;
                if (prev !== null) v3Blur(ti, seat, prev, ctx);
                return;
            }
            v3Focus(ti, seat, surfaceId, ctx);
        },
        /**
         * surface 销毁时静默收敛：`wl_surface.destroy` 只清焦点槽、不发任何事件（死对象引用不了），
         * 这里把该 seat 的 focus 与 entered 一起抹平，等下次焦点变化再重新 enter。
         */
        onDestroy: (surfaceId, ctx) => {
            const ti = ctx.domain.textInputV3;
            for (const [seat, focus] of ti.focus) {
                if (focus !== surfaceId) continue;
                ti.focus.set(seat, null);
                for (const [_id, t] of ti.m) {
                    if (t.seat !== seat || !t.entered) continue;
                    t.entered = false;
                    t.current = newTextInputV3State();
                    t.pending = newTextInputV3State();
                }
            }
        },
        /** `input.text` 经 core 转发到这里；只在本协议是仲裁持有者时发（后激活者胜出） */
        onTextInput: (seat, text, preedit, ctx) => {
            const owner = ctx.domain.textInput.owner;
            if (owner?.protocol !== "v3") return;
            const t = ctx.domain.textInputV3.m.get(owner.id);
            if (!t) return;
            // 仲裁槽是 client 级的：持有者绑在别的 seat 上说明是另一个人在打字，忽略
            if (t.seat !== seat) return;
            // 未enter或未enable的对象按协议忽略
            if (!t.entered || !t.current.enabled) return;
            if (preedit) {
                // 光标置于preedit末尾（cursor_*为字节偏移）
                const cursor = new TextEncoder().encode(text).length;
                ctx.sendNow(owner.id, "zwp_text_input_v3.preedit_string", {
                    text,
                    cursor_begin: cursor,
                    cursor_end: cursor,
                });
            } else {
                ctx.sendNow(owner.id, "zwp_text_input_v3.commit_string", { text });
                ctx.sendNow(owner.id, "zwp_text_input_v3.preedit_string", {
                    text: "",
                    cursor_begin: 0,
                    cursor_end: 0,
                });
            }
            // 双缓冲事件在done时生效，serial为客户端commit计数
            ctx.sendNow(owner.id, "zwp_text_input_v3.done", { serial: t.commitCount });
        },
    },
    requests: {
        "zwp_text_input_manager_v3.get_text_input": (x, ctx) => {
            const textInputId = x.args.id;
            // 该对象绑在哪把 seat 上（协议本来就带 seat 参数），焦点/按键都按它过滤
            const seat = ctx.domain.seat.get(x.args.seat)?.name ?? "seat0";
            const data: TextInputV3Data = {
                seat,
                entered: false,
                commitCount: 0,
                current: newTextInputV3State(),
                pending: newTextInputV3State(),
            };
            ctx.domain.textInputV3.m.set(textInputId, data);
            // 对象创建晚于焦点变化时补发enter
            const focus = ctx.domain.textInputV3.focus.get(seat) ?? null;
            if (focus !== null) {
                data.entered = true;
                ctx.sendNow(textInputId, "zwp_text_input_v3.enter", { surface: focus });
            }
        },
        "zwp_text_input_v3.destroy": (x, ctx) => {
            ctx.domain.textInputV3.m.delete(x.id);
            if (ctx.domain.textInput.owner?.id === x.id) ctx.domain.textInput.owner = null;
        },
        "zwp_text_input_v3.enable": (x, ctx) => {
            const t = ctx.domain.textInputV3.m.get(x.id);
            if (!t) return;
            // enable会重置所有状态，客户端需重新提交
            t.pending = newTextInputV3State();
            t.pending.enabled = true;
            // v1/v3竞争仲裁：后激活者胜出
            ctx.domain.textInput.owner = { protocol: "v3", id: x.id };
        },
        "zwp_text_input_v3.disable": (x, ctx) => {
            const t = ctx.domain.textInputV3.m.get(x.id);
            if (!t) return;
            // disable同样使状态失效
            t.pending = newTextInputV3State();
            if (ctx.domain.textInput.owner?.id === x.id) ctx.domain.textInput.owner = null;
        },
        "zwp_text_input_v3.set_surrounding_text": (x, ctx) => {
            const t = ctx.domain.textInputV3.m.get(x.id);
            if (!t) return;
            t.pending.surroundingText = { text: x.args.text, cursor: x.args.cursor, anchor: x.args.anchor };
        },
        "zwp_text_input_v3.set_text_change_cause": (x, ctx) => {
            const t = ctx.domain.textInputV3.m.get(x.id);
            if (!t) return;
            const cause = getEnumName("zwp_text_input_v3.change_cause", x.args.cause);
            t.pending.textChangeCause = cause === "other" ? "other" : "input_method";
        },
        "zwp_text_input_v3.set_content_type": (x, ctx) => {
            const t = ctx.domain.textInputV3.m.get(x.id);
            if (!t) return;
            t.pending.contentHint = x.args.hint;
            t.pending.contentPurpose = x.args.purpose;
        },
        "zwp_text_input_v3.set_cursor_rectangle": (x, ctx) => {
            const t = ctx.domain.textInputV3.m.get(x.id);
            if (!t) return;
            t.pending.cursorRect = { x: x.args.x, y: x.args.y, width: x.args.width, height: x.args.height };
        },
        "zwp_text_input_v3.commit": (x, ctx) => {
            const t = ctx.domain.textInputV3.m.get(x.id);
            if (!t) return;
            t.current = { ...t.pending };
            // change_cause只作用于本次commit，应用后重置
            t.pending.textChangeCause = "input_method";
            t.commitCount++;
            ctx.sendNow(x.id, "zwp_text_input_v3.done", { serial: t.commitCount });
        },
    },
});
