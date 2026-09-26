/**
 * 桌面侧对外 API 的类型契约。
 *
 * 只有类型、零实现零副作用；`index.ts` 是唯一入口，host/ 负责实现这些形状。
 * 设计原则见 PLAN.md §0：对外 API 以「桌面需要回答的问题」建模
 * （有哪些窗口、多大、光标是什么、怎么操作），不以 Wayland 对象建模。
 *
 * 与 `module.ts` 的分工：module.ts 是**协议模块**的契约（handler / ctx），
 * 本文件是**桌面**的契约（事件 / 查询 / 控制），两边互不 import 实现。
 */
import type { SurfaceId } from "./module";

// ───────────────────────── 窗口身份 ─────────────────────────

/**
 * 服务端全局窗口身份：单调递增的 `"w1"`、`"w2"`…
 *
 * Wayland 对象 id 由**客户端本地分配**（实测两个客户端可同时用 `id: 9`），
 * 扁平事件不能直接用 windowId。递增 handle 客户端断开重连后 id 复用也不会串台。
 */
export type WinHandle = string;

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface WindowStates {
    activated: boolean;
    maximized: boolean;
    minimized: boolean;
}

/** 宽高（不含位置） */
export interface Size {
    width: number;
    height: number;
}

/**
 * 一次自包含的窗口快照：`window.created` / `window.changed` 与查询接口共用。
 * 字段全部自包含，桌面拿到即可用，无需反查 client、无需拼 id。
 */
export interface WindowInfo {
    handle: WinHandle;
    /** 所属连接；需要按客户端过滤时才用 */
    clientId: string;
    appid: string;
    title: string;
    /**
     * 窗口几何。
     * - `w`/`h`：客户端 `xdg_surface.set_window_geometry` 声明的尺寸（未设置时为 surface 尺寸）。
     * - `x`/`y`：客户端声明的几何偏移（surface 局部坐标），**不是屏幕位置**——
     *   摆放由桌面负责，桌面渲染时几何原点即窗口元素左上角（renderTools 已按 offset 平移内容）。
     *
     * 命中检测请用 `0 ≤ p.x < rect.w && 0 ≤ p.y < rect.h`（窗口元素的局部坐标）。
     */
    rect: Rect;
    states: WindowStates;
    /** 渲染侧不透明 id：`render.getXdgSurfaceEle(info.renderId)` */
    renderId: string;
}

// ───────────────────────── 光标状态 ─────────────────────────

/**
 * 光标的语义状态（`state/cursor_store.ts` 是唯一写入点）。
 * `shape` 是 wp_cursor_shape 的纯枚举名，可序列化；`image` 是 surface 图像，
 * 图像是一等数据（cursor 协议传的是 surface，不能藏在 DOM 实现里），故内联画布。
 */
export type CursorState =
    | { kind: "hidden" }
    | { kind: "shape"; shape: string; hotspot: { x: 0; y: 0 } }
    | {
          kind: "image";
          surfaceId: SurfaceId;
          hotspot: { x: number; y: number };
          /** 该 surface 最近一次合成的帧；还没提交过帧时为 undefined，桌面应保留上一张 */
          canvas?: OffscreenCanvas;
      };

// ───────────────────────── 客户端 ─────────────────────────

export interface ClientLogConfig {
    receive: boolean | string[];
    send: boolean | string[];
}

/**
 * 桌面能从 `server.clients` 拿到的东西。
 *
 * 常规路径（窗口 / 光标 / 剪贴板的事件、查询、命令）一律走 server；
 * 这里只留连接级的底层入口：日志开关、remote/调试等明确要 client 对象的场景。
 */
export interface Client {
    readonly id: string;
    setLogConfig(op: ClientLogConfig): void;
}

// ───────────────────────── 输入命令 ─────────────────────────

/** x、y 相对该窗口的 xdg_surface 元素左上角 */
export interface PointerCommand {
    type: "move" | "down" | "up";
    x: number;
    y: number;
    button: number;
}

