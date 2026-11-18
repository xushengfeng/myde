import { describe, expect, it } from "vitest";
import type { ModuleCtx, WaylandObjectId2, WaylandWinId } from "../../module";
import { xdgDialogModule } from "./xdg_dialog";
import { xdgShellModule } from "./xdg_shell";

const winA = 10 as WaylandWinId;
const winB = 11 as WaylandWinId;
const winC = 12 as WaylandWinId;
const dialogA = 100 as WaylandObjectId2<"xdg_dialog_v1">;

function dialogSetup() {
    const modal: [WaylandWinId, boolean][] = [];
    const errors: string[] = [];
    const objects = new Map<number, { protocol: { name: string }; data: unknown }>([
        [dialogA, { protocol: { name: "xdg_dialog_v1" }, data: undefined }],
    ]);
    const dialog = xdgDialogModule.domain.dialog?.(undefined as never) as NonNullable<
        ReturnType<NonNullable<typeof xdgDialogModule.domain.dialog>>
    >;
    const ctx = {
        objects: {
            get: (id: number) => objects.get(id),
            getOption: (id: number | undefined) => (id === undefined ? undefined : objects.get(id)),
        },
        domain: {
            dialog,
            windows: {
                get: (id: WaylandWinId) => (id === winA || id === winB ? {} : undefined),
                setModal: (id: WaylandWinId, value: boolean) => modal.push([id, value]),
            },
        },
        postError: (_iface: string, _id: number, code: string) => errors.push(code),
    } as unknown as ModuleCtx;
    const req = (key: string) => {
        const handler = xdgDialogModule.requests.get(key as never);
        if (!handler) throw new Error(`missing ${key}`);
        return handler;
    };
    return { modal, errors, ctx, dialog, req, objects };
}

describe("xdg-dialog-v1", () => {
    it("每个 toplevel 只能注册一个 dialog 对象", () => {
        const { req, ctx, dialog, errors, objects } = dialogSetup();
        req("xdg_wm_dialog_v1.get_xdg_dialog")({ id: 1, args: { id: dialogA, toplevel: winA } } as never, ctx);
        expect(dialog.byToplevel.get(winA)).toBe(dialogA);
        expect(objects.get(dialogA)?.data).toEqual({ toplevel: winA });

        const second = 101 as WaylandObjectId2<"xdg_dialog_v1">;
        req("xdg_wm_dialog_v1.get_xdg_dialog")({ id: 1, args: { id: second, toplevel: winA } } as never, ctx);
        expect(errors).toEqual(["already_used"]);
    });

    it("set_modal / unset_modal 映射到窗口记录，destroy 撤销提示", () => {
        const { req, ctx, dialog, modal, errors } = dialogSetup();
        req("xdg_wm_dialog_v1.get_xdg_dialog")({ id: 1, args: { id: dialogA, toplevel: winA } } as never, ctx);

        req("xdg_dialog_v1.set_modal")({ id: dialogA, args: {} } as never, ctx);
        expect(modal).toEqual([[winA, true]]);
        req("xdg_dialog_v1.unset_modal")({ id: dialogA, args: {} } as never, ctx);
        expect(modal).toEqual([
            [winA, true],
            [winA, false],
        ]);

        req("xdg_dialog_v1.destroy")({ id: dialogA, args: {} } as never, ctx);
        expect(modal.at(-1)).toEqual([winA, false]);
        expect(dialog.byToplevel.size).toBe(0);
        expect(dialog.byObject.size).toBe(0);
        // toplevel 已销毁后再来 destroy 是 inert：不报错、不再触发记录变化
        const before = modal.length;
        req("xdg_dialog_v1.destroy")({ id: dialogA, args: {} } as never, ctx);
        expect(modal.length).toBe(before);
        expect(errors).toEqual([]);
    });

    it("toplevel 销毁后 dialog 变 inert", () => {
        const { req, ctx, dialog, modal } = dialogSetup();
        req("xdg_wm_dialog_v1.get_xdg_dialog")({ id: 1, args: { id: dialogA, toplevel: winA } } as never, ctx);
        dialog.forgetToplevel(winA);
        expect(dialog.byToplevel.size).toBe(0);
        req("xdg_dialog_v1.set_modal")({ id: dialogA, args: {} } as never, ctx);
        expect(modal).toEqual([]);
    });
});

