/**
 * 协议模块与系统之间的全部契约。
 *
 * 零实现、零副作用；依赖只允许指向叶子类型模块（protocols/wayland-types、
 * utils/wayland-binary、render_tools、api），**不得 import 任何实现文件**，
 * 否则协议模块之间会重新形成环。api.ts 也是纯类型，与本文件的互相 import
 * 只在类型层，编译期即被擦除。
 *
 * `WaylandDataRegistry` 本身是空的：各协议状态由对应文件的 `declare module`
 * 声明合并进来（`protocols/core/region.ts` 是样板）。
 */
import type { OutputInfo, ServerNotifyMap } from "./api";
import type { wlSurfaceData } from "./protocols/core/wayland";
import type { WaylandEnumObj, WaylandEventObj, WaylandInterfaces, WaylandRequestObj } from "./protocols/wayland-types";
import type { renderTools } from "./render_tools";
import type { WaylandName, WaylandObjectId, WaylandOp, WaylandProtocol } from "./utils/wayland-binary";

// ───────────────────────── 对象 id（品牌类型） ─────────────────────────
// brand 只从三个入口产生：生成类型的 msg.args、host 的 NEW_ID 登记、ctx.objects.create()。

export type WaylandObjectId2<t extends WaylandInterfaces> = number & {
    __brand: "WaylandObjectId";
    __interface: t;
};
export type WaylandObjectId3<t extends string> = number & { __brand: "WaylandObjectId"; __interface: t };

export type SurfaceId = WaylandObjectId2<"wl_surface">;
export type BufferId = WaylandObjectId2<"wl_buffer">;
/** 窗口即 xdg_toplevel 对象；跨客户端会撞，桌面侧全局身份是 api.ts 的 WinHandle */
export type WaylandWinId = WaylandObjectId2<"xdg_toplevel">;

// ───────────────────────── 对象状态类型 ─────────────────────────

export type WaylandSurfaceData = {
    /** `null` = 客户端 `attach(nil)` 过，commit 后 surface 处于 unmap（与「本次没 attach」的 undefined 不同） */
    buffer?: { id: BufferId } | null;
    /** 客户端上报的 damage：合成时保留 damage 外的上一帧内容（surface / buffer 坐标） */
    damageList?: { x: number; y: number; width: number; height: number }[];
    damageBufferList?: { x: number; y: number; width: number; height: number }[];
    /** 一次 commit 可以挂多个 frame 回调；每个都要 done，漏掉会让客户端一直等 */
    callbacks?: WaylandObjectId2<"wl_callback">[];
    /** 与 wl_region 模块声明的 rects 同形；此处内联以免 module.ts 反向依赖声明方 */
    inputRegion?: { x: number; y: number; width: number; height: number; type: "+" | "-" }[];
    /** `wl_surface.set_buffer_scale`，默认 1；buffer 像素 ÷ scale = surface 逻辑像素 */
    bufferScale?: number;
    /** `wl_surface.set_buffer_transform`，目前只按 normal 合成 */
    bufferTransform?: number;
    viewport?: {
        source?: { x: number; y: number; width: number; height: number };
        destination?: { width: number; height: number };
    };
};

/**
 * 每种接口挂在对象上的状态形状。
 * 各协议文件用 `declare module`（模块说明符按该文件到 module.ts 的相对路径写）
 * 追加自己的条目，不动这里。
 */
// biome-ignore lint/suspicious/noEmptyInterface: 各协议文件靠 declare module 向这个空 interface 合并状态类型，改成 type 会让它们全部失效
export interface WaylandDataRegistry {}

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

// ───────────────────────── 桌面命令（api.ts → 协议模块） ─────────────────────────

/**
 * `requests` 是 client→server，`actions` 是它的镜像：**桌面主动驱动**的命令
 * （`server.notify(...)`）由协议模块承接，组包、serial、遍历设备、状态维护都在
 * 协议文件里，host 只负责 handle 反查与派发。
 */
export type ActionKey = keyof ServerNotifyMap;

/** 命令表去掉首参 handle —— handle 是桌面身份，host 反查后换成 `winId`；无首参的 client 级命令得到 `[]` */
export type ActionArgs<K extends ActionKey> = K extends unknown
    ? ServerNotifyMap[K] extends [unknown, ...infer R]
        ? R
        : []
    : never;

