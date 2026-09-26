/**
 * 协议模块与系统之间的全部契约。
 *
 * 零实现、零副作用；依赖只允许指向叶子类型模块（protocols/wayland-types、
 * utils/wayland-binary、render_tools），**不得 import 任何实现文件**，
 * 否则协议模块之间会重新形成环。
 *
 * Phase 1 先建立契约本身；各接口的实现随 Phase 3-5 拆分落地。
 * 注意这里的 WaylandDataRegistry 是当前中央表的快照，Phase 3 起逐条移进
 * 各协议文件的 `declare module`，最终 module.ts 只留空壳。
 */
import type { WaylandEnumObj, WaylandEventObj, WaylandInterfaces, WaylandRequestObj } from "./protocols/wayland-types";
import type { renderTools } from "./render_tools";
import type { WaylandName, WaylandObjectId, WaylandOp, WaylandProtocol } from "./utils/wayland-binary";

// ───────────────────────── 对象 id（品牌类型） ─────────────────────────
// 从 server.ts 上移：这是纯类型，属于契约而非实现。
// brand 只从三个入口产生：生成类型的 msg.args、host 的 NEW_ID 登记、ctx.objects.create()。

export type WaylandObjectId2<t extends WaylandInterfaces> = number & {
    __brand: "WaylandObjectId";
    __interface: t;
};
export type WaylandObjectId3<t extends string> = number & { __brand: "WaylandObjectId"; __interface: t };

export type SurfaceId = WaylandObjectId2<"wl_surface">;
export type BufferId = WaylandObjectId2<"wl_buffer">;
/** 窗口即 xdg_toplevel 对象；跨客户端会撞，桌面侧全局身份属 Phase 6 的 WinHandle */
export type WaylandWinId = WaylandObjectId2<"xdg_toplevel">;

// ───────────────────────── 对象状态类型 ─────────────────────────

export type WaylandSurfaceData = {
    buffer?: { id: BufferId };
    damageList?: { x: number; y: number; width: number; height: number }[];
    damageBufferList?: { x: number; y: number; width: number; height: number }[];
    callback?: WaylandObjectId2<"wl_callback">;
    inputRegion?: WaylandData["wl_region"]["rects"];
    viewport?: {
        source?: { x: number; y: number; width: number; height: number };
        destination?: { width: number; height: number };
    };
};

/**
 * 每种接口挂在对象上的状态形状。
 * 各协议文件用 `declare module "../module" { interface WaylandDataRegistry { ... } }` 追加，
 * 不再改这里的中央表。
 */
export interface WaylandDataRegistry {
    wl_shm_pool: { fd: number };
    wl_surface: {
        canvas: OffscreenCanvas;
        current: WaylandSurfaceData;
        pending: WaylandSurfaceData;
    };
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
    wl_region: {
        rects: { x: number; y: number; width: number; height: number; type: "+" | "-" }[];
    };
    xdg_wm_base: { pingSerials: Map<number, () => void> };
    xdg_positioner: {
        size: { width: number; height: number };
        anchor_rect: { x: number; y: number; width: number; height: number };
        anchor: number;
        gravity: number;
        constraint_adjustment: number;
        offset: { x: number; y: number };
        reactive: boolean;
        parent_size: { parent_width: number; parent_height: number };
    };
    wl_data_source: { offers: string[] };
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
    wp_viewport: {
        surface: SurfaceId;
    };
    wp_cursor_shape_device_v1: {
        // 绑定的指针设备，目前只有 wl_pointer
        pointer: WaylandObjectId2<"wl_pointer">;
    };
}

/** 兼容 server.ts 现有写法；协议模块请直接用 WaylandDataRegistry */
export type WaylandData = WaylandDataRegistry;

export type DataOf<I extends WaylandInterfaces> = I extends keyof WaylandDataRegistry
    ? WaylandDataRegistry[I]
    : undefined;

