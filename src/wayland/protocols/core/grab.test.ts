import { describe, expect, it } from "vitest";
import { InputEventCodes } from "../../../input_codes/types";
import type { ModuleCtx, SeatRecord, SurfaceId, WaylandObjectId2, WaylandWinId } from "../../module";
import { xdgShellModule, xdgSurfaceData } from "../ext/xdg_shell";
import { endPointerGrabForSurfaces, forcePointerGrab, SeatStore, waylandCoreModule } from "./wayland";

/**
 * 隐式 grab 的 core 单元测试：不启动 Wayland 连接，只验证路由、按钮码空间和清理。
 * 指针/键盘资源用假对象表，xdg 命中用一个记录 hold 参数的假实现。
 */

const seatId = 1 as WaylandObjectId2<"wl_seat">;
const pointerId = 2 as WaylandObjectId2<"wl_pointer">;
const keyboardId = 3 as WaylandObjectId2<"wl_keyboard">;
const surfaceId = 100 as SurfaceId;
const otherSurfaceId = 101 as SurfaceId;
const winId = 10 as WaylandWinId;
const otherWinId = 20 as WaylandWinId;

function makeCtx() {
    const sent: { id: number; event: string; args: Record<string, unknown> }[] = [];
    const data = new Map<number, unknown>([
        [pointerId, {}],
        [keyboardId, {}],
        [surfaceId, {}],
        [otherSurfaceId, {}],
    ]);
    const store = new SeatStore();
    store.addSeat(seatId, "seat0");
    const seat = store.byName("seat0") as SeatRecord;
    seat.pointers.add(pointerId);
    seat.keyboards.add(keyboardId);
    seat.pointerFocus = surfaceId;
    seat.keyboardFocus = surfaceId;
    const surfaceByWin = new Map<number, SurfaceId>([
        [winId, surfaceId],
        [otherWinId, otherSurfaceId],
    ]);

    let serial = 1;
    const holdCalls: { win: number; p: { x: number; y: number }; hold?: number }[] = [];
    const ctx = {
        objects: {
            has: (id: number) => data.has(id),
            get: (id: number) => {
                if (!data.has(id)) throw new Error(`object ${id} not found`);
                return { protocol: {}, data: data.get(id), version: 1 };
            },
            getOption: (id: number | undefined) =>
                id !== undefined && data.has(id) ? { protocol: {}, data: data.get(id), version: 1 } : undefined,
            setData: (id: number, value: unknown) => data.set(id, value),
        },
        send: (id: number, event: string, args: Record<string, unknown>) => sent.push({ id, event, args }),
        sendNow: (id: number, event: string, args: Record<string, unknown>) => sent.push({ id, event, args }),
        domain: {
            serial: { next: () => serial++ },
            seat: store,
            dataDevice: { drag: undefined },
            xdgSurface: {
                hitTest: (win: number, p: { x: number; y: number }, hold?: number) => {
                    holdCalls.push({ win, p, hold });
                    return {
                        surface: (hold ?? surfaceByWin.get(win) ?? surfaceId) as SurfaceId,
                        xdgSurface: 200 as WaylandObjectId2<"xdg_surface">,
                        x: p.x,
                        y: p.y,
                        role: "main" as const,
                    };
                },
                dismissGrabsForPointer: () => {},
                getXdgSurfaceByToplevel: (win: number) =>
                    (win === otherWinId ? 201 : 200) as WaylandObjectId2<"xdg_surface">,
                getXdgSurface: (id: number) => ({ surface: id === 201 ? otherSurfaceId : surfaceId }),
                getXdgSurfaceByWlSurface: () => 200 as WaylandObjectId2<"xdg_surface">,
                rootXdgSurface: () => 200 as WaylandObjectId2<"xdg_surface">,
            },
        },
        notify: { focus: () => {} },
        transfer: { dragFinished: () => {} },
    } as unknown as ModuleCtx;

    return { ctx, store, seat, sent, holdCalls };
}

function action(ctx: ModuleCtx, key: string, args: unknown[], win: WaylandWinId = winId) {
    const handler = waylandCoreModule.actions.get(key as never);
    if (!handler) throw new Error(`未声明动作 ${key}`);
    handler({ winId: win, args } as never, ctx);
}

