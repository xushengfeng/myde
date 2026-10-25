import {
    defineModule,
    type HitTestResult,
    type ModuleCtx,
    type ObjectApi,
    type SubSurfaceApi,
    type SurfaceId,
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
        /** 连接级 xdg 状态（原 `ClientState.xdg_wm_base` / `appid`） */
        xdg: {
            /** 已绑定的 `xdg_wm_base` 对象；host 的 `ping()` 遍历它 */
            wmBase: Set<WaylandObjectId2<"xdg_wm_base">>;
            /** 首个 `set_app_id`：语义是 **client 级**，server 把它广播给该客户端的所有窗口 */
            appid?: string;
        };
        /** 窗口记录（`WindowsStore` 在本文件旁边的 `windows_store.ts`），`window.*` 的 fan-in 单写入点 */
        windows: WindowsApi;
    }
}

/**
 * 窗口几何下发：先发 `xdg_toplevel.configure`（states 按记录算），
 * 再发配套的 `xdg_surface.configure`（xdg_surface 要求一一对应）。
 */
/**
 * 键盘焦点挂在哪把 seat 上：`window.focus`/`window.blur` 没有 seat 参数，暂恒为 seat0
 * （B 批广播 seat1 之后这里要跟着桌面语义重新决策）。
 */
const FOCUS_SEAT = "seat0";

// ───────────── xdg_positioner：锚点/重力/约束 ─────────────

type KeyPoint = Parameters<typeof getRectKeyPoint>[1];

/** anchor 枚举 → anchor_rect 上被取的点 */
const ANCHOR_POINT: Record<number, KeyPoint> = {
    [getEnumValue("xdg_positioner.anchor", "none")]: "none",
    [getEnumValue("xdg_positioner.anchor", "top")]: "top",
    [getEnumValue("xdg_positioner.anchor", "bottom")]: "bottom",
    [getEnumValue("xdg_positioner.anchor", "left")]: "left",
    [getEnumValue("xdg_positioner.anchor", "right")]: "right",
    [getEnumValue("xdg_positioner.anchor", "top_left")]: "top_left",
    [getEnumValue("xdg_positioner.anchor", "top_right")]: "top_right",
    [getEnumValue("xdg_positioner.anchor", "bottom_left")]: "bottom_left",
    [getEnumValue("xdg_positioner.anchor", "bottom_right")]: "bottom_right",
};

/** gravity 指子 surface 相对锚点朝哪个方向摆，换成本 surface 上被对齐的那个点 */
const GRAVITY_POINT: Record<number, KeyPoint> = {
    [getEnumValue("xdg_positioner.gravity", "none")]: "none",
    [getEnumValue("xdg_positioner.gravity", "top")]: "bottom",
    [getEnumValue("xdg_positioner.gravity", "bottom")]: "top",
    [getEnumValue("xdg_positioner.gravity", "left")]: "right",
    [getEnumValue("xdg_positioner.gravity", "right")]: "left",
    [getEnumValue("xdg_positioner.gravity", "top_left")]: "bottom_right",
    [getEnumValue("xdg_positioner.gravity", "top_right")]: "bottom_left",
    [getEnumValue("xdg_positioner.gravity", "bottom_left")]: "top_right",
    [getEnumValue("xdg_positioner.gravity", "bottom_right")]: "top_left",
};

/** 绕轴翻转一个点（用于 constraint_adjustment 的 flip_x / flip_y） */
function flipPoint(p: KeyPoint, axis: "x" | "y"): KeyPoint {
    if (axis === "x") {
        if (p === "left") return "right";
        if (p === "right") return "left";
        if (p === "top_left") return "top_right";
        if (p === "top_right") return "top_left";
        if (p === "bottom_left") return "bottom_right";
        if (p === "bottom_right") return "bottom_left";
    } else {
        if (p === "top") return "bottom";
        if (p === "bottom") return "top";
        if (p === "top_left") return "bottom_left";
        if (p === "bottom_left") return "top_left";
        if (p === "top_right") return "bottom_right";
        if (p === "bottom_right") return "top_right";
    }
    return p;
}