// ───────────────────────── 模块声明 ─────────────────────────

export type RequestKey = keyof WaylandRequestObj;

export interface RequestMsg<K extends RequestKey = RequestKey> {
    /** 被调用的对象（wl_display 特例为 1） */
    id: WaylandObjectId;
    proto: WaylandProtocol;
    op: WaylandOp;
    args: WaylandRequestObj[K];
}

/** 书写态用对象字面量：键名写错编译期报错，args 按键精确推导 */
export type RequestHandlers = {
    [K in RequestKey]?: (msg: RequestMsg<K>, ctx: ModuleCtx) => void | Promise<void>;
};

export interface BindMsg {
    /** 全局 name，用于反查接口 */
    name: WaylandName;
    id: WaylandObjectId;
    protocol: WaylandProtocol;
}

export interface ModuleGlobal {
    name: string;
    version: number;
    onBind?: (msg: BindMsg, ctx: ModuleCtx) => void;
}

/** 协议文件导出的书写态 */
export interface ProtocolModuleDef {
    /** 与生成物 protocols.json 对应，如 "xdg_shell" */
    name: string;
    globals?: readonly ModuleGlobal[];
    requests?: RequestHandlers;
    hooks?: Partial<SurfaceHooks & SeatHooks>;
}

/** 装配后的运行态：Map 是 host 的分发优化，不暴露给书写者 */
export interface ProtocolModule {
    name: string;
    globals: readonly ModuleGlobal[];
    requests: ReadonlyMap<RequestKey, NonNullable<RequestHandlers[RequestKey]>>;
    hooks: Partial<SurfaceHooks & SeatHooks>;
}

/**
 * 把书写态编译成运行态。分发循环仍是 `requests.get(key)`，O(1) 不变。
 * 装配期还会校验同一 `接口.请求` 被两个模块声明（现在 Map.set 会静默覆盖）。
 */
export function defineModule(def: ProtocolModuleDef): ProtocolModule {
    const entries = Object.entries(def.requests ?? {}) as [RequestKey, NonNullable<RequestHandlers[RequestKey]>][];
    return {
        name: def.name,
        globals: def.globals ?? [],
        requests: new Map(entries),
        hooks: def.hooks ?? {},
    };
}

// ───────────────────────── 对象表窄访问面 ─────────────────────────

export interface ObjectInfo<I extends WaylandInterfaces> {
    protocol: WaylandProtocol;
    data: DataOf<I>;
}

export interface ObjectApi {
    get<I extends WaylandInterfaces>(id: WaylandObjectId2<I>): ObjectInfo<I>;
    getData<I extends WaylandInterfaces>(id: WaylandObjectId2<I>): DataOf<I>;
    setData<I extends WaylandInterfaces>(id: WaylandObjectId2<I>, data: DataOf<I>): void;
    /** 服务端自发对象（wl_callback、wl_data_offer…） */
    create<I extends WaylandInterfaces>(iface: I): WaylandObjectId2<I>;
    delete(id: WaylandObjectId): void;
    has(id: WaylandObjectId): boolean;
    /**
     * `wl_registry.bind` 的新对象接口由全局 name 决定，是唯一无法在编译期确定 brand 的入口，
     * 由 registry 模块内部完成 brand。
     */
    bind(msg: BindMsg): void;
}

// ───────────────────────── 事件发送 ─────────────────────────

/** 枚举名由接口名推导；该接口没有 error 枚举时退化为 number */
export type ErrorCode<I extends string> = `${I}.error` extends keyof WaylandEnumObj
    ? WaylandEnumObj[`${I}.error`]
    : number;