describe("指针隐式 grab", () => {
    it("按住期间移出 surface 仍发 motion，坐标可为负", () => {
        const { ctx, store, seat, sent, holdCalls } = makeCtx();
        store.beginPointerGrab(seat, winId, surfaceId, InputEventCodes.BTN_LEFT, 1);

        action(ctx, "input.pointer", [{ type: "move", x: -5, y: 7, button: 0 }]);

        expect(holdCalls.at(-1)).toMatchObject({ win: winId, hold: surfaceId });
        expect(sent.find((e) => e.event === "wl_pointer.motion")?.args).toMatchObject({
            surface_x: -5,
            surface_y: 7,
        });
        expect(sent.some((e) => e.event === "wl_pointer.leave" || e.event === "wl_pointer.enter")).toBe(false);
    });

    it("按住期间再按其它键：先松一个不会结束 grab，全部松开才结束", () => {
        const { ctx, store, seat } = makeCtx();
        store.beginPointerGrab(seat, winId, surfaceId, InputEventCodes.BTN_LEFT, 1);

        action(ctx, "input.pointer", [{ type: "down", x: 0, y: 0, button: 2 }]);
        expect(seat.pointerGrab?.buttons).toEqual(new Set([InputEventCodes.BTN_LEFT, InputEventCodes.BTN_RIGHT]));

        action(ctx, "input.pointer", [{ type: "up", x: 0, y: 0, button: 0 }]);
        expect(seat.pointerGrab?.buttons).toEqual(new Set([InputEventCodes.BTN_RIGHT]));

        action(ctx, "input.pointer", [{ type: "up", x: 0, y: 0, button: 2 }]);
        expect(seat.pointerGrab?.buttons.size).toBe(0);
        expect(seat.pointerGrab?.serial).toBe(1);
    });

    it("grab 期间收到别的窗口：先补 release + leave，再按新窗口 enter", () => {
        const { ctx, store, seat, sent, holdCalls } = makeCtx();
        store.beginPointerGrab(seat, winId, surfaceId, InputEventCodes.BTN_LEFT, 1);

        action(ctx, "input.pointer", [{ type: "move", x: 3, y: 4, button: 0 }], otherWinId);

        const events = sent.map((e) => e.event);
        expect(events[0]).toBe("wl_pointer.button");
        expect(sent[0].args).toMatchObject({ button: InputEventCodes.BTN_LEFT, state: expect.any(Number) });
        expect(events).toContain("wl_pointer.leave");
        expect(events).toContain("wl_pointer.enter");
        expect(sent.find((e) => e.event === "wl_pointer.enter")?.args).toMatchObject({
            surface: otherSurfaceId,
        });
        expect(holdCalls.at(-1)).toMatchObject({ win: otherWinId });
        expect(seat.pointerFocus).toBe(otherSurfaceId);
        expect(seat.pointerGrab?.buttons.size).toBe(0);
    });

    it("surface 消失时结束以它为目标的 grab，并补 release", () => {
        const { ctx, store, seat, sent } = makeCtx();
        store.beginPointerGrab(seat, winId, surfaceId, InputEventCodes.BTN_LEFT, 1);

        endPointerGrabForSurfaces(ctx, [surfaceId]);

        const events = sent.filter((e) => e.event === "wl_pointer.button");
        expect(events).toHaveLength(1);
        expect(events[0].args).toMatchObject({ button: InputEventCodes.BTN_LEFT, state: 0 });
        expect(seat.pointerGrab?.buttons.size).toBe(0);
        expect(seat.pointerFocus).toBeNull();
    });

    it("只结束命中的 surface，别的 surface 上的 grab 保持不变", () => {
        const { ctx, store, seat } = makeCtx();
        store.beginPointerGrab(seat, winId, surfaceId, InputEventCodes.BTN_LEFT, 1);

        endPointerGrabForSurfaces(ctx, [otherSurfaceId]);

        expect(seat.pointerGrab?.buttons.size).toBe(1);
    });

    it("没有对应 down 的 up 丢弃，不改焦点", () => {
        const { ctx, seat, sent } = makeCtx();
        const before = seat.pointerFocus;

        action(ctx, "input.pointer", [{ type: "up", x: 0, y: 0, button: 0 }]);

        expect(sent).toEqual([]);
        expect(seat.pointerFocus).toBe(before);
    });

    it("重复 down 只发一次 pressed", () => {
        const { ctx, seat, sent } = makeCtx();

        action(ctx, "input.pointer", [{ type: "down", x: 0, y: 0, button: 0 }]);
        action(ctx, "input.pointer", [{ type: "down", x: 0, y: 0, button: 0 }]);

        expect(sent.filter((e) => e.event === "wl_pointer.button")).toHaveLength(1);
        expect(seat.pointerGrab?.buttons.size).toBe(1);
    });

    it("键盘补 enter 时带当前 pressedKeys 快照", () => {
        const { ctx, seat, sent } = makeCtx();
        seat.keyboardFocus = null;
        seat.pressedKeys.add(30);

        action(ctx, "input.key", [31, "pressed"]);

        const enter = sent.find((e) => e.event === "wl_keyboard.enter");
        expect(enter?.args).toMatchObject({ surface: surfaceId });
        expect([...(enter?.args.keys as Uint32Array)]).toEqual([30]);
    });

    it("键盘切到别的窗口：先 leave 旧 surface，再 enter 新 surface", () => {
        const { ctx, sent } = makeCtx();

        action(ctx, "input.key", [31, "pressed"], otherWinId);

        const events = sent.map((e) => e.event);
        expect(events.slice(0, 2)).toEqual(["wl_keyboard.leave", "wl_keyboard.enter"]);
        expect(sent[0].args.surface).toBe(surfaceId);
        expect(sent[1].args.surface).toBe(otherSurfaceId);
    });

    it("scroll 没有 pointer focus 时先补 enter，再发 axis", () => {
        const { ctx, seat, sent } = makeCtx();
        seat.pointerFocus = null;

        action(ctx, "input.scroll", [{ deltaX: 0, deltaY: 100, deltaZ: 0, source: "wheel" }]);

        const events = sent.map((e) => e.event);
        expect(events[0]).toBe("wl_pointer.enter");
        expect(events).toContain("wl_pointer.axis");
        expect(sent[0].args).toMatchObject({ surface: surfaceId });
        expect(seat.pointerFocus).toBe(surfaceId);
    });

    it("dnd.endLocal 用同一按钮码空间清空 grab", () => {
        const { ctx, store, seat } = makeCtx();
        store.beginPointerGrab(seat, winId, surfaceId, InputEventCodes.BTN_LEFT, 1);
        ctx.domain.dataDevice.drag = {
            dataDeviceId: 11 as WaylandObjectId2<"wl_data_device">,
            sourceId: 12 as WaylandObjectId2<"wl_data_source">,
            seatName: "seat0",
            surface: surfaceId,
            remoteDriven: true,
        };

        action(ctx, "dnd.endLocal", []);

        expect(seat.pointerGrab?.buttons.size).toBe(0);
        expect(ctx.domain.dataDevice.drag).toBeUndefined();
    });

    it("键盘 release 不覆盖 press：press 的 serial 在松键后仍可用于 move/grab", () => {
        const { ctx, store, seat, sent } = makeCtx();

        action(ctx, "input.key", [30, "pressed"]);
        const pressed = sent.find((e) => e.event === "wl_keyboard.key")?.args.serial as number;
        action(ctx, "input.key", [30, "released"]);
        const released = sent.filter((e) => e.event === "wl_keyboard.key").at(-1)?.args.serial as number;

        expect(store.isUserActionSerial(seat, pressed)).toBe(true);
        expect(store.isUserActionSerial(seat, released)).toBe(false);
    });
});

