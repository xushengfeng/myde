import type { GestureCommand, PointerCommand, ScrollCommand, WinHandle } from "../api";
import type { WaylandWinId } from "../module";

/**
 * 跨 client 的 seat 归属路由：只维护「哪个 client 当前拥有 pointer/keyboard」，
 * 协议细节（surface 级 enter/leave、grab、补 release）仍由各自的 SeatState 负责。
 *
 * 它不维护 target 流，也不做时间对齐：只在下一个事件到达时，给旧 client 补 leave/cancel。
 */

export interface SeatClientActions {
    pointer(winId: WaylandWinId, ev: PointerCommand, seat: string): void;
    pointerLeave(seat: string): void;
    pointerCancel(seat: string): void;
    scroll(winId: WaylandWinId, ev: ScrollCommand, seat: string): void;
    gesture(winId: WaylandWinId, ev: GestureCommand, seat: string): void;
    key(winId: WaylandWinId, key: number, state: "pressed" | "released", seat: string): void;
    focus(winId: WaylandWinId, seat: string): void;
    blur(winId: WaylandWinId, seat: string): void;
}

interface RouteOwner {
    clientId: string;
    handle: WinHandle;
    winId: WaylandWinId;
}

interface SeatRoute {
    /** 当前 pointer 归属（跨 client 比较基线）；没有 grab 时随事件更新 */
    focus?: RouteOwner;
    /** 当前隐式 grab 的窗口；同窗口多键共用 */
    grab?: RouteOwner;
    /** DOM 按钮集合：只用于判断 grab 是否还在，不参与 BTN_* 映射 */
    buttons: Set<number>;
    /** 当前 keyboard 归属 */
    keyboard?: RouteOwner;
}

export class SeatRouter {
    #seats = new Map<string, SeatRoute>();

    constructor(private readonly getClient: (clientId: string) => SeatClientActions | undefined) {}

