import { describe, expect, it } from "vitest";
import { InputEventCodes } from "../../../input_codes/types";
import type { ModuleCtx, SeatRecord, SurfaceId, WaylandObjectId2, WaylandWinId } from "../../module";
import { xdgShellModule } from "../ext/xdg_shell";
import { SeatStore, waylandCoreModule } from "./wayland";

/**
 * 隐式 grab 的 core 单元测试：不启动 Wayland 连接，只验证路由、按钮码空间和清理。
 * 指针/键盘资源用假对象表，xdg 命中用一个记录 hold 参数的假实现。
 */

const seatId = 1 as WaylandObjectId2<"wl_seat">;
const pointerId = 2 as WaylandObjectId2<"wl_pointer">;
const keyboardId = 3 as WaylandObjectId2<"wl_keyboard">;
const surfaceId = 100 as SurfaceId;
const winId = 10 as WaylandWinId;

function makeCtx() {
    const sent: { id: number; event: string; args: Record<string, unknown> }[] = [];
    const data = new Map<number, unknown>([
        [pointerId, {}],
        [keyboardId, {}],
        [surfaceId, {}],
    ]);
    const store = new SeatStore();
    store.addSeat(seatId, "seat0");
    const seat = store.byName("seat0") as SeatRecord;
    seat.pointers.add(pointerId);
    seat.keyboards.add(keyboardId);
    seat.pointerFocus = surfaceId;
    seat.keyboardFocus = surfaceId;

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
                        surface: (hold ?? surfaceId) as SurfaceId,
                        xdgSurface: 200 as WaylandObjectId2<"xdg_surface">,
                        x: p.x,
                        y: p.y,
                        role: "main" as const,
                    };
                },
                dismissGrabsForPointer: () => {},
            },
        },
        notify: { focus: () => {} },
    } as unknown as ModuleCtx;

    return { ctx, store, seat, sent, holdCalls };
}

function action(ctx: ModuleCtx, key: string, args: unknown[]) {
    const handler = waylandCoreModule.actions.get(key as never);
    if (!handler) throw new Error(`未声明动作 ${key}`);
    handler({ winId, args } as never, ctx);
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
        seat.pointerGrab = {
            serial: 1,
            surface: surfaceId,
            winId,
            buttons: new Set([InputEventCodes.BTN_LEFT, InputEventCodes.BTN_RIGHT]),
        };
        const ctx = {
            objects: { has: (id: number) => id === pointerId },
            sendNow: (id: number, event: string, args: Record<string, unknown>) => sent.push({ id, event, args }),
            domain: {
                seat: store,
                serial: { next: () => 100 },
                xdgSurface: {
                    getXdgSurfaceByToplevel: () => 5,
                    dismissGrabsForWindow: () => {},
                    toplevelDestroyed: () => {},
                },
                decoration: { forgetToplevel: () => {} },
                dialog: { forgetToplevel: () => {} },
                export: { forgetToplevel: () => [] },
                windows: { detachChildren: () => {}, remove: () => {}, notifyClosed: () => {} },
            },
            client: { emit: () => {} },
        } as unknown as ModuleCtx;

        const handler = xdgShellModule.requests.get("xdg_toplevel.destroy" as never);
        if (!handler) throw new Error("未声明 xdg_toplevel.destroy");
        handler({ id: winId, args: {} } as never, ctx);

        expect(seat.pointerGrab).toBeUndefined();
        expect(sent.filter((e) => e.event === "wl_pointer.button").map((e) => e.args.button)).toEqual([
            InputEventCodes.BTN_LEFT,
            InputEventCodes.BTN_RIGHT,
        ]);
    });
});
