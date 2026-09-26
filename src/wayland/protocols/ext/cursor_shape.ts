import { defineModule } from "../../module";
import { getEnumName } from "../../utils/wayland-proto";

/**
 * cursor-shape
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
// 状态类型归本模块声明，不再登记 module.ts 的中央表（P3）
declare module "../../module" {
    interface WaylandDataRegistry {
    wp_cursor_shape_device_v1: {
        // 绑定的指针设备，目前只有 wl_pointer
        pointer: WaylandObjectId2<"wl_pointer">;
    };
    }
}

export const cursorShapeModule = defineModule({
    name: "cursor-shape",
    requests: {
        "wp_cursor_shape_manager_v1.get_pointer": (x, ctx) => {
            ctx.objects.get(x.args.cursor_shape_device).data = { pointer: x.args.pointer };
        },
        "wp_cursor_shape_device_v1.set_shape": (x, ctx) => {
            // todo serial 校验wl_pointer.enter的serial，不匹配时忽略
            const shape = getEnumName("wp_cursor_shape_device_v1.shape", x.args.shape);
            if (!shape) {
                ctx.postError("wp_cursor_shape_device_v1", x.id, "invalid_shape", `Invalid shape ${x.args.shape}`);
                return;
            }
            // 语义光标替换之前的surface光标（与wl_pointer.set_cursor混用，后到者生效）
            ctx.state.cursor.setShape(shape);
        },
    },
});
