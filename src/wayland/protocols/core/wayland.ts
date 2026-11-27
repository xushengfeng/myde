import { InputEventCodes } from "../../../input_codes/types";
import type { ClipboardOffer, OutputInfo, PointerCommand, ScrollCommand, TouchCommand } from "../../api";
import {
    type BindMsg,
    defineModule,
    type HitTestResult,
    type ModuleCtx,
    type SeatRecord,
    type SerialApi,
    type SurfaceId,
    type WaylandObjectId2,
    type WaylandSurfaceData,
    type WaylandWinId,
} from "../../module";
import type { renderTools } from "../../render_tools";
import type { WaylandName, WaylandProtocol } from "../../utils/wayland-binary";
import { getEnumName, getEnumValue, tryX, waylandObjectId } from "../../utils/wayland-proto";
import {
    keyboardEnter,
    keyboardKey,
    keyboardKeymap,
    keyboardLeave,
    keyboardModifiers,
    keyboardRepeatInfo,
    pointerAxis,
    pointerAxisDiscrete,
    pointerAxisRelativeDirection,
    pointerAxisSource,
    pointerAxisStop,
    pointerAxisValue120,
    pointerButton,
    pointerEnter,
    pointerFrame,
    pointerLeave,
    pointerMotion,
    touchCancel,
    touchDown,
    touchFrame,
    touchMotion,
    touchUp,
} from "./seat_native";

const fs = require("node:fs") as typeof import("node:fs");

/*
 * myde-drm 的 GPU 转换在 glFlush 后就把新 GBM buffer 交给 Electron 导入，依赖
 * dma-buf 隐式 fence 让导入方等到画完。默认保持模块的 flush：每帧 glFinish 会
 * 把 JS 主线程按帧等 GPU，4K 下直接吃掉 8.3ms 预算的一大块。
 * 某些驱动对隐式 fence 支持不好（出现整块透明/旧帧）时，用 `MYDE_DRM_GPU_FINISH=1`
 * 让转换器改回 glFinish 等待（模块自己读这个环境变量）。
 */
const {
    convertDmabufToRgba,
    convertDmabufToTexture,
    convertShmToRgba,
    convertShmToRgbaRegion,
    getElectronPixelFormat,
    needsConversion,
} = require("myde-drm") as typeof import("myde-drm");

import { importSharedTexture } from "../../utils/shared_texture";

declare module "../../module" {
    interface WaylandDataRegistry {
        wl_shm_pool: { fd: number };
        wl_buffer:
            | {
                  type: "shm";
                  fd: number;
                  offset: number;
                  stride: number;
                  width: number;
                  height: number;
                  format: number;
                  /** Reused RGBA output; avoids a new Buffer per commit. */
                  frame?: { rgba: Buffer; imageData: ImageData };
              }
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
        wl_data_source: { offers: string[]; actions?: number };
        wl_data_offer: {
            mimeTypes: string[];
            /** 拖拽时指向发起 source；剪贴板 offer 用 token 找 server 的 selection */
            sourceId?: WaylandObjectId2<"wl_data_source">;
            /** 剪贴板 selection 的来源 token（客户端源或桌面源），`receive` 时交给 `ctx.transfer` */
            token?: string;
            /** 跨客户端拖拽会话 id；目标侧 offer 的 accept/actions/receive/finish 交给 `ctx.dnd` */
            dndSessionId?: string;
            /** 这个 offer 属于 drag-and-drop，不是剪贴板 selection */
            drag?: boolean;
            /** 目标客户端 accept 的 mime */
            accepted?: string;
            /** 目标通过 set_actions 声明的动作 */
            targetActions?: number;
            preferredAction?: number;
            /** 协商后的动作（v3 的 action 事件） */
            selectedAction?: number;
        };
        wl_data_device: { seatName: string };
    }
}

declare module "../../module" {
    interface WaylandDataRegistry {
        wl_surface: {
            canvas: OffscreenCanvas;
            current: WaylandSurfaceData;
            pending: WaylandSurfaceData;
            /** 像素提交序号：unmap/销毁时递增，取消还在异步导入的旧帧 */
            renderSeq?: number;
            /** 同步子 surface 的提交缓存：按提交顺序排队，父 surface 状态生效时依次应用 */
            cache?: WaylandSurfaceData[];
            /**
             * 提交排队：damage 是「相对上一次 commit」的，像素必须按提交顺序贴进
             * 画布。dmabuf 导入是异步的，并发完成会乱序，所以在这里排队而不是丢帧。
             */
            draining?: boolean;
            /** 已入队、尚未应用的提交状态（surface 销毁时要归还其中的 buffer） */
            queuedStates?: WaylandSurfaceData[];
            /** 最近一次合成、等待呈现的帧；同一 surface 每 rAF 只上屏一次 */
            pendingPresent?: {
                canvas: OffscreenCanvas;
                width: number;
                height: number;
                /** 该帧对应的提交状态（viewporter 等 onFrame 钩子要用） */
                data: WaylandSurfaceData;
            };
            /** 已排队一次 rAF 呈现 */
            presentScheduled?: boolean;
            /** 本帧已经上过屏：同一帧里更晚的提交合并到下一帧 */
            presentedThisFrame?: boolean;
            /** presentedThisFrame 的世代：旧帧的解锁回调不能清掉新帧的状态 */
            presentToken?: number;
            /**
             * 等本次呈现之后再释放的 VideoFrame / 导入资源。Canvas2D 没有完成事件，
             * 以「呈现后的下一帧」为界，避免宿主还在采样就把资源还回池子/客户端。
             */
            pendingReleases?: { frame: VideoFrame; onClose?: () => void }[];
            /** wp_viewport.source 的裁剪画布，按 surface 复用，避免每帧分配 */
            viewportCanvas?: OffscreenCanvas;
        };
    }
}

declare module "../../module" {
    interface WaylandDataRegistry {
        wl_pointer: {
            /** 最近一次 `wl_pointer.enter` 的 serial；set_cursor / cursor-shape 的校验基线 */
            enterSerial?: number;
        };
    }
}

/** seat 名 → 该 seat 的 data_device 集合（selection 按 seat 路由，跟随键盘焦点） */
type DataDevices = Map<string, Set<WaylandObjectId2<"wl_data_device">>>;

declare module "../../module" {
    interface WaylandDataRegistry {
        wl_region: {
            rects: { x: number; y: number; width: number; height: number; type: "+" | "-" }[];
        };
    }
    interface WaylandDomainRegistry {
        /** wl_data_* 的连接态；字节不在这里，`ctx.transfer` 负责 fd 与桌面数据请求 */
        dataDevice: {
            devices?: DataDevices;
            /** 同 client 的 drag-and-drop 会话（跨 client 暂不支持，start_drag 会取消） */
            drag?: {
                dataDeviceId: WaylandObjectId2<"wl_data_device">;
                sourceId: WaylandObjectId2<"wl_data_source">;
                seatName: string;
                surface: SurfaceId;
                /** `start_drag` 的 icon surface；提交新帧时转发给桌面 */
                iconSurface?: SurfaceId;
                offerId?: WaylandObjectId2<"wl_data_offer">;
                /** 桌面已通过 `dnd.move` 接管目标，本地同 client 目标不再处理指针 */
                remoteDriven?: boolean;
                /** 触摸点发起的拖拽：收尾时不能向 wl_pointer 补左键释放 */
                touch?: boolean;
            };
            /** drop 后等目标 receive 取数据；超时或 receive 后补 dnd_finished */
            dragFinish?: { sourceId: WaylandObjectId2<"wl_data_source">; timer: NodeJS.Timeout };
        };
        /**
         * text-input v1/v3 的仲裁槽（后 activate/enable 者持有）：core 只当中立槽位，不解释 zwp_* 事件——
         * 读写方是各 text_input 模块，触发通道是 core 的 `input.text` action（见 `TextInputHooks.onTextInput`）。
         */
        textInput: { owner: TextInputOwner | null };
        /** 客户端级 serial 分配器（所有需要 serial 的事件共用） */
        serial: SerialApi;
        /** 输入设备状态（`SeatStore` 在本文件旁边的 `seat_store.ts`）：只有 core 读写，host 不碰 */
        seat: SeatApi;
        /**
         * 该连接绑定的 wl_output 与已创建的 wl_surface。
         * 两者到达顺序不确定：output 先绑就把已有 surface 补进 output，surface 先建就等
         * output 绑定时再 enter。客户端靠 enter 把窗口和 output 的刷新率关联起来。
         */
        output: {
            outputs: Set<WaylandObjectId2<"wl_output">>;
            surfaces: Set<SurfaceId>;
        };
        /** 帧回调按桌面 vsync 排队：每个 surface 每次 rAF 只放一个 done，避免客户端跑超刷新率 */
        commitPacing: {
            pending: Map<SurfaceId, WaylandObjectId2<"wl_callback">[]>;
            raf: boolean;
            /** 没有待发回调后继续跑 rAF 的帧数，防止稀疏 rAF 被宿主排到 60Hz */
            idleFrames: number;
            /**
             * surface → 帧率上限（Hz）。没有条目就跟随桌面 rAF；
             * 子 surface 沿父链继承最近的上限（见 `surfaceFrameRate`）。
             */
            limits: Map<SurfaceId, number>;
            /** surface → 还要跳过几次 rAF 才回 done；用于把帧率压到输出刷新率的整数因数 */
            skips: Map<SurfaceId, number>;
        };
    }
}

/** 给 surface 补发所有已绑定 output 的 `wl_surface.enter`（只在 surface/output 新建时调用） */
function enterBoundOutputs(ctx: ModuleCtx, surface: SurfaceId) {
    for (const output of ctx.domain.output.outputs) {
        ctx.send(surface, "wl_surface.enter", { output });
    }
}

/** 整数 scale：向客户端建议的 buffer 倍率，向上取整保证不损失像素。 */
function integerScale(scale: number): number {
    return Math.max(1, Math.ceil(scale - 1e-9));
}

/** 发送当前输出状态；同一批事件用 done 收尾（由协议版本过滤低版本事件）。 */
function sendOutputState(outputId: WaylandObjectId2<"wl_output">, output: OutputInfo, send: ModuleCtx["send"]) {
    send(outputId, "wl_output.name", { name: output.name });
    send(outputId, "wl_output.description", { description: output.description });
    send(outputId, "wl_output.mode", {
        width: output.mode.width,
        height: output.mode.height,
        refresh: output.mode.refresh,
        flags: getEnumValue("wl_output.mode", ["current", "preferred"]),
    });
    send(outputId, "wl_output.geometry", {
        x: 0,
        y: 0,
        physical_width: output.physicalSize?.width ?? 0,
        physical_height: output.physicalSize?.height ?? 0,
        make: "",
        model: "",
        subpixel: getEnumValue("wl_output.subpixel", "unknown"),
        transform: getEnumValue("wl_output.transform", output.transform),
    });
    send(outputId, "wl_output.scale", { factor: integerScale(output.scale) });
    send(outputId, "wl_output.done", {});
}

/**
 * 通知 surface 的输出缩放偏好。
 * 支持分数的客户端会从 wp_fractional_scale_v1 拿到精确值；这里给只认整数的客户端。
 */
function sendPreferredScale(ctx: ModuleCtx, surface: SurfaceId, output: OutputInfo, send: ModuleCtx["send"]) {
    const version = ctx.objects.getOption(surface)?.version ?? 0;
    if (version < 6) return;
    const factor = integerScale(output.scale);
    send(surface, "wl_surface.preferred_buffer_scale", { factor });
    send(surface, "wl_surface.preferred_buffer_transform", {
        transform: getEnumValue("wl_output.transform", "normal"),
    });
}

/** 静止后继续跑多少帧 rAF；120Hz 下约 500ms。 */
const PACING_KEEPALIVE_FRAMES = 60;

/**
 * 等呈现后再 close 的 VideoFrame。宿主被提交洪峰饿住时，这个队列会一直涨；稳定副本
 * 每帧都是新分配的 GPU dmabuf（4K 一帧 ~33MB），不设上限就会把内存吃光。超过上限
 * 时提前关最旧的：老的早就过了呈现时机，宁可丢它也不能让 GPU 内存无上限增长。
 */
const MAX_PENDING_VIDEO_FRAMES = 8;
const pendingVideoFrames = new Map<VideoFrame, () => void>();

function closePendingVideoFrame(frame: VideoFrame) {
    const onClose = pendingVideoFrames.get(frame);
    if (onClose === undefined) return;
    pendingVideoFrames.delete(frame);
    try {
        frame.close();
    } catch {
        /* 已关闭 */
    }
    // VideoFrame 先 close 再 release 导入对象：两者各持一份引用，先放帧的
    // 引用、再放导入的引用，GPU 资源才会在最后一个引用消失时销毁。
    onClose();
}

function releaseVideoFrameLater(frame: VideoFrame, onClose?: () => void) {
    pendingVideoFrames.set(frame, onClose ?? (() => {}));
    // rAF 是主路径；页面被节流/遮挡时 rAF 可能停，用定时器兜底，避免 buffer 和
    // 拷贝池槽位永远不还导致客户端停摆。
    const timer = setTimeout(() => closePendingVideoFrame(frame), 100);
    requestAnimationFrame(() => {
        clearTimeout(timer);
        closePendingVideoFrame(frame);
    });
    while (pendingVideoFrames.size > MAX_PENDING_VIDEO_FRAMES) {
        const oldest = pendingVideoFrames.keys().next().value;
        if (oldest === undefined) break;
        closePendingVideoFrame(oldest);
    }
}

/**
 * 目标帧率对应输出刷新率的整数因数：`refresh / divisor` 是最接近目标、且能按 rAF 均匀
 * 分频的帧率（例如 120Hz → 30Hz、144Hz → 28.8Hz、165Hz → 27.5Hz）。
 */
export function frameRateDivisor(refreshMhz: number, fps: number): number {
    const refresh = Number.isFinite(refreshMhz) && refreshMhz > 0 ? refreshMhz / 1000 : 60;
    return Math.max(1, Math.round(refresh / fps));
}

/** surface 的帧率上限；子 surface 沿父链继承最近的上限。 */
function surfaceFrameRate(ctx: ModuleCtx, surfaceId: SurfaceId): number | undefined {
    let current: SurfaceId | undefined = surfaceId;
    for (let depth = 0; depth < 64 && current !== undefined; depth++) {
        const fps = ctx.domain.commitPacing.limits.get(current);
        if (fps !== undefined) return fps;
        current = ctx.core.subsurface.getParent(current);
    }
    return undefined;
}

/**
 * 帧回调按桌面 rAF 排队：同一 surface 每次 rAF 只发一个 done。
 *
 * 立即回 done 会让客户端一路跑超刷新率（实测能到 200+ commit/s）；等一个 rAF
 * 再回则是把每个 surface 的更新节拍钉在桌面刷新率上，Chrome 会按 120Hz 稳定出帧。
 *
 * 有 `window.setFrameRate` 上限时按输出刷新率的整数因数跳帧（每 N 次 rAF 回一个），
 * 客户端据此把该窗口的渲染降到目标帧率；没有上限的 surface 不受影响。
 *
 * 只在有回调时注册下一帧还不够：客户端拿到 done 后 commit，可能落在两次 rAF
 * 之间，上一轮链已结束，宿主会把新的孤立 rAF 排到 60Hz（KDE 宽容，wrap/winit
 * 不宽容）。保持一小段连续 rAF，动画期间不断链，静止后自动停。
 */
function scheduleFrameDone(ctx: ModuleCtx, surfaceId: SurfaceId, callback: WaylandObjectId2<"wl_callback">) {
    const pacing = ctx.domain.commitPacing;
    let queue = pacing.pending.get(surfaceId);
    if (!queue) {
        queue = [];
        pacing.pending.set(surfaceId, queue);
    }
    queue.push(callback);
    pacing.idleFrames = 0;
    if (pacing.raf) return;

    const drain = () => {
        pacing.raf = false;
        let sent = 0;
        for (const [sid, q] of pacing.pending) {
            if (q.length === 0) {
                pacing.pending.delete(sid);
                continue;
            }
            const fps = surfaceFrameRate(ctx, sid);
            if (fps !== undefined) {
                const skip = pacing.skips.get(sid) ?? 0;
                if (skip > 0) {
                    pacing.skips.set(sid, skip - 1);
                    continue;
                }
                pacing.skips.set(sid, frameRateDivisor(ctx.client.output().mode.refresh, fps) - 1);
            } else {
                pacing.skips.delete(sid);
            }
            const cb = q.shift();
            if (cb !== undefined) {
                // 必须和 presentation 的 CLOCK_MONOTONIC 同基准且单调；Date.now()
                // 会被 NTP 调整，客户端据此排帧时会出现回退/抖动。
                const callbackData = Number(process.hrtime.bigint() / 1_000_000n) >>> 0;
                ctx.sendNow(cb, "wl_callback.done", { callback_data: callbackData });
                ctx.sendNow(ctx.client.displayId, "wl_display.delete_id", { id: cb });
                sent++;
            }
            if (q.length === 0) {
                // 只清空队列，保留跳帧计数：客户端拿到 done 后才提交下一帧，
                // 中间这段空档不能把分频相位重置，否则又会在下一次 rAF 立刻回 done。
                pacing.pending.delete(sid);
            }
        }
        // 还有回调在排队时必须继续跑 rAF：限速的 surface 可能这几次都要跳过。
        pacing.idleFrames = sent > 0 || pacing.pending.size > 0 ? 0 : pacing.idleFrames + 1;
        if (pacing.idleFrames < PACING_KEEPALIVE_FRAMES) {
            pacing.raf = true;
            requestAnimationFrame(drain);
        }
    };
    pacing.raf = true;
    requestAnimationFrame(drain);
}

