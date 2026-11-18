import { defineModule, type WaylandObjectId2 } from "../../module";

/**
 * xdg-dialog-v1
 *
 * 只承载「这个 toplevel 是相对父窗口的对话框」这一提示，其中对我们有意义的
 * 是 `set_modal` / `unset_modal`：父窗口的输入阻塞由桌面决定（协议原文也是 hint）。
 * 父子关系本身在 xdg-shell 的 `xdg_toplevel.set_parent` 里。
 */
declare module "../../module" {
    interface WaylandDataRegistry {
        xdg_dialog_v1: {
            toplevel: WaylandObjectId2<"xdg_toplevel">;
        };
    }
    interface WaylandDomainRegistry {
        dialog: DialogData;
    }
}

export class DialogData {
    /** toplevel → dialog 对象（一个 toplevel 最多一个） */
    readonly byToplevel = new Map<WaylandObjectId2<"xdg_toplevel">, WaylandObjectId2<"xdg_dialog_v1">>();
    /** dialog → toplevel：destroy 是 destructor，分发器会先删对象，只能靠它反查 */
    readonly byObject = new Map<WaylandObjectId2<"xdg_dialog_v1">, WaylandObjectId2<"xdg_toplevel">>();

    /**
     * toplevel 销毁：dialog 对象随之变 inert。
     * 不发桌面事件——窗口记录随后就删掉了，模态标记跟着消失。
     */
    forgetToplevel(toplevel: WaylandObjectId2<"xdg_toplevel">): void {
        const dialog = this.byToplevel.get(toplevel);
        if (dialog === undefined) return;
        this.byToplevel.delete(toplevel);
        this.byObject.delete(dialog);
    }
}

export const xdgDialogModule = defineModule({
    name: "xdg-dialog-v1",
    globals: [{ name: "xdg_wm_dialog_v1" }],
    domain: {
        dialog: () => new DialogData(),
    },
    requests: {
        "xdg_wm_dialog_v1.get_xdg_dialog": (x, ctx) => {
            const toplevel = x.args.toplevel;
            if (ctx.domain.windows.get(toplevel) === undefined) {
                ctx.postError("xdg_wm_dialog_v1", x.id, "already_used", "xdg_toplevel does not exist");
                return;
            }
            const dialog = ctx.domain.dialog;
            if (dialog.byToplevel.has(toplevel)) {
                ctx.postError(
                    "xdg_wm_dialog_v1",
                    x.id,
                    "already_used",
                    "xdg_toplevel already has a xdg_dialog_v1 object",
                );
                return;
            }
            ctx.objects.get(x.args.id).data = { toplevel };
            dialog.byToplevel.set(toplevel, x.args.id);
            dialog.byObject.set(x.args.id, toplevel);
        },
        "xdg_dialog_v1.set_modal": (x, ctx) => {
            const toplevel = ctx.domain.dialog.byObject.get(x.id);
            if (toplevel === undefined) return;
            ctx.domain.windows.setModal(toplevel, true);
        },
        "xdg_dialog_v1.unset_modal": (x, ctx) => {
            const toplevel = ctx.domain.dialog.byObject.get(x.id);
            if (toplevel === undefined) return;
            ctx.domain.windows.setModal(toplevel, false);
        },
        "xdg_dialog_v1.destroy": (x, ctx) => {
            const dialog = ctx.domain.dialog;
            const toplevel = dialog.byObject.get(x.id);
            if (toplevel === undefined) return;
            dialog.byObject.delete(x.id);
            if (dialog.byToplevel.get(toplevel) === x.id) dialog.byToplevel.delete(toplevel);
            // dialog 销毁即撤销提示；toplevel 已死时记录不存在，setModal 是 no-op
            ctx.domain.windows.setModal(toplevel, false);
        },
    },
});
