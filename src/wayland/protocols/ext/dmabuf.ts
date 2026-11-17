import { defineModule, type ModuleCtx, type WaylandObjectId2 } from "../../module";
import { createFormatTableBuffer, DRM_FORMAT } from "../../utils/dma-buf";
import { newFd } from "../../utils/fd";
import { getEnumValue } from "../../utils/wayland-proto";

const fs = require("node:fs") as typeof import("node:fs");

/**
 * linux-dmabuf-v1
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
// 状态类型归本模块声明（P3）
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

/**
 * 广播 Electron 能直接导入的格式（ARGB8888/ABGR8888 → bgra/rgba，以及视频格式），
 * 以及其余 32 位 RGB(A) 格式（XRGB/XBGR/RGBX/BGRX/RGBA/BGRA）。
 *
 * 不透明格式不能省：Mesa 的 EGL 平台实现了 `EGL_EXT_present_opaque`，客户端
 * （如 Blender）请求该属性时，`eglCreateWindowSurface` 会要求合成器同时广播
 * 透明格式对应的不透明格式，并且两者有共同的 modifier，否则直接返回
 * `EGL_BAD_MATCH`（Blender 的表现是启动即退出）。只给 wl_shm 的 xrgb8888 不够，
 * 那条路径没有 modifier，无法通过共同 modifier 检查。
 *
 * 需要转换的格式走 myde-drm 的 GPU 拷贝（默认路径本来就把 dmabuf 拷贝成 ARGB8888
 * 稳定副本），不需要额外的导入路径。
 */
const FEEDBACK_FORMATS = [
    DRM_FORMAT.DRM_FORMAT_ARGB8888,
    DRM_FORMAT.DRM_FORMAT_ABGR8888,
    DRM_FORMAT.DRM_FORMAT_XRGB8888,
    DRM_FORMAT.DRM_FORMAT_XBGR8888,
    DRM_FORMAT.DRM_FORMAT_RGBX8888,
    DRM_FORMAT.DRM_FORMAT_BGRX8888,
    DRM_FORMAT.DRM_FORMAT_RGBA8888,
    DRM_FORMAT.DRM_FORMAT_BGRA8888,
    DRM_FORMAT.DRM_FORMAT_NV12,
    DRM_FORMAT.DRM_FORMAT_NV16,
    DRM_FORMAT.DRM_FORMAT_P010,
];

/**
 * `zwp_linux_dmabuf_feedback_v1` 的一次完整下发。default 与 surface feedback 必须
 * 走同一份内容：v4/v5 客户端（Chromium 会用 surface feedback）拿不到 format_table
 * 时会认为没有可用格式，直接退回 wl_shm。
 */
function sendFeedback(ctx: ModuleCtx, feedbackId: WaylandObjectId2<"zwp_linux_dmabuf_feedback_v1">) {
    const formatTable = createFormatTableBuffer(FEEDBACK_FORMATS.map((format) => ({ format, modifier: 0n })));
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
        indices: new Uint16Array(FEEDBACK_FORMATS.map((_, index) => index)),
    });
    ctx.send(feedbackId, "zwp_linux_dmabuf_feedback_v1.tranche_flags", {
        flags: getEnumValue("zwp_linux_dmabuf_feedback_v1.tranche_flags", []),
    });
    ctx.send(feedbackId, "zwp_linux_dmabuf_feedback_v1.tranche_done", {});

    ctx.send(feedbackId, "zwp_linux_dmabuf_feedback_v1.done", {});
}

export const dmabufModule = defineModule({
    name: "linux-dmabuf-v1",
    requests: {
        "zwp_linux_dmabuf_v1.create_params": (x, ctx) => {
            const params = ctx.objects.get(x.args.params_id);
            params.data = { planes: [] };
        },
        "zwp_linux_dmabuf_v1.get_surface_feedback": (x, ctx) => {
            sendFeedback(ctx, x.args.id);
        },
        "zwp_linux_dmabuf_v1.get_default_feedback": (x, ctx) => {
            sendFeedback(ctx, x.args.id);
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