/** xdg_positioner.constraint_adjustment 的位；resize_x/resize_y 未实现（保持原尺寸） */
const ADJ_SLIDE_X = 1;
const ADJ_SLIDE_Y = 2;
const ADJ_FLIP_X = 4;
const ADJ_FLIP_Y = 8;

/** 该 toplevel 的主 wl_surface —— 键盘焦点落在它上面；已解体的窗口返回 null */
function mainSurface(ctx: ModuleCtx, winId: WaylandWinId): SurfaceId | null {
    const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByToplevel(winId);
    if (xdgSurfaceId === undefined) return null;
    return ctx.domain.xdgSurface.getXdgSurface(xdgSurfaceId).surface;
}

/**
 * 下发一次完整的 configure：先 role 事件（xdg_toplevel/xdg_popup.configure），
 * 再以唯一 serial 收尾 xdg_surface.configure。
 *
 * 客户端完成初始 commit 之前只记 pending、不发包——这是 xdg-shell 的硬性顺序，
 * 也是 Qt/KDE 客户端能正常 map popup 的前提（它们会丢弃初始 commit 前 / serial 0 的 configure）。
 * `now`：桌面命令用 sendNow（非请求上下文），commit 钩子里用 send（本批请求结束后统一 flush）。
 */
function sendConfigure(ctx: ModuleCtx, xdgSurfaceId: WaylandObjectId2<"xdg_surface">, now: boolean): void {
    const xdg = ctx.domain.xdgSurface;
    const s = xdg.getXdgSurface(xdgSurfaceId);
    if (s === undefined || s.xdg_role === undefined) return;
    if (!s.initialCommitDone) {
        s.configurePending = true;
        return;
    }
    const send: ModuleCtx["send"] = now ? ctx.sendNow : ctx.send;
    const role = s.xdg_role;
    if (ctx.objects.get(role).protocol.name === "xdg_popup") {
        const p = s.popupConfigure;
        if (p === undefined) return;
        send(role as WaylandObjectId2<"xdg_popup">, "xdg_popup.configure", {
            x: p.x,
            y: p.y,
            width: p.width,
            height: p.height,
        });
    } else {
        const win = ctx.domain.windows.get(role as WaylandObjectId2<"xdg_toplevel">);
        if (win === undefined) return;
        const states: number[] = [];
        if (win.actived) states.push(getEnumValue("xdg_toplevel.state", "activated"));
        if (win.maximized) states.push(getEnumValue("xdg_toplevel.state", "maximized"));
        send(role as WaylandObjectId2<"xdg_toplevel">, "xdg_toplevel.configure", {
            width: win.box.width,
            height: win.box.height,
            states: new Uint32Array(states),
        });
    }
    const serial = xdg.nextConfigureSerial();
    s.lastConfigureSerial = serial;
    send(xdgSurfaceId, "xdg_surface.configure", { serial });
    s.configurePending = false;
}

/** 窗口状态变化（focus/size/maximize…）后请求一次 configure；初始 commit 前会转成 pending */
function configureWin(ctx: ModuleCtx, winId: WaylandWinId): void {
    const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByToplevel(winId);
    if (xdgSurfaceId === undefined) return;
    sendConfigure(ctx, xdgSurfaceId, true);
}

/**
 * 初始 commit（无 buffer）后才允许 map：此时回一份 configure。
 * 之后的 commit 只在桌面改了状态（configurePending）时补发，避免同一状态反复 configure。
 */
function onSurfaceCommit(ctx: ModuleCtx, surfaceId: SurfaceId): void {
    const xdg = ctx.domain.xdgSurface;
    const xdgSurfaceId = xdg.getXdgSurfaceByWlSurface(surfaceId);
    if (xdgSurfaceId === undefined) return;
    const s = xdg.getXdgSurface(xdgSurfaceId);
    if (s.xdg_role === undefined) return;
    if (!s.initialCommitDone) {
        s.initialCommitDone = true;
        sendConfigure(ctx, xdgSurfaceId, false);
        return;
    }
    if (s.configurePending) sendConfigure(ctx, xdgSurfaceId, false);
}