export interface ActionMsg<K extends ActionKey = ActionKey> {
    /** handle 反查到的窗口对象（xdg_toplevel id）；`clipboard.*` 等客户端级 action 可忽略 */
    winId: WaylandWinId;
    args: ActionArgs<K>;
}

export type ActionHandlers = {
    [K in ActionKey]?: (msg: ActionMsg<K>, ctx: ModuleCtx) => void;
};

/** 装配态用的单一签名（各键 handler 的联合签名会把参数收成交集，先折平） */
export type ActionFn = (msg: ActionMsg<ActionKey>, ctx: ModuleCtx) => void;

/** 书写态用对象字面量：键名写错编译期报错，args 按键精确推导 */
export type RequestHandlers = {
    [K in RequestKey]?: (msg: RequestMsg<K>, ctx: ModuleCtx) => void | Promise<void>;
};

export interface BindMsg {
    /** 全局 name，用于反查接口 */
    name: WaylandName;
    id: WaylandObjectId;
    protocol: WaylandProtocol;
    /** 客户端 `bind` 时协商的版本；事件只能发到这个版本的范围内 */
    version: number;
}

export interface ModuleGlobal {
    name: string;
    onBind?: (msg: BindMsg, ctx: ModuleCtx) => void;
}

/** 某个域状态的提供函数；`K` 是 `WaylandDomainRegistry` 的 key（由协议自己 `declare module` 声明） */
export type DomainInit<K extends keyof WaylandDomainRegistry> = (ctx: ModuleCtx) => WaylandDomainRegistry[K];
/** 模块声明的域状态提供者表：只允许填自己声明的 key，跨模块重复由 `assertModuleConflicts()` 拦 */
export type DomainInits = { [K in keyof WaylandDomainRegistry]?: DomainInit<K> };

/** 协议文件导出的书写态 */
export interface ProtocolModuleDef {
    /** 与生成物 protocols.json 对应，如 "xdg_shell" */
    name: string;
    globals?: readonly ModuleGlobal[];
    requests?: RequestHandlers;
    /** 桌面命令的出口（`server.notify` → 本表），见 `ActionKey` */
    actions?: ActionHandlers;
    hooks?: Partial<SurfaceHooks & SeatHooks & TextInputHooks & OutputHooks>;
    /**
     * core 能力的提供者（`registry` 除外——那是 host 对全部 `globals` 的跨模块聚合）。
     * 域状态实例在自己文件里 `new`，装配知识只写在这里，host 不 import 任何协议的构造。
     */
    core?: (ctx: ModuleCtx) => Omit<CoreApi, "registry">;
    /** 协议域状态的提供者；key 必须是本模块声明进 `WaylandDomainRegistry` 的字段 */
    domain?: DomainInits;
}

/** 装配后的运行态：Map 是 host 的分发优化，不暴露给书写者 */
export interface ProtocolModule {
    name: string;
    globals: readonly ModuleGlobal[];
    requests: ReadonlyMap<RequestKey, NonNullable<RequestHandlers[RequestKey]>>;
    actions: ReadonlyMap<ActionKey, ActionFn>;
    hooks: Partial<SurfaceHooks & SeatHooks & TextInputHooks & OutputHooks>;
    /** 见 `ProtocolModuleDef.core`；没有提供 core 能力的模块为 undefined */
    core?: (ctx: ModuleCtx) => Omit<CoreApi, "registry">;
    /** 见 `ProtocolModuleDef.domain` */
    domain: DomainInits;
}

/**
 * 把书写态编译成运行态。分发循环仍是 `requests.get(key)` / `actions.get(key)`，O(1) 不变。
 * 装配期还会校验同一 `接口.请求` 或同一命令被两个模块声明（现在 Map.set 会静默覆盖）。
 */
export function defineModule(def: ProtocolModuleDef): ProtocolModule {
    const entries = Object.entries(def.requests ?? {}) as [RequestKey, NonNullable<RequestHandlers[RequestKey]>][];
    const actions = Object.entries(def.actions ?? {}) as [ActionKey, ActionFn][];
    return {
        name: def.name,
        globals: def.globals ?? [],
        requests: new Map(entries),
        actions: new Map(actions),
        hooks: def.hooks ?? {},
        core: def.core,
        domain: def.domain ?? {},
    };
}

