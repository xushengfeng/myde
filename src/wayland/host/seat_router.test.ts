import { describe, expect, it } from "vitest";
import type { PointerCommand } from "../api";
import type { WaylandWinId } from "../module";
import { type SeatClientActions, SeatRouter } from "./seat_router";

const winA = 1 as WaylandWinId;
const winB = 2 as WaylandWinId;

function setup() {
    const calls: string[] = [];
    const actions = (id: string): SeatClientActions => ({
        pointer: (winId, ev) => calls.push(`${id}:pointer:${winId}:${ev.type}`),
        pointerLeave: (seat) => calls.push(`${id}:leave:${seat}`),
        pointerCancel: (seat) => calls.push(`${id}:cancel:${seat}`),
        scroll: (winId, ev) => calls.push(`${id}:scroll:${winId}:${ev.deltaY}`),
        gesture: (winId, ev) => calls.push(`${id}:gesture:${winId}:${ev.type}:${ev.phase}`),
        key: (winId, key, state) => calls.push(`${id}:key:${winId}:${key}:${state}`),
        focus: (winId) => calls.push(`${id}:focus:${winId}`),
        blur: (winId) => calls.push(`${id}:blur:${winId}`),
    });
    const clients = new Map([
        ["a", actions("a")],
        ["b", actions("b")],
    ]);
    const router = new SeatRouter((id) => clients.get(id));
    const owner = (clientId: "a" | "b", winId: WaylandWinId) => ({
        clientId,
        handle: `${winId}`,
        winId,
    });
    return { router, calls, owner };
}

const down = (button: number): PointerCommand => ({ type: "down", x: 0, y: 0, button });
const move: PointerCommand = { type: "move", x: 1, y: 1, button: 0 };
const up = (button: number): PointerCommand => ({ type: "up", x: 0, y: 0, button });

describe("SeatRouter", () => {
    it("跨 client 切换 pointer：旧 client 先 leave", () => {
        const { router, calls, owner } = setup();
        router.pointer(owner("a", winA), move);
        router.pointer(owner("b", winB), move);
        expect(calls).toEqual(["a:pointer:1:move", "a:leave:seat0", "b:pointer:2:move"]);
    });

    it("grab 期间收到别的窗口：旧 client cancel，再按新窗口处理", () => {
        const { router, calls, owner } = setup();
        router.pointer(owner("a", winA), down(0));
        router.pointer(owner("b", winB), move);
        expect(calls).toEqual(["a:pointer:1:down", "a:cancel:seat0", "b:pointer:2:move"]);
    });

    it("grab 同窗口：motion 不 leave，重复 down/up 被过滤", () => {
        const { router, calls, owner } = setup();
        const a = owner("a", winA);
        router.pointer(a, down(0));
        router.pointer(a, down(0));
        router.pointer(a, move);
        router.pointer(a, up(0));
        router.pointer(a, up(0));
        expect(calls).toEqual(["a:pointer:1:down", "a:pointer:1:move", "a:pointer:1:up"]);
    });

    it("键盘 focus 切换自动 blur 旧 owner；key 也以事件窗口为准", () => {
        const { router, calls, owner } = setup();
        router.keyboardFocus(owner("a", winA));
        router.keyboardFocus(owner("b", winB));
        router.key(owner("b", winB), 30, "pressed");
        expect(calls).toEqual(["a:focus:1", "a:blur:1", "b:focus:2", "b:key:2:30:pressed"]);
    });

    it("滚动到另一个 client：先 leave 旧 client，再交给目标", () => {
        const { router, calls, owner } = setup();
        router.pointer(owner("a", winA), move);
        router.scroll(owner("b", winB), { deltaX: 0, deltaY: 100, deltaZ: 0 });
        expect(calls).toEqual(["a:pointer:1:move", "a:leave:seat0", "b:scroll:2:100"]);
    });

    it("滚动在 grab 期间跟随 grab client", () => {
        const { router, calls, owner } = setup();
        router.pointer(owner("a", winA), down(0));
        router.scroll(owner("b", winB), { deltaX: 0, deltaY: 100, deltaZ: 0 });
        expect(calls).toEqual(["a:pointer:1:down", "a:scroll:1:100"]);
    });

    it("手势到另一个 client：先 leave 旧 client，再交给目标", () => {
        const { router, calls, owner } = setup();
        router.pointer(owner("a", winA), move);
        router.gesture(owner("b", winB), { type: "pinch", phase: "begin", fingers: 2 });
        expect(calls).toEqual(["a:pointer:1:move", "a:leave:seat0", "b:gesture:2:pinch:begin"]);
    });

    it("手势在 grab 期间跟随 grab client", () => {
        const { router, calls, owner } = setup();
        router.pointer(owner("a", winA), down(0));
        router.gesture(owner("b", winB), { type: "swipe", phase: "begin", fingers: 3 });
        expect(calls).toEqual(["a:pointer:1:down", "a:gesture:1:swipe:begin"]);
    });
});
