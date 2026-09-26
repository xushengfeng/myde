/**
 * wayland 层唯一公开入口。
 *
 * 只有这里 re-export 的东西算对外 API；host/、protocols/、state/ 及各内部类一律私有。
 * `server.ts` 后续会被拆分直至删除，调用方一律从这里导入，届时内部怎么改都不影响调用点。
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

export { WaylandClient } from "./host/client";
export { WaylandServer } from "./host/server";
export type { WaylandWinId } from "./module";
export type { renderTools, renderToolsOn } from "./render_tools";
