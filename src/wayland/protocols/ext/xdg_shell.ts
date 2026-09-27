import {
    defineModule,
    type ModuleCtx,
    type WaylandObjectId2,
    type WaylandWinId,
    type WindowRecord,
} from "../../module";
import type { renderTools } from "../../render_tools";
import { getEnumValue, waylandObjectId } from "../../utils/wayland-proto";
import { getRectKeyPoint } from "../../utils/xdg";
import type { wlSurfaceData } from "../core/wayland";

/**
 * xdg-shell
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
// 状态类型归本模块声明（P3）
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
    /** `ctx.domain.xdgSurface` 这个 key 归本模块所有（提供者见下方 `domain`） */
    interface WaylandDomainRegistry {
        xdgSurface: XdgSurfaceApi;
    }
}

/**
 * 窗口几何下发：先发 `xdg_toplevel.configure`（states 按记录算），
 * 再发配套的 `xdg_surface.configure`（xdg_surface 要求一一对应）。
 */
function configureWin(ctx: ModuleCtx, winId: WaylandWinId, win: WindowRecord): void {
    const s: number[] = [];
    if (win.actived) s.push(getEnumValue("xdg_toplevel.state", "activated"));
    ctx.sendNow(winId, "xdg_toplevel.configure", {
        width: win.box.width,
        height: win.box.height,
        states: new Uint32Array(s),
    });
    const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByToplevel(winId);
    if (xdgSurfaceId === undefined) return;
    ctx.sendNow(xdgSurfaceId, "xdg_surface.configure", { serial: 1 });
}

// ───────────── 域状态：xdg_surface 的 role、父子关系、几何 ─────────────
// xdg 自己造、自己用，经 `ctx.domain.xdgSurface` 暴露；对 wl_surface 只持有
// `wlSurfaceData` 实例（core 构造后由 host 注入），运行时反向依赖仍为零。

export class xdgSurfaceData {
    wl_surface: wlSurfaceData;

    xdg_surface: Record<
        WaylandObjectId2<"xdg_surface">,
        {
            surface: WaylandObjectId2<"wl_surface">;
            winGeo?: { x: number; y: number; w: number; h: number };
            offset: { x: number; y: number }; // 一般popup的才有
            xdg_role?: WaylandObjectId2<"xdg_toplevel" | "xdg_popup">;
            parent: WaylandObjectId2<"xdg_surface"> | undefined;
            children: WaylandObjectId2<"xdg_surface">[];
        }
    > = {};
    xdg_popup = new Map<WaylandObjectId2<"xdg_popup">, WaylandObjectId2<"xdg_surface">>();
    xdg_toplevel = new Map<WaylandObjectId2<"xdg_toplevel">, WaylandObjectId2<"xdg_surface">>();
    private render: renderTools;
    private idScope: (id: unknown) => string;
    constructor(wl: wlSurfaceData) {
        this.wl_surface = wl;
        this.render = wl.render;
        this.idScope = wl.idScope;
    }