export interface EventApi {
    /** 入队，本批消息处理完统一 flush —— 请求上下文用这个 */
    send<I extends WaylandInterfaces, T extends keyof WaylandEventObj & `${I}.${string}`>(
        target: WaylandObjectId2<I>,
        event: T,
        args: WaylandEventObj[T],
    ): void;
    /** 立即写 socket —— Store 回调、定时器、桌面主动推送等非请求上下文 */
    sendNow<I extends WaylandInterfaces, T extends keyof WaylandEventObj & `${I}.${string}`>(
        target: WaylandObjectId2<I>,
        event: T,
        args: WaylandEventObj[T],
    ): void;
    postError<I extends WaylandInterfaces>(
        iface: I,
        id: WaylandObjectId2<I>,
        code: ErrorCode<I>,
        message?: string,
    ): void;
}

// ───────────────────────── 正向依赖：扩展 → core ─────────────────────────

export type SurfaceRole = "subsurface" | "toplevel" | "popup" | "cursor";

export interface WlSurfaceApi {
    getRole(id: SurfaceId): SurfaceRole | undefined;
    /** false = role 冲突（对应现 WaylandSurfaceRoleError → 客户端 bad_surface） */
    setRole(id: SurfaceId, role: SurfaceRole): boolean;
    getSize(id: SurfaceId): { w: number; h: number };
    getFrame(id: SurfaceId): OffscreenCanvas | undefined;
}

export interface RegistryApi {
    /** 当前所有 global，供 wl_display.get_registry 广播（现 waylandProtocolsNameMap，server.ts:835-842） */
    globals(): Iterable<{ name: WaylandName; protocol: WaylandProtocol }>;
}

export interface BufferApi {
    /** 解析 wl_buffer 的 shm/dmabuf 载荷；对象不存在时返回 undefined */
    get(id: BufferId): WaylandDataRegistry["wl_buffer"] | undefined;
}

export interface WlSeatApi {
    /** 当前键盘焦点 surface（现 obj2.focusSurface） */
    focus(): SurfaceId | undefined;
    /** 分配 serial（现 obj2.serial，server.ts:2393-2394） */
    nextSerial(): number;
}

/**
 * 扩展可以依赖的 core 能力全集。
 * 这是「协议模块不互相 import」那条原则的落地手段：xdg_shell 之类只认这里，
 * 不认识 wlSurfaceData 这些具体类。
 */
export interface CoreApi {
    surface: WlSurfaceApi;
    registry: RegistryApi;
    buffer: BufferApi;
    seat: WlSeatApi;
}

// ───────────────────────── 反向通知：core → 扩展 ─────────────────────────

/** core 不 import 扩展，扩展注册回调；这是唯一的反向通道 */
export interface SurfaceHooks {
    /** 现 server.ts:1066-1072（发 xdg configure）、:1095-1115（viewporter 合成） */
    onCommit?(surfaceId: SurfaceId, ctx: ModuleCtx): void;
    /** 现 server.ts:1141-1145（destroy 清 cursor）、:1147 的 todo 级联清理 */
    onDestroy?(surfaceId: SurfaceId, ctx: ModuleCtx): void;
}

export interface SeatHooks {
    /** 现 server.ts:2385/:2390（键盘焦点驱动 text-input enter/leave） */
    onFocus?(surfaceId: SurfaceId | undefined, ctx: ModuleCtx): void;
}

// ───────────────────────── handler 运行时上下文 ─────────────────────────

/**
 * handler 拿得到的一切 —— 把「闭包捕获整个 WaylandClient」收窄成清单。
 * 拆分能成立的前提：handler 移出文件后不再有 `this`，只依赖这里注入的东西。
 */
export interface ModuleCtx {
    objects: ObjectApi;
    send: EventApi["send"];
    sendNow: EventApi["sendNow"];
    postError: EventApi["postError"];
    /** 扩展唯一可依赖的 core 面 */
    core: CoreApi;
    /** 场景投影（Phase 2 瘦身为 SceneCmd 分发，像素走 ImageKV） */
    scene: renderTools;
    // state: { cursor: CursorStore; windows: WindowsStore; seat: SeatStore };  // Phase 2 随 Store 落地
}
