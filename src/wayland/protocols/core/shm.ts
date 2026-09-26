import { defineModule, type WaylandObjectId2 } from "../../module";
import { getEnumValue } from "../../utils/wayland-proto";

/**
 * wl_shm
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
export const shmModule = defineModule({
    name: "wl_shm",
    globals: [
        {
            name: "wl_shm",
            version: 1,
            onBind: (msg, ctx) => {
                const id = msg.id as WaylandObjectId2<"wl_shm">;
                ctx.send(id, "wl_shm.format", { format: getEnumValue("wl_shm.format", "argb8888") });
                ctx.send(id, "wl_shm.format", { format: getEnumValue("wl_shm.format", "xrgb8888") });
            },
        },
    ],
    requests: {
        "wl_shm.create_pool": (x, ctx) => {
            const fd = x.args.fd;
            ctx.objects.get(x.args.id).data = { fd };
        },
        "wl_shm_pool.create_buffer": (x, ctx) => {
            const thisObj = ctx.objects.get(x.id);
            const buffer = ctx.objects.get(x.args.id);
            const imageData = new ImageData(x.args.width, x.args.height);
            buffer.data = {
                type: "shm",
                fd: thisObj.data.fd,
                offset: x.args.offset,
                stride: x.args.stride,
                imageData: imageData,
            };
        },
    },
});