/**
 * 对外出口。实现方是 `protocols/ext/xdg_shell.ts` 的 `domain.windows` initializer
 * ——它把 Store 调用转成 `ctx.client.emit`；`host/server.ts` 订阅这些事件做 fan-in，
 * 分配全局 `WinHandle` 后以 `window.*`（见 api.ts）转发给桌面。
 *
 * Store 与协议 handler 都不认识 server，改对外形状只动上面那一层接线。
 */
export interface WindowsSink {
    created(id: WaylandWinId, renderId: string): void;
    closed(id: WaylandWinId): void;
    resized(id: WaylandWinId, width: number, height: number): void;
    startMove(id: WaylandWinId): void;
    maximized(id: WaylandWinId): void;
    unmaximized(id: WaylandWinId): void;
    titleChanged(id: WaylandWinId, title: string): void;
}

/**
 * 窗口记录的唯一持有者。
 *
 * 状态与事件绑在同一次调用里，避免「发了事件但记录没改」这类不同步；
 * 桌面侧看到的 `window.*` 事件由 server fan-in 自本类的 sink。
 */
export class WindowsStore {
    #wins = new Map<WaylandWinId, WindowRecord>();
    #sink: WindowsSink;

    constructor(sink: WindowsSink) {
        this.#sink = sink;
    }

    /**
     * 活的 Map，只留给协议模块与 host 内部（`WindowsApi.wins` 契约）。
     */
    get wins(): Map<WaylandWinId, WindowRecord> {
        return this.#wins;
    }

    get(id: WaylandWinId): WindowRecord | undefined {
        return this.#wins.get(id);
    }

