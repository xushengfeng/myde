import { defineModule, type WaylandObjectId2 } from "../../module";
import { getEnumValue } from "../../utils/wayland-proto";

/**
 * wl_output：目前硬编码单路输出（readme 已注明还没有硬件处理）。
 *
 * 本模块没有请求，只有绑定时的自报——这正是 globals[].onBind 存在的理由：
 * 原先这类初始化散在 wl_registry.bind 的 if 链里，新增 global 必须改中枢。
 */
export const outputModule = defineModule({
    name: "wl_output",
    globals: [
        {
            name: "wl_output",
            version: 1,
            onBind: (msg, ctx) => {
                const id = msg.id as WaylandObjectId2<"wl_output">;
                ctx.send(id, "wl_output.name", { name: "output0" });
                ctx.send(id, "wl_output.description", { description: "Output 0" });
                ctx.send(id, "wl_output.mode", {
                    width: 1920,
                    height: 1080,
                    refresh: 60000,
                    flags: getEnumValue("wl_output.mode", "current"),
                });
                ctx.send(id, "wl_output.geometry", {
                    x: 0,
                    y: 0,
                    physical_width: 344,
                    physical_height: 194,
                    make: "",
                    model: "",
                    subpixel: getEnumValue("wl_output.subpixel", "unknown"),
                    transform: getEnumValue("wl_output.transform", "normal"),
                });
                ctx.send(id, "wl_output.done", {});
            },
        },
    ],
});
