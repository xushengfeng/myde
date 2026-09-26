/**
 * 协议模块与系统之间的全部契约。
 *
 * 零实现、零副作用；依赖只允许指向叶子类型模块（protocols/wayland-types、
 * utils/wayland-binary、render_tools），**不得 import 任何实现文件**，
 * 否则协议模块之间会重新形成环。
 *
 * Phase 1 先建立契约本身；各接口的实现随 Phase 3-5 拆分落地。
 * 注意这里的 WaylandDataRegistry 仍是多数协议状态的中央表；随 Phase 3-5 逐条
 * 移进各协议文件的 `declare module`（region 已作为样板迁出），最终只留空壳。
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
    /** 与 wl_region 模块声明的 rects 同形；此处内联以免 module.ts 反向依赖声明方 */
    inputRegion?: { x: number; y: number; width: number; height: number; type: "+" | "-" }[];
    viewport?: {
        source?: { x: number; y: number; width: number; height: number };
        destination?: { width: number; height: number };
    };
};

/**
 * 每种接口挂在对象上的状态形状。
 * 各协议文件用 `declare module`（模块说明符按该文件到 module.ts 的相对路径写）
 * 追加自己的条目，不再改这里。
 */
export interface WaylandDataRegistry {
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

export type DataOf<I extends WaylandInterfaces> = I extends keyof WaylandDataRegistry
    ? WaylandDataRegistry[I]
    : undefined;

// ───────────────────────── 模块声明 ─────────────────────────

export type RequestKey = keyof WaylandRequestObj;

/** 由 `"接口.请求"` 推出被调对象的品牌类型，handler 里无需再 cast */
type BrandedId<K extends string> = K extends `${infer I}.${string}` ? WaylandObjectId3<I> : never;

export type RequestMsg<K extends RequestKey = RequestKey> = {
    /** 被调用的对象（wl_display 特例为 1） */
    id: BrandedId<K>;
    proto: WaylandProtocol;
    op: WaylandOp;
    args: WaylandRequestObj[K];
};

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
    /** 对象不存在时返回 undefined（不发协议错误） */
    getOption<I extends WaylandInterfaces>(id: WaylandObjectId2<I> | undefined): ObjectInfo<I> | undefined;
    getData<I extends WaylandInterfaces>(id: WaylandObjectId2<I>): DataOf<I>;
    setData<I extends WaylandInterfaces>(id: WaylandObjectId2<I>, data: DataOf<I>): void;
    /** 服务端自发对象（wl_callback、wl_data_offer…） */
    create<I extends WaylandInterfaces>(iface: I): WaylandObjectId2<I>;
    delete(id: WaylandObjectId): void;
    has(id: WaylandObjectId): boolean;
    /** 遍历全部对象（按协议名过滤等场景） */
    entries(): IterableIterator<[WaylandObjectId, ObjectInfo<WaylandInterfaces>]>;
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

export interface WlSurfaceInfo {
    role: SurfaceRole | undefined;
    size: { w: number; h: number };
    /** 最近一次合成输出的画布，可能与 surface 画布共用，取用时需要复制 */
    frame?: OffscreenCanvas;
}

export interface WlSurfaceApi {
    /** wl_compositor.create_surface：登记 surface 并建出场景节点 */
    addWlSurface(id: SurfaceId): void;
    getWlSurface(id: SurfaceId): WlSurfaceInfo;
    getRole(id: SurfaceId): SurfaceRole | undefined;
    /** false = role 冲突（对应现 WaylandSurfaceRoleError → 客户端 bad_surface） */
    setRole(id: SurfaceId, role: SurfaceRole): boolean;
    getSize(id: SurfaceId): { w: number; h: number };
    getFrame(id: SurfaceId): OffscreenCanvas | undefined;
    updateWlSurfaceSize(id: SurfaceId, w: number, h: number): void;
    setWlSurfaceOffset(id: SurfaceId, x: number, y: number): void;
    /** 提交合成后的帧到场景 */
    renderWlSurface(id: SurfaceId, canvas: OffscreenCanvas): void;
    destroyWlSurface(id: SurfaceId): void;
    /** 渲染侧不透明 id：同一 surface 在不同 renderer 下 id 不同 */
    idScope(id: unknown): string;
}

export type SubSurfaceId = WaylandObjectId2<"wl_subsurface">;
export type XdgSurfaceId = WaylandObjectId2<"xdg_surface">;
export type XdgToplevelId = WaylandObjectId2<"xdg_toplevel">;
export type XdgPopupId = WaylandObjectId2<"xdg_popup">;

export interface SubSurfaceApi {
    /** 返回 bad_surface / bad_parent 或 true，由调用方转成协议错误 */
    setWlSubSurface(sub: SubSurfaceId, parent: SurfaceId, child: SurfaceId): "bad_surface" | "bad_parent" | true;
    setPosition(id: SubSurfaceId, x: number, y: number): void;
    destroySubSurface(id: SubSurfaceId): void;
    getChildrenDeep(parent: SurfaceId): {
        id: SurfaceId;
        offsetRect: { x: number; y: number; w: number; h: number };
    }[];
}

export interface XdgSurfaceInfo {
    surface: SurfaceId;
    winGeo?: { x: number; y: number; w: number; h: number };
    offset: { x: number; y: number };
    xdg_role?: XdgToplevelId | XdgPopupId;
    parent: XdgSurfaceId | undefined;
    children: XdgSurfaceId[];
}

export interface XdgSurfaceApi {
    addXdgSurface(id: XdgSurfaceId, wlSurface: SurfaceId): void;
    getXdgSurface(id: XdgSurfaceId): XdgSurfaceInfo;
    setXdgSurfaceSize(id: XdgSurfaceId, x: number, y: number, w: number, h: number): void;
    getXdgSurfaceByToplevel(id: XdgToplevelId): XdgSurfaceId | undefined;
    getXdgSurfaceByPopup(id: XdgPopupId): XdgSurfaceId | undefined;
    setAsToplevel(id: XdgSurfaceId, toplevelId: XdgToplevelId): void;
    setAsPopup(id: XdgSurfaceId, popupId: XdgPopupId, parent: XdgSurfaceId): void;
    setOffset(id: XdgSurfaceId, x: number, y: number): void;
    popupDestroyed(popupId: XdgPopupId): void;
    toplevelDestroyed(toplevelId: XdgToplevelId): void;
}

export interface RegistryApi {
    /** 当前所有 global，供 wl_display.get_registry 广播 */
    globals(): Iterable<{ name: WaylandName; protocol: WaylandProtocol }>;
    /** 按全局 name（数字）查协议 */
    byName(name: WaylandName): WaylandProtocol | undefined;
    /** 按接口名查该模块声明的 global（绑定时初始化用，替代原 if 链） */
    globalOf(interfaceName: string): ModuleGlobal | undefined;
}

export interface BufferApi {
    /** 解析 wl_buffer 的 shm/dmabuf 载荷；对象不存在时返回 undefined */
    get(id: BufferId): WaylandDataRegistry["wl_buffer"] | undefined;
}

export interface WlSeatApi {
    /** 当前键盘焦点 surface（现 obj2.focusSurface），null 表示无焦点 */
    focus(): SurfaceId | null;
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
    subsurface: SubSurfaceApi;
    registry: RegistryApi;
    buffer: BufferApi;
    seat: WlSeatApi;
}

// ───────────────────────── 反向通知：core → 扩展 ─────────────────────────

/** core 不 import 扩展，扩展注册回调；这是唯一的反向通道 */
export interface SurfaceHooks {
    /**
     * buffer 已应用、像素尚未合成。`sizeChanged` 为本次 commit 是否改变了 surface 尺寸
     * ——xdg 只在此时发 configure。
     */
    onCommit?(surfaceId: SurfaceId, sizeChanged: boolean, ctx: ModuleCtx): void;
    /**
     * 像素已合成、渲染之前：可返回替换后的画布（viewporter 之类做后处理）。
     * 与 onCommit 分开是因为两者时机不同——合成逻辑必须在 damage 绘制之后。
     *
     * `pending` 是本次 commit 的双缓冲状态（合并进 current 之前的那份），
     * 原实现读的就是它，原样传下去以保持行为一致。
     */
    onFrame?(
        surfaceId: SurfaceId,
        canvas: OffscreenCanvas,
        pending: WaylandSurfaceData,
        ctx: ModuleCtx,
    ): OffscreenCanvas | void;
    onDestroy?(surfaceId: SurfaceId, ctx: ModuleCtx): void;
}

export interface SeatHooks {
    /** 现 server.ts:2385/:2390（键盘焦点驱动 text-input enter/leave） */
    onFocus?(surfaceId: SurfaceId | undefined, ctx: ModuleCtx): void;
}

// ───────────── 客户端级状态与事件（原 obj2 与事件表，Phase 3 上移） ─────────────

export type TextInputV3State = {
    /** 是否启用文本输入 */
    enabled: boolean;
    surroundingText: { text: string; cursor: number; anchor: number };
    /** 周围文本变化原因，应用到current后重置为input_method */
    textChangeCause: "input_method" | "other";
    contentHint: number;
    contentPurpose: number;
    /** 光标矩形（surface坐标），null表示客户端不支持 */
    cursorRect: { x: number; y: number; width: number; height: number } | null;
};

export type TextInputV3Data = {
    /** 是否收到enter，即文本输入焦点在本对象上 */
    entered: boolean;
    /** 客户端commit计数，作为done事件的serial */
    commitCount: number;
    /** 已应用的状态 */
    current: TextInputV3State;
    /** 待commit应用的状态 */
    pending: TextInputV3State;
};

export type TextInputOwner =
    | { protocol: "v1"; id: WaylandObjectId2<"zwp_text_input_v1"> }
    | { protocol: "v3"; id: WaylandObjectId2<"zwp_text_input_v3"> };

export interface WaylandClientEventMap {
    close: () => void;
    windowCreated: (xdgToplevelId: WaylandWinId, renderId: string) => void;
    windowClosed: (xdgToplevelId: WaylandWinId) => void;
    windowStartMove: (xdgToplevelId: WaylandWinId) => void;
    windowResized: (xdgToplevelId: WaylandWinId, width: number, height: number) => void;
    windowMaximized: (xdgToplevelId: WaylandWinId) => void;
    windowUnMaximized: (xdgToplevelId: WaylandWinId) => void;
    appid: (id: string) => void;
    title: (xdgToplevelId: WaylandWinId, title: string) => void;
    copy: (text: string) => void;
    paste: () => void;
}

export interface WaylandClientSyncEventMap {
    windowBound?: () => { width: number; height: number } | undefined;
}
// ───────────── 语义 Store 与客户端自身（结构化实现，由 host 注入） ─────────────

export interface WindowRecord {
    actived: boolean;
    box: { width: number; height: number };
    title: string;
}

export interface WindowsApi {
    /** 活的 Map：桌面与 mock 会直接遍历/增删它 */
    readonly wins: Map<WaylandWinId, WindowRecord>;
    get(id: WaylandWinId): WindowRecord | undefined;
    created(id: WaylandWinId, renderId: string): void;
    /** 仅移除记录；destroy 流程里 xdg 清理夹在 remove 与 notifyClosed 之间（顺序对桌面可见） */
    remove(id: WaylandWinId): void;
    notifyClosed(id: WaylandWinId): void;
    setTitle(id: WaylandWinId, title: string): void;
    resized(id: WaylandWinId, width: number, height: number): void;
    startMove(id: WaylandWinId): void;
    setMaximized(id: WaylandWinId, maximized: boolean): void;
}

export interface CursorApi {
    setSurface(id: SurfaceId, hotspot: { x: number; y: number }, frame?: OffscreenCanvas): void;
    updateFrame(id: SurfaceId, frame: OffscreenCanvas): void;
    hide(id?: SurfaceId): void;
    setShape(shape: string): void;
    isCursorSurface(id: SurfaceId): boolean;
}

/** 焦点来源：主 surface 还是 popup —— 决定键盘焦点要不要跟着切 */
export type FocusType = "main" | "popup" | null;

export interface SeatRecord {
    pointer?: WaylandObjectId2<"wl_pointer">;
    keyboard?: WaylandObjectId2<"wl_keyboard">;
}

export interface SeatApi {
    addSeat(id: WaylandObjectId2<"wl_seat">): void;
    get(id: WaylandObjectId2<"wl_seat">): SeatRecord | undefined;
    all(): IterableIterator<SeatRecord>;
    nextSerial(): number;
    addModifier(bit: number): void;
    removeModifier(bit: number): void;
    modifierMask(): number;
    focus(): SurfaceId | null;
    focusType(): FocusType;
    setFocus(surface: SurfaceId | null, type: FocusType): void;
}

/** 原 obj2 的剩余字段：clipboard、text-input 仲裁、appid 等 */
export interface ClientState {
    textInputV1?: {
        focus: WaylandObjectId | null;
        m: Map<WaylandObjectId2<"zwp_text_input_v1">, { focus: boolean; serial: number }>;
    };
    dataDevices?: Set<WaylandObjectId2<"wl_data_device">>;
    pendingPaste?: { offerId: WaylandObjectId; fd: number; mime: string; timeout: NodeJS.Timeout };
    /** text-input-v3，焦点跟随键盘焦点 */
    textInputV3: {
        focus: SurfaceId | null;
        m: Map<WaylandObjectId2<"zwp_text_input_v3">, TextInputV3Data>;
    };
    /** v1/v3 竞争仲裁的持有对象，null 表示无激活的 text_input */
    textInputOwner: TextInputOwner | null;
    xdg_wm_base: Set<WaylandObjectId2<"xdg_wm_base">>;
    appid: string | undefined;
}

export interface ClientApi {
    /** 连接 id，仅日志用 */
    id: string;
    displayId: WaylandObjectId2<"wl_display">;
    /** 协议版本继承表（bind 时按父对象版本补） */
    protoVersions: Map<string, number>;
    /** 客户端级状态（原 obj2） */
    state: ClientState;
    /** client 级事件；Phase 6 上提 server 级后改由 Store 出口 */
    emit<K extends keyof WaylandClientEventMap>(event: K, ...args: Parameters<WaylandClientEventMap[K]>): void;
    emitSync<K extends keyof WaylandClientSyncEventMap>(
        event: K,
        ...args: Parameters<NonNullable<WaylandClientSyncEventMap[K]>>
    ): ReturnType<NonNullable<WaylandClientSyncEventMap[K]>> | undefined;
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
    /** core 面：扩展唯一可依赖的东西 */
    core: CoreApi;
    /** 过渡：xdg 域服务，Phase 5 随 xdgSurfaceData 迁入 xdg 模块后删除 */
    domain: { xdgSurface: XdgSurfaceApi };
    /** 语义状态单写入点 */
    state: { windows: WindowsApi; cursor: CursorApi; seat: SeatApi };
    /**
     * core → 扩展的反向通知（唯一通道，扩展以 `hooks` 声明、core 只负责触发）。
     * core 不 import 扩展，所以这里聚合自 `protocolModules`。
     */
    notify: {
        /** buffer 已应用、像素尚未合成 */
        commit(surfaceId: SurfaceId, sizeChanged: boolean): void;
        /** 像素已合成、渲染之前；返回（可能被替换的）画布 */
        frame(surfaceId: SurfaceId, canvas: OffscreenCanvas, pending: WaylandSurfaceData): OffscreenCanvas;
        destroy(surfaceId: SurfaceId): void;
        focus(surfaceId: SurfaceId | undefined): void;
    };
    /** 客户端自身 */
    client: ClientApi;
    /** 场景投影（Phase 6 可能瘦身为 SceneCmd 分发，像素走 ImageKV） */
    scene: renderTools;
}