/** 只能按 bgra 猜格式直导的 fourcc 已警告过，避免每帧刷日志 */
const warnedUnimportableFormats = new Set<number>();
function warnUnimportableFormat(format: number): void {
    if (warnedUnimportableFormats.has(format) || warnedUnimportableFormats.size >= 16) return;
    warnedUnimportableFormats.add(format);
    console.warn(
        `dmabuf format 0x${format.toString(16)}: Electron 不能直接导入、myde-drm 也不能转换` +
            "（多平面 / 非 LINEAR / 未知格式），按 bgra 直导",
    );
}

/** 呈现兜底定时器：rAF 是首选（与宿主合成对齐），被节流/遮挡时也要继续推进。 */
const PRESENT_FALLBACK_MS = 50;

/**
 * 合成完成 → 上屏。
 *
 * 本帧还没上过屏就直接上屏（提交到合成不跨帧，避免给正常节奏多加一帧延迟）；
 * 本帧已经上过屏就合并到下一帧（一次 DOM 整画布上传），期间的提交只更新画布、
 * 不会丢 damage。rAF 被宿主节流时用定时器兜底：迟到的呈现只会让画面晚一拍，
 * 不会停在旧内容，也不会让客户端的 buffer 永远等不到归还。
 */
function schedulePresent(ctx: ModuleCtx, surfaceId: SurfaceId): void {
    const surface = ctx.objects.getOption(surfaceId);
    if (!surface || surface.data.presentScheduled) return;
    if (surface.data.presentedThisFrame !== true) {
        presentSurface(ctx, surfaceId);
        return;
    }
    surface.data.presentScheduled = true;
    const timer = setTimeout(() => presentSurface(ctx, surfaceId), PRESENT_FALLBACK_MS);
    requestAnimationFrame(() => {
        clearTimeout(timer);
        presentSurface(ctx, surfaceId);
    });
}

/**
 * 复制 surface 工作画布：桌面事件持有的是独立快照，不会被下一帧改写。
 * 纯 node 环境没有 OffscreenCanvas（协议单测），此时直接透传。
 */
function snapshotCanvas(canvas: OffscreenCanvas): OffscreenCanvas {
    if (typeof OffscreenCanvas === "undefined") return canvas;
    const copy = new OffscreenCanvas(canvas.width, canvas.height);
    copy.getContext("2d")?.drawImage(canvas, 0, 0);
    return copy;
}

/**
 * 拖拽图标 surface 的新帧或撤销：只在它仍属于当前拖拽会话时上报。
 * 图标只是源客户端的一张 surface，桌面把它叠在光标下，不影响光标本身。
 */
function updateDragIcon(
    ctx: ModuleCtx,
    surfaceId: SurfaceId,
    frame: OffscreenCanvas | undefined,
    size: { width: number; height: number },
): void {
    const drag = ctx.domain.dataDevice.drag;
    if (drag?.iconSurface !== surfaceId) return;
    if (frame === undefined) {
        ctx.transfer.dragIcon(drag.sourceId, null);
        return;
    }
    const icon = ctx.core.surface.getWlSurface(surfaceId);
    ctx.transfer.dragIcon(drag.sourceId, {
        canvas: snapshotCanvas(frame),
        size,
        offset: icon?.offset ?? { x: 0, y: 0 },
    });
}

/**
 * 把待呈现帧交给桌面：viewporter 裁剪 → DOM canvas → 光标。
 *
 * VideoFrame/导入资源的释放放到这一帧之后（见 pendingReleases）：Canvas2D 没有
 * 完成事件，只能以「呈现后的下一帧」为界，避免宿主还在采样就把资源还回去。
 */
function presentSurface(ctx: ModuleCtx, surfaceId: SurfaceId): void {
    const surface = ctx.objects.getOption(surfaceId);
    if (!surface) return;
    surface.data.presentScheduled = false;
    const pending = surface.data.pendingPresent;
    surface.data.pendingPresent = undefined;
    try {
        if (pending) {
            const fcanvas = ctx.notify.frame(surfaceId, pending.canvas, pending.data);
            ctx.core.surface.renderWlSurface(surfaceId, fcanvas);
            ctx.cursor.updateFrame(surfaceId, fcanvas, { width: pending.width, height: pending.height });
            updateDragIcon(ctx, surfaceId, fcanvas, { width: pending.width, height: pending.height });
            // 本帧已经上屏，下一帧再解锁（同一帧里更晚的提交合并到下一帧）
            surface.data.presentedThisFrame = true;
            surface.data.presentToken = (surface.data.presentToken ?? 0) + 1;
            const token = surface.data.presentToken;
            requestAnimationFrame(() => {
                const latest = ctx.objects.getOption(surfaceId);
                if (latest?.data.presentToken === token) latest.data.presentedThisFrame = false;
            });
        }
    } catch (error) {
        console.error(`present surface failed (surface ${surfaceId}):`, error);
    } finally {
        // 无论呈现是否成功都把资源放掉：宁可这一帧没上屏，也不能让客户端
        // buffer 或拷贝池槽位永远卡住。
        const releases = surface.data.pendingReleases;
        surface.data.pendingReleases = undefined;
        for (const item of releases ?? []) releaseVideoFrameLater(item.frame, item.onClose);
    }
}

/** 丢弃待呈现帧与待释放资源（unmap/销毁）；不释放会让客户端 buffer 永远卡住 */
function discardPendingPresent(ctx: ModuleCtx, surfaceId: SurfaceId): void {
    const surface = ctx.objects.getOption(surfaceId);
    if (!surface) return;
    surface.data.pendingPresent = undefined;
    const releases = surface.data.pendingReleases;
    surface.data.pendingReleases = undefined;
    for (const item of releases ?? []) releaseVideoFrameLater(item.frame, item.onClose);
}

/**
 * 客户端级 serial 分配器（`ctx.domain.serial`）。
 *
 * Wayland 的 serial 只是「本连接内某次事件」的 uint32 令牌，没有类型编码；协议只规定某些请求
 * 必须回传对应事件的 serial（pointer enter、configure、ping、隐式 grab…），并不要求不同接口
 * 各自编号。这里用单条单调序列，既避免不同接口的事件撞值，也让所有事件共享同一个回绕规则。
 *
 * 校验状态不放这里：它是「谁的请求」就记在谁身上——pointer 的 enter serial 在对象数据里，
 * xdg_surface 的待 ack 队列在 xdg 域里，ping 表挂在 xdg_wm_base 对象上。
 */
export class SerialStore implements SerialApi {
    /** 首值 1（0 在部分客户端里等于「没有 serial」） */
    #serial = 0;

    next(): number {
        // uint32 回绕：0 跳过，回到 1
        this.#serial = this.#serial >= 0xffffffff ? 1 : this.#serial + 1;
        return this.#serial;
    }
}

/** 最近键盘按下 serial 的保留数量：move/grab 可能晚于 release 到达，保留一小段足够 */
const KEY_PRESS_SERIAL_KEEP = 16;

/**
 * 输入设备侧状态（原散在 host 的 `ClientState`（`obj2`）里：seats/focusSurface/focusSurfaceType/modifiers）。
 *
 * **per-seat**：焦点与修饰键都是「一把 seat 一份」——`pointerFocus`/`keyboardFocus`/`mods`
 * 是 `SeatRecord` 上的数据字段（读写像 `win.actived` 一样直接），因为多光标 = 多 seat，
 * 各人的焦点互不相干（Firefox 启动时会把所有 seat 都绑上）。
 *
 * 只放数据与原子操作；**协议动作（发 wl_pointer.enter/leave、wl_keyboard.*、wl_touch.*）在协议文件里**
 * ——`protocols/core/wayland.ts` 的 `actions` / `core` initializer 经 `ctx.domain.seat`
 * 取这里的数据，组包与下发用 `ctx.sendNow`，store 不必注入一整套上下文。
 * 键盘焦点的单写入点是 `ctx.core.focusKeyboard`（同值去重后才发包）。
 *
 * 配套的 text-input v1/v3 仲裁状态在 core 的域槽里（`ctx.domain.textInput.owner`，
 * 见 `protocols/core/wayland.ts`）：v1/v3 各自私有状态走自己的 `ctx.domain.textInputV1/V3`。
 */
export class SeatStore {
    #seats = new Map<WaylandObjectId2<"wl_seat">, SeatRecord>();
    #byName = new Map<string, SeatRecord>();

    addSeat(id: WaylandObjectId2<"wl_seat">, name: string): void {
        // 同一把 seat 可能被客户端在不同 registry 上重复 bind（Firefox 会这么做）。
        // 名字才是物理 seat 的身份：复用已有记录，资源（pointer/keyboard/touch）才能都汇到一处。
        const existing = this.#byName.get(name);
        if (existing !== undefined) {
            this.#seats.set(id, existing);
            return;
        }
        const record: SeatRecord = {
            name,
            pointers: new Set(),
            keyboards: new Set(),
            touches: new Set(),
            pointerFocus: null,
            pointerPos: { x: 0, y: 0 },
            touchPoints: new Map(),
            keyboardFocus: null,
            mods: new Set(),
            pressedKeys: new Set(),
            keyboardPressSerials: [],
            touchPressSerials: [],
        };
        this.#seats.set(id, record);
        this.#byName.set(name, record);
    }

    get(id: WaylandObjectId2<"wl_seat">): SeatRecord | undefined {
        return this.#seats.get(id);
    }

    /** `input.*` 的 `seat` 参数解析用；缺省 `"seat0"`（本机光标） */
    byName(name: string): SeatRecord | undefined {
        return this.#byName.get(name);
    }

    /** 全 seat 遍历（焦点清理、offer 目标计算）用；重复 bind 的 wl_seat 已归一到同一记录，这里去重 */
    all(): IterableIterator<SeatRecord> {
        return new Set(this.#seats.values()).values();
    }

    /** 按下按钮：第一次按下时建立隐式 grab，之后只追加按钮（保留首次的 serial） */
    beginPointerGrab(seat: SeatRecord, winId: WaylandWinId, surface: SurfaceId, button: number, serial: number): void {
        const grab = seat.pointerGrab;
        if (grab !== undefined && grab.buttons.size > 0) {
            grab.buttons.add(button);
            return;
        }
        seat.pointerGrab = { serial, surface, winId, buttons: new Set([button]) };
    }

    /** 松开按钮；返回 true 表示全部按钮都已松开（隐式 grab 结束） */
    endPointerButton(seat: SeatRecord, button: number): boolean {
        const grab = seat.pointerGrab;
        if (grab === undefined) return false;
        grab.buttons.delete(button);
        return grab.buttons.size === 0;
    }

    /** serial 是否属于当前仍按住按钮的指针 grab（DnD 要求 grab 仍然有效） */
    isActivePointerGrab(seat: SeatRecord, serial: number): boolean {
        const grab = seat.pointerGrab;
        return grab !== undefined && grab.buttons.size > 0 && grab.serial === serial;
    }

    /** 指针 grab 的 serial（含已结束的最近一次）或最近几次键盘按下的 serial */
    isUserActionSerial(seat: SeatRecord, serial: number): boolean {
        return (
            seat.pointerGrab?.serial === serial ||
            seat.keyboardPressSerials.includes(serial) ||
            seat.touchPressSerials.includes(serial)
        );
    }

    /** 仍按住的触摸点的 down serial → 按下时的 surface/坐标（触摸拖拽的 start_drag 校验） */
    activeTouchSerial(seat: SeatRecord, serial: number): { surface: SurfaceId; x: number; y: number } | undefined {
        for (const point of seat.touchPoints.values()) {
            if (point.serial === serial) return point;
        }
        return undefined;
    }

    noteTouchPress(seat: SeatRecord, serial: number): void {
        seat.touchPressSerials.push(serial);
        if (seat.touchPressSerials.length > KEY_PRESS_SERIAL_KEEP) seat.touchPressSerials.shift();
    }

    noteKeyboardPress(seat: SeatRecord, serial: number): void {
        seat.keyboardPressSerials.push(serial);
        if (seat.keyboardPressSerials.length > KEY_PRESS_SERIAL_KEEP) seat.keyboardPressSerials.shift();
    }

    /** 该键是否逻辑按着（焦点离开收尾后为空） */
    isKeyPressed(seat: SeatRecord, key: number): boolean {
        return seat.pressedKeys.has(key);
    }

    /** 按下键：重复 press 返回 false；否则更新 `pressedKeys` 与修饰位 */
    pressKey(seat: SeatRecord, key: number): boolean {
        if (seat.pressedKeys.has(key)) return false;
        seat.pressedKeys.add(key);
        const bit = MOD_KEY_TO_BIT[key];
        if (bit !== undefined) seat.mods.add(bit);
        return true;
    }

    /** 松开键：没有对应 press 的 release 返回 false；否则更新 `pressedKeys` 与修饰位 */
    releaseKey(seat: SeatRecord, key: number): boolean {
        if (!seat.pressedKeys.delete(key)) return false;
        const bit = MOD_KEY_TO_BIT[key];
        if (bit !== undefined) seat.mods.delete(bit);
        return true;
    }

    /**
     * 焦点离开时取走全部按下的键（调用方负责在 `leave` 前补 release），修饰位一起清空。
     * 返回的键就是需要补发 release 的集合，`modifiersChanged` 决定要不要再补一条 `modifiers`。
     */
    takePressedKeys(seat: SeatRecord): { keys: number[]; modifiersChanged: boolean } {
        const keys = [...seat.pressedKeys];
        let modifiersChanged = seat.mods.size > 0;
        for (const key of keys) {
            if (MOD_KEY_TO_BIT[key] !== undefined) modifiersChanged = true;
        }
        seat.pressedKeys.clear();
        seat.mods.clear();
        return { keys, modifiersChanged };
    }

    /** `wl_keyboard.modifiers.mods_depressed` 的位掩码：按仍按下的逻辑键算，左右同名键不会互相覆盖 */
    modifierMask(seat: SeatRecord): number {
        let mask = 0;
        for (const key of seat.pressedKeys) {
            const bit = MOD_KEY_TO_BIT[key];
            if (bit !== undefined) mask |= 1 << bit;
        }
        for (const bit of seat.mods) mask |= 1 << bit;
        return mask;
    }
}

// ───────────── 域状态：wl_surface / wl_subsurface 的 role、父子关系 ─────────────
// core 自己造、自己用，经 `ctx.core.surface` / `ctx.core.subsurface` 暴露；
// 扩展（xdg）通过 `SurfaceId` 读写，不需要 import 这里（运行时零跨协议依赖）。

class WaylandSurfaceRoleError extends Error {}

export class wlSurfaceData {
    private wl_surface: Record<
        WaylandObjectId2<"wl_surface">,
        {
            role: "subsurface" | "toplevel" | "popup" | "cursor" | "dnd_icon" | undefined;
            size: { w: number; h: number };
            /** `wl_surface.offset` 的当前值（surface 逻辑坐标） */
            offset: { x: number; y: number };
            // 最近一次合成输出的画布，可能与surface画布共用，取用时需要复制
            frame?: OffscreenCanvas;
        }
    > = {};

    render: renderTools;
    idScope: (id: unknown) => string;

    constructor(render: renderTools) {
        this.render = render;
        this.idScope = render.idScope();
    }

    addWlSurface(id: WaylandObjectId2<"wl_surface">) {
        this.wl_surface[id] = { role: undefined, size: { w: 0, h: 0 }, offset: { x: 0, y: 0 } };
        this.render.bindCanvas(this.idScope(id));
    }
    getWlSurface(id: WaylandObjectId2<"wl_surface">) {
        return this.wl_surface[id];
    }
    getRole(id: WaylandObjectId2<"wl_surface">) {
        return this.wl_surface[id]?.role;
    }
    renderWlSurface(id: WaylandObjectId2<"wl_surface">, canvas: OffscreenCanvas) {
        const surface = this.wl_surface[id];
        surface.frame = canvas;
        this.render.renderCanvas(canvas, this.idScope(id), {
            logicalWidth: surface.size.w,
            logicalHeight: surface.size.h,
        });
    }
    destroyWlSurface(id: WaylandObjectId2<"wl_surface">) {
        delete this.wl_surface[id];
        this.render.destroyCanvas(this.idScope(id));
    }

    setWlSurfaceRole(
        id: WaylandObjectId2<"wl_surface">,
        role: "subsurface" | "toplevel" | "popup" | "cursor" | "dnd_icon",
    ) {
        const oldRole = this.wl_surface[id].role;
        if (oldRole !== undefined && oldRole !== role) {
            throw new WaylandSurfaceRoleError();
        }
        this.wl_surface[id].role = role;
    }
    updateWlSurfaceSize(id: WaylandObjectId2<"wl_surface">, w: number, h: number) {
        this.wl_surface[id].size = { w, h };
    }
    setWlSurfaceOffset(id: WaylandObjectId2<"wl_surface">, x: number, y: number) {
        this.wl_surface[id].offset = { x, y };
        this.render.setBufferOffset(this.idScope(id), x, y);
    }
}

export class wlSubSurfaceData {
    wl_surface: wlSurfaceData;
    wl_subsurface: Record<
        WaylandObjectId2<"wl_subsurface">,
        {
            parent: WaylandObjectId2<"wl_surface">;
            child: WaylandObjectId2<"wl_surface">;
            /** 已生效的位置（父 surface 坐标系） */
            posi: { x: number; y: number };
            /** set_position 排定的位置，父 surface 状态生效时替换 posi */
            pendingPos: { x: number; y: number };
            /** 本 surface 自己的同步模式；默认同步 */
            syncMode: boolean;
            /** 是否已经随父 surface 的某次提交进入树中（新增子 surface 是双缓冲的） */
            active: boolean;
        }
    > = {};
    /** 已生效的堆叠顺序（底 → 顶），只有这些子 surface 参与合成/命中 */
    parentChildren = new Map<WaylandObjectId2<"wl_surface">, WaylandObjectId2<"wl_subsurface">[]>();
    /** 挂起的堆叠顺序（含尚未生效的新增子 surface），父 surface 状态生效时整体复制到 parentChildren */
    private pendingChildren = new Map<WaylandObjectId2<"wl_surface">, WaylandObjectId2<"wl_subsurface">[]>();
    private surface2subsurface = new Map<WaylandObjectId2<"wl_surface">, WaylandObjectId2<"wl_subsurface">>();
    private render: renderTools;
    private idScope: (id: unknown) => string;
    constructor(wl: wlSurfaceData) {
        this.wl_surface = wl;
        this.render = wl.render;
        this.idScope = wl.idScope;
    }

