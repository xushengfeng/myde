import { defineModule, type WaylandObjectId2 } from "../../module";
import { getEnumValue, waylandObjectId } from "../../utils/wayland-proto";
import { getRectKeyPoint } from "../../utils/xdg";

/**
 * xdg-shell
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
// 状态类型归本模块声明，不再登记 module.ts 的中央表（P3）
declare module "../../module" {
    interface WaylandDataRegistry {
    xdg_wm_base: { pingSerials: Map<number, () => void> };
    xdg_positioner: {
        size: { width: number; height: number };
        anchor_rect: { x: number; y: number; width: number; height: number };
        anchor: number;
        gravity: number;
        constraint_adjustment: number;
        offset: { x: number; y: number };
        reactive: boolean;
        parent_size: { parent_width: number; parent_height: number };
    };
    }
}

export const xdgShellModule = defineModule({
    name: "xdg-shell",
    hooks: {
        /**
         * 由 wl_surface.commit 触发。原实现是 core 里的一段字符串扫描
         * （遍历对象表找 xdg_surface），现已搬到这里。
         *
         * 注意保留了原有语义：尺寸一变就给**所有** xdg_surface 发 configure，
         * 而不只是本 surface 对应的那个——是否该收窄属于另一个问题，不在本次改动范围。
         */
        onCommit: (_surfaceId, sizeChanged, ctx) => {
            if (!sizeChanged) return;
            // todo 考虑实际窗口的几何，否则有外边框的会变大
            for (const [id, p] of ctx.objects.entries()) {
                if (p.protocol.name === "xdg_surface") {
                    ctx.send(id as WaylandObjectId2<"xdg_surface">, "xdg_surface.configure", { serial: 1 });
                }
            }
        },
    },
    requests: {
        "xdg_wm_base.get_xdg_surface": (x, ctx) => {
            const surfaceId = waylandObjectId(x.args.surface, "wl_surface");
            ctx.domain.xdgSurface.addXdgSurface(x.args.id, surfaceId);
        },
        "xdg_wm_base.create_positioner": (x, ctx) => {
            const thisObj = ctx.objects.get(x.args.id);
            thisObj.data = {
                size: { width: 0, height: 0 },
                anchor_rect: { x: 0, y: 0, width: 0, height: 0 },
                anchor: getEnumValue("xdg_positioner.anchor", "none"),
                gravity: getEnumValue("xdg_positioner.gravity", "none"),
                constraint_adjustment: getEnumValue("xdg_positioner.constraint_adjustment", "none"),
                offset: { x: 0, y: 0 },
                parent_size: { parent_width: 0, parent_height: 0 },
                reactive: false,
            };
        },
        "xdg_wm_base.pong": (x, ctx) => {
            const thisObj = ctx.objects.get(x.id);
            const p = thisObj.data.pingSerials.get(x.args.serial);
            p?.();
            thisObj.data.pingSerials.delete(x.args.serial);
        },
        "xdg_wm_base.destroy": (x, ctx) => {
            ctx.client.state.xdg_wm_base.delete(x.id);
        },
        "xdg_positioner.set_size": (x, ctx) => {
            const pData = ctx.objects.get(x.id).data;
            pData.size = x.args;
        },
        "xdg_positioner.set_anchor_rect": (x, ctx) => {
            const pData = ctx.objects.get(x.id).data;
            pData.anchor_rect = x.args;
        },
        "xdg_positioner.set_anchor": (x, ctx) => {
            const pData = ctx.objects.get(x.id).data;
            pData.anchor = x.args.anchor;
        },
        "xdg_positioner.set_gravity": (x, ctx) => {
            const pData = ctx.objects.get(x.id).data;
            pData.gravity = x.args.gravity;
        },
        "xdg_positioner.set_constraint_adjustment": (x, ctx) => {
            const pData = ctx.objects.get(x.id).data;
            pData.constraint_adjustment = x.args.constraint_adjustment;
        },
        "xdg_positioner.set_offset": (x, ctx) => {
            const pData = ctx.objects.get(x.id).data;
            pData.offset = x.args;
        },
        "xdg_positioner.set_parent_size": (x, ctx) => {
            const pData = ctx.objects.get(x.id).data;
            pData.parent_size = x.args;
        },
        "xdg_positioner.set_reactive": (x, ctx) => {
            const pData = ctx.objects.get(x.id).data;
            pData.reactive = true;
        },
        "xdg_surface.get_toplevel": (x, ctx) => {
            const xid = x.id;
            const toplevelId = x.args.id;
            ctx.sendNow(toplevelId, "xdg_toplevel.wm_capabilities", {
                capabilities: new Uint32Array([
                    getEnumValue("xdg_toplevel.wm_capabilities", "minimize"),
                    getEnumValue("xdg_toplevel.wm_capabilities", "maximize"),
                ]),
            });
            const outerBounds = ctx.client.emitSync("windowBound") || { width: 800, height: 600 };
            ctx.send(toplevelId, "xdg_toplevel.configure_bounds", {
                width: outerBounds.width,
                height: outerBounds.height,
            });
            ctx.send(x.id, "xdg_surface.configure", { serial: 1 });
            ctx.domain.xdgSurface.setAsToplevel(xid, toplevelId);
            ctx.state.windows.created(toplevelId, ctx.core.surface.idScope(xid));
        },
        "xdg_surface.set_window_geometry": (x, ctx) => {
            const thisXdgSurface = ctx.domain.xdgSurface.getXdgSurface(x.id);
            ctx.domain.xdgSurface.setXdgSurfaceSize(x.id, x.args.x, x.args.y, x.args.width, x.args.height);
            if (thisXdgSurface.xdg_role) {
                ctx.state.windows.resized(
                    thisXdgSurface.xdg_role as WaylandObjectId2<"xdg_toplevel">, // todo check
                    x.args.width,
                    x.args.height,
                );
            }
        },
        "xdg_surface.get_popup": (x, ctx) => {
            const xid = x.id;
            const popupId = x.args.id;
            const parentXdgSurfaceId = waylandObjectId(x.args.parent, "xdg_surface");
            if (!parentXdgSurfaceId) {
                console.error("No parent for popup");
                return;
            }

            const positioner = ctx.objects.get(waylandObjectId(x.args.positioner, "xdg_positioner"));
            const positionerData = positioner.data;

            const anchor = positionerData.anchor;
            const anchorPoint = getRectKeyPoint(
                positionerData.anchor_rect,
                (
                    {
                        [getEnumValue("xdg_positioner.anchor", "none")]: "none",
                        [getEnumValue("xdg_positioner.anchor", "top")]: "top",
                        [getEnumValue("xdg_positioner.anchor", "bottom")]: "bottom",
                        [getEnumValue("xdg_positioner.anchor", "left")]: "left",
                        [getEnumValue("xdg_positioner.anchor", "right")]: "right",
                        [getEnumValue("xdg_positioner.anchor", "top_left")]: "top_left",
                        [getEnumValue("xdg_positioner.anchor", "top_right")]: "top_right",
                        [getEnumValue("xdg_positioner.anchor", "bottom_left")]: "bottom_left",
                        [getEnumValue("xdg_positioner.anchor", "bottom_right")]: "bottom_right",
                    } as const
                )[anchor],
            );
            const popupPoint = getRectKeyPoint(
                { x: 0, y: 0, width: positionerData.size.width, height: positionerData.size.height },
                (
                    {
                        [getEnumValue("xdg_positioner.gravity", "none")]: "none",
                        [getEnumValue("xdg_positioner.gravity", "top")]: "bottom",
                        [getEnumValue("xdg_positioner.gravity", "bottom")]: "top",
                        [getEnumValue("xdg_positioner.gravity", "left")]: "right",
                        [getEnumValue("xdg_positioner.gravity", "right")]: "left",
                        [getEnumValue("xdg_positioner.gravity", "top_left")]: "bottom_right",
                        [getEnumValue("xdg_positioner.gravity", "top_right")]: "bottom_left",
                        [getEnumValue("xdg_positioner.gravity", "bottom_left")]: "top_right",
                        [getEnumValue("xdg_positioner.gravity", "bottom_right")]: "top_left",
                    } as const
                )[positionerData.gravity],
            );

            // todo offset
            // todo constraint_adjustment
            const nx = anchorPoint.x - popupPoint.x;
            const ny = anchorPoint.y - popupPoint.y;

            const xdgSurfaceM = ctx.domain.xdgSurface;
            xdgSurfaceM.setAsPopup(xid, popupId, parentXdgSurfaceId);
            xdgSurfaceM.setOffset(xid, nx, ny);

            // todo 给定外部处理的接口

            ctx.send(x.args.id, "xdg_popup.configure", {
                x: Math.floor(nx),
                y: Math.floor(ny),
                width: positionerData.size.width,
                height: positionerData.size.height,
            });
            ctx.send(x.id, "xdg_surface.configure", { serial: 0 });
        },
        "xdg_popup.destroy": (x, ctx) => {
            const xid = x.id;
            const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByPopup(xid);
            if (xdgSurfaceId === undefined) return;
            ctx.domain.xdgSurface.popupDestroyed(xid);
            ctx.send(x.id, "xdg_popup.popup_done", {});
        },
        "xdg_toplevel.set_app_id": (x, ctx) => {
            if (!ctx.client.state.appid) {
                ctx.client.state.appid = x.args.app_id;
                ctx.client.emit("appid", x.args.app_id);
            }
        },
        "xdg_toplevel.set_title": (x, ctx) => {
            ctx.state.windows.setTitle(x.id, x.args.title);
        },
        "xdg_toplevel.move": (x, ctx) => {
            ctx.state.windows.startMove(x.id);
        },
        "xdg_toplevel.set_maximized": (x, ctx) => {
            ctx.state.windows.setMaximized(x.id, true);
        },
        "xdg_toplevel.unset_maximized": (x, ctx) => {
            ctx.state.windows.setMaximized(x.id, false);
        },
        "xdg_toplevel.destroy": (x, ctx) => {
            const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByToplevel(x.id);
            if (xdgSurfaceId === undefined) return;
            // 顺序对桌面可见：记录删除 → onToplevelRemove → windowClosed
            ctx.state.windows.remove(x.id);
            ctx.domain.xdgSurface.toplevelDestroyed(x.id);
            ctx.state.windows.notifyClosed(x.id);
        },
    },
});