// ───────────────────────── 对象表窄访问面 ─────────────────────────

export interface ObjectInfo<I extends WaylandInterfaces> {
    protocol: WaylandProtocol;
    data: DataOf<I>;
    /**
     * 这个对象自己的版本：`bind` 时客户端协商的值，客户端 `new_id` 创建时继承父对象，
     * 服务端创建时由 `create` 指定。事件按它过滤（`since` 超过版本的一律不发）。
     */
    version: number;
}

export interface ObjectApi {
    get<I extends WaylandInterfaces>(id: WaylandObjectId2<I>): ObjectInfo<I>;
    /** 对象不存在时返回 undefined（不发协议错误） */
    getOption<I extends WaylandInterfaces>(id: WaylandObjectId2<I> | undefined): ObjectInfo<I> | undefined;
    getData<I extends WaylandInterfaces>(id: WaylandObjectId2<I>): DataOf<I>;
    setData<I extends WaylandInterfaces>(id: WaylandObjectId2<I>, data: DataOf<I>): void;
    /** 服务端自发对象（wl_callback、wl_data_offer…）；`version` 一般取相关父对象的版本，缺省用接口最大版本 */
    create<I extends WaylandInterfaces>(iface: I, version?: number): WaylandObjectId2<I>;
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
    /** 销毁前取关系：拿到 child surface 用于撤掉最后一帧 */
    getSubSurface(id: SubSurfaceId): { parent: SurfaceId; surface: SurfaceId; posi: { x: number; y: number } };
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
    initialCommitDone: boolean;
    configurePending: boolean;
    lastConfigureSerial?: number;
    /** 最近一次广播给桌面的窗口尺寸（显式 winGeo 或退化的 surface 尺寸） */
    reportedSize?: { w: number; h: number };
    popupConfigure?: { x: number; y: number; width: number; height: number };
}

export interface XdgSurfaceApi {
    addXdgSurface(id: XdgSurfaceId, wlSurface: SurfaceId): void;
    getXdgSurface(id: XdgSurfaceId): XdgSurfaceInfo;
    getXdgSurfaceByWlSurface(id: SurfaceId): XdgSurfaceId | undefined;
    /** 客户端级单调 serial（0 在 Qt 里等于「没有 configure」） */
    nextConfigureSerial(): number;
    ackConfigure(id: XdgSurfaceId, serial: number): void;
    /** `xdg_popup.grab`：seat 名 → grab 栈（嵌套 popup 压栈） */
    grabPopup(seatName: string, popupId: XdgPopupId, xdgSurfaceId: XdgSurfaceId): void;
    /** 指针按下：关掉不再包含指针的 grabbing popup（点击外部关闭） */
    dismissGrabsForPointer(hit: HitTestResult | undefined, seatName: string, ctx: ModuleCtx): void;
    /** 窗口失焦/销毁：关掉属于该 toplevel 的 grabbing popup */
    dismissGrabsForWindow(winId: WaylandWinId, ctx: ModuleCtx): void;
    setXdgSurfaceSize(id: XdgSurfaceId, x: number, y: number, w: number, h: number): void;
    /** 无 `set_window_geometry` 时，按当前 surface 尺寸同步渲染元素（不写 winGeo） */
    setSurfaceGeo(id: XdgSurfaceId): void;
    /** 外部状态（如装饰模式）变化后请求一次 configure；初始 commit 前会转成 pending */
    requestConfigure(id: XdgSurfaceId): void;
    getXdgSurfaceByToplevel(id: XdgToplevelId): XdgSurfaceId | undefined;
    getXdgSurfaceByPopup(id: XdgPopupId): XdgSurfaceId | undefined;
    setAsToplevel(id: XdgSurfaceId, toplevelId: XdgToplevelId): void;
    setAsPopup(id: XdgSurfaceId, popupId: XdgPopupId, parent: XdgSurfaceId): void;
    setOffset(id: XdgSurfaceId, x: number, y: number): void;
    /** xdg_surface 在窗口元素坐标系里的偏移（父链累加）；toplevel 为 0 */
    absoluteOffset(id: XdgSurfaceId): { x: number; y: number };
    /** 沿 parent 链找到顶层 xdg_surface */
    rootXdgSurface(id: XdgSurfaceId): XdgSurfaceId;
    /** 连接断开：撤掉该连接的全部 xdg 元素（不再走协议 destroy） */
    destroyAll(): void;
    popupDestroyed(popupId: XdgPopupId, ctx: ModuleCtx): void;
    toplevelDestroyed(toplevelId: XdgToplevelId): void;
    /** 窗口几何：`winGeo` 优先，未声明时退化为 surface 尺寸（host 的 `windowRect` 在用） */
    getReRect(id: XdgSurfaceId): { w: number; h: number };
    /**
     * xdg_surface 子树里所有 popup（含嵌套子菜单），偏移已合并父链、与顶层坐标系一致。
     * 本模块的 `hitTest` 在用。
     */
    getChildenDeepOnlyPopup(parent: XdgSurfaceId): {
        id: XdgSurfaceId;
        offset: { x: number; y: number };
        size: { w: number; h: number };
    }[];
    /**
     * 指针命中检测（纯几何）：xdg 几何 + popup 树 + subsurface + input region。
     * `p` 相对窗口元素左上角（几何原点）；没命中任何 surface 时 undefined —— 此时**不发 leave**。
     * core 的 `input.pointer` 在调；焦点转移与 enter/leave 的协议动作留在 core。
     */
    hitTest(winId: WaylandWinId, p: { x: number; y: number }): HitTestResult | undefined;
}