    addXdgSurface(id: WaylandObjectId2<"xdg_surface">, wlSurface: WaylandObjectId2<"wl_surface">) {
        this.xdg_surface[id] = { surface: wlSurface, parent: undefined, children: [], offset: { x: 0, y: 0 } };

        this.render.createXdgSurfaceEle(this.idScope(id), this.idScope(wlSurface));
    }
    getXdgSurface(id: WaylandObjectId2<"xdg_surface">) {
        return this.xdg_surface[id];
    }
    setXdgSurfaceSize(id: WaylandObjectId2<"xdg_surface">, x: number, y: number, w: number, h: number) {
        this.xdg_surface[id].winGeo = { x, y, w, h };

        this.render.setXdgSurfaceGeo(this.idScope(id), w, h, x, y);
    }
    getXdgSurfaceByToplevel(id: WaylandObjectId2<"xdg_toplevel">) {
        return this.xdg_toplevel.get(id);
    }
    getXdgSurfaceByPopup(id: WaylandObjectId2<"xdg_popup">) {
        return this.xdg_popup.get(id);
    }
    setRelation(parent: WaylandObjectId2<"xdg_surface">, child: WaylandObjectId2<"xdg_surface">) {
        this.xdg_surface[child].parent = parent;
        this.xdg_surface[parent].children.push(child);
    }
    rmRelation(parent: WaylandObjectId2<"xdg_surface">, child: WaylandObjectId2<"xdg_surface">) {
        this.xdg_surface[child].parent = undefined;
        this.xdg_surface[parent].children = this.xdg_surface[parent].children.filter((c) => c !== child);
    }
    getMainSurfaceRect(id: WaylandObjectId2<"xdg_surface">) {
        const xdgSurface = this.getXdgSurface(id);
        const mainWlSurface = this.wl_surface.getWlSurface(xdgSurface.surface);
        const size = mainWlSurface.size;
        // todo subsurface 需要考虑吗
        return { w: size.w, h: size.h };
    }
    /** 获取xdgsurface窗口大小 */
    getReRect(id: WaylandObjectId2<"xdg_surface">) {
        const xdgSurface = this.getXdgSurface(id);
        const mainWlSurface = this.wl_surface.getWlSurface(xdgSurface.surface);
        const size = xdgSurface.winGeo ?? mainWlSurface.size;
        // todo subsurface
        return { w: size.w, h: size.h };
    }
    setAsToplevel(id: WaylandObjectId2<"xdg_surface">, toplevelId: WaylandObjectId2<"xdg_toplevel">) {
        this.wl_surface.setWlSurfaceRole(this.getXdgSurface(id).surface, "toplevel");
        this.xdg_toplevel.set(toplevelId, id);
        this.xdg_surface[id].xdg_role = toplevelId;

        this.render.asToplevel(this.idScope(id));
    }
    setAsPopup(
        id: WaylandObjectId2<"xdg_surface">,
        popupId: WaylandObjectId2<"xdg_popup">,
        parent: WaylandObjectId2<"xdg_surface">,
    ) {
        this.wl_surface.setWlSurfaceRole(this.getXdgSurface(id).surface, "popup");
        this.xdg_popup.set(popupId, id);
        this.xdg_surface[id].xdg_role = popupId;
        this.setRelation(parent, id);

        this.render.addPopupToXdgSurface(this.idScope(id), this.idScope(parent));
    }
    setOffset(id: WaylandObjectId2<"xdg_surface">, x: number, y: number) {
        this.getXdgSurface(id).offset.x = x;
        this.getXdgSurface(id).offset.y = y;

        this.render.setPopupPosi(this.idScope(id), x, y);
    }
    xdgSurfaceDestroyed(xdgSurfaceId: WaylandObjectId2<"xdg_surface">, type: "toplevel" | "popup") {
        delete this.xdg_surface[xdgSurfaceId];

        this.render.destroyXdgSurfaceEle(this.idScope(xdgSurfaceId), type);
    }
    popupDestroyed(popupId: WaylandObjectId2<"xdg_popup">) {
        const id = this.xdg_popup.get(popupId);
        if (id === undefined) {
            return;
        }
        const xdgSurface = this.getXdgSurface(id);
        const parent = xdgSurface.parent;
        if (parent) {
            this.rmRelation(parent, id);
        }
        this.xdgSurfaceDestroyed(id, "popup");
        this.xdg_popup.delete(popupId);
    }
    toplevelDestroyed(toplevelId: WaylandObjectId2<"xdg_toplevel">) {
        const id = this.xdg_toplevel.get(toplevelId);
        if (id === undefined) {
            return;
        }
        const xdgSurface = this.getXdgSurface(id);
        const parent = xdgSurface.parent;
        if (parent) {
            this.rmRelation(parent, id);
        }
        this.xdgSurfaceDestroyed(id, "toplevel");
        this.xdg_toplevel.delete(toplevelId);
    }
    getChildenDeepOnlyPopup(parent: WaylandObjectId2<"xdg_surface">) {
        const children: {
            id: WaylandObjectId2<"xdg_surface">;
            offset: { x: number; y: number };
            size: { w: number; h: number };
        }[] = [];
        // todo tree walk
        children.push(
            ...this.xdg_surface[parent].children
                .filter((c) => this.wl_surface.getWlSurface(this.getXdgSurface(c).surface).role === "popup")
                .map((i) => ({
                    id: i,
                    offset: this.getXdgSurface(i).offset, // todo 合并父偏移
                    size: this.getReRect(i),
                })),
        );
        return children;
    }
}

