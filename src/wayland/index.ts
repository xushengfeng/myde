/**
 * wayland 层唯一公开入口。
 *
 * 只有这里 re-export 的东西算对外 API；host/、protocols/、state/ 及各内部类一律私有。
 * `Client` 是桌面能看到的连接接口（日志开关等底层入口），`WaylandClient` 是内部实现。
 */

import { WaylandServer } from "./host/server";
import type { renderTools } from "./render_tools";

/**
 * 创建 wayland 服务端。
 * 环境相关参数（socketDir、uid/gid 等）由调用方决定，wayland 层不读环境。
 */
export function createServer(op: { render: renderTools; socketDir?: string }): WaylandServer {
    return new WaylandServer({ socketDir: op.socketDir, render: op.render });
}

export type {
    Client,
    ClientLogConfig,
    CursorState,
    PointerCommand,
    Rect,
    ScrollCommand,
    ServerEvents,
    ServerNotifyMap,
    ServerRequests,
    Size,
    WindowInfo,
    WindowStates,
    WinHandle,
} from "./api";
export { WaylandServer } from "./host/server";
export type { WaylandWinId } from "./module";
export type { renderTools, renderToolsOn } from "./render_tools";
