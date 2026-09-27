import { InputEventCodes } from "../../../input_codes/types";
import type { PointerCommand, ScrollCommand } from "../../api";
import {
    type BindMsg,
    defineModule,
    type HitTestResult,
    type ModuleCtx,
    type SeatRecord,
    type SurfaceId,
    type WaylandObjectId2,
} from "../../module";
import type { renderTools } from "../../render_tools";
import type { WaylandName, WaylandObjectId, WaylandProtocol } from "../../utils/wayland-binary";
import { getEnumValue, tryX, waylandObjectId } from "../../utils/wayland-proto";
import { SeatStore } from "./seat_store";

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

/** seat 名 → 该 seat 的 data_device 集合（selection 按 seat 路由，跟随键盘焦点） */
type DataDevices = Map<string, Set<WaylandObjectId2<"wl_data_device">>>;

declare module "../../module" {
    interface WaylandDataRegistry {
        wl_region: {
            rects: { x: number; y: number; width: number; height: number; type: "+" | "-" }[];
        };
    }
    interface WaylandDomainRegistry {
        /** wl_data_* 的连接态（原 `ClientState.dataDevices` / `pendingPaste`）；host 的 `paste()` 也从这里读 */
        dataDevice: {
            devices?: DataDevices;
            pendingPaste?: { offerId: WaylandObjectId; fd: number; mime: string; timeout: NodeJS.Timeout };
        };
        /**
         * text-input v1/v3 的仲裁槽（后 activate/enable 者持有）：core 只当中立槽位，不解释 zwp_* 事件——
         * 读写方是各 text_input 模块，触发通道是 core 的 `input.text` action（见 `TextInputHooks.onTextInput`）。
         */
        textInput: { owner: TextInputOwner | null };
        /** 输入设备状态（`SeatStore` 在本文件旁边的 `seat_store.ts`）：只有 core 读写，host 不碰 */
        seat: SeatApi;
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
            role: "subsurface" | "toplevel" | "popup" | "cursor" | undefined;
            size: { w: number; h: number };
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
        this.wl_surface[id] = { role: undefined, size: { w: 0, h: 0 } };
        this.render.bindCanvas(this.idScope(id));
    }
    getWlSurface(id: WaylandObjectId2<"wl_surface">) {
        return this.wl_surface[id];
    }
    renderWlSurface(id: WaylandObjectId2<"wl_surface">, canvas: OffscreenCanvas) {
        this.wl_surface[id].frame = canvas;
        this.render.renderCanvas(canvas, this.idScope(id));
    }
    destroyWlSurface(id: WaylandObjectId2<"wl_surface">) {
        delete this.wl_surface[id];
        this.render.destroyCanvas(this.idScope(id));
    }

    setWlSurfaceRole(id: WaylandObjectId2<"wl_surface">, role: "subsurface" | "toplevel" | "popup" | "cursor") {
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
            posi: { x: number; y: number };
        }
    > = {};
    parentChildren = new Map<WaylandObjectId2<"wl_surface">, WaylandObjectId2<"wl_subsurface">[]>();
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
        for (const c of this.getChildrenDeep(child)) {
            if (c.id === parent) {
                return "bad_parent";
            }
        }
        const oldRelationId = this.getSubSurfaceBySurface(child);
        if (oldRelationId) {
            // 已经有父子关系了，先删除旧关系
            const oldRelation = this.wl_subsurface[oldRelationId];
            // biome-ignore lint/style/noNonNullAssertion: 关系与parentchildren应该是同步的
            const oldTree = this.parentChildren.get(oldRelation.parent)!;
            this.parentChildren.set(
                oldRelation.parent,
                oldTree.filter((c) => c !== oldRelationId),
            );
        }

        this.wl_subsurface[subRelationId] = { parent, child, posi: { x: 0, y: 0 } };
        const parentData = this.parentChildren.get(parent) ?? [];
        parentData.push(subRelationId);
        this.parentChildren.set(parent, parentData);
        this.surface2subsurface.set(child, subRelationId);

        this.render.setCanvasAnchor(this.idScope(child), this.idScope(parent));

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
        sub.posi.x = x;
        sub.posi.y = y;