    /** xdg_surface.get_toplevel */
    created(id: WaylandWinId, renderId: string): void {
        this.#wins.set(id, {
            actived: false,
            box: { width: 0, height: 0 },
            title: "",
            maximized: false,
            minimized: false,
        });
        this.#sink.created(id, renderId);
    }

    /**
     * 仅移除记录。destroy 流程里 xdg 侧清理必须夹在「移除记录」与「发关闭事件」之间——
     * `toplevelDestroyed` 会触发桌面可见的 `onToplevelRemove`，原顺序是
     * 记录删除 → onToplevelRemove → windowClosed，两者的先后桌面能观察到。
     */
    remove(id: WaylandWinId): void {
        this.#wins.delete(id);
    }

    /** 仅发关闭事件，须在 xdg 侧清理之后调用 */
    notifyClosed(id: WaylandWinId): void {
        this.#sink.closed(id);
    }

    setTitle(id: WaylandWinId, title: string): void {
        // 先发事件再改记录，顺序对桌面可观察
        this.#sink.titleChanged(id, title);
        const w = this.#wins.get(id);
        if (w) w.title = title;
    }

    /** xdg_surface.set_window_geometry —— 只通知，不改 box（box 由桌面命令维护） */
    resized(id: WaylandWinId, width: number, height: number): void {
        this.#sink.resized(id, width, height);
    }

    startMove(id: WaylandWinId): void {
        this.#sink.startMove(id);
    }

    /** 客户端请求最大化/取消最大化：先改记录再发事件，window.changed 的 states 才自包含 */
    setMaximized(id: WaylandWinId, maximized: boolean): void {
        const w = this.#wins.get(id);
        if (w) w.maximized = maximized;
        if (maximized) this.#sink.maximized(id);
        else this.#sink.unmaximized(id);
    }
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
            /**
             * 客户端是否已完成该 xdg_surface 的「初始 commit（无 buffer）」。
             * 规范要求初始 commit 之后才能发 configure；Qt/KDE 会丢弃更早的 configure。
             */
            initialCommitDone: boolean;
            /** 初始 commit 前桌面就可能改了状态（focus/setBox），先记下，等 commit 再发 */
            configurePending: boolean;
            /** 最近一次下发的 xdg_surface.configure serial，ack 时对账 */
            lastConfigureSerial?: number;
            /** popup 的初始 configure 参数，get_popup 时按 positioner 算好 */
            popupConfigure?: { x: number; y: number; width: number; height: number };
        }
    > = {};
    xdg_popup = new Map<WaylandObjectId2<"xdg_popup">, WaylandObjectId2<"xdg_surface">>();
    xdg_toplevel = new Map<WaylandObjectId2<"xdg_toplevel">, WaylandObjectId2<"xdg_surface">>();
    /** 反向索引：commit 走 wl_surface id，靠它找回 xdg_surface */
    private byWlSurface = new Map<WaylandObjectId2<"wl_surface">, WaylandObjectId2<"xdg_surface">>();
    /** xdg configure serial：客户端级单调递增，起点 1（0 会被 Qt 当作无效 configure） */
    #configureSerial = 1;
    private render: renderTools;
    private idScope: (id: unknown) => string;
    /** core 的 subsurface 树与对象表：`hitTest` 的正向依赖（ext → core 允许） */
    private subsurface: SubSurfaceApi;
    private objects: ObjectApi;
    constructor(ctx: ModuleCtx) {
        this.wl_surface = ctx.core.surface;
        this.render = this.wl_surface.render;
        this.idScope = this.wl_surface.idScope;
        this.subsurface = ctx.core.subsurface;
        this.objects = ctx.objects;
    }

    addXdgSurface(id: WaylandObjectId2<"xdg_surface">, wlSurface: WaylandObjectId2<"wl_surface">) {
        this.xdg_surface[id] = {
            surface: wlSurface,
            parent: undefined,
            children: [],
            offset: { x: 0, y: 0 },
            initialCommitDone: false,
            configurePending: false,
        };
        this.byWlSurface.set(wlSurface, id);

        this.render.createXdgSurfaceEle(this.idScope(id), this.idScope(wlSurface));
    }
    getXdgSurfaceByWlSurface(id: WaylandObjectId2<"wl_surface">) {
        return this.byWlSurface.get(id);
    }
    nextConfigureSerial() {
        const serial = this.#configureSerial;
        this.#configureSerial += 2;
        return serial;
    }
    /** 记录 ack；只用于把「已送达」的 serial 收掉 */
    ackConfigure(id: WaylandObjectId2<"xdg_surface">, serial: number) {
        const s = this.getXdgSurface(id);
        if (s && s.lastConfigureSerial === serial) s.lastConfigureSerial = undefined;
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
    /** xdg_surface 在窗口元素（顶层窗口几何原点）坐标系里的偏移：父链 offset 累加 */
    absoluteOffset(id: WaylandObjectId2<"xdg_surface">): { x: number; y: number } {
        const info = this.getXdgSurface(id);
        if (!info.parent) return { x: 0, y: 0 };
        const parent = this.absoluteOffset(info.parent);
        return { x: parent.x + info.offset.x, y: parent.y + info.offset.y };
    }
    /** 沿 parent 链找到顶层 xdg_surface（popup 的约束范围以它为界） */
    rootXdgSurface(id: WaylandObjectId2<"xdg_surface">): WaylandObjectId2<"xdg_surface"> {
        const info = this.getXdgSurface(id);
        if (!info.parent) return id;
        return this.rootXdgSurface(info.parent);
    }
    xdgSurfaceDestroyed(xdgSurfaceId: WaylandObjectId2<"xdg_surface">, type: "toplevel" | "popup") {
        const surface = this.xdg_surface[xdgSurfaceId]?.surface;
        if (surface !== undefined && this.byWlSurface.get(surface) === xdgSurfaceId) {
            this.byWlSurface.delete(surface);
        }
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
        // 深度优先：父 popup 在前、子 popup 在后；hitTest 反向遍历，子菜单（更上层）先命中。
        // offset 用 absoluteOffset 合并父链，坐标系与顶层 xdg_surface 一致。
        const walk = (parentId: WaylandObjectId2<"xdg_surface">) => {
            for (const c of this.xdg_surface[parentId].children) {
                if (this.wl_surface.getWlSurface(this.getXdgSurface(c).surface).role !== "popup") continue;
                children.push({
                    id: c,
                    offset: this.absoluteOffset(c),
                    size: this.getReRect(c),
                });
                walk(c);
            }
        };
        walk(parent);
        return children;
    }

    /**
     * 指针命中检测（`ctx.domain.xdgSurface.hitTest` 的实现，纯几何）：
     * xdg 几何 + popup 树 + subsurface + input region。
     * 只做几何；焦点转移与 enter/leave 的协议动作在 `protocols/core/wayland.ts` 的 `input.pointer`。
     * 没命中任何 surface 时返回 undefined —— 此时**不发 leave**（见 core 的 todo）。
     */
    hitTest(winId: WaylandWinId, p: { x: number; y: number }): HitTestResult | undefined {
        const xdgSurfaceId = this.getXdgSurfaceByToplevel(winId);
        if (xdgSurfaceId === undefined) return undefined;
        const { x, y } = p;
        // 获取在哪个xdgsurface上，并区分surface还是popup
        let inXdgSurface: WaylandObjectId2<"xdg_surface"> | undefined;
        /** 相对于主xdgsurface坐标，适用于popup */
        const xdgSurfaceOffset = { x: 0, y: 0 };
        let reasonSurfaceType: "main" | "popup" | null = null;
        for (const { id: p, offset, size } of this.getChildenDeepOnlyPopup(xdgSurfaceId).toReversed()) {
            const offsetX = offset.x;
            const offsetY = offset.y;
            const offsetX1 = offset.x + size.w;
            const offsetY1 = offset.y + size.h;
            if (x >= offsetX && x < offsetX1 && y >= offsetY && y < offsetY1) {
                console.log(`pointer in popup surface ${p}`);
                inXdgSurface = p;
                xdgSurfaceOffset.x = offset.x;
                xdgSurfaceOffset.y = offset.y;
                reasonSurfaceType = "popup";
                break;
            }
        }
        if (!inXdgSurface) {
            if (0 < x && x < this.getReRect(xdgSurfaceId).w && 0 < y && y < this.getReRect(xdgSurfaceId).h) {
                inXdgSurface = xdgSurfaceId;
                xdgSurfaceOffset.x = 0;
                xdgSurfaceOffset.y = 0;
                reasonSurfaceType = "main";
            } else {
                return undefined;
            }
        }
        // 获取与xdgsurface相关的所有surface，比如子表面
        const surfaces: {
            id: WaylandObjectId2<"wl_surface">;
            /** 相对于主surface坐标 */
            offsetRect: { x: number; y: number; w: number; h: number };
        }[] = [];
        const mainSurfaceId = this.getXdgSurface(inXdgSurface).surface;
        // 主 surface 尺寸：自家 `wl_surface` 域（原 host 的 getMainSurfaceRect 等价内联）
        const rel = this.wl_surface.getWlSurface(mainSurfaceId).size;
        const { winGeo: selfOffset = { x: 0, y: 0 } } = this.getXdgSurface(inXdgSurface);
        surfaces.push({ id: mainSurfaceId, offsetRect: { x: 0, y: 0, w: rel.w, h: rel.h } });
        surfaces.push(...this.subsurface.getChildrenDeep(mainSurfaceId));

        let inSurface: { id: WaylandObjectId2<"wl_surface">; x: number; y: number } | undefined;
        let canSend = false;
        for (const { id: s, offsetRect } of surfaces.toReversed()) {
            const offsetX = offsetRect.x - selfOffset.x + xdgSurfaceOffset.x;
            const offsetY = offsetRect.y - selfOffset.y + xdgSurfaceOffset.y;
            const offsetX1 = offsetRect.x + offsetRect.w - selfOffset.x + xdgSurfaceOffset.x;
            const offsetY1 = offsetRect.y + offsetRect.h - selfOffset.y + xdgSurfaceOffset.y;
            if (x >= offsetX && x < offsetX1 && y >= offsetY && y < offsetY1) {
                const nx = x - offsetX;
                const ny = y - offsetY;

                const surfaceInputRegion = this.objects.get<"wl_surface">(s).data.current.inputRegion;
                if (surfaceInputRegion) {
                    for (const r of surfaceInputRegion) {
                        if (nx >= r.x && nx < r.x + r.width && ny >= r.y && ny < r.y + r.height) {
                            if (r.type === "+") {
                                canSend = true;
                            } else {
                                canSend = false;
                                break;
                            }
                        }
                    }
                } else canSend = true;

                if (canSend) {
                    console.log(`pointer in surface ${s}`);
                    inSurface = { id: s, x: nx, y: ny };
                    break;
                }
            }
        }

        if (inSurface) {
            return { surface: inSurface.id, x: inSurface.x, y: inSurface.y, role: reasonSurfaceType ?? "main" };
        }
        // todo 指针不在任何surface上时应发送wl_pointer.leave并清除指针焦点
        //  现在焦点悬挂：客户端收不到leave（hover状态卡住），重新进来也不发enter、客户端不重发光标
        //  还需给桌面新增sendPointerLeave()入口（移出窗口时调用，幂等），覆盖移出所有窗口、跨客户端窗口
        return undefined;
    }
}