    setWlSubSurface(
        subRelationId: WaylandObjectId2<"wl_subsurface">,
        parent: WaylandObjectId2<"wl_surface">,
        child: WaylandObjectId2<"wl_surface">,
    ) {
        const [roleerror] = tryX(() => {
            this.wl_surface.setWlSurfaceRole(child, "subsurface");
        });
        if (roleerror instanceof WaylandSurfaceRoleError) {
            return "bad_surface";
        }
        if (parent === child) {
            return "bad_parent";
        }
        if (this.isDescendant(child, parent)) {
            return "bad_parent";
        }
        const oldRelationId = this.getSubSurfaceBySurface(child);
        if (oldRelationId) {
            // 已经有父子关系了，先删除旧关系（新关系仍要等父 surface 提交才生效）
            const oldRelation = this.wl_subsurface[oldRelationId];
            if (oldRelation) this.detachChild(oldRelation.parent, oldRelationId);
            this.surface2subsurface.delete(child);
            delete this.wl_subsurface[oldRelationId];
        }

        this.wl_subsurface[subRelationId] = {
            parent,
            child,
            posi: { x: 0, y: 0 },
            pendingPos: { x: 0, y: 0 },
            syncMode: true,
            active: false,
        };
        const parentData = this.pendingChildren.get(parent) ?? [];
        parentData.push(subRelationId);
        this.pendingChildren.set(parent, parentData);
        this.surface2subsurface.set(child, subRelationId);

        // 先挂到父节点下，避免子 surface 的画布作为根节点露出来；真正生效要等父 surface 提交
        this.render.setCanvasAnchor(this.idScope(child), this.idScope(parent));
        this.render.setCanvasOffset(this.idScope(child), 0, 0);

        return true;
    }
    private getSubSurfaceBySurface(child: WaylandObjectId2<"wl_surface">) {
        return this.surface2subsurface.get(child);
    }
    getParentChildren(parent: WaylandObjectId2<"wl_surface">) {
        const subs = Array.from(this.parentChildren.get(parent) ?? []);
        return subs.map((s) => this.wl_subsurface[s].child);
    }
    getParentChildrenWithRect(parent: WaylandObjectId2<"wl_surface">) {
        const subs = Array.from(this.parentChildren.get(parent) ?? []);
        return subs.map((s) => ({
            id: this.wl_subsurface[s].child,
            offsetRect: {
                x: this.wl_subsurface[s].posi.x,
                y: this.wl_subsurface[s].posi.y,
                w: this.wl_surface.getWlSurface(this.wl_subsurface[s].child).size.w,
                h: this.wl_surface.getWlSurface(this.wl_subsurface[s].child).size.h,
            },
        }));
    }
    setPosition(id: WaylandObjectId2<"wl_subsurface">, x: number, y: number) {
        const sub = this.wl_subsurface[id];
        if (sub === undefined) return;
        // 位置和堆叠一样双缓冲：父 surface 提交后才写 posi / 动 DOM
        sub.pendingPos = { x, y };
    }
    place(id: WaylandObjectId2<"wl_subsurface">, sibling: WaylandObjectId2<"wl_surface">, above: boolean) {
        const sub = this.wl_subsurface[id];
        if (sub === undefined) return false;
        // 参考面不能是自己；父 surface 本身表示栈底/栈顶
        if (sibling === sub.child) return false;
        let siblingRelationId: WaylandObjectId2<"wl_subsurface"> | undefined;
        if (sibling !== sub.parent) {
            siblingRelationId = this.surface2subsurface.get(sibling);
            if (siblingRelationId === undefined) return false;
            const siblingSub = this.wl_subsurface[siblingRelationId];
            if (siblingSub === undefined || siblingSub.parent !== sub.parent) return false;
        }

        const list = [...(this.pendingChildren.get(sub.parent) ?? [])];
        const selfIndex = list.indexOf(id);
        if (selfIndex === -1) return false;
        list.splice(selfIndex, 1);

        if (siblingRelationId === undefined) {
            if (above) list.push(id);
            else list.unshift(id);
        } else {
            const siblingIndex = list.indexOf(siblingRelationId);
            if (siblingIndex === -1) return false;
            list.splice(above ? siblingIndex + 1 : siblingIndex, 0, id);
        }
        this.pendingChildren.set(sub.parent, list);
        return true;
    }
    setSync(id: WaylandObjectId2<"wl_subsurface">, sync: boolean) {
        const sub = this.wl_subsurface[id];
        if (sub !== undefined) sub.syncMode = sync;
    }
    isSynchronized(surface: WaylandObjectId2<"wl_surface">): boolean {
        // 同步会沿子树递归：自己的模式是 desync，但祖先还是 sync 时仍按同步处理。
        // 还没进入父 surface 已生效状态的子 surface 也先缓存，等父提交把它接进树。
        let current = surface;
        const seen = new Set<number>();
        while (true) {
            if (seen.has(current)) return false; // 防御：关系成环时不要卡死
            seen.add(current);
            const subId = this.surface2subsurface.get(current);
            if (subId === undefined) return false; // 主 surface 永远按 desync 处理
            const sub = this.wl_subsurface[subId];
            if (sub === undefined) return false;
            if (!sub.active || sub.syncMode) return true;
            current = sub.parent;
        }
    }
    /**
     * 父 surface 的状态生效：复制挂起堆叠顺序、应用 set_position、重排 DOM。
     * 返回当前生效的子 surface（底 → 顶），调用方接着应用它们缓存的提交。
     */
    applyPending(parent: WaylandObjectId2<"wl_surface">): WaylandObjectId2<"wl_surface">[] {
        const pending = this.pendingChildren.get(parent) ?? [];
        const active = this.parentChildren.get(parent) ?? [];
        const changed = pending.length !== active.length || pending.some((subId, i) => subId !== active[i]);

        if (pending.length === 0) this.parentChildren.delete(parent);
        else this.parentChildren.set(parent, [...pending]);

        const children: WaylandObjectId2<"wl_surface">[] = [];
        for (const subId of pending) {
            const sub = this.wl_subsurface[subId];
            if (sub === undefined) continue;
            sub.active = true;
            children.push(sub.child);
            if (changed) this.render.setCanvasAnchor(this.idScope(sub.child), this.idScope(parent));
            if (sub.posi.x !== sub.pendingPos.x || sub.posi.y !== sub.pendingPos.y) {
                sub.posi = { ...sub.pendingPos };
                this.render.setCanvasOffset(this.idScope(sub.child), sub.posi.x, sub.posi.y);
            }
        }
        return children;
    }
    getSubSurface(id: WaylandObjectId2<"wl_subsurface">) {
        return {
            parent: this.wl_subsurface[id].parent,
            surface: this.wl_subsurface[id].child,
            posi: this.wl_subsurface[id].posi,
        };
    }
    getParent(child: WaylandObjectId2<"wl_surface">) {
        const relation = this.surface2subsurface.get(child);
        return relation === undefined ? undefined : this.wl_subsurface[relation]?.parent;
    }
    getChildrenDeep(parent: WaylandObjectId2<"wl_surface">) {
        const surfaces: {
            id: WaylandObjectId2<"wl_surface">;
            offsetRect: { x: number; y: number; w: number; h: number };
        }[] = [];

        // 递归并累加每层 set_position：返回的 offsetRect 都在 parent 坐标系里，
        // 命中检测与缩略图合成都直接可用（Firefox/GTK 会用多层子表面）。
        // 顺序按生效的堆叠顺序（底 → 顶），调用方 toReversed() 就能从最上层开始命中。
        const walk = (parentId: WaylandObjectId2<"wl_surface">, baseX: number, baseY: number) => {
            for (const subId of this.parentChildren.get(parentId) ?? []) {
                const sub = this.wl_subsurface[subId];
                if (sub === undefined) continue;
                const x = baseX + sub.posi.x;
                const y = baseY + sub.posi.y;
                const size = this.wl_surface.getWlSurface(sub.child).size;
                surfaces.push({ id: sub.child, offsetRect: { x, y, w: size.w, h: size.h } });
                walk(sub.child, x, y);
            }
        };
        walk(parent, 0, 0);
        return surfaces;
    }
    destroySubSurface(id: WaylandObjectId2<"wl_subsurface">) {
        const relation = this.wl_subsurface[id];
        if (relation === undefined) return;
        this.detachChild(relation.parent, id);
        this.surface2subsurface.delete(relation.child);
        delete this.wl_subsurface[id];
    }

    /** 挂起树里是否包含 target（新增子 surface 还没生效，也要参与成环检查） */
    private isDescendant(parent: WaylandObjectId2<"wl_surface">, target: WaylandObjectId2<"wl_surface">) {
        const stack = [parent];
        const seen = new Set<number>();
        while (stack.length > 0) {
            const current = stack.pop();
            if (current === undefined || seen.has(current)) continue;
            seen.add(current);
            for (const subId of this.pendingChildren.get(current) ?? []) {
                const sub = this.wl_subsurface[subId];
                if (sub === undefined) continue;
                if (sub.child === target) return true;
                stack.push(sub.child);
            }
        }
        return false;
    }