    #seat(name: string): SeatRoute {
        let route = this.#seats.get(name);
        if (route === undefined) {
            route = { buttons: new Set() };
            this.#seats.set(name, route);
        }
        return route;
    }

    #cancelGrab(route: SeatRoute, seat: string): void {
        const grab = route.grab;
        if (grab === undefined) return;
        this.getClient(grab.clientId)?.pointerCancel(seat);
        route.grab = undefined;
        route.buttons.clear();
        // pointerCancel 已经让旧 client 补了 release 并 leave
        route.focus = undefined;
    }

    pointer(owner: RouteOwner, ev: PointerCommand, seat = "seat0"): void {
        const route = this.#seat(seat);
        const client = this.getClient(owner.clientId);
        if (client === undefined) return;

        if (route.grab !== undefined && route.buttons.size === 0) route.grab = undefined;

        if (route.grab !== undefined) {
            if (route.grab.handle !== owner.handle) {
                // 桌面把 grab 期间的事件发到了别的窗口：旧会话坐标空间已不可信，强制收尾
                this.#cancelGrab(route, seat);
            } else {
                if (ev.type === "down") {
                    if (route.buttons.has(ev.button)) return;
                    route.buttons.add(ev.button);
                    client.pointer(owner.winId, ev, seat);
                    return;
                }
                if (ev.type === "up") {
                    if (!route.buttons.has(ev.button)) return;
                    route.buttons.delete(ev.button);
                    client.pointer(owner.winId, ev, seat);
                    if (route.buttons.size === 0) route.grab = undefined;
                    return;
                }
                client.pointer(owner.winId, ev, seat);
                return;
            }
        }

        // 没有 grab：up 没有对应 down，直接丢弃
        if (ev.type === "up") return;

        // 跨 client 切换：旧 client 先 leave；同 client 的 surface 切换由 L2 自己处理
        if (route.focus !== undefined && route.focus.clientId !== owner.clientId) {
            this.getClient(route.focus.clientId)?.pointerLeave(seat);
        }
        route.focus = owner;

        if (ev.type === "down") {
            route.grab = owner;
            route.buttons.add(ev.button);
        }
        client.pointer(owner.winId, ev, seat);
    }

    /**
     * 滚动没有按钮状态：没有 grab 时按目标窗口切换 pointer 归属；
     * grab 期间 axis 必须跟随固定的 pointer focus，所以仍发给 grab client。
     */
    scroll(owner: RouteOwner, ev: ScrollCommand, seat = "seat0"): void {
        const route = this.#seat(seat);
        if (route.grab !== undefined && route.buttons.size === 0) route.grab = undefined;
        if (route.grab !== undefined && route.grab.handle !== owner.handle) {
            const grab = route.grab;
            this.getClient(grab.clientId)?.scroll(grab.winId, ev, seat);
            return;
        }
        if (route.focus !== undefined && route.focus.clientId !== owner.clientId) {
            this.getClient(route.focus.clientId)?.pointerLeave(seat);
        }
        route.focus = owner;
        this.getClient(owner.clientId)?.scroll(owner.winId, ev, seat);
    }

    /** 手势和滚动一样：没有 grab 时切换 pointer 归属，grab 期间跟随 grab client */
    gesture(owner: RouteOwner, ev: GestureCommand, seat = "seat0"): void {
        const route = this.#seat(seat);
        if (route.grab !== undefined && route.buttons.size === 0) route.grab = undefined;
        if (route.grab !== undefined && route.grab.handle !== owner.handle) {
            const grab = route.grab;
            this.getClient(grab.clientId)?.gesture(grab.winId, ev, seat);
            return;
        }
        if (route.focus !== undefined && route.focus.clientId !== owner.clientId) {
            this.getClient(route.focus.clientId)?.pointerLeave(seat);
        }
        route.focus = owner;
        this.getClient(owner.clientId)?.gesture(owner.winId, ev, seat);
    }

    /** 键盘焦点命令（window.focus）：跨 client 时先 blur 旧 owner */
    keyboardFocus(owner: RouteOwner, seat = "seat0"): void {
        const route = this.#seat(seat);
        const previous = route.keyboard;
        if (previous !== undefined && previous.clientId !== owner.clientId) {
            this.getClient(previous.clientId)?.blur(previous.winId, seat);
        }
        route.keyboard = owner;
        this.getClient(owner.clientId)?.focus(owner.winId, seat);
    }

    /** window.blur：只有它拥有 keyboard 时才清归属，动作本身照常下发 */
    keyboardBlur(owner: RouteOwner, seat = "seat0"): void {
        const route = this.#seat(seat);
        if (
            route.keyboard !== undefined &&
            route.keyboard.clientId === owner.clientId &&
            route.keyboard.handle === owner.handle
        ) {
            route.keyboard = undefined;
        }
        this.getClient(owner.clientId)?.blur(owner.winId, seat);
    }

    /** 按键事件自带窗口：桌面没先 focus 时，以事件窗口为准补 keyboard 归属 */
    key(owner: RouteOwner, key: number, state: "pressed" | "released", seat = "seat0"): void {
        const route = this.#seat(seat);
        const previous = route.keyboard;
        if (previous !== undefined && previous.clientId !== owner.clientId) {
            this.getClient(previous.clientId)?.blur(previous.winId, seat);
        }
        route.keyboard = owner;
        this.getClient(owner.clientId)?.key(owner.winId, key, state, seat);
    }

    /** 窗口消失：只清路由状态；L2 的销毁收尾由 xdg/core 负责 */
    windowClosed(handle: WinHandle): void {
        for (const route of this.#seats.values()) {
            if (route.focus?.handle === handle) route.focus = undefined;
            if (route.grab?.handle === handle) {
                route.grab = undefined;
                route.buttons.clear();
            }
            if (route.keyboard?.handle === handle) route.keyboard = undefined;
        }
    }

    /** 连接断开：清掉该 client 的全部归属 */
    clientClosed(clientId: string): void {
        for (const route of this.#seats.values()) {
            if (route.focus?.clientId === clientId) route.focus = undefined;
            if (route.grab?.clientId === clientId) {
                route.grab = undefined;
                route.buttons.clear();
            }
            if (route.keyboard?.clientId === clientId) route.keyboard = undefined;
        }
    }
}