export interface RegistryApi {
    /** 当前所有 global，供 wl_display.get_registry 广播 */
    globals(): Iterable<{ name: WaylandName; protocol: WaylandProtocol }>;
    /** 按全局 name（数字）查协议 */
    byName(name: WaylandName): WaylandProtocol | undefined;
    /** 按接口名查该模块声明的 global（绑定时初始化用） */
    globalOf(interfaceName: string): ModuleGlobal | undefined;
}

/**
 * 扩展可以依赖的 core 能力全集。
 * 这是「协议模块不互相 import」那条原则的落地手段：xdg_shell 之类只认这里，
 */
export interface CoreApi {
    surface: wlSurfaceData;
    subsurface: SubSurfaceApi;
    registry: RegistryApi;
    /**
     * 键盘焦点转移（**每 seat 一份**，由桌面 `window.focus`/`window.blur` 驱动，hover 不参与）：
     * 同值直接去重返回；变化才发 `leave`(旧) → `enter`(新) + `modifiers`、写 `seat.keyboardFocus`、
     * 最后 `ctx.notify.focus(seat, surface)` 扇出给 text-input / selection 等派生物。
     *
     * `seat` 缺省 `"seat0"`。两轴独立：xdg 的 `actived` 由 `window.focus` 自己去重维护，
     * 规范对 `configure(activated)` 与 `wl_keyboard.enter` 的顺序没有要求。
     */
    focusKeyboard(surface: SurfaceId | null, seat?: string): void;
}

/**
 * 协议域状态注册表：与 `WaylandDataRegistry` 同构，空接口由各协议 `declare module` 合并。
 * key 即 `ctx.domain` 的字段名，值是该域对外的接口（`XdgSurfaceApi` 之类）；
 * 实例由声明方模块的 `domain` initializer `new`，host 只按清单跑一遍。
 */
// biome-ignore lint/suspicious/noEmptyInterface: 各协议靠 declare module 向这个空 interface 合并域状态 key，改成 type 会让声明合并全部失效
export interface WaylandDomainRegistry {}

// ───────────────────────── 反向通知：core → 扩展 ─────────────────────────

/**
 * core → 扩展的**通知**通道：扩展注册回调，`host/client.ts` 聚合成 `ctx.notify.*` 扇出。
 * 双向通信里这是通知（无返回、扇出）那一半；查询直接同步调 `ctx.domain.*` 的域方法。
 * core 不 import 扩展。
 */