    /**
     * 从父 surface 的子表里摘掉一条关系（生效表与挂起表都摘）；摘空后直接删 key。
     * 只 set 空数组的话，反复建/毁子表面的长跑客户端会按父 surface 攒一堆空数组。
     */
    private detachChild(parent: WaylandObjectId2<"wl_surface">, subRelationId: WaylandObjectId2<"wl_subsurface">) {
        for (const map of [this.parentChildren, this.pendingChildren]) {
            const list = map.get(parent);
            if (list === undefined) continue;
            const next = list.filter((c) => c !== subRelationId);
            if (next.length === 0) map.delete(parent);
            else map.set(parent, next);
        }
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

/**
 * 解析 `input.*` 的 `seat` 参数：**选择器语义**，缺省 `"seat0"`（本机光标），不是广播位——
 * 一个 seat = 一个人的一套设备，同一事件发给多个 seat 会被客户端当成 N 把同步光标（点击双发）。
 */
function resolveSeat(ctx: ModuleCtx, name?: string): SeatRecord | undefined {
    const seat = ctx.domain.seat.byName(name ?? "seat0");
    if (seat === undefined) console.warn(`Unknown seat: ${String(name)}`);
    return seat;
}

/**
 * 这个 `wl_seat` global 是 registry 广播的**第几个** → seat 名（`seat0`/`seat1`…）。
 * 按**广播顺序**算而不是 bind 顺序：客户端只 bind 第二把时它也得叫 seat1，
 * 否则 `input.*` 的 seat 选择器会把事件喂错人。
 */
function seatNameOf(ctx: ModuleCtx, msg: BindMsg): string {
    const index = [...ctx.core.registry.globals()]
        .filter((g) => g.protocol.name === msg.protocol.name)
        .findIndex((g) => g.name === msg.name);
    return `seat${index < 0 ? 0 : index}`;
}

function activePointers(ctx: ModuleCtx, seat: SeatRecord): WaylandObjectId2<"wl_pointer">[] {
    return [...seat.pointers].filter((id) => ctx.objects.has(id));
}

function activeKeyboards(ctx: ModuleCtx, seat: SeatRecord): WaylandObjectId2<"wl_keyboard">[] {
    return [...seat.keyboards].filter((id) => ctx.objects.has(id));
}

function activeTouches(ctx: ModuleCtx, seat: SeatRecord): WaylandObjectId2<"wl_touch">[] {
    return [...seat.touches].filter((id) => ctx.objects.has(id));
}

/**
 * 取消该连接在这把 seat 上的全部触摸点。`wl_touch.cancel` 没有 id、按对象整体取消，
 * 所以不能只撤一个点：清空 touchPoints 后给每个 wl_touch 发一次 cancel。
 */
function cancelTouchPoints(ctx: ModuleCtx, seat: SeatRecord): void {
    if (seat.touchPoints.size === 0) return;
    seat.touchPoints.clear();
    for (const touch of activeTouches(ctx, seat)) touchCancel(ctx, touch);
}

/**
 * 焦点离开前的键盘收尾：`leave` 之后客户端不能再收到 `key`，所以按住的键必须在 `leave` 前补 release，
 * 然后清空逻辑按键与修饰位。
 *
 * 清空让桌面稍后补发的真实 release 变成「没有 press 的 release」，由 `sendKey` 去重吞掉；
 * 和指针 grab / 触摸 cancel 的收尾语义一致：焦点切换不再保留上一焦点的按键状态。
 */
function releaseKeyboardKeys(ctx: ModuleCtx, seat: SeatRecord): void {
    const keyboards = activeKeyboards(ctx, seat);
    const { keys, modifiersChanged } = ctx.domain.seat.takePressedKeys(seat);
    const time = Date.now();
    for (const key of keys) {
        const serial = ctx.domain.serial.next();
        for (const keyboard of keyboards) keyboardKey(ctx, keyboard, serial, time, key, "released");
    }
    if (!modifiersChanged || keyboards.length === 0) return;
    const serial = ctx.domain.serial.next();
    const mask = ctx.domain.seat.modifierMask(seat);
    for (const keyboard of keyboards) keyboardModifiers(ctx, keyboard, serial, mask);
}

/**
 * 键盘焦点单写入点：同值去重；变化时先给旧焦点收尾（补 release + 清状态），
 * 再发 `leave`(旧) → `enter`(新) + `modifiers`。
 *
 * `enter.keys` 带该连接当前逻辑按下的键；正常焦点切换已经收尾为空，
 * 快照留给新 `wl_keyboard` 绑定和异常残留。
 */
function focusKeyboard(ctx: ModuleCtx, surface: SurfaceId | null, seatName?: string): void {
    const seat = ctx.domain.seat.byName(seatName ?? "seat0");
    if (seat === undefined) return;
    const prev = seat.keyboardFocus;
    if (prev === surface) return;
    const keyboards = activeKeyboards(ctx, seat);
    if (prev !== null) {
        // surface 已经销毁时连 `leave` 都发不出去：只取走状态，避免下次 `enter` 把旧键带回来
        if (ctx.objects.has(prev)) releaseKeyboardKeys(ctx, seat);
        else ctx.domain.seat.takePressedKeys(seat);
    }
    if (prev !== null && ctx.objects.has(prev)) {
        const serial = ctx.domain.serial.next();
        for (const keyboard of keyboards) keyboardLeave(ctx, keyboard, serial, prev);
    }
    if (surface !== null) {
        const enterSerial = ctx.domain.serial.next();
        const modifiersSerial = ctx.domain.serial.next();
        const keys = Uint32Array.from(seat.pressedKeys);
        for (const keyboard of keyboards) {
            keyboardEnter(ctx, keyboard, enterSerial, surface, keys);
            keyboardModifiers(ctx, keyboard, modifiersSerial, ctx.domain.seat.modifierMask(seat));
        }
    }
    seat.keyboardFocus = surface;
    ctx.notify.focus(seat.name, surface ?? undefined);
    if (surface === null) clearSelection(ctx, seat.name);
}

/**
 * 指针焦点转移：**只管指针**，hover 是否改键盘焦点是桌面政策。
 * 不同 surface 先 leave 旧、再 enter 新；同 surface 只更新坐标。
 * 已销毁的旧 surface 不再引用（不能给死对象发 leave），直接清槽。
 */
function updatePointerFocus(ctx: ModuleCtx, seat: SeatRecord, hit: HitTestResult): void {
    const prevFocus = seat.pointerFocus;
    const pointers = activePointers(ctx, seat);
    // 坐标每次都更新：后创建的 pointer 需要能补发 enter
    seat.pointerPos = { x: hit.x, y: hit.y };
    if (prevFocus === hit.surface) return;
    if (prevFocus !== null && ctx.objects.has(prevFocus)) {
        const serial = ctx.domain.serial.next();
        for (const p of pointers) pointerLeave(ctx, p, serial, prevFocus);
    }
    const serial = ctx.domain.serial.next();
    for (const p of pointers) {
        pointerEnter(ctx, p, serial, hit.surface, hit.x, hit.y);
        pointerFrame(ctx, p);
    }
    seat.pointerFocus = hit.surface;
}

/** 桌面 `PointerCommand.button`（DOM 编号）→ Linux 键码；grab 与 `wl_pointer.button` 共用这个码空间 */
function pointerButtonCode(button: number): number {
    switch (button) {
        case 1:
            return InputEventCodes.BTN_MIDDLE;
        case 2:
            return InputEventCodes.BTN_RIGHT;
        case 3:
            return InputEventCodes.BTN_SIDE;
        case 4:
            return InputEventCodes.BTN_EXTRA;
        default:
            return InputEventCodes.BTN_LEFT;
    }
}

/**
 * 指针离开所有 surface：发 leave 并清槽。没有活跃 grab 时才允许调用——
 * grab 期间 pointer focus 必须固定在按下 surface 上。
 */
function clearPointerFocus(ctx: ModuleCtx, seat: SeatRecord): void {
    const prev = seat.pointerFocus;
    if (prev === null) return;
    const pointers = activePointers(ctx, seat);
    if (ctx.objects.has(prev)) {
        const serial = ctx.domain.serial.next();
        for (const p of pointers) pointerLeave(ctx, p, serial, prev);
    }
    seat.pointerFocus = null;
}

/**
 * 强制结束隐式 grab：仍按住的按钮先补 `button(released)`，再清空按钮集合。
 * grab 对象保留（buttons 为空），让 `isUserActionSerial` 仍能校验延迟到达的 move/grab。
 *
 * - `cancel` / `destroy`：补 release，并 leave 当前 pointer focus；
 * - `compositor`：设备被合成器接管，只 leave，不补 release（客户端靠 leave 重置）。
 */
export function forcePointerGrab(ctx: ModuleCtx, seat: SeatRecord, reason: "cancel" | "destroy" | "compositor"): void {
    const grab = seat.pointerGrab;
    if (grab === undefined || grab.buttons.size === 0) return;
    const buttons = [...grab.buttons];
    const focusAlive = seat.pointerFocus !== null && ctx.objects.has(seat.pointerFocus);
    if (reason !== "compositor" && focusAlive && seat.pointerFocus === grab.surface) {
        const pointers = activePointers(ctx, seat);
        const time = Date.now();
        for (const pointer of pointers) {
            for (const button of buttons) {
                pointerButton(ctx, pointer, ctx.domain.serial.next(), time, button, "released");
            }
            pointerFrame(ctx, pointer);
        }
    }
    for (const button of buttons) grab.buttons.delete(button);
    if (seat.pointerFocus !== null) clearPointerFocus(ctx, seat);
    // 拖拽是被这次 grab 驱动的：grab 没了，拖拽也必须结束。
    // 桌面驱动的会话已经由 dnd hub 收尾，只清本地状态，避免重复 dnd_finished/cancelled。
    const drag = ctx.domain.dataDevice.drag;
    if (drag !== undefined && drag.seatName === seat.name) {
        if (drag.remoteDriven) ctx.domain.dataDevice.drag = undefined;
        else cancelDrag(ctx);
    }
}

/**
 * 一组 surface 即将消失（popup 销毁、`attach(nil)` 解 map 等）时结束以它们为目标的隐式 grab。
 *
 * 只按根 surface 比对不够：客户端（Firefox 的弹层）常把内容放在 subsurface 上，按下的
 * surface 就是 subsurface；popup 销毁后这个 surface 可能还活着但不显示，grab 不清掉
 * 会让之后的 motion/button 一直喂给它。surface 还活着时先补 release，再清 focus。
 */
export function endPointerGrabForSurfaces(
    ctx: ModuleCtx,
    surfaces: Iterable<SurfaceId>,
    reason: "cancel" | "destroy" = "destroy",
): void {
    const set = new Set(surfaces);
    if (set.size === 0) return;
    for (const seat of ctx.domain.seat.all()) {
        const grab = seat.pointerGrab;
        if (grab === undefined || grab.buttons.size === 0 || !set.has(grab.surface)) continue;
        forcePointerGrab(ctx, seat, reason);
    }
}

/**
 * 指针事件注入（发给这一把 seat 的全部 pointer）：坐标已由 hitTest 归一到 surface 局部。
 * 返回本次 button 事件的 serial；move 或没有 pointer 资源时返回 undefined。
 */
function sendPointer(ctx: ModuleCtx, seat: SeatRecord, ev: PointerCommand, hit: HitTestResult): number | undefined {
    // 移动先同步 DnD；抬起时先发 wl_pointer.button（和 KWin 一样），再结束拖拽发 drop
    if (ev.type === "move" && ctx.domain.dataDevice.drag) updateDrag(ctx, "move", hit);
    const pointers = activePointers(ctx, seat);
    if (pointers.length === 0) {
        if (ev.type === "up" && ctx.domain.dataDevice.drag) updateDrag(ctx, "up", hit);
        return undefined;
    }
    const { x: nx, y: ny } = hit;
    seat.pointerPos = { x: nx, y: ny };
    const time = Date.now();
    if (ev.type === "move") {
        for (const pointer of pointers) {
            pointerMotion(ctx, pointer, time, nx, ny);
            pointerFrame(ctx, pointer);
        }
        return undefined;
    }
    const button = pointerButtonCode(ev.button);
    const serial = ctx.domain.serial.next();
    for (const pointer of pointers) {
        pointerButton(ctx, pointer, serial, time, button, ev.type === "down" ? "pressed" : "released");
        pointerFrame(ctx, pointer);
    }
    if (ev.type === "up" && ctx.domain.dataDevice.drag) updateDrag(ctx, "up", hit);
    return serial;
}

/**
 * 解绑后的 surface 不应继续留在画面/命中测试里：
 * 工作画布缩成 1×1 透明帧（DOM canvas 同步缩小），surface 尺寸置 0；
 * 下次 attach buffer 时尺寸变化会重新走 updateWlSurfaceSize + render。
 */
function unmapSurface(ctx: ModuleCtx, surfaceId: SurfaceId): void {
    const surface = ctx.objects.getOption(surfaceId);
    const canvas = surface?.data.canvas;
    if (!surface || !canvas) return;
    // 让还在异步导入的旧提交过期，避免解绑/销毁后又被画回来；
    // 排队中的呈现/待释放资源也要撤掉，否则会把旧画面重新画回去或卡住 buffer。
    surface.data.renderSeq = (surface.data.renderSeq ?? 0) + 1;
    discardPendingPresent(ctx, surfaceId);
    canvas.width = 1;
    canvas.height = 1;
    ctx.core.surface.updateWlSurfaceSize(surfaceId, 0, 0);
    ctx.core.surface.renderWlSurface(surfaceId, canvas);
}

/**
 * 按键注入：状态转移（去重、`pressedKeys` / 修饰位）交给 `SeatStore`，这里只组包下发。
 * 只有存在焦点时才真正发 `wl_keyboard.key`；焦点离开时已经补发 release 并清空，
 * 所以桌面迟到的真实 release 在这里被 `releaseKey` 吞掉。
 * 修饰键按该 seat 的掩码补发 `wl_keyboard.modifiers`（两把键盘各记各的；todo repeat）。
 */
function sendKey(ctx: ModuleCtx, seat: SeatRecord, key: number, state: "pressed" | "released"): void {
    const store = ctx.domain.seat;
    const changed = state === "pressed" ? store.pressKey(seat, key) : store.releaseKey(seat, key);
    if (!changed) return;

    const keyboards = activeKeyboards(ctx, seat);
    if (seat.keyboardFocus === null || keyboards.length === 0) return;

    const serial = ctx.domain.serial.next();
    if (state === "pressed") store.noteKeyboardPress(seat, serial);
    const time = Date.now();
    for (const keyboard of keyboards) keyboardKey(ctx, keyboard, serial, time, key, state);
    if (MOD_KEY_TO_BIT[key] === undefined) return;
    const mask = store.modifierMask(seat);
    for (const keyboard of keyboards) keyboardModifiers(ctx, keyboard, serial, mask);
}

/**
 * 取窗口主 surface：`input.key` 的 handle 是桌面侧窗口身份，键盘状态机需要落到 surface。
 * 窗口不在（已销毁/不是 xdg）时返回 null。
 */
function mainSurfaceOfToplevel(ctx: ModuleCtx, winId: WaylandWinId): SurfaceId | null {
    const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByToplevel(winId);
    if (xdgSurfaceId === undefined) return null;
    const info = ctx.domain.xdgSurface.getXdgSurface(xdgSurfaceId);
    return info?.surface ?? null;
}

function surfaceInToplevel(ctx: ModuleCtx, surface: SurfaceId, winId: WaylandWinId): boolean {
    const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByWlSurface(surface);
    if (xdgSurfaceId === undefined) return false;
    return ctx.domain.xdgSurface.rootXdgSurface(xdgSurfaceId) === ctx.domain.xdgSurface.getXdgSurfaceByToplevel(winId);
}

/**
 * 滚动/手势这类没有坐标的事件：如果当前 pointer focus 不在目标窗口上，就以窗口主 surface
 * 补一次 enter（坐标沿用最近一次 pointerPos）。桌面已经做过命中，这里只补协议前置状态。
 */
function ensurePointerFocusForWindow(ctx: ModuleCtx, seat: SeatRecord, winId: WaylandWinId): boolean {
    const xdgSurfaceId = ctx.domain.xdgSurface.getXdgSurfaceByToplevel(winId);
    if (xdgSurfaceId === undefined) return false;
    if (seat.pointerFocus !== null && surfaceInToplevel(ctx, seat.pointerFocus, winId)) return true;
    const mainSurface = ctx.domain.xdgSurface.getXdgSurface(xdgSurfaceId).surface;
    updatePointerFocus(ctx, seat, {
        surface: mainSurface,
        xdgSurface: xdgSurfaceId,
        x: seat.pointerPos.x,
        y: seat.pointerPos.y,
        role: "main",
    });
    return true;
}

/**
 * 滚动注入（发给这一把 seat 的全部 pointer；没有指针焦点说明指针不在任何窗口上，丢弃）。
 *
 * 滚轮和触摸板必须分开编码：
 * - `wheel`：一格 = `delta` 100px（桌面约定）+ `value120` 120。`axis` 按 Wayland 惯例
 *   一格发 10 surface-local px，同时按客户端版本发 `axis_value120`（v8+）或
 *   `axis_discrete`（v5-7）。高精度滚轮两种事件可以同帧一起发（KWin 也这么做）。
 * - `finger` / `continuous`：`axis` 就是 surface-local 像素，连续且无离散步进；
 *   按协议不生成 `axis_discrete` / `axis_value120`（触摸板没有滚轮格）。
 *
 * v9 起可带 `axis_relative_direction`，告诉客户端物理手指方向与 axis 方向是否相反
 * （自然滚动），供音量滑块之类控件校正方向。
 *
 * 连续滚动结束（`stop`）补 `axis_stop`，客户端据此结束滚动序列并启动惯性。
 */
function sendScroll(ctx: ModuleCtx, seat: SeatRecord, ev: ScrollCommand): void {
    const pointers = [...seat.pointers].filter((id) => ctx.objects.has(id));
    if (pointers.length === 0 || seat.pointerFocus === null) return;
    const source = ev.source ?? "wheel";
    const { deltaX, deltaY } = ev;
    const stop = ev.stop === true;
    if (!stop && deltaX === 0 && deltaY === 0) return;
    // 一格滚轮在桌面 delta 里是 100px，在 Wayland axis 里是 10px、在 value120 里是 120
    const axisPerPx = 10 / 100;
    const value120PerPx = 120 / 100;
    for (const pointer of pointers) {
        // 同一把 seat 上可能有多把不同版本的指针，按各自的版本挑事件
        const pointerVersion = ctx.objects.getOption(pointer)?.version ?? 0;
        if (pointerVersion >= 5) {
            pointerAxisSource(ctx, pointer, getEnumValue("wl_pointer.axis_source", source));
        }
        const sendAxis = (
            axis: "horizontal_scroll" | "vertical_scroll",
            delta: number,
            /** 调用方给的高精度滚轮值；缺省按 delta 换算 */
            value120: number | undefined,
        ) => {
            if (delta === 0) return;
            const axisValue = getEnumValue("wl_pointer.axis", axis);
            // axis_relative_direction 与 axis 同帧、紧跟其前
            if (pointerVersion >= 9 && ev.relativeDirection !== undefined) {
                pointerAxisRelativeDirection(
                    ctx,
                    pointer,
                    axisValue,
                    getEnumValue("wl_pointer.axis_relative_direction", ev.relativeDirection),
                );
            }
            if (source === "wheel") {
                const steps120 = value120 ?? delta * value120PerPx;
                if (pointerVersion >= 5 && pointerVersion < 8) {
                    // axis_discrete 必须紧跟在同一 frame 的 axis 之前
                    const discrete = Math.round(steps120 / 120);
                    if (discrete !== 0) pointerAxisDiscrete(ctx, pointer, axisValue, discrete);
                } else if (pointerVersion >= 8) {
                    // 高精度滚轮：value120 与 axis 同帧，value120 在前（与 KWin 一致）
                    const steps = Math.round(steps120);
                    if (steps !== 0) pointerAxisValue120(ctx, pointer, axisValue, steps);
                }
                pointerAxis(ctx, pointer, Date.now(), axisValue, delta * axisPerPx);
            } else {
                // 连续滚动：axis 直接是 surface-local 像素，不带离散步进
                pointerAxis(ctx, pointer, Date.now(), axisValue, delta);
            }
        };
        sendAxis("horizontal_scroll", deltaX, ev.value120X);
        sendAxis("vertical_scroll", deltaY, ev.value120Y);
        // 连续滚动结束（触摸板抬手）。客户端按自己滚动的轴处理，两个轴都发一遍。
        if (stop && source !== "wheel" && pointerVersion >= 5) {
            pointerAxisStop(ctx, pointer, Date.now(), getEnumValue("wl_pointer.axis", "horizontal_scroll"));
            pointerAxisStop(ctx, pointer, Date.now(), getEnumValue("wl_pointer.axis", "vertical_scroll"));
        }
        pointerFrame(ctx, pointer);
    }
}

/** 撤掉某把 seat 上发给该客户端的 selection（`id` 可空：0 即「无选择」） */
function clearSelection(ctx: ModuleCtx, seatName: string): void {
    const set = ctx.domain.dataDevice.devices?.get(seatName);
    if (set === undefined) return;
    for (const ddId of set)
        ctx.sendNow(ddId, "wl_data_device.selection", {
            id: 0 as unknown as WaylandObjectId2<"wl_data_offer">,
        });
}

/** wl_data_device_manager.dnd_action 的 copy/move（v3 事件；低版本由 host 按 since 丢弃） */
const DND_ACTION_COPY = getEnumValue("wl_data_device_manager.dnd_action", "copy") ?? 1;
const DND_ACTION_MOVE = getEnumValue("wl_data_device_manager.dnd_action", "move") ?? 2;

/** 在 source 支持的动作里选目标首选的动作；目标没有可接受动作时返回 none */
function chooseDndAction(sourceActions: number, targetActions: number, preferred: number): number {
    if (targetActions === 0) return 0;
    if (preferred !== 0 && (preferred & targetActions) !== 0 && (preferred & sourceActions) !== 0) return preferred;
    if ((sourceActions & DND_ACTION_COPY) !== 0 && (targetActions & DND_ACTION_COPY) !== 0) return DND_ACTION_COPY;
    if ((sourceActions & DND_ACTION_MOVE) !== 0 && (targetActions & DND_ACTION_MOVE) !== 0) return DND_ACTION_MOVE;
    return 0;
}

/** dnd_action 位掩码 → 桌面可读的动作名 */
function dndActionNames(mask: number): ("copy" | "move")[] {
    const actions: ("copy" | "move")[] = [];
    if ((mask & DND_ACTION_COPY) !== 0) actions.push("copy");
    if ((mask & DND_ACTION_MOVE) !== 0) actions.push("move");
    return actions;
}

type DataDrag = NonNullable<ModuleCtx["domain"]["dataDevice"]["drag"]>;

/**
 * 发起/切换拖拽目标：先给目标 data_device 发 data_offer + offer，再发 enter。
 * 目前只支持同 client（目标 surface 必须在本客户端对象表里），跨 client 会取消。
 */
function sendDragEnter(ctx: ModuleCtx, drag: DataDrag, surface: SurfaceId, x: number, y: number): void {
    const src = ctx.objects.getOption(drag.sourceId);
    if (!src) {
        cancelDrag(ctx);
        return;
    }
    if (drag.offerId !== undefined) ctx.sendNow(drag.dataDeviceId, "wl_data_device.leave", {});
    const offerId = ctx.objects.create("wl_data_offer", ctx.objects.getOption(drag.dataDeviceId)?.version);
    ctx.objects.setData(offerId, { mimeTypes: [...src.data.offers], sourceId: drag.sourceId, drag: true });
    ctx.sendNow(drag.dataDeviceId, "wl_data_device.data_offer", { id: offerId });
    for (const mime of src.data.offers) ctx.sendNow(offerId, "wl_data_offer.offer", { mime_type: mime });
    ctx.sendNow(offerId, "wl_data_offer.source_actions", { source_actions: src.data.actions ?? DND_ACTION_COPY });
    const serial = ctx.domain.serial.next();
    ctx.sendNow(drag.dataDeviceId, "wl_data_device.enter", { serial, surface, x, y, id: offerId });
    drag.offerId = offerId;
    drag.surface = surface;
}

/** drop 后目标取完数据（或超时）再给 source 补 dnd_finished */
function finishDragSource(ctx: ModuleCtx, sourceId: WaylandObjectId2<"wl_data_source">): void {
    const finish = ctx.domain.dataDevice.dragFinish;
    if (!finish || finish.sourceId !== sourceId) return;
    clearTimeout(finish.timer);
    ctx.domain.dataDevice.dragFinish = undefined;
    if (ctx.objects.has(sourceId)) ctx.sendNow(sourceId, "wl_data_source.dnd_finished", {});
}

/** 指针在目标上松开：drop + action + dnd_drop_performed */
function finishDrag(ctx: ModuleCtx): void {
    const drag = ctx.domain.dataDevice.drag;
    if (!drag) return;
    ctx.domain.dataDevice.drag = undefined;
    ctx.transfer.dragFinished(drag.sourceId, "finished");
    const offer = drag.offerId !== undefined ? ctx.objects.getOption(drag.offerId) : undefined;
    const action = offer?.data?.selectedAction ?? DND_ACTION_COPY;
    if (drag.offerId !== undefined) {
        ctx.sendNow(drag.offerId, "wl_data_offer.action", { dnd_action: action });
    }
    ctx.sendNow(drag.dataDeviceId, "wl_data_device.drop", {});
    if (!ctx.objects.has(drag.sourceId)) return;
    ctx.sendNow(drag.sourceId, "wl_data_source.action", { dnd_action: action });
    ctx.sendNow(drag.sourceId, "wl_data_source.dnd_drop_performed", {});
    // dnd_finished 要等目标 receive/finish 数据后由目标触发；客户端不按时 finish 时兜底
    const timer = setTimeout(() => finishDragSource(ctx, drag.sourceId), 500);
    (timer as { unref?: () => void }).unref?.();
    ctx.domain.dataDevice.dragFinish = { sourceId: drag.sourceId, timer };
}

function cancelDrag(ctx: ModuleCtx): void {
    const drag = ctx.domain.dataDevice.drag;
    if (!drag) return;
    ctx.domain.dataDevice.drag = undefined;
    ctx.transfer.dragFinished(drag.sourceId, "cancelled");
    ctx.sendNow(drag.dataDeviceId, "wl_data_device.leave", {});
    if (ctx.objects.has(drag.sourceId)) ctx.sendNow(drag.sourceId, "wl_data_source.cancelled", {});
}

/** 把指针事件同步到进行中的拖拽；目标离开本 client 时取消 */
function updateDrag(ctx: ModuleCtx, type: "move" | "down" | "up", hit: HitTestResult): void {
    const drag = ctx.domain.dataDevice.drag;
    if (!drag || drag.remoteDriven) return;
    if (!ctx.objects.has(hit.surface)) {
        cancelDrag(ctx);
        return;
    }
    if (type === "move") {
        if (hit.surface !== drag.surface) sendDragEnter(ctx, drag, hit.surface, hit.x, hit.y);
        else ctx.sendNow(drag.dataDeviceId, "wl_data_device.motion", { time: Date.now(), x: hit.x, y: hit.y });
    } else if (type === "up") {
        finishDrag(ctx);
    }
}

/**
 * 把 selection offer 给本连接的数据设备。
 *
 * `selection` 为 null / 空 mime 时发送 `selection(nil)`，让客户端知道剪贴板已清空。
 * 字节不在 core：offer 只带 token，真正 `receive` 时交给 `ctx.transfer`。
 */
function offerTo(ctx: ModuleCtx, selection: ClipboardOffer | null, seatName?: string): void {
    const devices = ctx.domain.dataDevice.devices;
    if (!devices) return;
    let ddIds: WaylandObjectId2<"wl_data_device">[];
    if (seatName !== undefined) {
        ddIds = [...(devices.get(seatName) ?? [])];
    } else {
        const focused = [...ctx.domain.seat.all()].flatMap((s) => [...(devices.get(s.name) ?? [])]);
        // 没有焦点（桌面 `clipboard.offer` 调得比 `window.focus` 早）→ 退回全发
        ddIds = focused.length > 0 ? focused : [...devices.values()].flatMap((s) => [...s]);
    }

    for (const ddId of ddIds) {
        if (selection === null || selection.mimes.length === 0) {
            ctx.sendNow(ddId, "wl_data_device.selection", {
                id: 0 as unknown as WaylandObjectId2<"wl_data_offer">,
            });
            continue;
        }
        const dataOfferId = ctx.objects.create("wl_data_offer", ctx.objects.getOption(ddId)?.version);
        ctx.objects.setData(dataOfferId, { mimeTypes: [...selection.mimes], token: selection.token });
        ctx.sendNow(ddId, "wl_data_device.data_offer", { id: dataOfferId });
        for (const mime of selection.mimes) {
            ctx.sendNow(dataOfferId, "wl_data_offer.offer", { mime_type: mime });
        }
        ctx.sendNow(ddId, "wl_data_device.selection", { id: dataOfferId });
    }
}

/**
 * 同步子 surface 的提交缓存：不更新 current、不合成像素，按提交顺序排队，
 * 等父 surface 状态生效时依次应用。每个提交的 buffer/damage 都是独立状态，
 * 不能合成一个：后一个 buffer 未覆盖的区域可能仍是前一个 buffer 里的内容。
 */
function cacheSurfaceState(ctx: ModuleCtx, surfaceId: SurfaceId, data: WaylandSurfaceData): void {
    const surface = ctx.objects.get(surfaceId);
    const cache = surface.data.cache;
    if (cache === undefined) surface.data.cache = [data];
    else cache.push(data);
}

/**
 * 按 surface 串行应用提交状态（同一批缓存状态也按顺序）。
 *
 * 像素必须按提交顺序贴进画布：damage 是「相对上一次 commit」的，异步导入乱序
 * 完成会让后面的 damage 先落地、前面的被丢弃。队列同时是 dmabuf 的背压：buffer
 * 要等它的像素进画布才 release，客户端想过量提交只会卡在自己的 buffer 上。
 */
function enqueueSurfaceStates(ctx: ModuleCtx, surfaceId: SurfaceId, states: WaylandSurfaceData[]): void {
    const surface = ctx.objects.getOption(surfaceId);
    if (!surface) return;
    if (surface.data.queuedStates === undefined) surface.data.queuedStates = [];
    surface.data.queuedStates.push(...states);
    if (surface.data.draining === true) return;
    surface.data.draining = true;
    // 空闲时在 commit 的同一次调用里同步开始（applySurfaceState 在第一个 await
    // 之前是同步的：shm 的格式转换和 buffer 查表不跨任务）。
    void drainSurfaceStates(ctx, surfaceId);
}

/** 依次应用排队的提交；队列排空后停，下一次提交再同步启动 */
async function drainSurfaceStates(ctx: ModuleCtx, surfaceId: SurfaceId): Promise<void> {
    try {
        for (;;) {
            const surface = ctx.objects.getOption(surfaceId);
            const state = surface?.data.queuedStates?.shift();
            if (surface === undefined || state === undefined) return;
            await applySurfaceState(ctx, surfaceId, state);
        }
    } catch (error) {
        console.error(`apply surface state failed (surface ${surfaceId}):`, error);
    } finally {
        const surface = ctx.objects.getOption(surfaceId);
        if (surface) surface.data.draining = false;
    }
}

/** 丢弃尚未生效的缓存并归还其中的 buffer（surface/子 surface 销毁、关系解除时） */
function discardCachedState(ctx: ModuleCtx, surfaceId: SurfaceId): void {
    const surface = ctx.objects.getOption(surfaceId);
    const cache = surface?.data.cache;
    if (surface === undefined || cache === undefined) return;
    surface.data.cache = undefined;
    releaseStateBuffers(ctx, cache);
}

/** 归还一组未应用提交里挂着的 buffer（同一对象只还一次） */
function releaseStateBuffers(ctx: ModuleCtx, states: WaylandSurfaceData[]): void {
    const bufferIds = new Set<WaylandObjectId2<"wl_buffer">>();
    for (const state of states) {
        const buffer = state.buffer;
        if (buffer) bufferIds.add(buffer.id);
    }
    for (const id of bufferIds) {
        if (ctx.objects.has(id)) ctx.sendNow(id, "wl_buffer.release", {});
    }
}

/** surface 销毁时丢弃还没应用的提交，否则这些 buffer 永远不会 release */
function discardQueuedStates(ctx: ModuleCtx, surfaceId: SurfaceId): void {
    const surface = ctx.objects.getOption(surfaceId);
    const queue = surface?.data.queuedStates;
    if (surface === undefined || queue === undefined) return;
    surface.data.queuedStates = undefined;
    releaseStateBuffers(ctx, queue);
}

/**
 * surface 状态生效后，应用中子 surface 的挂起位置/堆叠，再依次应用它们排队的提交。
 * 缓存状态会继续走 applySurfaceState，从而递归应用到更深的子 surface。
 */
async function applySubsurfaceChildren(ctx: ModuleCtx, parent: SurfaceId): Promise<void> {
    if (!ctx.objects.has(parent)) return;
    for (const child of ctx.core.subsurface.applyPending(parent)) {
        const surface = ctx.objects.getOption(child);
        if (surface === undefined) continue;
        const cache = surface.data.cache;
        if (cache === undefined) continue;
        // 取走缓存：父 surface 后续的提交不能重复应用旧状态
        surface.data.cache = undefined;
        enqueueSurfaceStates(ctx, child, cache);
    }
}

/**
 * 应用一次 surface 提交（直接提交，或父 surface 生效时按顺序取出的同步缓存）。
 *
 * 更新 current、合成像素、回 frame callback，最后应用子 surface 的挂起位置/堆叠与缓存。
 * 调用方保证按提交顺序串行（见 enqueueSurfaceStates）；renderSeq 只在 unmap/销毁时
 * 推进，用来取消还在异步导入的旧帧。
 */
async function applySurfaceState(ctx: ModuleCtx, surfaceId: SurfaceId, data: WaylandSurfaceData): Promise<void> {
    const surface = ctx.objects.getOption(surfaceId);
    if (!surface) return;
    surface.data.current = Object.assign({}, surface.data.current, data);
    try {
        const buffer = data.buffer;
        const bufferId = buffer?.id;
        const bufferObj = ctx.objects.getOption(bufferId)?.data;
        if (buffer === null) {
            // attach(nil) 的提交：surface 进入 unmap，上一帧必须从画面里撤掉。
            // unmapSurface 会推进 renderSeq，让还在异步导入的旧提交过期。
            // 先结束以它为目标的隐式 grab：客户端可能用 attach(nil) 隐藏一个仍按着的
            // surface（Firefox 复用弹层 surface），不结束的话后续 motion/button 会一直喂给它。
            ctx.core.endPointerGrabForSurfaces([surfaceId]);
            unmapSurface(ctx, surfaceId);
            ctx.cursor.hide(surfaceId);
            updateDragIcon(ctx, surfaceId, undefined, { width: 0, height: 0 });
            ctx.notify.commit(surfaceId, false);
            // 没有新 buffer 的提交也可能请求了 frame callback（Firefox 的 vsync
            // source 会这样取节拍）；不回复会让它退回 60Hz 软件定时器。
            for (const callback of data.callbacks ?? []) scheduleFrameDone(ctx, surfaceId, callback);
        } else if (!bufferObj) {
            // 无 buffer 的 commit 也要让扩展看到：xdg 靠初始 commit 才能下发 configure
            // （规范：客户端先不带 buffer 提交，合成器才回 configure，之后才允许 attach）
            ctx.notify.commit(surfaceId, false);
            for (const callback of data.callbacks ?? []) scheduleFrameDone(ctx, surfaceId, callback);
        } else {
            // 本次提交带像素。提交不能丢：damage 是相对上一次 commit 的，丢掉这次
            // 提交就等于丢掉一块再也没人补画的内容（后面的 damage 不会覆盖它）。
            // 上屏频率由 present 那一层控制（见 schedulePresent），这里只保证按顺序
            // 把每个提交的 damage 贴进画布。序号用于 unmap/销毁时取消在飞的导入。
            const seq = (surface.data.renderSeq ?? 0) + 1;
            surface.data.renderSeq = seq;
            // surface 逻辑尺寸与 buffer 坐标的换算：
            // k = buffer_scale；viewport.source 是 surface 坐标，乘 k 后落到 buffer 像素；
            // destination 是逻辑尺寸（分数缩放时 buffer 保持高分辨率，只改显示尺寸）。
            const current = surface.data.current;
            const bufferScale = current.bufferScale ?? 1;
            const viewport = current.viewport;
            const bufferW = bufferObj.width;
            const bufferH = bufferObj.height;
            const extentW = bufferW / bufferScale;
            const extentH = bufferH / bufferScale;
            const source = viewport?.source;
            const logicalW = Math.max(1, viewport?.destination?.width ?? source?.width ?? extentW);
            const logicalH = Math.max(1, viewport?.destination?.height ?? source?.height ?? extentH);
            const crop = source
                ? {
                      x: source.x * bufferScale,
                      y: source.y * bufferScale,
                      w: source.width * bufferScale,
                      h: source.height * bufferScale,
                  }
                : { x: 0, y: 0, w: bufferW, h: bufferH };
            const damageScaleX = crop.w / logicalW;
            const damageScaleY = crop.h / logicalH;
            const damageList: { x: number; y: number; width: number; height: number }[] = [];
            for (const damage of data.damageList ?? []) {
                // damage 是 surface 坐标：先落到 crop 区域，再换到 buffer 像素
                damageList.push({
                    x: crop.x + damage.x * damageScaleX,
                    y: crop.y + damage.y * damageScaleY,
                    width: damage.width * damageScaleX,
                    height: damage.height * damageScaleY,
                });
            }
            for (const damage of data.damageBufferList ?? []) {
                // damage_buffer 已经是 buffer 坐标
                damageList.push(damage);
            }
            // 转换/导入失败时保持 undefined：宁可掉这一帧，也不画透明像素
            let image: ImageData | VideoFrame | undefined;
            /** image 是否是 myde 自己的稳定副本（GPU 拷贝 / CPU 转换），而不是客户端 dmabuf 零拷贝 */
            let imageStable = false;
            /** 导入对象的 release 延后到 VideoFrame close 之后（见 closePendingVideoFrame） */
            let releaseImported: (() => void) | undefined;
            if (bufferObj.type === "shm") {
                let frame = bufferObj.frame;
                if (!frame) {
                    const imageData = new ImageData(bufferObj.width, bufferObj.height);
                    // 直接复用 ImageData 自己的像素内存，模块写进去后
                    // putImageData 不需要再拷贝一遍。
                    const rgba = Buffer.from(
                        imageData.data.buffer as ArrayBuffer,
                        imageData.data.byteOffset,
                        imageData.data.byteLength,
                    );
                    frame = { rgba, imageData };
                    bufferObj.frame = frame;
                }
                try {
                    const options = {
                        fd: bufferObj.fd,
                        offset: bufferObj.offset,
                        stride: bufferObj.stride,
                        width: bufferObj.width,
                        height: bufferObj.height,
                        format: bufferObj.format,
                    };
                    // damage 是相对上一帧的变更区域：只转换这块，其余像素
                    // 已经在 canvas 里，复用上次的 RGBA 输出即可。
                    let region: { x: number; y: number; width: number; height: number } | null | undefined;
                    if (damageList.length) {
                        let minX = Number.POSITIVE_INFINITY;
                        let minY = Number.POSITIVE_INFINITY;
                        let maxX = Number.NEGATIVE_INFINITY;
                        let maxY = Number.NEGATIVE_INFINITY;
                        for (const damage of damageList) {
                            const x0 = Math.max(0, Math.floor(damage.x));
                            const y0 = Math.max(0, Math.floor(damage.y));
                            const x1 = Math.min(bufferObj.width, Math.ceil(damage.x + damage.width));
                            const y1 = Math.min(bufferObj.height, Math.ceil(damage.y + damage.height));
                            if (x1 <= x0 || y1 <= y0) continue;
                            minX = Math.min(minX, x0);
                            minY = Math.min(minY, y0);
                            maxX = Math.max(maxX, x1);
                            maxY = Math.max(maxY, y1);
                        }
                        region =
                            maxX > minX && maxY > minY
                                ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
                                : null;
                    }
                    if (region === undefined) {
                        convertShmToRgba(options, frame.rgba);
                    } else if (region !== null) {
                        convertShmToRgbaRegion(options, frame.rgba, region);
                    }
                    image = frame.imageData;
                } catch (error) {
                    console.error(`shm format 0x${bufferObj.format.toString(16)} conversion failed:`, error);
                }
            } else {
                const modifierX = bufferObj.planes[0];
                const modifier = (BigInt(modifierX.modifier_hi >>> 0) << 32n) | BigInt(modifierX.modifier_lo >>> 0);
                // myde-wrap 支持 dmabuf 时走 GPU shared texture；旧版 wrap（只有 wl_shm）
                // 下 Electron GPU 创建 shared image 会失败甚至崩溃，桌面模式退回 CPU 拷贝。
                // 主进程把 env 通过 URL 的 env 参数传进来（renderer 的 process.env 不可靠）。
                let desktopDisplay = false;
                let rendererEnv: Record<string, string | undefined> = {};
                try {
                    if (globalThis.location !== undefined) {
                        const params = new URLSearchParams(globalThis.location.search);
                        desktopDisplay = params.get("displayType") === "desktop";
                        const rawEnv = params.get("env");
                        if (rawEnv) rendererEnv = JSON.parse(rawEnv);
                    }
                } catch {
                    // 纯 node 环境或 env 解析失败：按窗口模式处理
                }
                const forceCpu =
                    rendererEnv.MYDE_FORCE_CPU_DMABUF === "1" ||
                    (desktopDisplay && rendererEnv.MYDE_WRAP_DMABUF !== "1");
                if (forceCpu) {
                    // 诊断/回退：完全不经过主进程 shared texture import，CPU 拷贝
                    try {
                        const rgba = convertDmabufToRgba({
                            width: bufferObj.width,
                            height: bufferObj.height,
                            format: bufferObj.format,
                            modifier,
                            planes: bufferObj.planes.map((p) => ({
                                fd: p.fd,
                                offset: p.offset,
                                stride: p.stride,
                            })),
                        });
                        image = new ImageData(
                            new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength),
                            bufferObj.width,
                            bufferObj.height,
                        );
                    } catch (error) {
                        console.error(`dmabuf format 0x${bufferObj.format.toString(16)} CPU conversion failed:`, error);
                    }
                } else {
                    const pixelFormat = getElectronPixelFormat(bufferObj.format);
                    let imageFromGpu: VideoFrame | undefined;
                    let converted: ImageData | undefined;
                    // myde-drm 的转换器只支持单平面 32 位 + LINEAR。NV12/NV16/P010
                    // （多平面）和带 tiled modifier 的 buffer 根本无法拷贝，直接用
                    // Electron 导入 —— 不要拿异常探测，否则这类客户端每帧都要抛一次
                    // 错并打一条日志。
                    const copyable =
                        bufferObj.planes.length === 1 &&
                        modifier === 0n &&
                        (pixelFormat !== null || needsConversion(bufferObj.format));
                    // 默认先 GPU 拷贝一份稳定副本：VideoFrame 不再引用客户端 dmabuf，
                    // 客户端复用 buffer 时不会闪旧帧。myde-drm 内部按尺寸复用一块
                    // buffer 池（按内存预算自动分配，默认 256MB，MYDE_DRM_POOL_MB），
                    // 槽位按 client+surface 隔离，拷贝在消费者释放导入纹理后才还给
                    // 池子，不会按帧累积，也不会串到别的窗口。MYDE_DMABUF_COPY=0
                    // 可退回零拷贝（接受“客户端 buffer 何时被改写”不可观测）。
                    const forceCopy = rendererEnv.MYDE_DMABUF_COPY !== "0";

                    // 显式强制拷贝，或者 Electron 不能直接导入、必须转换时才拷贝。
                    // 零拷贝模式（MYDE_DMABUF_COPY=0）只对 Electron 认识的格式生效。
                    if (copyable && (forceCopy || !pixelFormat)) {
                        try {
                            const gpu = convertDmabufToTexture({
                                width: bufferObj.width,
                                height: bufferObj.height,
                                format: bufferObj.format,
                                modifier,
                                // 池按 client+surface 隔离：不同窗口不共用拷贝缓冲，
                                // 避免一个窗口闪出另一个窗口的内容。
                                owner: `${ctx.client.id}:${surfaceId}`,
                                planes: bufferObj.planes.map((p) => ({
                                    fd: p.fd,
                                    offset: p.offset,
                                    stride: p.stride,
                                })),
                            });
                            if (gpu) {
                                let imported = false;
                                try {
                                    const t = await importSharedTexture({
                                        textureInfo: {
                                            handle: {
                                                nativePixmap: {
                                                    planes: gpu.planes.map((p) => ({
                                                        stride: p.stride,
                                                        offset: p.offset ?? 0,
                                                        size: p.size ?? p.stride * bufferObj.height,
                                                        fd: p.fd,
                                                    })),
                                                    modifier: gpu.modifier.toString(),
                                                    supportsZeroCopyWebGpuImport: true,
                                                },
                                            },
                                            codedSize: { height: bufferObj.height, width: bufferObj.width },
                                            pixelFormat: gpu.pixelFormat,
                                        },
                                    });
                                    imageFromGpu = t.getVideoFrame();
                                    imported = true;
                                    // 拷贝占用的池槽位要等导入纹理释放后才归还，
                                    // 否则下一帧可能复用还在被宿主采样的 buffer。
                                    releaseImported = () => {
                                        t.release();
                                        gpu.close();
                                    };
                                    imageStable = true;
                                } finally {
                                    if (!imported) gpu.close();
                                }
                            }
                        } catch (error) {
                            console.error(
                                `dmabuf format 0x${bufferObj.format.toString(16)} GPU conversion failed:`,
                                error,
                            );
                        }

                        if (!pixelFormat && !imageFromGpu) {
                            try {
                                const rgba = convertDmabufToRgba({
                                    width: bufferObj.width,
                                    height: bufferObj.height,
                                    format: bufferObj.format,
                                    modifier,
                                    planes: bufferObj.planes.map((p) => ({
                                        fd: p.fd,
                                        offset: p.offset,
                                        stride: p.stride,
                                    })),
                                });
                                converted = new ImageData(
                                    new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength),
                                    bufferObj.width,
                                    bufferObj.height,
                                );
                                imageStable = true;
                            } catch (error) {
                                console.error(
                                    `dmabuf format 0x${bufferObj.format.toString(16)} conversion failed:`,
                                    error,
                                );
                            }
                        }
                    }

                    if (imageFromGpu) {
                        image = imageFromGpu;
                    } else if (converted) {
                        image = converted;
                    } else {
                        // 直导：pixelFormat 有值时 Electron 自己认识；没有时只能按 bgra
                        // 猜（例如 tiled 的 XRGB 系列），每个格式只警告一次。
                        if (!pixelFormat) warnUnimportableFormat(bufferObj.format);
                        try {
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
                                    pixelFormat: pixelFormat ?? "bgra",
                                },
                            });
                            image = t.getVideoFrame();
                            releaseImported = () => t.release();
                        } catch (error) {
                            console.error(`dmabuf format 0x${bufferObj.format.toString(16)} import failed:`, error);
                        }
                    }
                }
            }
            // 异步导入期间 surface 可能已被解绑/销毁/被新提交接管：
            // 这一帧已经过期或没有像素，丢掉它，保留画布上的上一帧。
            const latest = ctx.objects.getOption(surfaceId);
            if (!image || !latest || latest.data.renderSeq !== seq) {
                if (image instanceof VideoFrame) image.close();
                releaseImported?.();
                if (bufferId) ctx.sendNow(bufferId, "wl_buffer.release", {});
                for (const callback of data.callbacks ?? []) scheduleFrameDone(ctx, surfaceId, callback);
                return;
            }
            let canvas = latest.data.canvas;
            const sizeChanged = bufferW !== canvas.width || bufferH !== canvas.height;
            if (sizeChanged) {
                // 给 canvas 设宽高会清空位图。新 buffer 的 damage 往往只覆盖变化区域，
                // 其余像素就变成透明（整窗闪透明）。先用上一帧铺满新尺寸，再让新帧覆盖：
                // 客户端重绘前最多是短暂变形，不会露出壁纸。
                const next = new OffscreenCanvas(bufferW, bufferH);
                const nextCtx = next.getContext("2d");
                if (nextCtx) {
                    nextCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, bufferW, bufferH);
                    canvas = next;
                    latest.data.canvas = next;
                } else {
                    canvas.width = bufferW;
                    canvas.height = bufferH;
                }
            }
            // biome-ignore lint/style/noNonNullAssertion: 2d context 在 OffscreenCanvas 上必然可用
            const c2d = canvas.getContext("2d")!;
            // surface 的逻辑尺寸与 buffer 尺寸是两回事：viewport destination 变化时
            // buffer 可能完全没变，但窗口/命中检测尺寸必须更新。
            ctx.core.surface.updateWlSurfaceSize(surfaceId, logicalW, logicalH);
            // buffer 已应用、像素尚未合成：交给扩展（xdg 在此按尺寸变化发 configure）
            ctx.notify.commit(surfaceId, sizeChanged);

            // damage 是「相对上一帧的变更区域」：组合器保留 damage 外的旧内容。
            // 新 buffer 在 damage 外的像素可能是复用缓冲区的旧数据/未定义内容，
            // 不能整帧覆盖，只能把 damage 区域贴到已有画布上。
            if (damageList.length) {
                for (const damage of damageList) {
                    const dx = Math.max(0, Math.floor(damage.x));
                    const dy = Math.max(0, Math.floor(damage.y));
                    const x1 = Math.min(canvas.width, Math.ceil(damage.x + damage.width));
                    const y1 = Math.min(canvas.height, Math.ceil(damage.y + damage.height));
                    const dw = x1 - dx;
                    const dh = y1 - dy;
                    if (dw <= 0 || dh <= 0) continue;
                    if (image instanceof VideoFrame) {
                        // VideoFrame 走 source-over，先清掉 damage 区域，透明像素才是替换
                        c2d.clearRect(dx, dy, dw, dh);
                        c2d.drawImage(image, dx, dy, dw, dh, dx, dy, dw, dh);
                    } else c2d.putImageData(image, 0, 0, dx, dy, dw, dh);
                }
            } else {
                // 没有 damage 的提交（少见）：按整帧处理
                if (image instanceof VideoFrame) {
                    c2d.clearRect(0, 0, canvas.width, canvas.height);
                    c2d.drawImage(image, 0, 0, canvas.width, canvas.height);
                } else c2d.putImageData(image, 0, 0);
            }
            // 呈现之后才释放：Canvas2D/Chromium 的采样时机不可观测（可能只引用纹理、
            // 延迟栅格化），以「呈现后的下一帧」为界（见 presentSurface）。
            // 稳定副本（GPU 拷贝 / CPU 转换）已经与客户端 buffer 解耦，客户端 buffer
            // 可以立刻归还，避免只带两个 buffer 的客户端被多扣一帧后掉到 60Hz。
            if (image instanceof VideoFrame) {
                if (latest.data.pendingReleases === undefined) latest.data.pendingReleases = [];
                const releases = latest.data.pendingReleases;
                if (imageStable) {
                    if (bufferId) ctx.sendNow(bufferId, "wl_buffer.release", {});
                    releases.push({ frame: image, onClose: releaseImported });
                } else {
                    const frame = image;
                    releases.push({
                        frame,
                        onClose: () => {
                            releaseImported?.();
                            if (bufferId && ctx.objects.has(bufferId)) {
                                ctx.sendNow(bufferId, "wl_buffer.release", {});
                            }
                        },
                    });
                }
            } else if (bufferId) {
                // shm/CPU 路径已经同步拷贝完（putImageData 会把像素写进画布后备），
                // 客户端 buffer 可以立刻归还。
                ctx.sendNow(bufferId, "wl_buffer.release", {});
            }
            // frame callback 走 rAF 排队，把每个 surface 的提交节拍钉在桌面刷新率上。
            for (const callback of data.callbacks ?? []) scheduleFrameDone(ctx, surfaceId, callback);

            // 合成完成：交给下一个 rAF 呈现。同一 surface 每帧只上屏一次，期间的
            // 提交只更新画布并覆盖待呈现帧，不会丢 damage。
            latest.data.pendingPresent = { canvas, width: logicalW, height: logicalH, data };
            schedulePresent(ctx, surfaceId);
        }
    } finally {
        await applySubsurfaceChildren(ctx, surfaceId);
    }
}

