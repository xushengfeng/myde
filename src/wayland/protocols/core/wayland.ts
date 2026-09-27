import { InputEventCodes } from "../../../input_codes/types";
import type { PointerCommand, ScrollCommand } from "../../api";
import { defineModule, type HitTestResult, type ModuleCtx, type SurfaceId, type WaylandObjectId2 } from "../../module";
import type { WaylandName, WaylandProtocol } from "../../utils/wayland-binary";
import { getEnumValue, tryX, waylandObjectId } from "../../utils/wayland-proto";

const fs = require("node:fs") as typeof import("node:fs");

import { buildXkb } from "myde-xcb";
import { DRM_FORMAT } from "../../utils/dma-buf";
import { newFd } from "../../utils/fd";
import { importSharedTexture } from "../../utils/shared_texture";

declare module "../../module" {
    interface WaylandDataRegistry {
        wl_shm_pool: { fd: number };
        wl_buffer:
            | { type: "shm"; fd: number; offset: number; stride: number; imageData: ImageData }
            | {
                  type: "dmabuf";
                  planes: {
                      fd: number;
                      plane_idx: number;
                      offset: number;
                      stride: number;
                      modifier_hi: number;
                      modifier_lo: number;
                  }[];
                  width: number;
                  height: number;
                  format: number;
              };
    }
}
declare module "../../module" {
    interface WaylandDataRegistry {
        wl_data_source: { offers: string[] };
    }
}

declare module "../../module" {
    interface WaylandDataRegistry {
        wl_surface: {
            canvas: OffscreenCanvas;
            current: WaylandSurfaceData;
            pending: WaylandSurfaceData;
        };
    }
}

declare module "../../module" {
    interface WaylandDataRegistry {
        wl_region: {
            rects: { x: number; y: number; width: number; height: number; type: "+" | "-" }[];
        };
    }
}

// ───────────── 桌面命令（actions）：组包、serial、状态维护都在这里，host 只做派发 ─────────────

/** 修饰键 → xkb modifiers 位（`wl_keyboard.modifiers` 的掩码来源） */
const MOD_KEY_TO_BIT: { [k: number]: number } = {
    [InputEventCodes.KEY_LEFTSHIFT]: 0, // Shift -> bit 0
    [InputEventCodes.KEY_RIGHTSHIFT]: 0,
    [InputEventCodes.KEY_CAPSLOCK]: 1, // CapsLock -> bit 1
    [InputEventCodes.KEY_LEFTCTRL]: 2, // Ctrl -> bit 2
    [InputEventCodes.KEY_RIGHTCTRL]: 2,
    [InputEventCodes.KEY_LEFTALT]: 3, // Alt -> bit 3
    [InputEventCodes.KEY_RIGHTALT]: 3,
    [InputEventCodes.KEY_LEFTMETA]: 4, // Meta/Super -> bit 4
    [InputEventCodes.KEY_RIGHTMETA]: 4,
};

/** 键盘焦点：enter 时按协议补一份 modifiers，并通知 text-input 等扩展 */
function keyboardFocus(ctx: ModuleCtx, surface: SurfaceId): void {
    for (const k of ctx.state.seat.keyboards()) {
        ctx.sendNow(k, "wl_keyboard.enter", { serial: 0, surface: surface, keys: new Uint32Array([]) });
        ctx.sendNow(k, "wl_keyboard.modifiers", {
            serial: 0,
            mods_depressed: 0,
            mods_latched: 0,
            mods_locked: 0,
            group: 0,
        });
    }
    ctx.notify.focus(surface);
}

function keyboardBlur(ctx: ModuleCtx, surface: SurfaceId): void {
    for (const k of ctx.state.seat.keyboards()) ctx.sendNow(k, "wl_keyboard.leave", { serial: 0, surface: surface });
    ctx.notify.focus(undefined);
}

