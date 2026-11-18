import { defineModule, type ModuleCtx, type SeatRecord, type SurfaceId, type WaylandObjectId2 } from "../../module";
import type { WaylandInterfaces } from "../wayland-types";

/**
 * pointer-gestures-unstable-v1
 *
 * 触摸板语义手势：swipe / pinch / hold。手势对象挂在某个 wl_pointer 上，
 * 事件发给该 pointer 所属 seat 的焦点 surface（优先目标窗口内的指针焦点）。
 *
 * 桌面每帧只发一次 `input.gesture`，由这里补 serial / time / surface；
 * 同一把 seat 上同一种手势对象可能不止一个（Firefox 会在多份 registry 上重复绑定），
 * 每个都要收到。
 */
declare module "../../module" {
    interface WaylandDomainRegistry {
        pointerGestures: {
            /** 手势对象 → 创建它的 wl_pointer */
            swipe: Map<WaylandObjectId2<"zwp_pointer_gesture_swipe_v1">, WaylandObjectId2<"wl_pointer">>;
            pinch: Map<WaylandObjectId2<"zwp_pointer_gesture_pinch_v1">, WaylandObjectId2<"wl_pointer">>;
            hold: Map<WaylandObjectId2<"zwp_pointer_gesture_hold_v1">, WaylandObjectId2<"wl_pointer">>;
            /** 已经发过 begin、还没发 end 的对象 */
            activeSwipe: Set<WaylandObjectId2<"zwp_pointer_gesture_swipe_v1">>;
            activePinch: Set<WaylandObjectId2<"zwp_pointer_gesture_pinch_v1">>;
            activeHold: Set<WaylandObjectId2<"zwp_pointer_gesture_hold_v1">>;
        };
    }
}

function resolveSeat(ctx: ModuleCtx, name?: string): SeatRecord | undefined {
    const seat = ctx.domain.seat.byName(name ?? "seat0");
    if (seat === undefined) console.warn(`Unknown seat: ${String(name)}`);
    return seat;
}

/** 只发属于该 seat 的手势对象；pointer 已 release 的跳过。 */
function forGestureObjects<I extends WaylandInterfaces, O extends WaylandObjectId2<I>>(
    map: Map<O, WaylandObjectId2<"wl_pointer">>,
    seat: SeatRecord,
    fn: (id: O) => void,
): void {
    for (const [id, pointer] of map) {
        if (seat.pointers.has(pointer)) fn(id);
    }
}

function forEachActive<I extends WaylandInterfaces, O extends WaylandObjectId2<I>>(
    map: Map<O, WaylandObjectId2<"wl_pointer">>,
    active: Set<O>,
    seat: SeatRecord,
    fn: (id: O) => void,
): void {
    forGestureObjects(map, seat, (id) => {
        if (active.delete(id)) fn(id);
    });
}

function removeGesture<I extends WaylandInterfaces, O extends WaylandObjectId2<I>>(
    map: Map<O, WaylandObjectId2<"wl_pointer">>,
    active: Set<O>,
    id: O,
): void {
    map.delete(id);
    active.delete(id);
}

