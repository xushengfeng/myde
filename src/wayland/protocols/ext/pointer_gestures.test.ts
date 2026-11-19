import { describe, expect, it } from "vitest";
import type { ModuleCtx, WaylandObjectId2 } from "../../module";
import { pointerGesturesModule } from "./pointer_gestures";

const pointer = 1 as WaylandObjectId2<"wl_pointer">;
const webPointer = 2 as WaylandObjectId2<"wl_pointer">;
const winId = 10 as WaylandObjectId2<"xdg_toplevel">;
const xdgSurfaceId = 11 as WaylandObjectId2<"xdg_surface">;
const surface = 12 as WaylandObjectId2<"wl_surface">;
const pinch = 30 as WaylandObjectId2<"zwp_pointer_gesture_pinch_v1">;
const swipe = 31 as WaylandObjectId2<"zwp_pointer_gesture_swipe_v1">;
const hold = 32 as WaylandObjectId2<"zwp_pointer_gesture_hold_v1">;

function setup() {
    const sent: { id: number; event: string; args: Record<string, unknown> }[] = [];
    let serial = 1;
    const pointerGestures = pointerGesturesModule.domain.pointerGestures?.(undefined as never);
    if (!pointerGestures) throw new Error("pointerGestures domain missing");
    const seat = {
        name: "seat0",
        pointers: new Set([pointer]),
        pointerFocus: surface,
        pointerPos: { x: 0, y: 0 },
        keyboards: new Set(),
        keyboardFocus: null,
        mods: new Set<number>(),
    };
    const ctx = {
        objects: {
            get: () => ({ protocol: {}, data: undefined, version: 3 }),
            has: (id: number) => id === surface,
        },
        sendNow: (id: number, event: string, args: Record<string, unknown>) => sent.push({ id, event, args }),
        core: { ensurePointerFocus: () => true },
        domain: {
            serial: { next: () => serial++ },
            seat: {
                byName: (name: string) => (name === "seat0" ? seat : undefined),
            },
            xdgSurface: {
                getXdgSurfaceByToplevel: (id: number) => (id === winId ? xdgSurfaceId : undefined),
                getXdgSurface: (id: number) => ({ surface: id === xdgSurfaceId ? surface : 0, xdg_role: winId }),
                getXdgSurfaceByWlSurface: (id: number) => (id === surface ? xdgSurfaceId : undefined),
                rootXdgSurface: (id: number) => id,
            },
            pointerGestures,
        },
    } as unknown as ModuleCtx;
    const action = pointerGesturesModule.actions.get("input.gesture");
    if (!action) throw new Error("input.gesture missing");
    return { sent, ctx, action };
}

describe("pointer-gestures", () => {
    it("creates gesture objects and sends pinch begin/update/end", () => {
        const { sent, ctx, action } = setup();
        pointerGesturesModule.requests.get("zwp_pointer_gestures_v1.get_pinch_gesture")?.(
            { args: { id: pinch, pointer }, id: 1 } as never,
            ctx,
        );
        pointerGesturesModule.requests.get("zwp_pointer_gestures_v1.get_swipe_gesture")?.(
            { args: { id: swipe, pointer: webPointer }, id: 1 } as never,
            ctx,
        );
        pointerGesturesModule.requests.get("zwp_pointer_gestures_v1.get_hold_gesture")?.(
            { args: { id: hold, pointer }, id: 1 } as never,
            ctx,
        );

        action({ winId, args: [{ type: "pinch", phase: "begin", fingers: 2 }] } as never, ctx);
        action(
            {
                winId,
                args: [{ type: "pinch", phase: "update", deltaX: 3, deltaY: -4, scale: 1.5, rotation: 12 }],
            } as never,
            ctx,
        );
        action({ winId, args: [{ type: "pinch", phase: "end", cancelled: false }] } as never, ctx);

        expect(sent.map((s) => s.event)).toEqual([
            "zwp_pointer_gesture_pinch_v1.begin",
            "zwp_pointer_gesture_pinch_v1.update",
            "zwp_pointer_gesture_pinch_v1.end",
        ]);
        expect(sent[0].args).toMatchObject({ surface, fingers: 2 });
        expect(sent[1].args).toMatchObject({ dx: 3, dy: -4, scale: 1.5, rotation: 12 });
        expect(sent[2].args).toMatchObject({ cancelled: 0 });
        // swipe 对象绑在另一个 pointer 上，不在 seat0，不能收到
        expect(sent.some((s) => s.id === swipe || s.id === hold)).toBe(false);
    });

    it("sends swipe and hold to gesture objects on the seat", () => {
        const { sent, ctx, action } = setup();
        pointerGesturesModule.requests.get("zwp_pointer_gestures_v1.get_swipe_gesture")?.(
            { args: { id: swipe, pointer }, id: 1 } as never,
            ctx,
        );
        pointerGesturesModule.requests.get("zwp_pointer_gestures_v1.get_hold_gesture")?.(
            { args: { id: hold, pointer }, id: 1 } as never,
            ctx,
        );

        action({ winId, args: [{ type: "swipe", phase: "begin", fingers: 4 }] } as never, ctx);
        action({ winId, args: [{ type: "swipe", phase: "update", deltaX: 10, deltaY: 20 }] } as never, ctx);
        action({ winId, args: [{ type: "swipe", phase: "end", cancelled: true }] } as never, ctx);
        action({ winId, args: [{ type: "hold", phase: "begin", fingers: 2 }] } as never, ctx);
        action({ winId, args: [{ type: "hold", phase: "end", cancelled: false }] } as never, ctx);

        expect(sent.map((s) => s.event)).toEqual([
            "zwp_pointer_gesture_swipe_v1.begin",
            "zwp_pointer_gesture_swipe_v1.update",
            "zwp_pointer_gesture_swipe_v1.end",
            "zwp_pointer_gesture_hold_v1.begin",
            "zwp_pointer_gesture_hold_v1.end",
        ]);
        expect(sent[0].args).toMatchObject({ surface, fingers: 4 });
        expect(sent[2].args).toMatchObject({ cancelled: 1 });
        expect(sent[3].args).toMatchObject({ fingers: 2 });
    });
});