export const xdgShellModule = defineModule({
    name: "xdg-shell",
    /** `ctx.domain.xdgSurface` 的实例；构造时吃 core 提供的 `ctx.core.surface`（装配先跑完 core 两趟） */
    domain: {
        xdgSurface: (ctx) => new xdgSurfaceData(ctx.core.surface),
    },
    hooks: {
        /**
         * 由 wl_surface.commit 触发。
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
            const outerBounds = ctx.client.surfaceBounds() || { width: 800, height: 600 };
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
    actions: {
        /** 窗口命令：改 `WindowRecord` + 发 configure。语义事件（window.changed 等）仍由 WindowsStore fan-in */
        "window.focus": (msg, ctx) => {
            const win = ctx.state.windows.get(msg.winId);
            if (win === undefined || win.actived) return;
            win.actived = true;
            win.minimized = false;
            configureWin(ctx, msg.winId, win);
        },
        "window.blur": (msg, ctx) => {
            const win = ctx.state.windows.get(msg.winId);
            if (win === undefined || !win.actived) return;
            win.actived = false;
            configureWin(ctx, msg.winId, win);
        },
        "window.close": (msg, ctx) => {
            if (ctx.state.windows.get(msg.winId) === undefined) return;
            ctx.sendNow(msg.winId, "xdg_toplevel.close", {});
        },
        /** 只记录桌面配置的盒子，不发 configure */
        "window.setBox": (msg, ctx) => {
            const win = ctx.state.windows.get(msg.winId);
            if (win === undefined) return;
            win.box = msg.args[0];
        },
        "window.setSize": (msg, ctx) => {
            const win = ctx.state.windows.get(msg.winId);
            if (win === undefined) return;
            win.box.width = msg.args[0].width;
            win.box.height = msg.args[0].height;
            configureWin(ctx, msg.winId, win);
        },
        "window.maximize": (msg, ctx) => {
            const win = ctx.state.windows.get(msg.winId);
            if (win === undefined) return;
            if (ctx.domain.xdgSurface.getXdgSurfaceByToplevel(msg.winId) === undefined) return;
            win.actived = true;
            win.maximized = true;
            win.minimized = false;
            win.box.width = msg.args[0]?.width ?? win.box.width;
            win.box.height = msg.args[0]?.height ?? win.box.height;

            ctx.sendNow(msg.winId, "xdg_toplevel.configure", {
                width: win.box.width,
                height: win.box.height,
                states: new Uint32Array([
                    getEnumValue("xdg_toplevel.state", "activated"),
                    getEnumValue("xdg_toplevel.state", "maximized"),
                ]),
            });
            const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByToplevel(msg.winId);
            if (xdgSurfaceId === undefined) return;
            ctx.sendNow(xdgSurfaceId, "xdg_surface.configure", { serial: 1 });
        },
        "window.unmaximize": (msg, ctx) => {
            const win = ctx.state.windows.get(msg.winId);
            if (win === undefined) return;
            win.maximized = false;
            win.box.width = msg.args[0]?.width ?? win.box.width;
            win.box.height = msg.args[0]?.height ?? win.box.height;
            configureWin(ctx, msg.winId, win);
        },
        "window.minimize": (msg, ctx) => {
            const win = ctx.state.windows.get(msg.winId);
            if (win === undefined) return;
            win.actived = false;
            win.minimized = true;
            configureWin(ctx, msg.winId, win);
        },
    },
});
