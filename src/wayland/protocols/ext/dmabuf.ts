import { defineModule } from "../../module";
import { createFormatTableBuffer, DRM_FORMAT } from "../../utils/dma-buf";
import { newFd } from "../../utils/fd";

const fs = require("node:fs") as typeof import("node:fs");

import { getEnumValue } from "../../utils/wayland-proto";

/**
 * linux-dmabuf-v1
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
// 状态类型归本模块声明，不再登记 module.ts 的中央表（P3）
declare module "../../module" {
    interface WaylandDataRegistry {
        zwp_linux_buffer_params_v1: {
            planes: {
                fd: number;
                plane_idx: number;
                offset: number;
                stride: number;
                modifier_hi: number;
                modifier_lo: number;
            }[];
        };
    }
}

export const dmabufModule = defineModule({
    name: "linux-dmabuf-v1",
    requests: {
        "zwp_linux_dmabuf_v1.create_params": (x, ctx) => {
            const params = ctx.objects.get(x.args.params_id);
            params.data = { planes: [] };
        },
        "zwp_linux_dmabuf_v1.get_surface_feedback": (x, ctx) => {
            const feedbackId = x.args.id;
            ctx.send(feedbackId, "zwp_linux_dmabuf_feedback_v1.done", {});
        },
        "zwp_linux_dmabuf_v1.get_default_feedback": (x, ctx) => {
            const feedbackId = x.args.id;

            const formatTable = createFormatTableBuffer([
                { format: DRM_FORMAT.DRM_FORMAT_ARGB8888, modifier: 0n },
                { format: DRM_FORMAT.DRM_FORMAT_ABGR8888, modifier: 0n },
                { format: DRM_FORMAT.DRM_FORMAT_NV12, modifier: 0n },
                { format: DRM_FORMAT.DRM_FORMAT_NV16, modifier: 0n },
                { format: DRM_FORMAT.DRM_FORMAT_P010, modifier: 0n },
            ]);
            const { fd } = newFd(new Uint8Array(formatTable.buffer));
            ctx.send(feedbackId, "zwp_linux_dmabuf_feedback_v1.format_table", {
                fd: fd,
                size: formatTable.byteLength,
            });

            const r = fs.statSync("/dev/dri/renderD128"); // todo
            const buffer = Buffer.alloc(8);
            buffer.writeBigUInt64LE(BigInt(r.rdev));
            const a = new Uint8Array(buffer.buffer);
            ctx.send(feedbackId, "zwp_linux_dmabuf_feedback_v1.main_device", { device: a });

            ctx.send(feedbackId, "zwp_linux_dmabuf_feedback_v1.tranche_target_device", {
                device: a,
            });
            ctx.send(feedbackId, "zwp_linux_dmabuf_feedback_v1.tranche_formats", {
                indices: new Uint16Array([0, 1, 2, 3, 4]),
            });
            ctx.send(feedbackId, "zwp_linux_dmabuf_feedback_v1.tranche_flags", {
                flags: getEnumValue("zwp_linux_dmabuf_feedback_v1.tranche_flags", []),
            });
            ctx.send(feedbackId, "zwp_linux_dmabuf_feedback_v1.tranche_done", {});

            ctx.send(feedbackId, "zwp_linux_dmabuf_feedback_v1.done", {});
        },
        "zwp_linux_buffer_params_v1.add": (x, ctx) => {
            const params = ctx.objects.get(x.id);
            params.data.planes[x.args.plane_idx] = {
                fd: x.args.fd,
                plane_idx: x.args.plane_idx,
                offset: x.args.offset,
                stride: x.args.stride,
                modifier_hi: x.args.modifier_hi,
                modifier_lo: x.args.modifier_lo,
            };
        },
        "zwp_linux_buffer_params_v1.create_immed": (x, ctx) => {
            const params = ctx.objects.get(x.id);
            if (!params.data) {
                console.error("No planes data for create_immed");
                return;
            }
            const planes = params.data.planes;
            const bufferId = x.args.buffer_id;
            const buffer = ctx.objects.get(bufferId);
            buffer.data = { type: "dmabuf", planes, width: x.args.width, height: x.args.height, format: x.args.format };
        },
    },
});