/**
 * 指针焦点转移：命中 surface 变了才发 leave/enter，键盘焦点按角色跟不跟（popup 不抢键盘）。
 * 与几何命中检测分开——`ctx.hitTest` 是纯几何（host），这里只剩协议动作。
 */
function updatePointerFocus(ctx: ModuleCtx, hit: HitTestResult): void {
    const prevFocus = ctx.state.seat.focus();
    const prevFocusType = ctx.state.seat.focusType();
    if (prevFocus === hit.surface) return;
    if (prevFocus && ctx.objects.has(prevFocus)) {
        for (const p of ctx.state.seat.pointers())
            ctx.sendNow(p, "wl_pointer.leave", { serial: 0, surface: prevFocus });
        if (prevFocusType === "main" && hit.role === "main") keyboardBlur(ctx, prevFocus); // todo popup
    }
    for (const p of ctx.state.seat.pointers()) {
        ctx.sendNow(p, "wl_pointer.enter", {
            serial: 0,
            surface: hit.surface,
            surface_x: hit.x,
            surface_y: hit.y,
        });
        ctx.sendNow(p, "wl_pointer.frame", {});
    }
    if ((prevFocusType === "main" || !prevFocusType) && hit.role === "main") keyboardFocus(ctx, hit.surface);
    ctx.state.seat.setFocus(hit.surface, hit.role);
}

/** 指针事件注入：坐标已由 hitTest 归一到 surface 局部 */
function sendPointer(ctx: ModuleCtx, ev: PointerCommand, hit: HitTestResult): void {
    const { x: nx, y: ny } = hit;
    if (ev.type === "move") {
        for (const p of ctx.state.seat.pointers()) {
            ctx.sendNow(p, "wl_pointer.motion", { time: Date.now(), surface_x: nx, surface_y: ny });
            ctx.sendNow(p, "wl_pointer.frame", {});
        }
        return;
    }
    const button =
        ev.button === 0
            ? InputEventCodes.BTN_LEFT
            : ev.button === 1
              ? InputEventCodes.BTN_MIDDLE
              : ev.button === 2
                ? InputEventCodes.BTN_RIGHT
                : InputEventCodes.BTN_LEFT;
    for (const pointer of ctx.state.seat.pointers()) {
        ctx.sendNow(pointer, "wl_pointer.button", {
            serial: 0,
            time: Date.now(),
            button,
            state: getEnumValue("wl_pointer.button_state", ev.type === "down" ? "pressed" : "released"),
        });
        ctx.sendNow(pointer, "wl_pointer.frame", {});
    }
}

/** 按键注入；修饰键变化时按掩码补发 `wl_keyboard.modifiers`（todo repeat） */
function sendKey(ctx: ModuleCtx, key: number, state: "pressed" | "released"): void {
    const s = ctx.state.seat.nextSerial();
    for (const k of ctx.state.seat.keyboards())
        ctx.sendNow(k, "wl_keyboard.key", {
            serial: s,
            time: Date.now(),
            key: key,
            state: getEnumValue("wl_keyboard.key_state", state),
        });

    const bit = MOD_KEY_TO_BIT[key];
    if (bit === undefined) return;
    const seat = ctx.state.seat;
    if (state === "pressed") seat.addModifier(bit);
    else seat.removeModifier(bit);

    for (const k of seat.keyboards()) {
        ctx.sendNow(k, "wl_keyboard.modifiers", {
            serial: s,
            mods_depressed: seat.modifierMask(),
            mods_latched: 0, // todo not tracking latched in this implementation
            mods_locked: 0, // todo not tracking locked separately here
            group: 0,
        });
    }
}

