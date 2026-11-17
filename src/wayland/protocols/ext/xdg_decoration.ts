import { defineModule, type ModuleCtx, type WaylandObjectId2 } from "../../module";
import { getEnumName, getEnumValue } from "../../utils/wayland-proto";

/**
 * xdg-decoration-unstable-v1
 *
 * 客户端通过它申请服务端装饰。桌面负责画标题栏，这里只维护协商状态：
 * toplevel → decoration 对象、客户端请求的模式，以及每次 xdg configure 要带上的有效模式。
 */
declare module "../../module" {
    interface WaylandDataRegistry {
        zxdg_toplevel_decoration_v1: {
            toplevel: WaylandObjectId2<"xdg_toplevel">;
        };
    }
    interface WaylandDomainRegistry {
        decoration: DecorationData;
    }
}

const MODE_CLIENT_SIDE = getEnumValue("zxdg_toplevel_decoration_v1.mode", "client_side");
const MODE_SERVER_SIDE = getEnumValue("zxdg_toplevel_decoration_v1.mode", "server_side");

export class DecorationData {
    /** toplevel → decoration 对象（一个 toplevel 最多一个） */
    readonly byToplevel = new Map<WaylandObjectId2<"xdg_toplevel">, WaylandObjectId2<"zxdg_toplevel_decoration_v1">>();
    /** decoration → toplevel：destroy 是 destructor，分发器会先删对象，只能靠它反查 */
    readonly byObject = new Map<WaylandObjectId2<"zxdg_toplevel_decoration_v1">, WaylandObjectId2<"xdg_toplevel">>();
    /** decoration → 客户端请求的模式；未收到 set_mode 时由桌面决定 */
    readonly requested = new Map<WaylandObjectId2<"zxdg_toplevel_decoration_v1">, number>();
    /** decoration → 最近一次随 xdg configure 发出的模式；相同模式不重复发，避免客户端反复 set_mode */
    readonly lastConfigured = new Map<WaylandObjectId2<"zxdg_toplevel_decoration_v1">, number>();

    modeOf(toplevel: WaylandObjectId2<"xdg_toplevel">): number {
        const id = this.byToplevel.get(toplevel);
        if (id === undefined) return MODE_SERVER_SIDE;
        return this.requested.get(id) ?? MODE_SERVER_SIDE;
    }

    /**
     * 取这次 xdg configure 需要附带的 decoration.configure。
     * 模式没变化时返回 undefined（协议允许重复发，但会让「按 configure 重新 set_mode」的客户端形成回路）。
     */
    takeConfigure(
        toplevel: WaylandObjectId2<"xdg_toplevel">,
    ): { decoration: WaylandObjectId2<"zxdg_toplevel_decoration_v1">; mode: number } | undefined {
        const id = this.byToplevel.get(toplevel);
        if (id === undefined) return undefined;
        const mode = this.modeOf(toplevel);
        if (this.lastConfigured.get(id) === mode) return undefined;
        this.lastConfigured.set(id, mode);
        return { decoration: id, mode };
    }

    /** toplevel 销毁时清掉关联；不再发桌面事件（窗口记录随后就没了） */
    forgetToplevel(toplevel: WaylandObjectId2<"xdg_toplevel">): void {
        const id = this.byToplevel.get(toplevel);
        if (id === undefined) return;
        this.byToplevel.delete(toplevel);
        this.byObject.delete(id);
        this.requested.delete(id);
        this.lastConfigured.delete(id);
    }
}

/** 把当前有效模式同步给窗口记录，并请求一次 configure（初始 commit 前会转成 pending） */
function applyMode(ctx: ModuleCtx, toplevel: WaylandObjectId2<"xdg_toplevel">): void {
    const decoration = ctx.domain.decoration;
    const before = ctx.domain.windows.get(toplevel)?.decorated ?? false;
    const decorated = decoration.modeOf(toplevel) === MODE_SERVER_SIDE;
    ctx.domain.windows.setDecorated(toplevel, decorated);
    // 模式没变就不发 configure：客户端可能「每次 configure 都 set_mode」，无变化时再发会形成回路
    if (before === decorated) return;
    const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByToplevel(toplevel);
    if (xdgSurfaceId !== undefined) ctx.domain.xdgSurface.requestConfigure(xdgSurfaceId);
}

export const xdgDecorationModule = defineModule({
    name: "xdg-decoration-unstable-v1",
    globals: [{ name: "zxdg_decoration_manager_v1" }],
    domain: {
        decoration: () => new DecorationData(),
    },
    requests: {
        "zxdg_decoration_manager_v1.get_toplevel_decoration": (x, ctx) => {
            const toplevel = x.args.toplevel;
            const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByToplevel(toplevel);
            if (xdgSurfaceId === undefined || ctx.domain.windows.get(toplevel) === undefined) {
                ctx.postError("zxdg_toplevel_decoration_v1", x.args.id, "orphaned", "xdg_toplevel does not exist");
                return;
            }
            const decoration = ctx.domain.decoration;
            if (decoration.byToplevel.has(toplevel)) {
                ctx.postError(
                    "zxdg_toplevel_decoration_v1",
                    x.args.id,
                    "already_constructed",
                    "xdg_toplevel already has a decoration object",
                );
                return;
            }
            const id = x.args.id;
            ctx.objects.get(id).data = { toplevel };
            decoration.byToplevel.set(toplevel, id);
            decoration.byObject.set(id, toplevel);
            // 客户端没说偏好前，桌面默认提供服务端装饰
            applyMode(ctx, toplevel);
        },
        "zxdg_toplevel_decoration_v1.set_mode": (x, ctx) => {
            const toplevel = ctx.domain.decoration.byObject.get(x.id);
            if (toplevel === undefined) return;
            const mode = getEnumName("zxdg_toplevel_decoration_v1.mode", x.args.mode);
            if (mode !== "client_side" && mode !== "server_side") {
                ctx.postError("zxdg_toplevel_decoration_v1", x.id, "invalid_mode", `Invalid mode ${x.args.mode}`);
                return;
            }
            ctx.domain.decoration.requested.set(x.id, mode === "client_side" ? MODE_CLIENT_SIDE : MODE_SERVER_SIDE);
            applyMode(ctx, toplevel);
        },
        "zxdg_toplevel_decoration_v1.unset_mode": (x, ctx) => {
            const decoration = ctx.domain.decoration;
            const toplevel = decoration.byObject.get(x.id);
            if (toplevel === undefined) return;
            decoration.requested.delete(x.id);
            applyMode(ctx, toplevel);
        },
        "zxdg_toplevel_decoration_v1.destroy": (x, ctx) => {
            const decoration = ctx.domain.decoration;
            const toplevel = decoration.byObject.get(x.id);
            if (toplevel === undefined) return;
            decoration.byToplevel.delete(toplevel);
            decoration.byObject.delete(x.id);
            decoration.requested.delete(x.id);
            decoration.lastConfigured.delete(x.id);
            // destroy 后客户端恢复自绘装饰；不再发 configure（对象已经销毁）
            ctx.domain.windows.setDecorated(toplevel, false);
        },
    },
});
