import { defineModule } from "../../module";
import { DRM_FORMAT } from "../../utils/dma-buf";
import { importSharedTexture } from "../../utils/shared_texture";

const fs = require("node:fs") as typeof import("node:fs");

import { waylandObjectId } from "../../utils/wayland-proto";

/**
 * wl_surface
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
// 状态类型归本模块声明（P3）
declare module "../../module" {
    interface WaylandDataRegistry {
        wl_surface: {
            canvas: OffscreenCanvas;
            current: WaylandSurfaceData;
            pending: WaylandSurfaceData;
        };
    }
}

export const surfaceModule = defineModule({
    name: "wl_surface",
    requests: {
        "wl_surface.attach": (x, ctx) => {
            const surface = ctx.objects.get(x.id);
            const bufferId = waylandObjectId(x.args.buffer, "wl_buffer");
            // todo attach(null)应该unmap，commit后视为无内容（如隐藏光标surface）
            if (!bufferId) return;
            surface.data.pending.buffer = { id: bufferId };
        },
        "wl_surface.damage": (x, ctx) => {
            const surface = ctx.objects.get(x.id);
            const damageList = surface.data.pending.damageList || [];
            damageList.push({
                x: x.args.x,
                y: x.args.y,
                width: x.args.width,
                height: x.args.height,
            });
            surface.data.pending.damageList = damageList;
        },
        "wl_surface.damage_buffer": (x, ctx) => {
            const surface = ctx.objects.get(x.id);
            const damageBufferList = surface.data.pending.damageBufferList || [];
            damageBufferList.push({
                x: x.args.x,
                y: x.args.y,
                width: x.args.width,
                height: x.args.height,
            });
            surface.data.pending.damageBufferList = damageBufferList;
        },
        "wl_surface.frame": (x, ctx) => {
            const callbackId = x.args.callback;
            const surface = ctx.objects.get(x.id);
            surface.data.pending.callback = callbackId;
        },
        "wl_surface.commit": async (x, ctx) => {
            const surfaceId = x.id;
            const surface = ctx.objects.get(surfaceId);
            const data = surface.data.pending;
            surface.data.current = Object.assign({}, surface.data.current, data);
            surface.data.pending = {};
            const canvas = surface.data.canvas;
            // biome-ignore lint/style/noNonNullAssertion: 忽略小概率
            const c2d = canvas.getContext("2d")!;
            const buffer = data.buffer;
            const bufferId = buffer?.id;
            const bufferObj = ctx.objects.getOption(bufferId)?.data;
            if (!bufferObj) {
            } else {
                let image: ImageData | VideoFrame;
                if (bufferObj.type === "shm") {
                    image = bufferObj.imageData;

                    const buffern = new Uint8ClampedArray(bufferObj.stride * image.height);
                    try {
                        fs.readSync(bufferObj.fd, buffern, 0, buffern.length, bufferObj.offset);
                    } catch (error) {
                        console.error("Error reading shm buffer:", error);
                    }
                    // todo 模块读取
                    const rgba = new Uint8ClampedArray(image.width * image.height * 4);
                    for (let y = 0; y < image.height; y++) {
                        for (let x = 0; x < image.width; x++) {
                            const ri = y * bufferObj.stride + x * 4;
                            const i = (y * image.width + x) * 4;
                            rgba[i] = buffern[ri + 2];
                            rgba[i + 1] = buffern[ri + 1];
                            rgba[i + 2] = buffern[ri];
                            rgba[i + 3] = buffern[ri + 3];
                        }
                    }

                    image.data.set(rgba);
                } else {
                    const modifierX = bufferObj.planes[0];
                    const modifier = (modifierX.modifier_hi << 32) | modifierX.modifier_lo;

                    const format =
                        bufferObj.format === DRM_FORMAT.DRM_FORMAT_ARGB8888
                            ? "bgra"
                            : bufferObj.format === DRM_FORMAT.DRM_FORMAT_ABGR8888
                              ? "rgba"
                              : bufferObj.format === DRM_FORMAT.DRM_FORMAT_NV12
                                ? "nv12"
                                : bufferObj.format === DRM_FORMAT.DRM_FORMAT_NV16
                                  ? "nv16"
                                  : bufferObj.format === DRM_FORMAT.DRM_FORMAT_P010
                                    ? "p010le"
                                    : "bgra";

                    const t = await importSharedTexture({
                        textureInfo: {
                            handle: {
                                nativePixmap: {
                                    planes: bufferObj.planes.map((p) => ({
                                        stride: p.stride,
                                        offset: p.offset,
                                        size: p.stride * bufferObj.height,
                                        fd: p.fd,
                                    })),
                                    modifier: modifier.toString(),
                                    supportsZeroCopyWebGpuImport: true,
                                },
                            },
                            codedSize: { height: bufferObj.height, width: bufferObj.width },
                            pixelFormat: format,
                        },
                    });

                    image = t.getVideoFrame();
                    t.release();
                }
                let width = 0,
                    height = 0;
                if (image instanceof VideoFrame) {
                    width = image.codedWidth;
                    height = image.codedHeight;
                } else {
                    width = image.width;
                    height = image.height;
                }
                const sizeChanged = width !== canvas.width || height !== canvas.height;
                if (sizeChanged) {
                    canvas.width = width;
                    canvas.height = height;
                    ctx.core.surface.updateWlSurfaceSize(surfaceId, width, height);
                }
                // buffer 已应用、像素尚未合成：交给扩展（xdg 在此按尺寸变化发 configure）
                ctx.notify.commit(surfaceId, sizeChanged);

                const damageList = [...(data.damageList || []), ...(data.damageBufferList || [])];
                // todo 有区别，但现在先不处理
                if (damageList.length) {
                    for (const damage of damageList) {
                        const dw = Math.min(canvas.width, damage.width);
                        const dh = Math.min(canvas.height, damage.height);
                        if (image instanceof VideoFrame) {
                            c2d.clearRect(damage.x, damage.y, dw, dh);
                            c2d.drawImage(image, damage.x, damage.y, dw, dh, damage.x, damage.y, dw, dh);
                        } else c2d.putImageData(image, 0, 0, damage.x, damage.y, dw, dh);
                    }
                } else {
                    if (image instanceof VideoFrame) {
                        c2d.drawImage(image, 0, 0, canvas.width, canvas.height);
                    } else c2d.putImageData(image, 0, 0);
                }
                if (image instanceof VideoFrame) {
                    image.close();
                }
                // 像素已合成、渲染之前交给扩展后处理（viewporter 的裁剪缩放）
                const fcanvas = ctx.notify.frame(surfaceId, canvas, data);
                ctx.core.surface.renderWlSurface(surfaceId, fcanvas);

                // 只有当前光标surface才推送光标，隐藏后commit不应重新显示
                ctx.state.cursor.updateFrame(surfaceId, fcanvas);
            }

            requestAnimationFrame(() => {
                const bufferId = data.buffer?.id;
                if (bufferId) {
                    ctx.sendNow(bufferId, "wl_buffer.release", {});
                }
                const x = data.callback;
                if (x) {
                    ctx.sendNow(x, "wl_callback.done", { callback_data: Date.now() });
                    ctx.sendNow(ctx.client.displayId, "wl_display.delete_id", {
                        id: x,
                    });
                }
            });
        },
        "wl_surface.destroy": (x, ctx) => {
            const surfaceId = x.id;
            // 光标surface销毁后隐藏光标
            ctx.state.cursor.hide(surfaceId);
            ctx.notify.destroy(surfaceId);
            ctx.core.surface.destroyWlSurface(surfaceId);
            // todo 相关的如subsurface、xdgsurface等
        },
        "wl_surface.set_input_region": (x, ctx) => {
            const surface = ctx.objects.get(x.id);
            console.error("re", x.args);
            const region = ctx.objects.getOption(waylandObjectId(x.args.region, "wl_region"));
            surface.data.pending.inputRegion = region?.data.rects;
        },
        "wl_surface.offset": (x, ctx) => {
            ctx.core.surface.setWlSurfaceOffset(x.id, x.args.x, x.args.y);
        },
    },
});
