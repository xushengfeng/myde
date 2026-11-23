import { buildXkb } from "myde-xcb";
import type { ModuleCtx, SurfaceId, WaylandObjectId2 } from "../../module";
import { newFd } from "../../utils/fd";
import { getEnumValue } from "../../utils/wayland-proto";

/**
 * 原生输入事件出口：方法名和参数与 `wl_pointer` / `wl_keyboard` / `wl_touch` 事件一一对应。
 *
 * 这一层**不维护焦点**、不去重、不补事件；谁该 enter/leave、什么时候补 release
 * 由 `SeatStore` 上的状态机决定。所有 `wl_pointer.*` / `wl_keyboard.*` / `wl_touch.*` 事件都从这里发。
 */

export function pointerEnter(
    ctx: ModuleCtx,
    pointer: WaylandObjectId2<"wl_pointer">,
    serial: number,
    surface: SurfaceId,
    x: number,
    y: number,
    send: ModuleCtx["send"] = ctx.sendNow,
): void {
    const info = ctx.objects.getOption(pointer);
    if (info === undefined) return;
    ctx.objects.setData(pointer, { ...info.data, enterSerial: serial });
    send(pointer, "wl_pointer.enter", { serial, surface, surface_x: x, surface_y: y });
}

export function pointerLeave(
    ctx: ModuleCtx,
    pointer: WaylandObjectId2<"wl_pointer">,
    serial: number,
    surface: SurfaceId,
): void {
    ctx.sendNow(pointer, "wl_pointer.leave", { serial, surface });
}

export function pointerMotion(
    ctx: ModuleCtx,
    pointer: WaylandObjectId2<"wl_pointer">,
    time: number,
    x: number,
    y: number,
): void {
    ctx.sendNow(pointer, "wl_pointer.motion", { time, surface_x: x, surface_y: y });
}

export function pointerButton(
    ctx: ModuleCtx,
    pointer: WaylandObjectId2<"wl_pointer">,
    serial: number,
    time: number,
    button: number,
    state: "pressed" | "released",
): void {
    ctx.sendNow(pointer, "wl_pointer.button", {
        serial,
        time,
        button,
        state: getEnumValue("wl_pointer.button_state", state),
    });
}

export function pointerFrame(
    ctx: ModuleCtx,
    pointer: WaylandObjectId2<"wl_pointer">,
    send: ModuleCtx["send"] = ctx.sendNow,
): void {
    send(pointer, "wl_pointer.frame", {});
}

export function pointerAxisSource(ctx: ModuleCtx, pointer: WaylandObjectId2<"wl_pointer">, source: number): void {
    ctx.sendNow(pointer, "wl_pointer.axis_source", { axis_source: source });
}

export function pointerAxis(
    ctx: ModuleCtx,
    pointer: WaylandObjectId2<"wl_pointer">,
    time: number,
    axis: number,
    value: number,
): void {
    ctx.sendNow(pointer, "wl_pointer.axis", { time, axis, value });
}

export function pointerAxisDiscrete(
    ctx: ModuleCtx,
    pointer: WaylandObjectId2<"wl_pointer">,
    axis: number,
    discrete: number,
): void {
    ctx.sendNow(pointer, "wl_pointer.axis_discrete", { axis, discrete });
}

export function pointerAxisValue120(
    ctx: ModuleCtx,
    pointer: WaylandObjectId2<"wl_pointer">,
    axis: number,
    value120: number,
): void {
    ctx.sendNow(pointer, "wl_pointer.axis_value120", { axis, value120 });
}

export function pointerAxisStop(
    ctx: ModuleCtx,
    pointer: WaylandObjectId2<"wl_pointer">,
    time: number,
    axis: number,
): void {
    ctx.sendNow(pointer, "wl_pointer.axis_stop", { time, axis });
}

export function pointerAxisRelativeDirection(
    ctx: ModuleCtx,
    pointer: WaylandObjectId2<"wl_pointer">,
    axis: number,
    direction: number,
): void {
    ctx.sendNow(pointer, "wl_pointer.axis_relative_direction", { axis, direction });
}

export function touchDown(
    ctx: ModuleCtx,
    touch: WaylandObjectId2<"wl_touch">,
    serial: number,
    time: number,
    surface: SurfaceId,
    id: number,
    x: number,
    y: number,
    send: ModuleCtx["send"] = ctx.sendNow,
): void {
    send(touch, "wl_touch.down", { serial, time, surface, id, x, y });
}

export function touchUp(
    ctx: ModuleCtx,
    touch: WaylandObjectId2<"wl_touch">,
    serial: number,
    time: number,
    id: number,
): void {
    ctx.sendNow(touch, "wl_touch.up", { serial, time, id });
}

export function touchMotion(
    ctx: ModuleCtx,
    touch: WaylandObjectId2<"wl_touch">,
    time: number,
    id: number,
    x: number,
    y: number,
): void {
    ctx.sendNow(touch, "wl_touch.motion", { time, id, x, y });
}

export function touchFrame(ctx: ModuleCtx, touch: WaylandObjectId2<"wl_touch">): void {
    ctx.sendNow(touch, "wl_touch.frame", {});
}

export function touchCancel(ctx: ModuleCtx, touch: WaylandObjectId2<"wl_touch">): void {
    ctx.sendNow(touch, "wl_touch.cancel", {});
}

export function keyboardKeymap(
    ctx: ModuleCtx,
    keyboard: WaylandObjectId2<"wl_keyboard">,
    send: ModuleCtx["send"] = ctx.sendNow,
): void {
    const { fd, size } = newFd(buildXkb());
    send(keyboard, "wl_keyboard.keymap", {
        format: getEnumValue("wl_keyboard.keymap_format", "xkb_v1"),
        fd,
        size,
    });
}

export function keyboardRepeatInfo(
    ctx: ModuleCtx,
    keyboard: WaylandObjectId2<"wl_keyboard">,
    send: ModuleCtx["send"] = ctx.sendNow,
): void {
    send(keyboard, "wl_keyboard.repeat_info", { rate: 25, delay: 600 });
}

export function keyboardEnter(
    ctx: ModuleCtx,
    keyboard: WaylandObjectId2<"wl_keyboard">,
    serial: number,
    surface: SurfaceId,
    keys: Uint32Array,
    send: ModuleCtx["send"] = ctx.sendNow,
): void {
    send(keyboard, "wl_keyboard.enter", { serial, surface, keys });
}

export function keyboardLeave(
    ctx: ModuleCtx,
    keyboard: WaylandObjectId2<"wl_keyboard">,
    serial: number,
    surface: SurfaceId,
): void {
    ctx.sendNow(keyboard, "wl_keyboard.leave", { serial, surface });
}

export function keyboardKey(
    ctx: ModuleCtx,
    keyboard: WaylandObjectId2<"wl_keyboard">,
    serial: number,
    time: number,
    key: number,
    state: "pressed" | "released",
): void {
    ctx.sendNow(keyboard, "wl_keyboard.key", {
        serial,
        time,
        key,
        state: getEnumValue("wl_keyboard.key_state", state),
    });
}

export function keyboardModifiers(
    ctx: ModuleCtx,
    keyboard: WaylandObjectId2<"wl_keyboard">,
    serial: number,
    modsDepressed: number,
    send: ModuleCtx["send"] = ctx.sendNow,
): void {
    send(keyboard, "wl_keyboard.modifiers", {
        serial,
        mods_depressed: modsDepressed,
        mods_latched: 0,
        mods_locked: 0,
        group: 0,
    });
}