export interface SurfaceHooks {
    /**
     * 每次 wl_surface.commit 后（含无 buffer 的初始 commit）触发。
     * `sizeChanged` 为本次 commit 是否改变了 surface 尺寸；xdg 用初始 commit 下发 configure，
     * 之后仅在状态 pending 时补发。
     */
    onCommit?(surfaceId: SurfaceId, sizeChanged: boolean, ctx: ModuleCtx): void;
    /**
     * 像素已合成、渲染之前：可返回替换后的画布（viewporter 之类做后处理）。
     * 与 onCommit 分开是因为两者时机不同——合成逻辑必须在 damage 绘制之后。
     *
     * `pending` 是本次 commit 的双缓冲状态（合并进 current 之前的那份），
     * 原样传下去。
     */
    onFrame?(
        surfaceId: SurfaceId,
        canvas: OffscreenCanvas,
        pending: WaylandSurfaceData,
        ctx: ModuleCtx,
    ): OffscreenCanvas | undefined;
    onDestroy?(surfaceId: SurfaceId, ctx: ModuleCtx): void;
}

export interface SeatHooks {
    /**
     * 某把 seat 的键盘焦点变化（`focusKeyboard` 触发）。`surfaceId === undefined` 表示该 seat 失焦。
     * seat 名来自 `wl_seat.name`（`"seat0"`/`"seat1"`…），text-input 之类按它过滤自己的对象。
     */
    onFocus?(seat: string, surfaceId: SurfaceId | undefined, ctx: ModuleCtx): void;
}

/**
 * 输出配置变化的通知：桌面调用 `server.outputs.set` 后，host 对每个连接扇出一次。
 * 协议模块据此重发 `wl_output` / `preferred_*` 事件；不需要重新 map 窗口。
 */
export interface OutputHooks {
    onOutput?(ctx: ModuleCtx): void;
}

export interface TextInputHooks {
    /**
     * 桌面注入文本（`input.text`）。仲裁状态在 `ctx.domain.textInput.owner`（core 的域），
     * 各 text_input 模块自判是否持有，非持有者直接 return —— core 不认识 zwp_* 事件。
     *
     * `seat` 是发起输入的那把 seat（选择器语义，缺省 `"seat0"`）：持有者若绑定在别的 seat 上，
     * 说明是另一个人在打字，直接忽略。
     */
    onTextInput?(seat: string, text: string, preedit: boolean, ctx: ModuleCtx): void;
}

// ───────────── text-input 状态类型与客户端级事件出口 ─────────────

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
    /** 该对象绑在哪把 seat 上（`get_text_input(id, seat)` 的 seat 参数；焦点与按键按它过滤） */
    seat: string;
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

/**
 * client 级事件是 **client → server 的内部管道**：
 * server 订阅后 fan-in 成 `api.ts` 的 server 级事件（handle 化、自包含），
 * `Client` 接口上不暴露这张表。
 */
export interface WaylandClientEventMap {
    close: () => void;
    windowCreated: (xdgToplevelId: WaylandWinId, renderId: string) => void;
    windowClosed: (xdgToplevelId: WaylandWinId) => void;
    windowStartMove: (xdgToplevelId: WaylandWinId) => void;
    windowResized: (xdgToplevelId: WaylandWinId, width: number, height: number) => void;
    windowMaximized: (xdgToplevelId: WaylandWinId) => void;
    windowUnMaximized: (xdgToplevelId: WaylandWinId) => void;
    windowFullscreen: (xdgToplevelId: WaylandWinId) => void;
    windowUnFullscreen: (xdgToplevelId: WaylandWinId) => void;
    windowAppid: (xdgToplevelId: WaylandWinId, appid: string) => void;
    /** 服务端装饰（xdg-decoration server_side）开关变化 */
    windowDecorated: (xdgToplevelId: WaylandWinId, decorated: boolean) => void;
    title: (xdgToplevelId: WaylandWinId, title: string) => void;
    /** `xdg_toplevel.set_parent` 变化；`parent` 为 undefined 表示取消父窗口 */
    windowParent: (xdgToplevelId: WaylandWinId, parent: WaylandWinId | undefined) => void;
    /** xdg-dialog-v1 的模态提示变化 */
    windowModal: (xdgToplevelId: WaylandWinId, modal: boolean) => void;
    /** 客户端用 xdg-foreign 导出（或撤销导出）窗口句柄；portal 的 parent_window 用它解析 */
    toplevelExported: (handle: string, xdgToplevelId: WaylandWinId) => void;
    toplevelUnexported: (handle: string) => void;
}

// ───────────── 语义 Store 与客户端自身（结构化实现，由 host 注入） ─────────────