export const waylandCoreModule = defineModule({
    name: "wayland",
    /** core 能力的唯一提供者：surface / subsurface 域状态在自己文件里 new，host 不再认识它们 */
    core: (ctx) => {
        const surface = new wlSurfaceData(ctx.scene);
        return {
            surface,
            subsurface: new wlSubSurfaceData(surface),
            /** 键盘焦点单写入点（去重 + 发包 + 扇出），见 `CoreApi.focusKeyboard` */
            focusKeyboard: (surfaceId, seatName) => focusKeyboard(ctx, surfaceId, seatName),
            /** 强制结束隐式 grab（补 release + leave），给 xdg / dnd / host 收尾用 */
            forcePointerGrab: (seatName, reason) => {
                const seat = ctx.domain.seat.byName(seatName ?? "seat0");
                if (seat !== undefined) forcePointerGrab(ctx, seat, reason ?? "cancel");
            },
            endPointerGrabForSurfaces: (surfaces, reason) => endPointerGrabForSurfaces(ctx, surfaces, reason),
            /** 清 pointer focus；有活跃 grab 时忽略，避免 grab 期间焦点被外部清掉 */
            leavePointer: (seatName) => {
                const seat = ctx.domain.seat.byName(seatName ?? "seat0");
                if (seat === undefined) return;
                if (seat.pointerGrab !== undefined && seat.pointerGrab.buttons.size > 0) return;
                clearPointerFocus(ctx, seat);
            },
            /** 无坐标输入（scroll/gesture）的目标窗口 → 必要时补 pointer enter */
            ensurePointerFocus: (winId, seatName) => {
                const seat = ctx.domain.seat.byName(seatName ?? "seat0");
                if (seat === undefined) return false;
                if (seat.pointerGrab !== undefined && seat.pointerGrab.buttons.size > 0) {
                    return seat.pointerFocus !== null && surfaceInToplevel(ctx, seat.pointerFocus, winId);
                }
                return ensurePointerFocusForWindow(ctx, seat, winId);
            },
        };
    },
    domain: {
        dataDevice: () => ({ devices: undefined }),
        textInput: () => ({ owner: null }),
        /** 客户端级 serial（指针/键盘、configure、ping、手势共用同一条序列） */
        serial: () => new SerialStore(),
        /** 输入设备记录（原 `state/seat_store.ts`，host 已不持有）：只有 core 读写 */
        seat: () => new SeatStore(),
        output: () => ({ outputs: new Set(), surfaces: new Set() }),
        commitPacing: () => ({ pending: new Map(), raf: false, idleFrames: 0, limits: new Map(), skips: new Map() }),
    },
    hooks: {
        /** 桌面改了输出/缩放：重发 wl_output 状态和 surface 的整数缩放偏好。 */
        onOutput: (ctx) => {
            const output = ctx.client.output();
            for (const outputId of ctx.domain.output.outputs) {
                if (!ctx.objects.has(outputId)) continue;
                sendOutputState(outputId, output, ctx.sendNow);
            }
            for (const surface of ctx.domain.output.surfaces) {
                if (!ctx.objects.has(surface)) continue;
                sendPreferredScale(ctx, surface, output, ctx.sendNow);
            }
        },
    },
    globals: [
        {
            name: "wl_shm",
            onBind: (msg, ctx) => {
                const id = msg.id as WaylandObjectId2<"wl_shm">;
                ctx.send(id, "wl_shm.format", { format: getEnumValue("wl_shm.format", "argb8888") });
                ctx.send(id, "wl_shm.format", { format: getEnumValue("wl_shm.format", "xrgb8888") });
            },
        },
        {
            name: "wl_seat",
            onBind: (msg, ctx) => {
                const id = msg.id as WaylandObjectId2<"wl_seat">;
                const seatName = seatNameOf(ctx, msg);
                ctx.domain.seat.addSeat(id, seatName);
                ctx.send(id, "wl_seat.name", { name: seatName });
                ctx.send(id, "wl_seat.capabilities", {
                    capabilities: getEnumValue("wl_seat.capability", ["pointer", "keyboard", "touch"]),
                });
            },
        },
        {
            name: "wl_output",
            onBind: (msg, ctx) => {
                const id = msg.id as WaylandObjectId2<"wl_output">;
                // 记录绑定，并把已存在的 surface 关联到该 output（客户端可能在 output 之后才建窗口）
                const outputId = id as WaylandObjectId2<"wl_output">;
                ctx.domain.output.outputs.add(outputId);
                sendOutputState(outputId, ctx.client.output(), ctx.send);
                for (const surface of ctx.domain.output.surfaces) {
                    ctx.send(surface, "wl_surface.enter", { output: outputId });
                    sendPreferredScale(ctx, surface, ctx.client.output(), ctx.send);
                }
            },
        },
    ],
    requests: {
        "wl_display.sync": (x, ctx) => {
            const callbackId = x.args.callback;
            // 先 done 再 delete_id：客户端收到 done 后才允许复用这个 id，
            // 反序会让它把随后复用的同 id 回调误当成已完成。
            ctx.send(callbackId, "wl_callback.done", { callback_data: 0 });
            ctx.send(ctx.client.displayId, "wl_display.delete_id", { id: callbackId });
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
            // 协议元数据里 bind 只有 name/id 两个参数，版本从解码时另存的 `_version` 取
            const version = (x.args as unknown as { _version?: number })._version ?? 0;
            ctx.objects.bind({ name, id: x.args.id, protocol: proto, version });
            console.log(`Client ${ctx.client.id} bound ${proto.name} to id ${x.args.id} (v${version})`);

            // 各 global 的模块级副作用走本模块声明的 globals[].onBind（如 xdg_wm_base 见 ext/xdg_shell.ts）
            ctx.core.registry.globalOf(proto.name)?.onBind?.({ name, id: x.args.id, protocol: proto, version }, ctx);
        },
        "wl_compositor.create_surface": (x, ctx) => {
            const surfaceId = x.args.id;
            const surface = ctx.objects.get(surfaceId);
            surface.data = { canvas: new OffscreenCanvas(1, 1), current: {}, pending: {} };
            ctx.core.surface.addWlSurface(surfaceId);
            ctx.domain.output.surfaces.add(surfaceId);
            enterBoundOutputs(ctx, surfaceId);
            sendPreferredScale(ctx, surfaceId, ctx.client.output(), ctx.send);
        },
        "wl_compositor.create_region"(msg, ctx) {
            ctx.objects.setData(msg.args.id, { rects: [] });
        },
        "wl_shm.create_pool": (x, ctx) => {
            const fd = x.args.fd;
            // pool 与它创建的 buffer 共用这一个 fd，按引用计数关（见 FdRegistry）
            ctx.fds.retain(fd);
            ctx.objects.get(x.args.id).data = { fd };
        },
        "wl_shm_pool.create_buffer": (x, ctx) => {
            const thisObj = ctx.objects.get(x.id);
            const buffer = ctx.objects.get(x.args.id);
            ctx.fds.retain(thisObj.data.fd);
            buffer.data = {
                type: "shm",
                fd: thisObj.data.fd,
                offset: x.args.offset,
                stride: x.args.stride,
                width: x.args.width,
                height: x.args.height,
                format: x.args.format,
            };
        },
        "wl_shm_pool.destroy": (x, ctx) => {
            const pool = ctx.objects.getOption(x.id)?.data;
            if (pool) ctx.fds.release(pool.fd);
        },
        // 客户端销毁 buffer 就归还它那一份 fd 引用（dma-buf 尤其重要：不关就把显存
        // 钉住，客户端销毁后内核也回收不了这块 buffer）
        "wl_buffer.destroy": (x, ctx) => {
            const data = ctx.objects.getOption(x.id)?.data;
            if (!data) return;
            if (data.type === "shm") {
                ctx.fds.release(data.fd);
                return;
            }
            for (const plane of data.planes) {
                if (plane) ctx.fds.release(plane.fd);
            }
        },
        "wl_data_device_manager.create_data_source": (x, ctx) => {
            const src = ctx.objects.get(x.args.id);
            src.data = { offers: [] };
        },
        "wl_data_device.start_drag": (x, ctx) => {
            const sourceId = waylandObjectId(x.args.source, "wl_data_source");
            // 没有数据源的拖拽（窗口移动等）不在 core 里处理
            if (!sourceId) return;
            const seatName = ctx.objects.getOption(x.id)?.data?.seatName ?? "seat0";
            const seat = ctx.domain.seat.byName(seatName);
            if (!seat) {
                ctx.sendNow(sourceId, "wl_data_source.cancelled", {});
                return;
            }
            // 规范要求 serial 匹配发起拖拽的隐式 grab（按钮仍按住、origin 就是 grab surface）；
            // 触摸拖拽的 serial 来自仍按住的触摸点，origin 必须是该点按下的 surface。
            const grab = seat.pointerGrab;
            const touch = ctx.domain.seat.activeTouchSerial(seat, x.args.serial);
            const pointerDrag =
                ctx.domain.seat.isActivePointerGrab(seat, x.args.serial) &&
                grab !== undefined &&
                grab.surface === x.args.origin;
            const touchDrag = touch !== undefined && touch.surface === x.args.origin;
            if (!pointerDrag && !touchDrag) {
                ctx.sendNow(sourceId, "wl_data_source.cancelled", {});
                return;
            }
            const surface = (pointerDrag && grab !== undefined ? grab.surface : touch?.surface) ?? x.args.origin;
            if (!ctx.objects.has(surface)) {
                // 跨 client 拖拽暂不支持：取消，让客户端正常退出 drag 状态
                ctx.sendNow(sourceId, "wl_data_source.cancelled", {});
                return;
            }
            const pointerPos = pointerDrag
                ? seat.pointerFocus === surface
                    ? seat.pointerPos
                    : { x: 0, y: 0 }
                : { x: touch?.x ?? 0, y: touch?.y ?? 0 };
            const previousFinish = ctx.domain.dataDevice.dragFinish;
            if (previousFinish) finishDragSource(ctx, previousFinish.sourceId);
            // icon 是可选的普通 surface；协议要求它获得 drag-and-drop icon 角色，
            // 已有其它角色时是协议错误
            const iconId = waylandObjectId(x.args.icon, "wl_surface");
            let iconSurface: WaylandObjectId2<"wl_surface"> | undefined;
            if (iconId && ctx.objects.has(iconId)) {
                try {
                    ctx.core.surface.setWlSurfaceRole(iconId, "dnd_icon");
                    iconSurface = iconId;
                } catch (error) {
                    if (!(error instanceof WaylandSurfaceRoleError)) throw error;
                    ctx.postError("wl_data_device", x.id, "role", "Icon surface already has another role");
                    return;
                }
            }
            const drag = {
                dataDeviceId: x.id,
                sourceId,
                seatName,
                surface,
                iconSurface,
                touch: !pointerDrag,
                offerId: undefined as WaylandObjectId2<"wl_data_offer"> | undefined,
            };
            ctx.domain.dataDevice.drag = drag;
            sendDragEnter(ctx, drag, surface, pointerPos.x, pointerPos.y);
            const src = ctx.objects.getOption(sourceId);
            if (src && ctx.domain.dataDevice.drag?.sourceId === sourceId) {
                ctx.transfer.dragStarted(
                    seatName,
                    sourceId,
                    [...src.data.offers],
                    dndActionNames(src.data.actions ?? DND_ACTION_COPY),
                );
                // 客户端通常在 start_drag 前已经提交过图标；没有的话等它 commit 再上报
                const icon = iconSurface ? ctx.core.surface.getWlSurface(iconSurface) : undefined;
                if (iconSurface && icon?.frame)
                    updateDragIcon(ctx, iconSurface, icon.frame, { width: icon.size.w, height: icon.size.h });
            }
        },
        "wl_data_device.release": (x, ctx) => {
            const devices = ctx.domain.dataDevice.devices;
            for (const set of devices?.values() ?? []) set.delete(x.id);
            const drag = ctx.domain.dataDevice.drag;
            if (drag?.dataDeviceId === x.id) {
                ctx.domain.dataDevice.drag = undefined;
                ctx.transfer.dragFinished(drag.sourceId, "cancelled");
                if (ctx.objects.has(drag.sourceId)) {
                    ctx.sendNow(drag.sourceId, "wl_data_source.cancelled", {});
                }
            }
        },
        "wl_data_source.set_actions": (x, ctx) => {
            const src = ctx.objects.getOption(x.id);
            if (!src) return;
            const previousActions = src.data.actions;
            src.data.actions = x.args.dnd_actions;
            ctx.dnd.sourceActions(x.id, x.args.dnd_actions);
            const drag = ctx.domain.dataDevice.drag;
            if (drag?.sourceId !== x.id || drag.offerId === undefined) return;
            if (previousActions !== x.args.dnd_actions) {
                ctx.sendNow(drag.offerId, "wl_data_offer.source_actions", { source_actions: x.args.dnd_actions });
            }
            const offer = ctx.objects.getOption(drag.offerId);
            if (!offer) return;
            const action = chooseDndAction(
                x.args.dnd_actions,
                offer.data.targetActions ?? 0,
                offer.data.preferredAction ?? 0,
            );
            // 目标收到 action 会回 set_actions；动作没变就不再发，避免来回对拍
            if (action === offer.data.selectedAction) return;
            offer.data.selectedAction = action;
            ctx.sendNow(drag.offerId, "wl_data_offer.action", { dnd_action: action });
            ctx.sendNow(x.id, "wl_data_source.action", { dnd_action: action });
        },
        "wl_data_source.destroy": (x, ctx) => {
            ctx.transfer.sourceDestroyed(x.id);
            if (ctx.domain.dataDevice.drag?.sourceId === x.id) {
                ctx.domain.dataDevice.drag = undefined;
                ctx.transfer.dragFinished(x.id, "cancelled");
            }
            const finish = ctx.domain.dataDevice.dragFinish;
            if (finish?.sourceId === x.id) {
                clearTimeout(finish.timer);
                ctx.domain.dataDevice.dragFinish = undefined;
            }
        },
        "wl_data_device_manager.get_data_device": (x, ctx) => {
            const ddId = x.args.id;
            // 按所属 seat 归组：selection 归该 seat 的键盘焦点所有（跟随键盘焦点）
            const seatName = ctx.domain.seat.get(x.args.seat)?.name ?? "seat0";
            ctx.objects.setData(ddId, { seatName });
            const devices: DataDevices = ctx.domain.dataDevice.devices ?? new Map();
            let set = devices.get(seatName);
            if (set === undefined) {
                set = new Set();
                devices.set(seatName, set);
            }
            set.add(ddId);
            ctx.domain.dataDevice.devices = devices;
        },
        "wl_data_source.offer": (x, ctx) => {
            const src = ctx.objects.get(x.id);
            if (!src) return;
            src.data.offers.push(x.args.mime_type);
            const drag = ctx.domain.dataDevice.drag;
            if (drag?.sourceId === x.id && drag.offerId !== undefined) {
                ctx.sendNow(drag.offerId, "wl_data_offer.offer", { mime_type: x.args.mime_type });
            }
            console.log(`wl_data_source#${x.id} offer ${x.args.mime_type}`);
        },
        "wl_data_offer.accept": (x, ctx) => {
            const offer = ctx.objects.getOption(x.id);
            if (!offer) return;
            offer.data.accepted = x.args.mime_type;
            const dndSessionId = offer.data.dndSessionId;
            const mime = x.args.mime_type;
            if (dndSessionId !== undefined && mime) ctx.dnd.targetAccept(dndSessionId, x.id, mime);
        },
        "wl_data_offer.set_actions": (x, ctx) => {
            const offer = ctx.objects.getOption(x.id);
            const dndSessionId = offer?.data?.dndSessionId;
            if (dndSessionId !== undefined) {
                ctx.dnd.targetActions(dndSessionId, x.id, x.args.dnd_actions, x.args.preferred_action ?? 0);
                return;
            }
            if (!offer?.data?.drag) return;
            const previous = offer.data.selectedAction;
            const targetActions = x.args.dnd_actions;
            const preferred = x.args.preferred_action ?? 0;
            if (offer.data.targetActions === targetActions && offer.data.preferredAction === preferred) return;
            offer.data.targetActions = targetActions;
            offer.data.preferredAction = preferred;
            const src = offer.data.sourceId !== undefined ? ctx.objects.getOption(offer.data.sourceId) : undefined;
            const action = chooseDndAction(src?.data.actions ?? DND_ACTION_COPY, targetActions, preferred);
            // 客户端收到 action 会回 set_actions；只有动作真的变了才再发，避免无限对拍
            if (action === previous) return;
            offer.data.selectedAction = action;
            ctx.sendNow(x.id, "wl_data_offer.action", { dnd_action: action });
            if (src && offer.data.sourceId !== undefined) {
                ctx.sendNow(offer.data.sourceId, "wl_data_source.action", { dnd_action: action });
            }
        },
        "wl_data_offer.finish": (x, ctx) => {
            // 目标声明拖拽数据处理完了，给 source 发 dnd_finished
            const offer = ctx.objects.getOption(x.id);
            const dndSessionId = offer?.data?.dndSessionId;
            if (dndSessionId !== undefined) {
                ctx.dnd.targetFinish(dndSessionId, x.id);
                return;
            }
            if (offer?.data?.drag && offer.data.sourceId !== undefined) {
                finishDragSource(ctx, offer.data.sourceId);
            }
        },
        "wl_data_offer.destroy": (x, ctx) => {
            // 有的客户端不调 finish，直接销毁 offer；也当作数据处理完
            const offer = ctx.objects.getOption(x.id);
            const dndSessionId = offer?.data?.dndSessionId;
            if (dndSessionId !== undefined) {
                ctx.dnd.targetGone(dndSessionId, x.id);
                return;
            }
            if (offer?.data?.drag && offer.data.sourceId !== undefined) {
                finishDragSource(ctx, offer.data.sourceId);
            }
        },
        "wl_data_offer.receive": (x, ctx) => {
            const offerId = x.id;
            const mime = x.args.mime_type;
            const fd = x.args.fd;

            // 跨客户端拖拽：fd 交给全局会话，由它向源客户端或桌面要数据
            const offer = ctx.objects.getOption(offerId);
            const dndSessionId = offer?.data?.dndSessionId;
            if (dndSessionId !== undefined) {
                ctx.dnd.targetReceive(dndSessionId, offerId, mime, fd);
                return;
            }

            // drag-and-drop：把目标端 fd 转给 source 写入；同一 client 内 source 就在本对象表里
            if (offer?.data?.drag) {
                try {
                    const srcId = offer.data.sourceId;
                    if (srcId !== undefined && ctx.objects.has(srcId)) {
                        ctx.sendNow(srcId, "wl_data_source.send", { mime_type: mime, fd });
                    }
                } finally {
                    try {
                        fs.closeSync(fd);
                    } catch {
                        // ignore
                    }
                }
                return;
            }

            // 剪贴板：offer 只带 token，fd 交给 server 找到真正的数据源（客户端源或桌面）
            const token = offer?.data?.token;
            if (token !== undefined) {
                ctx.transfer.forward(token, mime, fd);
                return;
            }

            try {
                fs.closeSync(fd);
            } catch {
                // ignore
            }
        },
        "wl_data_device.set_selection": (x, ctx) => {
            const seatName = ctx.objects.getOption(x.id)?.data?.seatName ?? "seat0";
            const srcId = waylandObjectId(x.args.source, "wl_data_source");
            if (!srcId) {
                console.log("Selection cleared");
                ctx.transfer.clearSelection(seatName);
                return;
            }

            const src = ctx.objects.getOption(srcId);
            if (!src) {
                console.warn(`Selection source ${srcId} not found`);
                return;
            }

            // 不在这里读数据：桌面收到 `clipboard.changed` 后按需 `clipboard.read`，
            // 要存历史就立刻读走；server 不持有字节。
            ctx.transfer.selectionChanged(seatName, srcId, [...src.data.offers]);
        },
        "wl_surface.attach": (x, ctx) => {
            const surface = ctx.objects.get(x.id);
            const bufferId = waylandObjectId(x.args.buffer, "wl_buffer");
            // attach(nil)：显式解绑，commit 后 unmap（与「本次没有 attach」不同）
            surface.data.pending.buffer = bufferId ? { id: bufferId } : null;
        },
        "wl_surface.set_buffer_scale": (x, ctx) => {
            if (x.args.scale <= 0) {
                ctx.postError("wl_surface", x.id, "invalid_scale", "Buffer scale must be greater than 0");
                return;
            }
            ctx.objects.get(x.id).data.pending.bufferScale = x.args.scale;
        },
        "wl_surface.set_buffer_transform": (x, ctx) => {
            const name = getEnumName("wl_output.transform", x.args.transform);
            if (name === undefined) {
                ctx.postError("wl_surface", x.id, "invalid_transform", "Invalid buffer transform");
                return;
            }
            if (name !== "normal") {
                // 旋转/翻转暂不参与合成；保留状态，避免客户端因未实现而被打断
                console.warn(`wl_surface.set_buffer_transform: unsupported transform ${name}`);
            }
            ctx.objects.get(x.id).data.pending.bufferTransform = x.args.transform;
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
            const callbacks = surface.data.pending.callbacks ?? [];
            callbacks.push(callbackId);
            surface.data.pending.callbacks = callbacks;
        },
        "wl_surface.commit": async (x, ctx) => {
            const surface = ctx.objects.get(x.id);
            const data = surface.data.pending;
            surface.data.pending = {};
            // 同步子 surface 先缓存提交状态，等父 surface 状态生效时再应用
            if (ctx.core.subsurface.isSynchronized(x.id)) {
                cacheSurfaceState(ctx, x.id, data);
                return;
            }
            // 已切到 desync 但还留着同步期间缓存的提交：按协议把 pending 加到缓存后整体应用，
            // 否则旧缓存会在之后的父提交里被重新应用，状态顺序就反了。
            const cache = surface.data.cache;
            if (cache !== undefined) {
                surface.data.cache = undefined;
                enqueueSurfaceStates(ctx, x.id, [...cache, data]);
                return;
            }
            enqueueSurfaceStates(ctx, x.id, [data]);
        },
        "wl_surface.destroy": (x, ctx) => {
            const surfaceId = x.id;
            discardCachedState(ctx, surfaceId);
            discardQueuedStates(ctx, surfaceId);
            discardPendingPresent(ctx, surfaceId);
            ctx.domain.output.surfaces.delete(surfaceId);
            // 对象 id 可以由客户端复用，限速状态不能跟着旧 surface 留下来
            ctx.domain.commitPacing.limits.delete(surfaceId);
            ctx.domain.commitPacing.skips.delete(surfaceId);
            ctx.domain.commitPacing.pending.delete(surfaceId);
            // 光标surface销毁后隐藏光标
            ctx.cursor.hide(surfaceId);
            // 拖拽图标销毁：通知桌面移除，并清掉引用（对象 id 可能被复用）
            const drag = ctx.domain.dataDevice.drag;
            if (drag?.iconSurface === surfaceId) {
                ctx.transfer.dragIcon(drag.sourceId, null);
                drag.iconSurface = undefined;
            }
            ctx.notify.destroy(surfaceId);
            // 焦点悬挂修复：该 surface 若持有某把 seat 的焦点就**静默清槽**——
            // 不能向已销毁的对象发 leave（客户端已释放该 id，引用死对象会把连接打死）；
            // text-input 之类经 `notify.destroy` 收敛自己的状态，不走 focus 通知。
            for (const seat of ctx.domain.seat.all()) {
                if (seat.pointerFocus === surfaceId) seat.pointerFocus = null;
                // grab 固定的 surface 已销毁：不能再把 motion/up 路由给它；也不能给死对象补 release
                if (seat.pointerGrab?.surface === surfaceId) seat.pointerGrab.buttons.clear();
                if (seat.keyboardFocus === surfaceId) {
                    seat.keyboardFocus = null;
                    clearSelection(ctx, seat.name);
                }
                // 触摸序列固定在按下时的 surface 上：它没了就整体取消（cancel 没有 id）
                for (const point of seat.touchPoints.values()) {
                    if (point.surface !== surfaceId) continue;
                    cancelTouchPoints(ctx, seat);
                    break;
                }
            }
            ctx.core.surface.destroyWlSurface(surfaceId);
            // todo 相关的如subsurface、xdgsurface等
        },
        "wl_output.release": (x, ctx) => {
            ctx.domain.output.outputs.delete(x.id as WaylandObjectId2<"wl_output">);
        },
        "wl_surface.set_opaque_region": (x, ctx) => {
            const surface = ctx.objects.get(x.id);
            const region = ctx.objects.getOption(waylandObjectId(x.args.region, "wl_region"));
            // 协议要求拷贝：region 之后还能 add/subtract 或 destroy，pending 快照不能跟着变
            surface.data.pending.opaqueRegion = region ? [...region.data.rects] : undefined;
        },
        "wl_surface.set_input_region": (x, ctx) => {
            const surface = ctx.objects.get(x.id);
            const region = ctx.objects.getOption(waylandObjectId(x.args.region, "wl_region"));
            surface.data.pending.inputRegion = region?.data.rects;
        },
        "wl_surface.offset": (x, ctx) => {
            // wl_subsurface 文档要求子 surface 忽略 wl_surface.offset，移动用 set_position
            if (ctx.core.surface.getRole(x.id) === "subsurface") return;
            ctx.core.surface.setWlSurfaceOffset(x.id, x.args.x, x.args.y);
            // 拖拽图标可能只改偏移不换 buffer：也要把新位置发给桌面
            const drag = ctx.domain.dataDevice.drag;
            if (drag?.iconSurface !== x.id) return;
            const icon = ctx.core.surface.getWlSurface(x.id);
            if (icon?.frame) updateDragIcon(ctx, x.id, icon.frame, { width: icon.size.w, height: icon.size.h });
        },
        "wl_seat.get_pointer": (x, ctx) => {
            const pointerId = x.args.id;
            const seat = ctx.domain.seat.get(x.id);
            if (!seat) {
                console.warn(`Seat ${x.id} not found for get_pointer`);
                return;
            }
            seat.pointers.add(pointerId);
            ctx.objects.setData(pointerId, {});
            // 同一 seat 后来新建的 pointer 也要接上当前焦点（Firefox 会在多份 registry 上重复 get_pointer）
            if (seat.pointerFocus !== null && ctx.objects.has(seat.pointerFocus)) {
                const serial = ctx.domain.serial.next();
                pointerEnter(ctx, pointerId, serial, seat.pointerFocus, seat.pointerPos.x, seat.pointerPos.y, ctx.send);
                pointerFrame(ctx, pointerId, ctx.send);
            }
        },
        "wl_seat.get_keyboard": (x, ctx) => {
            const keyboardId = x.args.id;
            const seat = ctx.domain.seat.get(x.id);
            if (!seat) {
                console.warn(`Seat ${x.id} not found for get_keyboard`);
                return;
            }
            seat.keyboards.add(keyboardId);
            keyboardRepeatInfo(ctx, keyboardId, ctx.send);
            keyboardKeymap(ctx, keyboardId, ctx.send);
            if (seat.keyboardFocus !== null && ctx.objects.has(seat.keyboardFocus)) {
                const enterSerial = ctx.domain.serial.next();
                const modifiersSerial = ctx.domain.serial.next();
                keyboardEnter(
                    ctx,
                    keyboardId,
                    enterSerial,
                    seat.keyboardFocus,
                    Uint32Array.from(seat.pressedKeys),
                    ctx.send,
                );
                keyboardModifiers(ctx, keyboardId, modifiersSerial, ctx.domain.seat.modifierMask(seat), ctx.send);
            }
        },
        /** `wl_pointer.release` 是 destructor：对象已由分发器删除，这里只清 seat 的资源表 */
        "wl_pointer.release": (x, ctx) => {
            for (const seat of ctx.domain.seat.all()) seat.pointers.delete(x.id);
        },
        "wl_keyboard.release": (x, ctx) => {
            for (const seat of ctx.domain.seat.all()) seat.keyboards.delete(x.id);
        },
        /** 触摸对象不需要 enter/leave，按下事件自带 surface；这里只登记资源 */
        "wl_seat.get_touch": (x, ctx) => {
            const touchId = x.args.id;
            const seat = ctx.domain.seat.get(x.id);
            if (!seat) {
                console.warn(`Seat ${x.id} not found for get_touch`);
                return;
            }
            seat.touches.add(touchId);
        },
        "wl_touch.release": (x, ctx) => {
            for (const seat of ctx.domain.seat.all()) {
                seat.touches.delete(x.id);
                // 最后一个 touch 对象没了，后续 move/up 也发不出去，直接清掉序列
                if (activeTouches(ctx, seat).length === 0) seat.touchPoints.clear();
            }
        },
        "wl_pointer.set_cursor": (x, ctx) => {
            // serial 必须是该 pointer 最近一次 enter 的 serial；不匹配时按协议忽略整个请求
            const pointerData = ctx.objects.getOption(x.id)?.data;
            if (pointerData?.enterSerial !== x.args.serial) return;
            // todo wlsurface.offset
            const surfaceId = x.args.surface;
            if (!surfaceId) {
                // surface为null时隐藏光标
                ctx.cursor.hide();
                return;
            }
            // 校验 surface 存在（无效 id 走 postError）
            ctx.objects.get(surfaceId);
            const [_, e] = tryX(() => ctx.core.surface.setWlSurfaceRole(surfaceId, "cursor"));
            if (e) {
                ctx.postError("wl_pointer", x.id, "role", "Surface already has another role");
                return;
            }
            const cursorSurface = ctx.core.surface.getWlSurface(surfaceId);
            ctx.cursor.setSurface(surfaceId, { x: x.args.hotspot_x, y: x.args.hotspot_y }, cursorSurface.frame, {
                width: cursorSurface.size.w,
                height: cursorSurface.size.h,
            });
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
                ctx.postError("wl_subcompositor", x.id, "bad_parent", "Parent cannot be itself or its descendant");
            if (r !== true) return;
        },
        "wl_subsurface.set_position": (x, ctx) => {
            ctx.core.subsurface.setPosition(x.id, x.args.x, x.args.y);
        },
        "wl_subsurface.place_above": (x, ctx) => {
            if (!ctx.core.subsurface.place(x.id, x.args.sibling, true)) {
                ctx.postError("wl_subsurface", x.id, "bad_surface", "Sibling is not a sibling surface or the parent");
            }
        },
        "wl_subsurface.place_below": (x, ctx) => {
            if (!ctx.core.subsurface.place(x.id, x.args.sibling, false)) {
                ctx.postError("wl_subsurface", x.id, "bad_surface", "Sibling is not a sibling surface or the parent");
            }
        },
        "wl_subsurface.set_sync": (x, ctx) => {
            ctx.core.subsurface.setSync(x.id, true);
        },
        "wl_subsurface.set_desync": (x, ctx) => {
            const sub = ctx.core.subsurface.getSubSurface(x.id);
            ctx.core.subsurface.setSync(x.id, false);
            // set_sync/set_desync 立即生效；父链已是 desync 时，缓存状态在 set_desync 当场应用。
            // 父链仍同步或子 surface 还没进入树中时，缓存继续等父 surface 状态生效。
            if (ctx.core.subsurface.isSynchronized(sub.surface)) return;
            const surface = ctx.objects.getOption(sub.surface);
            const cache = surface?.data.cache;
            if (surface === undefined || cache === undefined) return;
            surface.data.cache = undefined;
            enqueueSurfaceStates(ctx, sub.surface, cache);
        },
        "wl_subsurface.destroy": (x, ctx) => {
            const sub = ctx.core.subsurface.getSubSurface(x.id);
            ctx.core.subsurface.destroySubSurface(x.id);
            discardCachedState(ctx, sub.surface);
            // 销毁后 surface 不再参与合成；客户端常只 attach(nil)+destroy，
            // 不在这里撤掉会留下最后一帧（Chrome 的地址栏补全下拉就是这种生命周期）
            unmapSurface(ctx, sub.surface);
        },
    },
    actions: {
        /**
         * 指针入口规范化：有隐式 grab 时固定在 grab surface（即使指针移出它的几何范围）；
         * 没有 grab 时先补齐 enter/leave，再发 motion/button。
         *
         * 桌面不需要严格保证 leave/enter 顺序：不同窗口的事件到达时，旧会话在这里被强制收尾，
         * 目标 surface 的 enter 在 button/motion 之前补发。没有对应 down 的 up 直接丢弃。
         */
        "input.pointer": (msg, ctx) => {
            const ev = msg.args[0];
            const seat = resolveSeat(ctx, msg.args[1]);
            if (seat === undefined) return;
            const p = { x: ev.x, y: ev.y };

            let grab = seat.pointerGrab;
            // grab 期间桌面把事件发到了别的窗口：旧会话的坐标空间已经不可信，先完整收尾
            if (grab !== undefined && grab.buttons.size > 0 && grab.winId !== msg.winId) {
                forcePointerGrab(ctx, seat, "cancel");
                grab = undefined;
            }

            if (grab !== undefined && grab.buttons.size > 0) {
                const hit = ctx.domain.xdgSurface.hitTest(grab.winId, p, grab.surface);
                if (hit === undefined) {
                    // grab 固定的 surface 已不可用（窗口销毁/角色变化），不能继续引用
                    forcePointerGrab(ctx, seat, "destroy");
                    return;
                }
                if (ev.type === "down") {
                    const code = pointerButtonCode(ev.button);
                    if (grab.buttons.has(code)) return;
                    const serial = sendPointer(ctx, seat, ev, hit);
                    if (serial !== undefined) {
                        ctx.domain.seat.beginPointerGrab(seat, grab.winId, grab.surface, code, grab.serial);
                    }
                } else if (ev.type === "move") {
                    sendPointer(ctx, seat, ev, hit);
                } else {
                    const code = pointerButtonCode(ev.button);
                    if (!grab.buttons.has(code)) return;
                    sendPointer(ctx, seat, ev, hit);
                    ctx.domain.seat.endPointerButton(seat, code);
                }
                return;
            }

            // 没有对应 down 的 up 丢弃，不制造幽灵点击
            if (ev.type === "up") return;

            const hit = ctx.domain.xdgSurface.hitTest(msg.winId, p);
            // 按下先收回不再包含指针的 popup grab（点击外部关闭），点击本身照常路由
            if (ev.type === "down") ctx.domain.xdgSurface.dismissGrabsForPointer(hit, seat.name, ctx);
            if (hit === undefined) {
                if (ev.type === "move") clearPointerFocus(ctx, seat);
                return;
            }

            // 任何 motion/button 之前先保证 enter 已发（不同 surface 先 leave 旧）
            updatePointerFocus(ctx, seat, hit);
            const serial = sendPointer(ctx, seat, ev, hit);
            if (ev.type === "down" && serial !== undefined) {
                ctx.domain.seat.beginPointerGrab(seat, msg.winId, hit.surface, pointerButtonCode(ev.button), serial);
            }
        },
        /** host 在跨 client 切换 pointer 归属时调用；有活跃 grab 时先补 release 再离开 */
        "input.pointerLeave": (msg, ctx) => {
            const seat = resolveSeat(ctx, msg.args[0]);
            if (seat === undefined) return;
            if (seat.pointerGrab !== undefined && seat.pointerGrab.buttons.size > 0) {
                forcePointerGrab(ctx, seat, "cancel");
                return;
            }
            clearPointerFocus(ctx, seat);
        },
        /** host / xdg / dnd 强制结束旧 grab：有活跃 grab 补 release，否则也清掉残留焦点 */
        "input.pointerCancel": (msg, ctx) => {
            const seat = resolveSeat(ctx, msg.args[0]);
            if (seat === undefined) return;
            if (seat.pointerGrab !== undefined && seat.pointerGrab.buttons.size > 0) {
                forcePointerGrab(ctx, seat, "cancel");
            } else {
                clearPointerFocus(ctx, seat);
            }
        },
        "input.scroll": (msg, ctx) => {
            const seat = resolveSeat(ctx, msg.args[1]);
            if (seat === undefined) return;
            // grab 期间 pointer focus 固定在按下 surface，滚动跟随它，不切目标
            if (seat.pointerGrab !== undefined && seat.pointerGrab.buttons.size > 0) {
                sendScroll(ctx, seat, msg.args[0]);
                return;
            }
            // 桌面按落点选中了窗口；焦点缺失/停在别的窗口时先补 enter，再发 axis
            if (ensurePointerFocusForWindow(ctx, seat, msg.winId)) sendScroll(ctx, seat, msg.args[0]);
        },
        "input.key": (msg, ctx) => {
            const seat = resolveSeat(ctx, msg.args[2]);
            if (seat === undefined) return;
            const [key, state] = msg.args;
            // 先查重：重复事件不能触发 focusKeyboard（焦点有副作用）；没有 press 的 release 更不值得补焦点
            const held = ctx.domain.seat.isKeyPressed(seat, key);
            if (state === "pressed" ? held : !held) return;
            // 事件自带窗口：桌面没发 window.focus 时，以它为准补 keyboard enter
            const surface = mainSurfaceOfToplevel(ctx, msg.winId);
            if (surface === null) return;
            focusKeyboard(ctx, surface, seat.name);
            sendKey(ctx, seat, key, state);
        },
        /**
         * 触摸入口：`down` 命中哪块 surface，整段序列（move/up）都留在那块 surface 上。
         * `wl_touch.motion/up` 不带 surface，move 的窗口局部坐标按 down 时的 surface 再换算，
         * 所以手指移出窗口后坐标仍落在同一个坐标空间里。
         */
        "input.touch": (msg, ctx) => {
            const seat = resolveSeat(ctx, msg.args[1]);
            if (seat === undefined) return;
            const ev = msg.args[0] as TouchCommand;
            if (ev.type === "cancel") {
                cancelTouchPoints(ctx, seat);
                return;
            }
            const touches = activeTouches(ctx, seat);
            if (touches.length === 0) return;

            if (ev.type === "down") {
                if (seat.touchPoints.has(ev.id)) return;
                const hit = ctx.domain.xdgSurface.hitTest(msg.winId, { x: ev.x, y: ev.y });
                if (hit === undefined) return;
                // 和指针按下一样：点在外面时先收回不再包含触摸点的 popup grab
                ctx.domain.xdgSurface.dismissGrabsForPointer(hit, seat.name, ctx);
                const serial = ctx.domain.serial.next();
                ctx.domain.seat.noteTouchPress(seat, serial);
                seat.touchPoints.set(ev.id, { surface: hit.surface, serial, x: hit.x, y: hit.y });
                const time = Date.now();
                for (const touch of touches) {
                    touchDown(ctx, touch, serial, time, hit.surface, ev.id, hit.x, hit.y);
                    touchFrame(ctx, touch);
                }
                return;
            }

            const point = seat.touchPoints.get(ev.id);
            if (point === undefined) return;
            if (ev.type === "up") {
                seat.touchPoints.delete(ev.id);
                const serial = ctx.domain.serial.next();
                const time = Date.now();
                for (const touch of touches) {
                    touchUp(ctx, touch, serial, time, ev.id);
                    touchFrame(ctx, touch);
                }
                return;
            }

            const hit = ctx.domain.xdgSurface.hitTest(msg.winId, { x: ev.x, y: ev.y }, point.surface);
            if (hit === undefined) return;
            point.x = hit.x;
            point.y = hit.y;
            const time = Date.now();
            for (const touch of touches) {
                touchMotion(ctx, touch, time, ev.id, hit.x, hit.y);
                touchFrame(ctx, touch);
            }
        },
        /** 仲裁交给各 text_input 模块（core 不认识 zwp_* 事件） */
        "input.text": (msg, ctx) => {
            const seat = resolveSeat(ctx, msg.args[2]);
            if (seat !== undefined) ctx.notify.textInput(seat.name, msg.args[0], msg.args[1]);
        },
        /**
         * 把当前 selection offer 给本连接（通常由桌面在键盘焦点进入时调用）。
         * selection 由 server 按 seat 填入；桌面只传 handle。
         */
        "clipboard.offer": (msg, ctx) => offerTo(ctx, msg.args[0] ?? null, msg.args[1]),
        /** 桌面开始驱动拖拽目标：撤掉本地同 client 目标（老目标要收 leave），源 source 保留 */
        "dnd.detachLocal": (_msg, ctx) => {
            const drag = ctx.domain.dataDevice.drag;
            if (!drag || drag.remoteDriven) return;
            drag.remoteDriven = true;
            if (drag.offerId !== undefined) {
                ctx.sendNow(drag.dataDeviceId, "wl_data_device.leave", {});
                drag.offerId = undefined;
            }
        },
        /** 全局会话收尾：清掉本地拖拽状态（finished/cancelled 已由 hub 发送） */
        "dnd.endLocal": (_msg, ctx) => {
            const drag = ctx.domain.dataDevice.drag;
            if (!drag) return;
            // 桌面驱动时源窗口没收到 wl_pointer.button；GTK/Firefox 会因此卡在 drag 状态。
            // 有活跃 grab 就统一走 forcePointerGrab；没有 grab 的兼容路径仍补一个左键释放。
            if (drag.remoteDriven) {
                const seat = ctx.domain.seat.byName(drag.seatName);
                if (seat?.pointerGrab !== undefined && seat.pointerGrab.buttons.size > 0) {
                    forcePointerGrab(ctx, seat, "cancel");
                } else if (seat !== undefined && !drag.touch) {
                    const pointers = activePointers(ctx, seat);
                    const time = Date.now();
                    for (const pointer of pointers) {
                        pointerButton(
                            ctx,
                            pointer,
                            ctx.domain.serial.next(),
                            time,
                            InputEventCodes.BTN_LEFT,
                            "released",
                        );
                        pointerFrame(ctx, pointer);
                    }
                }
            }
            if (drag.offerId !== undefined) ctx.sendNow(drag.dataDeviceId, "wl_data_device.leave", {});
            ctx.domain.dataDevice.drag = undefined;
        },
    },
});