function parentSetup() {
    const parents: [WaylandWinId, WaylandWinId | undefined][] = [];
    const errors: string[] = [];
    const records = new Map<WaylandWinId, { parent?: WaylandWinId }>([
        [winA, {}],
        [winB, { parent: winA }],
        [winC, {}],
    ]);
    const ctx = {
        domain: {
            windows: {
                get: (id: WaylandWinId) => records.get(id),
                setParent: (id: WaylandWinId, parent: WaylandWinId | undefined) => parents.push([id, parent]),
            },
        },
        postError: (_iface: string, _id: number, code: string) => errors.push(code),
    } as unknown as ModuleCtx;
    const handler = xdgShellModule.requests.get("xdg_toplevel.set_parent");
    if (!handler) throw new Error("missing xdg_toplevel.set_parent");
    return { parents, errors, ctx, handler };
}

describe("xdg-shell set_parent", () => {
    it("记录父窗口，null 取消父窗口", () => {
        const { parents, errors, ctx, handler } = parentSetup();
        handler({ id: winC, args: { parent: winB } } as never, ctx);
        handler({ id: winC, args: { parent: undefined } } as never, ctx);
        expect(parents).toEqual([
            [winC, winB],
            [winC, undefined],
        ]);
        expect(errors).toEqual([]);
    });

    it("父窗口不能是自己或自己的后代", () => {
        const { parents, errors, ctx, handler } = parentSetup();
        handler({ id: winA, args: { parent: winA } } as never, ctx);
        // winB 的父窗口是 winA：以 winB 为父窗口会让 winA 形成环
        handler({ id: winA, args: { parent: winB } } as never, ctx);
        expect(parents).toEqual([]);
        expect(errors).toEqual(["invalid_parent", "invalid_parent"]);
    });
});

function limitSetup() {
    const record = { minSize: { width: 0, height: 0 }, maxSize: { width: 0, height: 0 } };
    const errors: string[] = [];
    const ctx = {
        domain: {
            windows: {
                get: (id: WaylandWinId) => (id === winA ? record : undefined),
                setSizeLimits: (
                    _id: WaylandWinId,
                    min?: { width: number; height: number },
                    max?: { width: number; height: number },
                ) => {
                    if (min) record.minSize = min;
                    if (max) record.maxSize = max;
                },
            },
        },
        postError: (_iface: string, _id: number, code: string) => errors.push(code),
    } as unknown as ModuleCtx;
    const req = (key: string) => {
        const handler = xdgShellModule.requests.get(key as never);
        if (!handler) throw new Error(`missing ${key}`);
        return handler;
    };
    return { record, errors, ctx, req };
}

describe("xdg-shell set_min_size / set_max_size", () => {
    it("记录尺寸限制并校验 min/max 与负数", () => {
        const { record, errors, ctx, req } = limitSetup();
        req("xdg_toplevel.set_min_size")({ id: winA, args: { width: 400, height: 300 } } as never, ctx);
        expect(record.minSize).toEqual({ width: 400, height: 300 });

        // min 已大于新的 max：invalid_size，且记录不变
        req("xdg_toplevel.set_max_size")({ id: winA, args: { width: 300, height: 0 } } as never, ctx);
        expect(errors).toEqual(["invalid_size"]);
        expect(record.maxSize).toEqual({ width: 0, height: 0 });

        req("xdg_toplevel.set_max_size")({ id: winA, args: { width: 800, height: 600 } } as never, ctx);
        expect(record.maxSize).toEqual({ width: 800, height: 600 });

        req("xdg_toplevel.set_min_size")({ id: winA, args: { width: -1, height: 0 } } as never, ctx);
        expect(errors).toEqual(["invalid_size", "invalid_size"]);
        expect(record.minSize).toEqual({ width: 400, height: 300 });
    });
});