export interface WindowRecord {
    actived: boolean;
    box: { width: number; height: number };
    /** 该窗口最近一次 `xdg_toplevel.set_app_id`；同一连接的不同窗口可以不同 */
    appid: string;
    /** 是否由桌面绘制服务端装饰（xdg-decoration 协商为 server_side） */
    decorated: boolean;
    title: string;
    /**
     * `xdg_toplevel.set_parent` 的父窗口（同一连接内的 xdg_toplevel）。
     * 只描述「子窗口挂在谁上面」，位置/层级/输入阻塞由桌面决定。
     */
    parent?: WaylandWinId;
    /** 是否模态（xdg-dialog-v1 set_modal）；桌面据此阻塞父窗口输入 */
    modal: boolean;
    /** 客户端 `set_min_size` 的逻辑尺寸；0 表示不限制 */
    minSize: { width: number; height: number };
    /** 客户端 `set_max_size` 的逻辑尺寸；0 表示不限制 */
    maxSize: { width: number; height: number };
    /** 由桌面命令或客户端 set/unset_maximized 维护，进 WindowInfo.states */
    maximized: boolean;
    minimized: boolean;
    /** 由桌面命令或客户端 set/unset_fullscreen 维护，进 WindowInfo.states */
    fullscreen: boolean;
    /**
     * 进入全屏前是否处于最大化。退出全屏时用它恢复原状态；
     * 只在本模块内部使用，不进 WindowInfo。
     */
    fullscreenRestoreMaximized: boolean;
}

export interface WindowsApi {
    /** 活的 Map：桌面与 mock 会直接遍历/增删它 */
    readonly wins: Map<WaylandWinId, WindowRecord>;
    get(id: WaylandWinId): WindowRecord | undefined;
    created(id: WaylandWinId, renderId: string): void;
    /** 仅移除记录；destroy 流程里 xdg 清理夹在 remove 与 notifyClosed 之间（顺序对桌面可见） */
    remove(id: WaylandWinId): void;
    notifyClosed(id: WaylandWinId): void;
    setAppid(id: WaylandWinId, appid: string): void;
    setDecorated(id: WaylandWinId, decorated: boolean): void;
    setTitle(id: WaylandWinId, title: string): void;
    /** `xdg_toplevel.set_parent`；`undefined` 表示取消父窗口 */
    setParent(id: WaylandWinId, parent: WaylandWinId | undefined): void;
    /**
     * 父窗口被销毁：把它的子窗口按协议接到祖父窗口（没有祖父就取消父关系）。
     * 必须在 `remove(parent)` 之前调用，否则读不到父窗口自己的父链。
     */
    detachChildren(id: WaylandWinId): void;
    setModal(id: WaylandWinId, modal: boolean): void;
    /** `xdg_toplevel.set_min_size` / `set_max_size`；0 表示该轴不限制 */
    setSizeLimits(
        id: WaylandWinId,
        min?: { width: number; height: number },
        max?: { width: number; height: number },
    ): void;
    resized(id: WaylandWinId, width: number, height: number): void;
    startMove(id: WaylandWinId): void;
    setMaximized(id: WaylandWinId, maximized: boolean): void;
    setFullscreen(id: WaylandWinId, fullscreen: boolean): void;
}

export interface CursorApi {
    setSurface(
        id: SurfaceId,
        hotspot: { x: number; y: number },
        frame?: OffscreenCanvas,
        size?: { width: number; height: number },
    ): void;
    updateFrame(id: SurfaceId, frame: OffscreenCanvas, size?: { width: number; height: number }): void;
    hide(id?: SurfaceId): void;
    setShape(shape: string): void;
    isCursorSurface(id: SurfaceId): boolean;
}

