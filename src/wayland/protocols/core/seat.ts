import { buildXkb } from "myde-xcb";
import { defineModule } from "../../module";
import { newFd } from "../../utils/fd";
import { getEnumValue } from "../../utils/wayland-proto";

/**
 * wl_seat
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
export const seatModule = defineModule({
    name: "wl_seat",
    requests: {
        "wl_seat.get_pointer": (x, ctx) => {
            const pointerId = x.args.id;
            const seat = ctx.state.seat.get(x.id);
            if (!seat) {
                console.warn(`Seat ${x.id} not found for get_pointer`);
                return;
            }
            seat.pointer = pointerId;
        },
        "wl_seat.get_keyboard": (x, ctx) => {
            const keyboardId = x.args.id;
            const seat = ctx.state.seat.get(x.id);
            if (!seat) {
                console.warn(`Seat ${x.id} not found for get_keyboard`);
                return;
            }
            seat.keyboard = keyboardId;
            ctx.send(keyboardId, "wl_keyboard.repeat_info", {
                rate: 25,
                delay: 600,
            });

            const keymapStr = buildXkb();
            const { fd, size } = newFd(keymapStr);

            ctx.send(keyboardId, "wl_keyboard.keymap", {
                format: getEnumValue("wl_keyboard.keymap_format", "xkb_v1"),
                fd: fd,
                size: size,
            });
        },
    },
});