/** 滚轮注入（todo region） */
function sendScroll(ctx: ModuleCtx, ev: ScrollCommand): void {
    const { deltaX, deltaY } = ev;
    if (deltaX !== 0) {
        for (const pointer of ctx.state.seat.pointers())
            ctx.sendNow(pointer, "wl_pointer.axis", {
                time: Date.now(),
                axis: getEnumValue("wl_pointer.axis", "horizontal_scroll"),
                value: deltaX,
            });
    }
    if (deltaY !== 0) {
        for (const pointer of ctx.state.seat.pointers())
            ctx.sendNow(pointer, "wl_pointer.axis", {
                time: Date.now(),
                axis: getEnumValue("wl_pointer.axis", "vertical_scroll"),
                value: deltaY,
            });
    }
    for (const pointer of ctx.state.seat.pointers()) ctx.sendNow(pointer, "wl_pointer.frame", {});
}

/** 把剪贴板内容 offer 给该客户端的每个 data_device */
function offerTo(ctx: ModuleCtx): void {
    const dd = ctx.client.state.dataDevices;
    if (!dd) console.error("No data devices to offer to");
    for (const ddId of dd ?? []) {
        const dataOfferId = ctx.objects.create("wl_data_offer");
        ctx.sendNow(ddId, "wl_data_device.data_offer", { id: dataOfferId });
        ctx.sendNow(dataOfferId, "wl_data_offer.offer", { mime_type: "text/plain;charset=utf-8" });
        ctx.sendNow(dataOfferId, "wl_data_offer.offer", { mime_type: "text/plain" });
        ctx.sendNow(ddId, "wl_data_device.selection", { id: dataOfferId });
    }
}