export const pointerGesturesModule = defineModule({
    name: "pointer_gestures_unstable_v1",
    globals: [{ name: "zwp_pointer_gestures_v1" }],
    domain: {
        pointerGestures: () => ({
            swipe: new Map(),
            pinch: new Map(),
            hold: new Map(),
            activeSwipe: new Set(),
            activePinch: new Set(),
            activeHold: new Set(),
        }),
    },
    requests: {
        "zwp_pointer_gestures_v1.get_swipe_gesture": (x, ctx) => {
            ctx.objects.get(x.args.pointer);
            ctx.domain.pointerGestures.swipe.set(x.args.id, x.args.pointer);
        },
        "zwp_pointer_gestures_v1.get_pinch_gesture": (x, ctx) => {
            ctx.objects.get(x.args.pointer);
            ctx.domain.pointerGestures.pinch.set(x.args.id, x.args.pointer);
        },
        "zwp_pointer_gestures_v1.get_hold_gesture": (x, ctx) => {
            ctx.objects.get(x.args.pointer);
            ctx.domain.pointerGestures.hold.set(x.args.id, x.args.pointer);
        },
        /** release 只销毁 manager；按协议，由它创建的手势对象仍然有效。 */
        "zwp_pointer_gestures_v1.release": () => {},
        "zwp_pointer_gesture_swipe_v1.destroy": (x, ctx) => {
            const domain = ctx.domain.pointerGestures;
            removeGesture(domain.swipe, domain.activeSwipe, x.id);
        },
        "zwp_pointer_gesture_pinch_v1.destroy": (x, ctx) => {
            const domain = ctx.domain.pointerGestures;
            removeGesture(domain.pinch, domain.activePinch, x.id);
        },
        "zwp_pointer_gesture_hold_v1.destroy": (x, ctx) => {
            const domain = ctx.domain.pointerGestures;
            removeGesture(domain.hold, domain.activeHold, x.id);
        },
    },
    actions: {
        "input.gesture": (msg, ctx) => {
            const [ev, seatName] = msg.args;
            const seat = resolveSeat(ctx, seatName);
            if (seat === undefined) return;
            // 桌面已经按指针落点选中了窗口；优先用该窗口内的指针焦点（popup / 子 surface），
            // 焦点缺失或停在别的窗口时退回窗口主 surface。
            const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByToplevel(msg.winId);
            if (xdgSurfaceId === undefined) return;
            const xdg = ctx.domain.xdgSurface;
            let surface: SurfaceId = xdg.getXdgSurface(xdgSurfaceId).surface;
            if (seat.pointerFocus !== null) {
                const focus = seat.pointerFocus;
                const focusXdg = xdg.getXdgSurfaceByWlSurface(focus);
                if (focusXdg !== undefined && xdg.getXdgSurface(xdg.rootXdgSurface(focusXdg)).xdg_role === msg.winId) {
                    surface = focus;
                }
            }
            if (!ctx.objects.has(surface)) return;
            const domain = ctx.domain.pointerGestures;
            const time = Date.now();

            if (ev.type === "swipe") {
                if (ev.phase === "begin") {
                    const serial = ctx.domain.seat.nextSerial();
                    forGestureObjects(domain.swipe, seat, (id) => {
                        // 目标窗口在手势中途关闭时可能收不到 end；下一次 begin 先把旧序列取消
                        if (domain.activeSwipe.delete(id)) {
                            ctx.sendNow(id, "zwp_pointer_gesture_swipe_v1.end", {
                                serial: ctx.domain.seat.nextSerial(),
                                time,
                                cancelled: 1,
                            });
                        }
                        domain.activeSwipe.add(id);
                        ctx.sendNow(id, "zwp_pointer_gesture_swipe_v1.begin", {
                            serial,
                            time,
                            surface,
                            fingers: ev.fingers,
                        });
                    });
                    return;
                }
                if (ev.phase === "update") {
                    forGestureObjects(domain.swipe, seat, (id) => {
                        if (!domain.activeSwipe.has(id)) return;
                        ctx.sendNow(id, "zwp_pointer_gesture_swipe_v1.update", {
                            time,
                            dx: ev.deltaX,
                            dy: ev.deltaY,
                        });
                    });
                    return;
                }
                {
                    const serial = ctx.domain.seat.nextSerial();
                    forEachActive(domain.swipe, domain.activeSwipe, seat, (id) => {
                        ctx.sendNow(id, "zwp_pointer_gesture_swipe_v1.end", {
                            serial,
                            time,
                            cancelled: ev.cancelled === true ? 1 : 0,
                        });
                    });
                }
                return;
            }

            if (ev.type === "pinch") {
                if (ev.phase === "begin") {
                    const serial = ctx.domain.seat.nextSerial();
                    forGestureObjects(domain.pinch, seat, (id) => {
                        if (domain.activePinch.delete(id)) {
                            ctx.sendNow(id, "zwp_pointer_gesture_pinch_v1.end", {
                                serial: ctx.domain.seat.nextSerial(),
                                time,
                                cancelled: 1,
                            });
                        }
                        domain.activePinch.add(id);
                        ctx.sendNow(id, "zwp_pointer_gesture_pinch_v1.begin", {
                            serial,
                            time,
                            surface,
                            fingers: ev.fingers,
                        });
                    });
                    return;
                }
                if (ev.phase === "update") {
                    forGestureObjects(domain.pinch, seat, (id) => {
                        if (!domain.activePinch.has(id)) return;
                        ctx.sendNow(id, "zwp_pointer_gesture_pinch_v1.update", {
                            time,
                            dx: ev.deltaX,
                            dy: ev.deltaY,
                            scale: ev.scale,
                            rotation: ev.rotation,
                        });
                    });
                    return;
                }
                {
                    const serial = ctx.domain.seat.nextSerial();
                    forEachActive(domain.pinch, domain.activePinch, seat, (id) => {
                        ctx.sendNow(id, "zwp_pointer_gesture_pinch_v1.end", {
                            serial,
                            time,
                            cancelled: ev.cancelled === true ? 1 : 0,
                        });
                    });
                }
                return;
            }

            if (ev.phase === "begin") {
                const serial = ctx.domain.seat.nextSerial();
                forGestureObjects(domain.hold, seat, (id) => {
                    if (domain.activeHold.delete(id)) {
                        ctx.sendNow(id, "zwp_pointer_gesture_hold_v1.end", {
                            serial: ctx.domain.seat.nextSerial(),
                            time,
                            cancelled: 1,
                        });
                    }
                    domain.activeHold.add(id);
                    ctx.sendNow(id, "zwp_pointer_gesture_hold_v1.begin", {
                        serial,
                        time,
                        surface,
                        fingers: ev.fingers,
                    });
                });
                return;
            }
            {
                const serial = ctx.domain.seat.nextSerial();
                forEachActive(domain.hold, domain.activeHold, seat, (id) => {
                    ctx.sendNow(id, "zwp_pointer_gesture_hold_v1.end", {
                        serial,
                        time,
                        cancelled: ev.cancelled === true ? 1 : 0,
                    });
                });
            }
        },
    },
});