export interface SeatRecord {
    /** seat 名（registry 广播的第几个 `wl_seat` global：`seat0`/`seat1`…）；`input.*` 的 `seat` 参数按它选择 */
    name: string;
    /**
     * 该 seat 上全部 `wl_pointer` 资源。同一客户端可以在多份 registry 上重复 `get_pointer`
     * （Firefox 会这么做），事件必须发给每一个，只留最后一个会让窗口收不到输入。
     */
    pointers: Set<WaylandObjectId2<"wl_pointer">>;
    /** 同上，`wl_keyboard` 资源可能不止一个 */
    keyboards: Set<WaylandObjectId2<"wl_keyboard">>;
    /** 指针焦点：该 seat 的 `wl_pointer` 已 enter 的 surface（leave/enter 的比较基线） */
    pointerFocus: SurfaceId | null;
    /** 指针焦点内的最近坐标：后创建的 wl_pointer 补发 enter 时用 */
    pointerPos: { x: number; y: number };
    /**
     * 键盘焦点：该 seat 的 `wl_keyboard` 已 enter 的 surface。
     * **由桌面 `window.focus`/`window.blur` 驱动**（hover 政策归桌面，wayland 内部不自作主张）；
     * 与 xdg 的 `actived` 是两条独立的轴，规范对两者顺序无要求。
     */
    keyboardFocus: SurfaceId | null;
    /** 该 seat 的修饰键位（`mods_depressed` 的掩码原料），两把键盘各记各的 */
    mods: Set<number>;
}

export interface SeatApi {
    addSeat(id: WaylandObjectId2<"wl_seat">, name: string): void;
    get(id: WaylandObjectId2<"wl_seat">): SeatRecord | undefined;
    /** 按 seat 名取：`input.*` 的 `seat` 参数就按它解析（缺省 `"seat0"`） */
    byName(name: string): SeatRecord | undefined;
    all(): IterableIterator<SeatRecord>;
    nextSerial(): number;
    addModifier(seat: SeatRecord, bit: number): void;
    removeModifier(seat: SeatRecord, bit: number): void;
    modifierMask(seat: SeatRecord): number;
}

/**
 * `XdgSurfaceApi.hitTest` 的结果：命中哪个 surface、局部坐标，以及命中的 xdg 角色
 * （信息字段：上层据此区分主 surface 与 popup）。
 */
export interface HitTestResult {
    surface: SurfaceId;
    /** 该 surface 所属的 xdg_surface（主 surface 或某个 popup） */
    xdgSurface: XdgSurfaceId;
    /** 相对该 surface 的坐标 */
    x: number;
    y: number;
    role: "main" | "popup";
}

export interface ClientApi {
    /** 连接 id，仅日志用 */
    id: string;
    displayId: WaylandObjectId2<"wl_display">;
    /** client 级事件；server 订阅后 fan-in 成 server 级事件（见 api.ts） */
    emit<K extends keyof WaylandClientEventMap>(event: K, ...args: Parameters<WaylandClientEventMap[K]>): void;
    /**
     * 桌面提供的可用空间。
     * 必须同步返回——`xdg_surface.get_toplevel` 在同步 handler 里就要填 `configure_bounds`，
     * 由 `server.respond("surfaceBounds.request", …)` 注册，见 api.ts。
     */
    surfaceBounds(): { width: number; height: number } | undefined;
    /** 当前输出配置（桌面用 `server.outputs.set` 写入，协议只读） */
    output(): OutputInfo;
}

/**
 * 数据中转：剪贴板 / 拖拽的 fd 与字节都经这里。
 *
 * 协议模块只拿 token 和 mime，不关心数据在哪个连接、桌面还是客户端；
 * 字节的缓存、持久化、预览全在桌面，server 只负责把 fd 送到正确的一侧。
 */
export interface TransferApi {
    /** 客户端 `set_selection`：server 记录 selection、发 `clipboard.changed`、并把 offer 推给焦点客户端 */
    selectionChanged(seat: string, sourceId: number, mimes: string[]): void;
    /** 客户端把 selection 清空（`set_selection(nil)`） */
    clearSelection(seat: string): void;
    /** 客户端销毁 `wl_data_source`；若它正是当前 selection，server 清空并报 `sourceGone` */
    sourceDestroyed(sourceId: number): void;
    /**
     * 把某个 offer 的 fd 交给 token 背后的数据源；调用方交出 fd 所有权。
     * 客户端源直接转发给 `wl_data_source.send`，桌面源则走 `clipboard.requestData`。
     */
    forward(token: string, mime: string, fd: number): void;
    /** 客户端开始拖拽；server 建一个只读 token 并通知桌面 */
    dragStarted(seat: string, sourceId: number, mimes: string[], actions: ("copy" | "move")[]): void;
    /** 拖拽结束（正常 drop 或取消）；token 失效 */
    dragFinished(sourceId: number, reason: "finished" | "cancelled"): void;
}