describe("xdg_toplevel 销毁时的 grab 收尾", () => {
    it("补发按住的按钮释放并清空 grab", () => {
        const sent: { id: number; event: string; args: Record<string, unknown> }[] = [];
        const store = new SeatStore();
        store.addSeat(seatId, "seat0");
        const seat = store.byName("seat0") as SeatRecord;
        seat.pointers.add(pointerId);
        seat.pointerFocus = surfaceId;
        seat.pointerGrab = {
            serial: 1,
            surface: surfaceId,
            winId,
            buttons: new Set([InputEventCodes.BTN_LEFT, InputEventCodes.BTN_RIGHT]),
        };
        let ctx: ModuleCtx;
        ctx = {
            objects: { has: (id: number) => id === pointerId || id === surfaceId },
            sendNow: (id: number, event: string, args: Record<string, unknown>) => sent.push({ id, event, args }),
            domain: {
                seat: store,
                serial: { next: () => 100 },
                dataDevice: { drag: undefined },
                xdgSurface: {
                    getXdgSurfaceByToplevel: () => 5,
                    getXdgSurfaceByWlSurface: () => 5,
                    rootXdgSurface: () => 5,
                    dismissGrabsForWindow: () => {},
                    toplevelDestroyed: () => {},
                },
                decoration: { forgetToplevel: () => {} },
                dialog: { forgetToplevel: () => {} },
                export: { forgetToplevel: () => [] },
                windows: { detachChildren: () => {}, remove: () => {}, notifyClosed: () => {} },
            },
            core: {
                forcePointerGrab: (seatName, reason) => {
                    const s = store.byName(seatName ?? "seat0");
                    if (s !== undefined) forcePointerGrab(ctx, s, reason ?? "cancel");
                },
                leavePointer: () => {},
                focusKeyboard: () => {},
            },
            client: { emit: () => {} },
        } as unknown as ModuleCtx;

        const handler = xdgShellModule.requests.get("xdg_toplevel.destroy" as never);
        if (!handler) throw new Error("未声明 xdg_toplevel.destroy");
        handler({ id: winId, args: {} } as never, ctx);

        expect(seat.pointerGrab?.buttons.size).toBe(0);
        expect(sent.filter((e) => e.event === "wl_pointer.button").map((e) => e.args.button)).toEqual([
            InputEventCodes.BTN_LEFT,
            InputEventCodes.BTN_RIGHT,
        ]);
    });
});