        this.render.setCanvasOffset(this.idScope(sub.child), x, y);
    }
    getSubSurface(id: WaylandObjectId2<"wl_subsurface">) {
        return {
            parent: this.wl_subsurface[id].parent,
            surface: this.wl_subsurface[id].child,
            posi: this.wl_subsurface[id].posi,
        };
    }
    getChildrenDeep(parent: WaylandObjectId2<"wl_surface">) {
        const surfaces: {
            id: WaylandObjectId2<"wl_surface">;
            offsetRect: { x: number; y: number; w: number; h: number };
        }[] = [];

        // todo 遍历树，offset相加
        surfaces.push(...this.getParentChildrenWithRect(parent));
        return surfaces;
    }
    destroySubSurface(id: WaylandObjectId2<"wl_subsurface">) {
        const relation = this.wl_subsurface[id];
        const parent = relation.parent;
        const child = relation.child;
        const parentData = this.parentChildren.get(parent);
        if (parentData) {
            this.parentChildren.set(
                parent,
                parentData.filter((c) => c !== id),
            );
        }
        this.surface2subsurface.delete(child);
        delete this.wl_subsurface[id];
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

/**
 * 键盘焦点的单写入点（`CoreApi.focusKeyboard` 的实现）：**同值直接去重**；变化才发
 * `leave`(旧) → `enter`(新) + `modifiers`、写 `seat.keyboardFocus`，最后 `ctx.notify.focus`
 * 扇出给派生物（text-input 的 enter/leave、selection 归属都挂在这条通知上）。
 *
 * 与 xdg 的 `actived` 是两条独立的轴：规范对 `configure(activated)` 与 `wl_keyboard.enter`
 * 的顺序没有要求，所以这里不碰 actived，谁先变都以最终态为准。
 *
 * 旧 surface 若已被客户端销毁就不发 leave（协议上不能引用死对象）——那条路径在 `wl_surface.destroy`。
 */
function focusKeyboard(ctx: ModuleCtx, surface: SurfaceId | null, seatName?: string): void {
    const seat = ctx.domain.seat.byName(seatName ?? "seat0");
    if (seat === undefined) return;
    const prev = seat.keyboardFocus;
    if (prev === surface) return;
    if (prev !== null && seat.keyboard && ctx.objects.has(prev))
        ctx.sendNow(seat.keyboard, "wl_keyboard.leave", { serial: 0, surface: prev });
    if (surface !== null && seat.keyboard) {
        ctx.sendNow(seat.keyboard, "wl_keyboard.enter", { serial: 0, surface: surface, keys: new Uint32Array([]) });
        ctx.sendNow(seat.keyboard, "wl_keyboard.modifiers", {
            serial: 0,
            mods_depressed: ctx.domain.seat.modifierMask(seat),
            mods_latched: 0,
            mods_locked: 0,
            group: 0,
        });
    }
    seat.keyboardFocus = surface;
    ctx.notify.focus(seat.name, surface ?? undefined);
    // selection 跟随键盘焦点：失焦即撤掉本 seat 上发给该客户端的宣告（重新聚焦由桌面 `clipboard.offer` 推）
    if (surface === null) clearSelection(ctx, seat.name);
}

/**
 * 指针焦点转移——**只管指针**：hover 是否要改键盘焦点是桌面政策（想 focus-follows-mouse 的桌面
 * 自己在 hover 时调 `window.focus`），wayland 内部不再自作主张。
 * 命中 surface 变了才发 leave/enter，且只发给**这一把 seat** 的 pointer。
 * 与几何命中检测分开——`ctx.domain.xdgSurface.hitTest` 是纯几何（xdg 域），这里只剩协议动作。
 */
function updatePointerFocus(ctx: ModuleCtx, seat: SeatRecord, hit: HitTestResult): void {
    const prevFocus = seat.pointerFocus;
    if (prevFocus === hit.surface) return;
    if (prevFocus && ctx.objects.has(prevFocus) && seat.pointer)
        ctx.sendNow(seat.pointer, "wl_pointer.leave", { serial: 0, surface: prevFocus });
    if (seat.pointer) {
        ctx.sendNow(seat.pointer, "wl_pointer.enter", {
            serial: 0,
            surface: hit.surface,
            surface_x: hit.x,
            surface_y: hit.y,
        });
        ctx.sendNow(seat.pointer, "wl_pointer.frame", {});
    }
    seat.pointerFocus = hit.surface;
}

/** 指针事件注入（只发这一把 seat 的 pointer）：坐标已由 hitTest 归一到 surface 局部 */
function sendPointer(ctx: ModuleCtx, seat: SeatRecord, ev: PointerCommand, hit: HitTestResult): void {
    const pointer = seat.pointer;
    if (pointer === undefined) return;
    const { x: nx, y: ny } = hit;
    if (ev.type === "move") {
        ctx.sendNow(pointer, "wl_pointer.motion", { time: Date.now(), surface_x: nx, surface_y: ny });
        ctx.sendNow(pointer, "wl_pointer.frame", {});
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
    ctx.sendNow(pointer, "wl_pointer.button", {
        serial: 0,
        time: Date.now(),
        button,
        state: getEnumValue("wl_pointer.button_state", ev.type === "down" ? "pressed" : "released"),
    });
    ctx.sendNow(pointer, "wl_pointer.frame", {});
}

/**
 * 按键注入：**该 seat 没有键盘焦点就不发**（否则客户端会收到不属于任何聚焦窗口的按键）。
 * 修饰键按该 seat 的掩码补发 `wl_keyboard.modifiers`（两把键盘各记各的；todo repeat）。
 */
function sendKey(ctx: ModuleCtx, seat: SeatRecord, key: number, state: "pressed" | "released"): void {
    const k = seat.keyboard;
    if (seat.keyboardFocus === null || k === undefined) return;
    const s = ctx.domain.seat.nextSerial();
    ctx.sendNow(k, "wl_keyboard.key", {
        serial: s,
        time: Date.now(),
        key: key,
        state: getEnumValue("wl_keyboard.key_state", state),
    });

    const bit = MOD_KEY_TO_BIT[key];
    if (bit === undefined) return;
    const store = ctx.domain.seat;
    if (state === "pressed") store.addModifier(seat, bit);
    else store.removeModifier(seat, bit);

    ctx.sendNow(k, "wl_keyboard.modifiers", {
        serial: s,
        mods_depressed: store.modifierMask(seat),
        mods_latched: 0, // todo not tracking latched in this implementation
        mods_locked: 0, // todo not tracking locked separately here
        group: 0,
    });
}

/**
 * 滚轮注入（只发这一把 seat 的 pointer；没有指针焦点说明指针不在任何窗口上，丢弃）。
 * todo region
 */
function sendScroll(ctx: ModuleCtx, seat: SeatRecord, ev: ScrollCommand): void {
    const pointer = seat.pointer;
    if (pointer === undefined || seat.pointerFocus === null) return;
    const { deltaX, deltaY } = ev;
    if (deltaX !== 0) {
        ctx.sendNow(pointer, "wl_pointer.axis", {
            time: Date.now(),
            axis: getEnumValue("wl_pointer.axis", "horizontal_scroll"),
            value: deltaX,
        });
    }
    if (deltaY !== 0) {
        ctx.sendNow(pointer, "wl_pointer.axis", {
            time: Date.now(),
            axis: getEnumValue("wl_pointer.axis", "vertical_scroll"),
            value: deltaY,
        });
    }
    ctx.sendNow(pointer, "wl_pointer.frame", {});
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

/**
 * offer 剪贴板给本客户端——**跟随键盘焦点**：不指定 seat 时只发给「本客户端正持有键盘焦点」的
 * 那些 seat 的 data_device（selection 归聚焦者所有，见 wayland.xml 对 selection 的说明）。
 * 若一个都还没聚焦（桌面 `clipboard.offer` 调得比 `window.focus` 早），退回发给全部 data_device，
 * 与旧的「全发」行为等价。
 */
function offerTo(ctx: ModuleCtx, seatName?: string): void {
    const devices = ctx.domain.dataDevice.devices;
    if (!devices) {
        console.error("No data devices to offer to");
        return;
    }
    let ddIds: WaylandObjectId2<"wl_data_device">[];
    if (seatName !== undefined) {
        ddIds = [...(devices.get(seatName) ?? [])];
    } else {
        const focused = [...ctx.domain.seat.all()].flatMap((s) => [...(devices.get(s.name) ?? [])]);
        // 一个 seat 都没聚焦（桌面 `clipboard.offer` 调得比 `window.focus` 早）→ 退回全发，等价旧行为
        ddIds = focused.length > 0 ? focused : [...devices.values()].flatMap((s) => [...s]);
    }

    for (const ddId of ddIds) {
        const dataOfferId = ctx.objects.create("wl_data_offer");
        ctx.sendNow(ddId, "wl_data_device.data_offer", { id: dataOfferId });
        ctx.sendNow(dataOfferId, "wl_data_offer.offer", { mime_type: "text/plain;charset=utf-8" });
        ctx.sendNow(dataOfferId, "wl_data_offer.offer", { mime_type: "text/plain" });
        ctx.sendNow(ddId, "wl_data_device.selection", { id: dataOfferId });
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
        };
    },
    domain: {
        dataDevice: () => ({ devices: undefined, pendingPaste: undefined }),
        textInput: () => ({ owner: null }),
        /** 输入设备记录（原 `state/seat_store.ts`，host 已不持有）：只有 core 读写 */
        seat: () => new SeatStore(),
    },
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
                const seatName = seatNameOf(ctx, msg);
                ctx.domain.seat.addSeat(id, seatName);
                ctx.send(id, "wl_seat.name", { name: seatName });
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

            // 各 global 的模块级副作用走本模块声明的 globals[].onBind（如 xdg_wm_base 见 ext/xdg_shell.ts）
            ctx.core.registry.globalOf(proto.name)?.onBind?.({ name, id: x.args.id, protocol: proto }, ctx);
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
            // 按所属 seat 归组：selection 归该 seat 的键盘焦点所有（跟随键盘焦点）
            const seatName = ctx.domain.seat.get(x.args.seat)?.name ?? "seat0";
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
            console.log(`wl_data_source#${x.id} offer ${x.args.mime_type}`);
        },
        "wl_data_offer.receive": (x, ctx) => {
            const offerId = x.id;
            const mime = x.args.mime_type;
            const fd = x.args.fd;

            // fallback: compositor-local paste flow – keep pendingPaste and emit paste for external handler
            if (ctx.domain.dataDevice.pendingPaste) {
                console.warn("Existing pending paste request - rejecting previous");
                try {
                    fs.closeSync(ctx.domain.dataDevice.pendingPaste.fd);
                } catch {
                    // ignore
                }
                clearTimeout(ctx.domain.dataDevice.pendingPaste.timeout);
                ctx.domain.dataDevice.pendingPaste = undefined;
            }

            const timeout = setTimeout(() => {
                if (!ctx.domain.dataDevice.pendingPaste) return;
                console.warn("paste request timed out");
                try {
                    fs.closeSync(ctx.domain.dataDevice.pendingPaste.fd);
                } catch {
                    // ignore
                }
                ctx.domain.dataDevice.pendingPaste = undefined;
            }, 10000);

            ctx.domain.dataDevice.pendingPaste = { offerId, fd, mime, timeout };
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
                ctx.cursor.updateFrame(surfaceId, fcanvas);
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
            ctx.cursor.hide(surfaceId);
            ctx.notify.destroy(surfaceId);
            // 焦点悬挂修复：该 surface 若持有某把 seat 的焦点就**静默清槽**——
            // 不能向已销毁的对象发 leave（客户端已释放该 id，引用死对象会把连接打死）；
            // text-input 之类经 `notify.destroy` 收敛自己的状态，不走 focus 通知。
            for (const seat of ctx.domain.seat.all()) {
                if (seat.pointerFocus === surfaceId) seat.pointerFocus = null;
                if (seat.keyboardFocus === surfaceId) {
                    seat.keyboardFocus = null;
                    clearSelection(ctx, seat.name);
                }
            }
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
            const seat = ctx.domain.seat.get(x.id);
            if (!seat) {
                console.warn(`Seat ${x.id} not found for get_pointer`);
                return;
            }
            seat.pointer = pointerId;
        },
        "wl_seat.get_keyboard": (x, ctx) => {
            const keyboardId = x.args.id;
            const seat = ctx.domain.seat.get(x.id);
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
            ctx.cursor.setSurface(
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
        /** 指针路由：几何命中（`ctx.domain.xdgSurface.hitTest`）→ 焦点转移 → 事件下发；没命中时不发（见 hitTest 的 leave todo） */
        "input.pointer": (msg, ctx) => {
            const ev = msg.args[0];
            const seat = resolveSeat(ctx, msg.args[1]);
            if (seat === undefined) return;
            const hit = ctx.domain.xdgSurface.hitTest(msg.winId, { x: ev.x, y: ev.y });
            if (!hit) return;
            updatePointerFocus(ctx, seat, hit);
            sendPointer(ctx, seat, ev, hit);
        },
        "input.scroll": (msg, ctx) => {
            const seat = resolveSeat(ctx, msg.args[1]);
            if (seat !== undefined) sendScroll(ctx, seat, msg.args[0]);
        },
        "input.key": (msg, ctx) => {
            const seat = resolveSeat(ctx, msg.args[2]);
            if (seat !== undefined) sendKey(ctx, seat, msg.args[0], msg.args[1]);
        },
        /** 仲裁交给各 text_input 模块（core 不认识 zwp_* 事件） */
        "input.text": (msg, ctx) => {
            const seat = resolveSeat(ctx, msg.args[2]);
            if (seat !== undefined) ctx.notify.textInput(seat.name, msg.args[0], msg.args[1]);
        },
        /** offer 跟随键盘焦点（见 `offerTo`）；剪贴板内容仍由桌面经 `clipboard.paste` 回填 */
        "clipboard.offer": (_msg, ctx) => offerTo(ctx),
    },
});
