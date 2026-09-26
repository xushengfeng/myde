import type { FocusType, SeatRecord, WaylandWinId, WindowRecord } from "../module";

export type { FocusType, SeatRecord, WindowRecord };

/**
 * 对外出口。实现方是 `host/client.ts` 构造 `WindowsStore` 时注入的薄适配层，
 * 它把 Store 调用转成 client 级事件；`host/server.ts` 订阅这些事件做 fan-in，
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