/** 跨客户端拖拽会话里，目标侧 core 转发给 hub 的事件（offer 带 `dndSessionId`） */
export interface DndApi {
    targetAccept(token: string, offerId: number, mime: string): void;
    targetActions(token: string, offerId: number, actions: number, preferred: number): void;
    targetReceive(token: string, offerId: number, mime: string, fd: number): void;
    targetFinish(token: string, offerId: number): void;
    targetGone(token: string, offerId: number): void;
    /** 源 `wl_data_source.set_actions` 同步到全局会话 */
    sourceActions(sourceId: number, actions: number): void;
}

/** 单个连接给全局拖拽 hub 的窄接口；实现里只碰自己的对象表和 ctx */
export interface DndPeer {
    clientId: string;
    objects: ObjectApi;
    sendNow(id: number, event: string, args: Record<string, unknown>): void;
    dataDevices(seat: string): WaylandObjectId2<"wl_data_device">[];
    nextSerial(): number;
    hitTest(winId: WaylandWinId, p: { x: number; y: number }): HitTestResult | undefined;
    sendDataSource(sourceId: number, mime: string, fd: number): boolean;
    readDataSource(sourceId: number, mime: string): Promise<Uint8Array | null>;
    /** 桌面开始驱动目标后，撤掉源客户端自己的同 client 目标 */
    detachLocalDrag(): void;
    /** 会话结束：清掉源客户端的本地拖拽状态（不再发 cancelled） */
    endLocalDrag(): void;
}

/** host 持有的全局拖拽会话；server 创建一次，所有连接共用 */
export interface DndHubApi {
    attach(peer: DndPeer): void;
    detach(clientId: string): void;
    forClient(clientId: string): DndApi;
    startClient(
        clientId: string,
        appid: string,
        seat: string,
        sourceId: number,
        mimes: string[],
        actions: number,
    ): string;
    sourceActions(clientId: string, sourceId: number, actions: number): void;
    sourceFinished(clientId: string, sourceId: number, reason: "finished" | "cancelled"): void;
    read(token: string, mime: string): Promise<Uint8Array | null>;
    move(token: string, target: { clientId: string; winId: WaylandWinId; x: number; y: number } | null): void;
    drop(token: string, target: { clientId: string; winId: WaylandWinId; x: number; y: number } | null): void;
    cancel(token: string): void;
    startDesktop(itemId: string, mimes: string[], actions?: number): string;
}

// ───────────────────────── handler 运行时上下文 ─────────────────────────

/**
 * handler 拿得到的一切 —— 把「闭包捕获整个 WaylandClient」收窄成清单。
 * 拆分能成立的前提：handler 不碰 `this`，只依赖这里注入的东西。
 */
export interface ModuleCtx {
    objects: ObjectApi;
    send: EventApi["send"];
    sendNow: EventApi["sendNow"];
    postError: EventApi["postError"];
    /** core 面：扩展唯一可依赖的东西（`registry` 之外由 core 模块的 `core` initializer 提供） */
    core: CoreApi;
    /** 协议域状态；key 见 `WaylandDomainRegistry`，各协议 `declare module` 合并出字段 */
    domain: WaylandDomainRegistry;
    /**
     * 光标的单写入点。留 host 是因为它的两个出口一个在 renderTools（`ctx.scene`）、
     * 一个在 `ClientHost.cursorChanged`（不在 ctx），而它同时被 core 与 cursor_shape 两个协议读写。
     * 窗口与 seat 的记录各自归拥有它的协议（`ctx.domain.windows` / `ctx.domain.seat`）。
     */
    cursor: CursorApi;
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
        /** 某把 seat 的键盘焦点变化（`SeatHooks.onFocus` 扇出） */
        focus(seat: string, surfaceId: SurfaceId | undefined): void;
        /** 桌面注入文本，各 text_input 模块按仲裁结果自判（`TextInputHooks.onTextInput`） */
        textInput(seat: string, text: string, preedit: boolean): void;
    };
    /** 客户端自身 */
    client: ClientApi;
    /** 数据中转（剪贴板 / 拖拽的 fd 与字节出口） */
    transfer: TransferApi;
    /** 跨客户端拖拽：目标侧 offer 事件交给全局 hub */
    dnd: DndApi;
    /** 场景投影（可能瘦身为 SceneCmd 分发，像素走 ImageKV） */
    scene: renderTools;
}