describe("popup 销毁时的 grab 清理", () => {
    it("grab 落在 popup 的 subsurface 上也会被结束", () => {
        const popupXdg = 300 as WaylandObjectId2<"xdg_surface">;
        const parentXdg = 301 as WaylandObjectId2<"xdg_surface">;
        const popupSurface = 400 as SurfaceId;
        const parentSurface = 402 as SurfaceId;
        const popupSub = 401 as SurfaceId;
        const popupId = 500 as WaylandObjectId2<"xdg_popup">;

        const store = new SeatStore();
        store.addSeat(seatId, "seat0");
        const seat = store.byName("seat0") as SeatRecord;
        seat.pointerFocus = popupSub;
        seat.pointerGrab = {
            winId,
            surface: popupSub,
            buttons: new Set([InputEventCodes.BTN_LEFT]),
            serial: 1,
        };
        const cleared: SurfaceId[][] = [];
        const ctx = {
            core: {
                surface: {
                    render: { createXdgSurfaceEle: () => {}, destroyXdgSurfaceEle: () => {} },
                    idScope: (id: unknown) => String(id),
                },
                subsurface: {
                    getChildrenDeep: (id: SurfaceId) =>
                        id === popupSurface ? [{ id: popupSub, offsetRect: { x: 0, y: 0, w: 0, h: 0 } }] : [],
                },
                endPointerGrabForSurfaces: (surfaces: Iterable<SurfaceId>) => cleared.push([...surfaces]),
                leavePointer: () => {},
                focusKeyboard: () => {},
            },
            domain: { seat: store },
            sendNow: () => {},
        } as unknown as ModuleCtx;

        const xdg = new xdgSurfaceData(ctx);
        xdg.addXdgSurface(parentXdg, parentSurface);
        xdg.addXdgSurface(popupXdg, popupSurface);
        xdg.setRelation(parentXdg, popupXdg);
        xdg.xdg_popup.set(popupId, popupXdg);

        xdg.popupDestroyed(popupId, ctx);

        expect(cleared).toEqual([[popupSub]]);
        expect(xdg.xdg_popup.has(popupId)).toBe(false);
    });
});
