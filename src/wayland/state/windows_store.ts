import type { WaylandWinId } from "../module";

export interface WindowRecord {
    actived: boolean;
    box: { width: number; height: number };
    title: string;
}

/**
 * 对外出口。Phase 2 仍是 client 级事件（薄适配层在 server.ts 构造时注入），
 * Phase 6 改成 server 级 fan-in 时只动那一处接线，handler 与本类都不用改。
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
 * 窗口记录的唯一持有者（原 `obj2.windows`）。
 *
 * 状态与事件绑在同一次调用里，避免「发了事件但记录没改」这类不同步；
 * 对外事件名与 payload 保持不变，桌面零改动。
 */
export class WindowsStore {
    #wins = new Map<WaylandWinId, WindowRecord>();
    #sink: WindowsSink;

    constructor(sink: WindowsSink) {
        this.#sink = sink;
    }

    /**
     * 暴露**活的 Map**：桌面与 mock 会直接遍历、增删
     * （`desktop/*`、`desktop-test`、`test/mock/apps/base.ts:78/265`），
     * 返回副本会破坏它们。Phase 6 收敛为 `list()` 快照时再收口。
     */
    get wins(): Map<WaylandWinId, WindowRecord> {
        return this.#wins;
    }

    get(id: WaylandWinId): WindowRecord | undefined {
        return this.#wins.get(id);
    }

    /** xdg_surface.get_toplevel */
    created(id: WaylandWinId, renderId: string): void {
        this.#wins.set(id, { actived: false, box: { width: 0, height: 0 }, title: "" });
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
        // 先发事件再改记录，与重构前的顺序一致
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

    setMaximized(id: WaylandWinId, maximized: boolean): void {
        if (maximized) this.#sink.maximized(id);
        else this.#sink.unmaximized(id);
    }
}