export interface ScrollCommand {
    deltaX: number;
    deltaY: number;
    deltaZ: number;
}

// ───────────────────────── server 级事件 ─────────────────────────

/**
 * 服务端 → 桌面，按域分组、payload 自包含，一次订阅覆盖**全部**客户端。
 *
 * 注意键是扁平的 `"域.动作"`（EventEmitter 的键没有嵌套语义），
 * 写成 `window.created` 这种形式只是分组记号。
 */
export type ServerEvents = {
    /** 新窗口，`renderId` 内嵌在 `info` 里 */
    "window.created": [info: WindowInfo];
    /** rect / states / title / appid 任一变化；payload 自包含，无需反查 */
    "window.changed": [info: WindowInfo];
    /** 窗口关闭，**含客户端断开时由 server 统一补发的关闭** */
    "window.closed": [handle: WinHandle];
    /** 客户端请求移动窗口（xdg_toplevel.move） */
    "window.startMove": [handle: WinHandle];
    "cursor.changed": [clientId: string, state: CursorState];
    "clipboard.copy": [clientId: string, text: string];
    /** 客户端请求粘贴；桌面用 `notify("clipboard.paste", clientId, text)` 回填 */
    "clipboard.pasteRequested": [clientId: string];
    "client.opened": [clientId: string];
    /** 该客户端的窗口已在此之前逐个发出 `window.closed` */
    "client.closed": [clientId: string];
};

// ───────────────────────── 命令（桌面 → server → client） ─────────────────────────

/**
 * server 内部按 handle 反查 `(client, winId)` 后下发，桌面不接触 Wayland 对象 id。
 * 无返回值；查询用 `request` / `windows.*`。
 */
export type ServerNotifyMap = {
    "window.focus": [handle: WinHandle];
    "window.blur": [handle: WinHandle];
    "window.close": [handle: WinHandle];
    /** 只记录桌面配置的盒子，不发 configure */
    "window.setBox": [handle: WinHandle, size: Size];
    "window.setSize": [handle: WinHandle, size: Size];
    /** 不带 size 时沿用盒子尺寸 */
    "window.maximize": [handle: WinHandle, size?: Size];
    "window.unmaximize": [handle: WinHandle, size?: Size];
    "window.minimize": [handle: WinHandle];
    "input.pointer": [handle: WinHandle, ev: PointerCommand];
    "input.scroll": [handle: WinHandle, ev: ScrollCommand];
    "input.key": [handle: WinHandle, key: number, state: "pressed" | "released"];
    "input.text": [handle: WinHandle, text: string, preedit: boolean];
    /** 把剪贴板内容 offer 给该客户端，通常在获得焦点时调用 */
    "clipboard.offer": [handle: WinHandle];
    /** 剪贴板回填，clientId 来自 `clipboard.pasteRequested` 事件（剪贴板是 client 级而非窗口级） */
    "clipboard.paste": [clientId: string, text: string];
};

// ───────────────────────── 请求-应答 ─────────────────────────

/**
 * 请求-应答（形状同 `event-emitter` 的 `RequestEventMap`）。
 * 双向：`window.*` 由 server 自己应答（桌面查询），`surfaceBounds.request` 由桌面应答（server 查询）。
 *
 * 注意 `surfaceBounds.request` 必须**同步**应答——`xdg_surface.get_toplevel` 在同步
 * handler 里就要填 `configure_bounds`，Promise 版的 `EventEmitter.request` 来不及。
 * server 侧保留同步副本，见 `host/server.ts`。
 */
export type ServerRequests = {
    "window.get": { args: [handle: WinHandle]; result: WindowInfo };
    "window.getBounds": { args: [handle: WinHandle]; result: Rect };
    /** 桌面提供可用空间，注册一次，见 api.ts */
    "surfaceBounds.request": { args: []; result: Size };
};