export const waylandCoreModule = defineModule({
    name: "wayland",
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
        {
            name: "wl_seat",
            version: 1,
            onBind: (msg, ctx) => {
                const id = msg.id as WaylandObjectId2<"wl_seat">;
                ctx.state.seat.addSeat(id);
                ctx.send(id, "wl_seat.name", { name: "seat0" });
                ctx.send(id, "wl_seat.capabilities", {
                    capabilities: getEnumValue("wl_seat.capability", ["pointer", "keyboard"]),
                });
            },
        },
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
    requests: {
        "wl_display.sync": (x, ctx) => {
            const callbackId = x.args.callback;
            ctx.sendNow(ctx.client.displayId, "wl_display.delete_id", { id: callbackId });

            ctx.send(callbackId, "wl_callback.done", { callback_data: 0 });
        },
        "wl_display.get_registry": (x, ctx) => {
            const registryId = x.args.registry;
            for (const { name, protocol } of ctx.core.registry.globals()) {
                ctx.send(registryId, "wl_registry.global", {
                    name,
                    interface: protocol.name,
                    version: protocol.version,
                });
            }
        },
        "wl_registry.bind": (x, ctx) => {
            const name = x.args.name as WaylandName;
            const proto: WaylandProtocol | undefined = ctx.core.registry.byName(name);
            if (!proto) {
                console.warn(`Unknown global name: ${name}`);
                return;
            }
            ctx.objects.bind({ name, id: x.args.id, protocol: proto });
            // 注意：协议元数据里 bind 只有 name/id 两个参数，没有 version，
            // 所以这里记到的始终是 undefined（勿当成已生效的版本记录）
            // 值恒为 undefined，用 0 兜底仅为了匹配 Map<string, number> 的类型（falsy 语义与 undefined 相同）
            ctx.client.protoVersions.set(proto.name, (x.args as unknown as { _version?: number })._version ?? 0);
            console.log(`Client ${ctx.client.id} bound ${proto.name} to id ${x.args.id}`);

            ctx.core.registry.globalOf(proto.name)?.onBind?.({ name, id: x.args.id, protocol: proto }, ctx);

            // TODO：xdg_shell 模块声明该 global 后，此分支随之删除
            if (proto.name === "xdg_wm_base") {
                const id = x.args.id as WaylandObjectId2<"xdg_wm_base">;
                ctx.client.state.xdg_wm_base.add(id);
                ctx.objects.setData(id, { pingSerials: new Map() });
            }
        },
        "wl_compositor.create_surface": (x, ctx) => {
            const surfaceId = x.args.id;
            const surface = ctx.objects.get(surfaceId);
            surface.data = { canvas: new OffscreenCanvas(1, 1), current: {}, pending: {} };
            ctx.core.surface.addWlSurface(surfaceId);
        },
        "wl_compositor.create_region"(msg, ctx) {
            ctx.objects.setData(msg.args.id, { rects: [] });
        },
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
        "wl_data_device_manager.create_data_source": (x, ctx) => {
            const src = ctx.objects.get(x.args.id);
            src.data = { offers: [] };
        },
        "wl_data_device_manager.get_data_device": (x, ctx) => {
            const ddId = x.args.id;
            const dataDevices = ctx.client.state.dataDevices || new Set();
            dataDevices.add(ddId);
            ctx.client.state.dataDevices = dataDevices;
        },
        "wl_data_source.offer": (x, ctx) => {
            const src = ctx.objects.get(x.id);
            if (!src) return;
            src.data.offers.push(x.args.mime_type);
            console.log(`wl_data_source#${x.id} offer ${x.args.mime_type}`);
        },
        "wl_data_offer.receive": (x, ctx) => {
            const offerId = x.id;
            const mime = x.args.mime_type;
            const fd = x.args.fd;

            // fallback: compositor-local paste flow – keep pendingPaste and emit paste for external handler
            if (ctx.client.state.pendingPaste) {
                console.warn("Existing pending paste request - rejecting previous");
                try {
                    fs.closeSync(ctx.client.state.pendingPaste.fd);
                } catch {
                    // ignore
                }
                clearTimeout(ctx.client.state.pendingPaste.timeout);
                ctx.client.state.pendingPaste = undefined;
            }

            const timeout = setTimeout(() => {
                if (!ctx.client.state.pendingPaste) return;
                console.warn("paste request timed out");
                try {
                    fs.closeSync(ctx.client.state.pendingPaste.fd);
                } catch {
                    // ignore
                }
                ctx.client.state.pendingPaste = undefined;
            }, 10000);

            ctx.client.state.pendingPaste = { offerId, fd, mime, timeout };
            ctx.client.emit("paste");
        },
        "wl_data_device.set_selection": (x, ctx) => {
            const srcId = waylandObjectId(x.args.source, "wl_data_source");
            if (!srcId) {
                console.log("Selection cleared");
                return;
            }

            const src = ctx.objects.get(srcId);
            if (!src) {
                console.warn(`Selection source ${srcId} not found`);
                return;
            }

            const offers = src.data.offers;
            // 优先尝试 text/plain;charset=utf-8，然后 text/plain
            let mime = offers.find((m: string) => /text\/plain.*utf-?8/i.test(m));
            if (!mime) mime = offers.find((m: string) => /^text\/plain($|;)/i.test(m));
            if (!mime) {
                // 回退到第一个 offer
                mime = offers[0];
            }

            if (!mime) {
                console.log(`No offered mime types from source ${srcId}`);
                return;
            }

            // 创建一个临时 fd 传给客户端，让客户端往里面写入数据
            const { fd } = newFd("");

            try {
                // 发送请求，要求客户端把 mime 类型的数据写入我们提供的 fd
                ctx.sendNow(srcId, "wl_data_source.send", { mime_type: mime, fd: fd });

                // TODO: 使用基于 EOF 的读取更优雅，但客户端行为差异导致未能稳定工作，
                // 先回退到简单的延时读取（不优雅），以后再改进为可靠的 EOF/poll 检测。
                setTimeout(() => {
                    try {
                        const st = fs.fstatSync(fd);
                        const len = Number(st.size) || 0;
                        if (len === 0) {
                            // 若 size 为 0，尝试读取最多 64KB 的数据
                            const tryBuf = new Uint8Array(65536);
                            let read = 0;
                            try {
                                read = fs.readSync(fd, tryBuf, 0, tryBuf.length, 0);
                            } catch {
                                // ignore
                            }
                            const content = Buffer.from(tryBuf.buffer, tryBuf.byteOffset, read).toString("utf8");
                            console.log(`Clipboard (from ${srcId}) [len=${read}]:`, content);
                        } else {
                            const arr = new Uint8Array(len);
                            fs.readSync(fd, arr, 0, len, 0);
                            const content = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("utf8");
                            console.log(`Clipboard (from ${srcId}) [len=${len}]:`, content);
                            ctx.client.emit("copy", content);
                        }
                    } catch (err) {
                        console.error("Error reading selection fd:", err);
                    } finally {
                        try {
                            fs.closeSync(fd);
                        } catch {
                            // ignore
                        }
                    }
                }, 200);
            } catch (err) {
                console.error("Error sending wl_data_source.send:", err);
                try {
                    fs.closeSync(fd);
                } catch {
                    // ignore
                }
            }
        },
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
        "wl_pointer.set_cursor": (x, ctx) => {
            // todo serial
            // todo wlsurface.offset
            const surfaceId = x.args.surface;
            if (!surfaceId) {
                // surface为null时隐藏光标
                ctx.state.cursor.hide();
                return;
            }
            // 校验 surface 存在（无效 id 走 postError）
            ctx.objects.get(surfaceId);
            const [_, e] = tryX(() => ctx.core.surface.setWlSurfaceRole(surfaceId, "cursor"));
            if (e) {
                ctx.postError("wl_pointer", x.id, "role", "Surface already has another role");
                return;
            }
            ctx.state.cursor.setSurface(
                surfaceId,
                { x: x.args.hotspot_x, y: x.args.hotspot_y },
                ctx.core.surface.getWlSurface(surfaceId).frame,
            );
        },
        "wl_region.add"(msg, ctx) {
            ctx.objects.getData(msg.id).rects.push({ ...msg.args, type: "+" });
        },
        "wl_region.subtract"(msg, ctx) {
            ctx.objects.getData(msg.id).rects.push({ ...msg.args, type: "-" });
        },
        "wl_subcompositor.get_subsurface": (x, ctx) => {
            const r = ctx.core.subsurface.setWlSubSurface(
                x.args.id,
                waylandObjectId(x.args.parent, "wl_surface"),
                waylandObjectId(x.args.surface, "wl_surface"),
            );

            if (r === "bad_surface")
                ctx.postError("wl_subcompositor", x.id, "bad_surface", "Surface already has a role");
            else if (r === "bad_parent")
                ctx.postError("wl_subcompositor", x.id, "bad_parent", "Parent cannot be itself");
            if (r !== true) return;
        },
        "wl_subsurface.set_position": (x, ctx) => {
            ctx.core.subsurface.setPosition(x.id, x.args.x, x.args.y);
        },
        "wl_subsurface.destroy": (x, ctx) => {
            ctx.core.subsurface.destroySubSurface(x.id);
        },
    },
    actions: {
        /** 指针路由：几何命中（host）→ 焦点转移 → 事件下发；没命中时不发（见 client.ts 的 leave todo） */
        "input.pointer": (msg, ctx) => {
            const ev = msg.args[0];
            const hit = ctx.hitTest(msg.winId, { x: ev.x, y: ev.y });
            if (!hit) return;
            updatePointerFocus(ctx, hit);
            sendPointer(ctx, ev, hit);
        },
        "input.scroll": (msg, ctx) => sendScroll(ctx, msg.args[0]),
        "input.key": (msg, ctx) => sendKey(ctx, msg.args[0], msg.args[1]),
        /** 仲裁交给各 text_input 模块（core 不认识 zwp_* 事件） */
        "input.text": (msg, ctx) => ctx.notify.textInput(msg.args[0], msg.args[1]),
        "clipboard.offer": (_msg, ctx) => offerTo(ctx),
    },
});