export const xdgShellModule = defineModule({
    name: "xdg-shell",
    /** `ctx.domain.xdgSurface` 的实例；构造时吃 core 提供的 `ctx.core.surface`（装配先跑完 core 两趟） */
    domain: {
        xdgSurface: (ctx) => new xdgSurfaceData(ctx),
        xdg: () => ({ wmBase: new Set(), appid: undefined }),
        /**
         * 窗口记录 + `window.*` 的 fan-in 单写入点（原 `state/windows_store.ts`）。
         * 回调方向不是 `actions`（那是桌面→wayland 的命令入口），是 `ctx.client.emit`——
         * `host/server.ts` 订阅后 fan-in 成 `window.*`。原 host 里那段 7 行适配层移到这里。
         */
        windows: (ctx) =>
            new WindowsStore({
                created: (wid, renderId) => ctx.client.emit("windowCreated", wid, renderId),
                closed: (wid) => ctx.client.emit("windowClosed", wid),
                resized: (wid, width, height) => ctx.client.emit("windowResized", wid, width, height),
                startMove: (wid) => ctx.client.emit("windowStartMove", wid),
                maximized: (wid) => ctx.client.emit("windowMaximized", wid),
                unmaximized: (wid) => ctx.client.emit("windowUnMaximized", wid),
                titleChanged: (wid, title) => ctx.client.emit("title", wid, title),
            }),
    },
    /** 原先是 core `wl_registry.bind` 里的硬编码分支（带 TODO），现在走通用的 onBind */
    globals: [
        {
            name: "xdg_wm_base",
            onBind: (msg, ctx) => {
                const id = msg.id as WaylandObjectId2<"xdg_wm_base">;
                ctx.domain.xdg.wmBase.add(id);
                ctx.objects.setData(id, { pingSerials: new Map() });
            },
        },
    ],
    hooks: {
        /**
         * 每个 wl_surface.commit 都会到达（含无 buffer 的初始 commit）：
         * 初始 commit 回 xdg configure，之后的 commit 只在状态 pending 时补发。
         */
        onCommit: (surfaceId, _sizeChanged, ctx) => {
            onSurfaceCommit(ctx, surfaceId);
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
            ctx.domain.xdg.wmBase.delete(x.id);
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
            ctx.domain.xdgSurface.setAsToplevel(xid, toplevelId);
            ctx.domain.windows.created(toplevelId, ctx.core.surface.idScope(xid));
        },
        "xdg_surface.set_window_geometry": (x, ctx) => {
            const thisXdgSurface = ctx.domain.xdgSurface.getXdgSurface(x.id);
            ctx.domain.xdgSurface.setXdgSurfaceSize(x.id, x.args.x, x.args.y, x.args.width, x.args.height);
            const role = thisXdgSurface.xdg_role;
            // popup 的几何只影响自身渲染，不该冒充窗口变化广播给桌面
            if (role !== undefined && ctx.objects.get(role).protocol.name === "xdg_toplevel") {
                ctx.domain.windows.resized(role as WaylandObjectId2<"xdg_toplevel">, x.args.width, x.args.height);
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
            const width = positionerData.size.width;
            const height = positionerData.size.height;

            const position = (anchorPointName: KeyPoint, popupPointName: KeyPoint) => {
                const anchorPoint = getRectKeyPoint(positionerData.anchor_rect, anchorPointName);
                const popupPoint = getRectKeyPoint({ x: 0, y: 0, width, height }, popupPointName);
                return {
                    x: anchorPoint.x - popupPoint.x + positionerData.offset.x,
                    y: anchorPoint.y - popupPoint.y + positionerData.offset.y,
                };
            };

            const anchorName = ANCHOR_POINT[positionerData.anchor] ?? "none";
            const gravityName = GRAVITY_POINT[positionerData.gravity] ?? "none";
            let pos = position(anchorName, gravityName);

            // 约束范围用根窗口（嵌套 popup 的可用区域是顶层窗口，不是父菜单本身）
            const parentAbs = ctx.domain.xdgSurface.absoluteOffset(parentXdgSurfaceId);
            const rootId = ctx.domain.xdgSurface.rootXdgSurface(parentXdgSurfaceId);
            const bounds = ctx.domain.xdgSurface.getReRect(rootId);
            const outsideX = (x: number) => x < 0 || x + width > bounds.w;
            const outsideY = (y: number) => y < 0 || y + height > bounds.h;

            const adj = positionerData.constraint_adjustment;
            // 优先级按协议：flip → slide → resize
            if (outsideX(parentAbs.x + pos.x) && adj & ADJ_FLIP_X) {
                const flipped = position(flipPoint(anchorName, "x"), flipPoint(gravityName, "x"));
                if (!outsideX(parentAbs.x + flipped.x)) pos = { ...pos, x: flipped.x };
            }
            if (outsideY(parentAbs.y + pos.y) && adj & ADJ_FLIP_Y) {
                const flipped = position(flipPoint(anchorName, "y"), flipPoint(gravityName, "y"));
                if (!outsideY(parentAbs.y + flipped.y)) pos = { ...pos, y: flipped.y };
            }
            if (adj & ADJ_SLIDE_X) {
                const absX = parentAbs.x + pos.x;
                pos.x = Math.min(Math.max(absX, 0), Math.max(0, bounds.w - width)) - parentAbs.x;
            }
            if (adj & ADJ_SLIDE_Y) {
                const absY = parentAbs.y + pos.y;
                pos.y = Math.min(Math.max(absY, 0), Math.max(0, bounds.h - height)) - parentAbs.y;
            }

            const nx = pos.x;
            const ny = pos.y;

            const xdgSurfaceM = ctx.domain.xdgSurface;
            xdgSurfaceM.setAsPopup(xid, popupId, parentXdgSurfaceId);
            xdgSurfaceM.setOffset(xid, nx, ny);

            // 初始 commit 后才发 configure（Qt/KDE 只认那时机的 configure）
            xdgSurfaceM.getXdgSurface(xid).popupConfigure = {
                x: Math.floor(nx),
                y: Math.floor(ny),
                width: positionerData.size.width,
                height: positionerData.size.height,
            };
        },
        "xdg_surface.ack_configure": (x, ctx) => {
            ctx.domain.xdgSurface.ackConfigure(x.id, x.args.serial);
        },
        "xdg_popup.destroy": (x, ctx) => {
            const xid = x.id;
            const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByPopup(xid);
            if (xdgSurfaceId === undefined) return;
            ctx.domain.xdgSurface.popupDestroyed(xid);
        },
        "xdg_toplevel.set_app_id": (x, ctx) => {
            if (!ctx.domain.xdg.appid) {
                ctx.domain.xdg.appid = x.args.app_id;
                ctx.client.emit("appid", x.args.app_id);
            }
        },
        "xdg_toplevel.set_title": (x, ctx) => {
            ctx.domain.windows.setTitle(x.id, x.args.title);
        },
        "xdg_toplevel.move": (x, ctx) => {
            ctx.domain.windows.startMove(x.id);
        },
        "xdg_toplevel.set_maximized": (x, ctx) => {
            ctx.domain.windows.setMaximized(x.id, true);
        },
        "xdg_toplevel.unset_maximized": (x, ctx) => {
            ctx.domain.windows.setMaximized(x.id, false);
        },
        "xdg_toplevel.destroy": (x, ctx) => {
            const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByToplevel(x.id);
            if (xdgSurfaceId === undefined) return;
            // 顺序对桌面可见：记录删除 → onToplevelRemove → windowClosed
            ctx.domain.windows.remove(x.id);
            ctx.domain.xdgSurface.toplevelDestroyed(x.id);
            ctx.domain.windows.notifyClosed(x.id);
        },
    },
    actions: {
        /**
         * 窗口命令：**两轴各自去重、互不派生**（规范对 `configure(activated)` 与
         * `wl_keyboard.enter` 的顺序没有要求）——
         * C 轴是 xdg 的 `actived` + configure；seat 轴交 `ctx.core.focusKeyboard`。
         * 键盘焦点由桌面驱动：hover 政策归桌面（想 focus-follows-mouse 就在 hover 时调本命令）。
         */
        "window.focus": (msg, ctx) => {
            const win = ctx.domain.windows.get(msg.winId);
            if (win === undefined) return;
            if (!win.actived) {
                win.actived = true;
                win.minimized = false;
                configureWin(ctx, msg.winId);
            }
            // 主 surface 已解体的窗口只处理 actived，**不能**把焦点清空（会误伤真正在聚焦的那个）
            const surface = mainSurface(ctx, msg.winId);
            if (surface !== null) ctx.core.focusKeyboard(surface, FOCUS_SEAT);
        },
        "window.blur": (msg, ctx) => {
            const win = ctx.domain.windows.get(msg.winId);
            if (win === undefined) return;
            if (win.actived) {
                win.actived = false;
                configureWin(ctx, msg.winId);
            }
            // 只清**自己拥有**的键盘焦点：桌面 `focusWin` 是「目标 focus + 其余 blur」的全量循环，
            // 这样写与遍历顺序无关，终态一定是目标窗口持有焦点（重复 blur 也被 focusKeyboard 去重）
            const surface = mainSurface(ctx, msg.winId);
            if (surface !== null && ctx.domain.seat.byName(FOCUS_SEAT)?.keyboardFocus === surface)
                ctx.core.focusKeyboard(null, FOCUS_SEAT);
        },
        "window.close": (msg, ctx) => {
            if (ctx.domain.windows.get(msg.winId) === undefined) return;
            ctx.sendNow(msg.winId, "xdg_toplevel.close", {});
        },
        /** 只记录桌面配置的盒子，不发 configure */
        "window.setBox": (msg, ctx) => {
            const win = ctx.domain.windows.get(msg.winId);
            if (win === undefined) return;
            win.box = msg.args[0];
        },
        "window.setSize": (msg, ctx) => {
            const win = ctx.domain.windows.get(msg.winId);
            if (win === undefined) return;
            win.box.width = msg.args[0].width;
            win.box.height = msg.args[0].height;
            configureWin(ctx, msg.winId);
        },
        "window.maximize": (msg, ctx) => {
            const win = ctx.domain.windows.get(msg.winId);
            if (win === undefined) return;
            if (ctx.domain.xdgSurface.getXdgSurfaceByToplevel(msg.winId) === undefined) return;
            win.actived = true;
            win.maximized = true;
            win.minimized = false;
            win.box.width = msg.args[0]?.width ?? win.box.width;
            win.box.height = msg.args[0]?.height ?? win.box.height;
            configureWin(ctx, msg.winId);
        },
        "window.unmaximize": (msg, ctx) => {
            const win = ctx.domain.windows.get(msg.winId);
            if (win === undefined) return;
            win.maximized = false;
            win.box.width = msg.args[0]?.width ?? win.box.width;
            win.box.height = msg.args[0]?.height ?? win.box.height;
            configureWin(ctx, msg.winId);
        },
        "window.minimize": (msg, ctx) => {
            const win = ctx.domain.windows.get(msg.winId);
            if (win === undefined) return;
            win.actived = false;
            win.minimized = true;
            configureWin(ctx, msg.winId);
        },
    },
});
