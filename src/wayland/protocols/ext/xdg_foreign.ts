import { defineModule, type ModuleCtx, type SurfaceId, type WaylandObjectId2, type WaylandWinId } from "../../module";

/**
 * xdg-foreign-unstable-v1 / v2（只实现导出侧）
 *
 * 客户端把窗口导出成一个不透明 handle 交给 xdg-desktop-portal；
 * portal 后端（官方桌面的文件选择器）拿到 `parent_window` 后无法自己反查窗口，
 * 所以 handle → 窗口 的映射由 server 保存：协议模块把导出/撤销导出转成 client 事件，
 * `host/server.ts` 汇总成 `server.windows.lookupExport(handle)`。
 *
 * 导入侧（zxdg_importer_*）没有实现，也**不广播**这两个 global：
 * 跨客户端的「以别人的窗口为父窗口」不在当前桌面模型里。
 */
declare module "../../module" {
    interface WaylandDataRegistry {
        zxdg_exported_v1: {
            handle: string;
            toplevel: WaylandWinId;
        };
        zxdg_exported_v2: {
            handle: string;
            toplevel: WaylandWinId;
        };
    }
    interface WaylandDomainRegistry {
        export: ExportData;
    }
}

type ExportedObject = WaylandObjectId2<"zxdg_exported_v1" | "zxdg_exported_v2">;

export class ExportData {
    /** exported 对象 → 导出的 toplevel 与 handle */
    readonly byObject = new Map<ExportedObject, { handle: string; toplevel: WaylandWinId }>();

    /** 撤销导出，返回要作废的 handle（调用方负责通知 server） */
    remove(object: ExportedObject): string | undefined {
        const entry = this.byObject.get(object);
        if (entry === undefined) return undefined;
        this.byObject.delete(object);
        return entry.handle;
    }

    /** toplevel 销毁：它的全部 handle 一起作废 */
    forgetToplevel(toplevel: WaylandWinId): string[] {
        const handles: string[] = [];
        for (const [object, entry] of this.byObject) {
            if (entry.toplevel !== toplevel) continue;
            this.byObject.delete(object);
            handles.push(entry.handle);
        }
        return handles;
    }
}

/**
 * `export` / `export_toplevel` 的共同实现。
 * 只有 xdg 角色为 toplevel 的 surface 能导出；v2 有 invalid_surface 错误码，
 * v1 没有错误码，用 0 上报（客户端收到 wl_display.error 会断开）。
 */
function exportToplevel(
    ctx: ModuleCtx,
    exporter: WaylandObjectId2<"zxdg_exporter_v1" | "zxdg_exporter_v2">,
    exported: ExportedObject,
    surface: SurfaceId,
    version: 1 | 2,
): void {
    const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByWlSurface(surface);
    const role = xdgSurfaceId === undefined ? undefined : ctx.domain.xdgSurface.getXdgSurface(xdgSurfaceId).xdg_role;
    const isToplevel = role !== undefined && ctx.objects.get(role).protocol.name === "xdg_toplevel";
    if (!isToplevel) {
        // 协议错误挂在发起请求的 exporter 对象上
        if (version === 2) {
            ctx.postError("zxdg_exporter_v2", exporter as WaylandObjectId2<"zxdg_exporter_v2">, "invalid_surface");
        } else {
            ctx.postError("zxdg_exporter_v1", exporter as WaylandObjectId2<"zxdg_exporter_v1">, 0);
        }
        return;
    }
    const toplevel = role as WaylandWinId;
    const handle = `myde-${crypto.randomUUID()}`;
    ctx.domain.export.byObject.set(exported, { handle, toplevel });
    if (version === 1) {
        const id = exported as WaylandObjectId2<"zxdg_exported_v1">;
        ctx.objects.get(id).data = { handle, toplevel };
        ctx.send(id, "zxdg_exported_v1.handle", { handle });
    } else {
        const id = exported as WaylandObjectId2<"zxdg_exported_v2">;
        ctx.objects.get(id).data = { handle, toplevel };
        ctx.send(id, "zxdg_exported_v2.handle", { handle });
    }
    ctx.client.emit("toplevelExported", handle, toplevel);
}

function unexport(ctx: ModuleCtx, object: ExportedObject): void {
    const handle = ctx.domain.export.remove(object);
    if (handle !== undefined) ctx.client.emit("toplevelUnexported", handle);
}

export const xdgForeignModule = defineModule({
    name: "xdg-foreign",
    globals: [{ name: "zxdg_exporter_v1" }, { name: "zxdg_exporter_v2" }],
    domain: {
        export: () => new ExportData(),
    },
    requests: {
        "zxdg_exporter_v1.export": (x, ctx) => {
            exportToplevel(ctx, x.id, x.args.id, x.args.surface, 1);
        },
        "zxdg_exported_v1.destroy": (x, ctx) => {
            unexport(ctx, x.id);
        },
        "zxdg_exporter_v2.export_toplevel": (x, ctx) => {
            exportToplevel(ctx, x.id, x.args.id, x.args.surface, 2);
        },
        "zxdg_exported_v2.destroy": (x, ctx) => {
            unexport(ctx, x.id);
        },
    },
});
