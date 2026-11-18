/**
 * 桌面侧对外 API 的类型契约。
 *
 * 只有类型、零实现零副作用；`index.ts` 是唯一入口，host/ 负责实现这些形状。
 * 设计原则见 PLAN.md §0：对外 API 以「桌面需要回答的问题」建模
 * （有哪些窗口、多大、光标是什么、怎么操作），不以 Wayland 对象建模。
 *
 * 与 `module.ts` 的分工：module.ts 是**协议模块**的契约（handler / ctx），
 * 本文件是**桌面**的契约（事件 / 查询 / 控制），两边互不 import 实现。
 */
import type { SurfaceId } from "./module";

// ───────────────────────── 窗口身份 ─────────────────────────

/**
 * 服务端全局窗口身份：单调递增的 `"w1"`、`"w2"`…
 *
 * Wayland 对象 id 由**客户端本地分配**（实测两个客户端可同时用 `id: 9`），
 * 扁平事件不能直接用 windowId。递增 handle 客户端断开重连后 id 复用也不会串台。
 */
export type WinHandle = string;

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface WindowStates {
    activated: boolean;
    maximized: boolean;
    minimized: boolean;
    /**
     * 客户端请求或桌面下发的全屏。桌面按整块输出摆放窗口（不保留工具栏空间），
     * 退出全屏时恢复普通窗口尺寸。
     */
    fullscreen: boolean;
}

/** 宽高（不含位置） */
export interface Size {
    width: number;
    height: number;
}

// ───────────────────────── 输出 / 缩放 ─────────────────────────

/**
 * 一块输出的配置（当前单屏，后续多屏按列表扩展）。
 *
 * 坐标关系：桌面 CSS px = surface-local 逻辑 px × `scale`。
 * `mode` 是硬件像素；`scale` 是逻辑到物理的倍率（可分数）。
 */
export interface OutputInfo {
    name: string;
    description: string;
    /** 物理模式，硬件像素；refresh 单位 mHz */
    mode: { width: number; height: number; refresh: number };
    /** 1 surface-local px 对应多少物理 px，允许 1.25 / 1.5 等 */
    scale: number;
    transform: "normal" | "90" | "180" | "270";
    /** 物理尺寸（mm），未知时省略 */
    physicalSize?: Size;
}

/**
 * 一次自包含的窗口快照：`window.created` / `window.changed` 与查询接口共用。
 * 字段全部自包含，桌面拿到即可用，无需反查 client、无需拼 id。
 */
export interface WindowInfo {
    handle: WinHandle;
    /** 所属连接；需要按客户端过滤时才用 */
    clientId: string;
    /**
     * 该窗口的 `xdg_toplevel.set_app_id`（WM_CLASS）。
     * 是**窗口级**而不是连接级：xwayland-satellite 用一个连接承载全部 X11 窗口，
     * 每个应用的窗口有不同的 app_id，任务栏按它分组。
     */
    appid: string;
    title: string;
    /**
     * 是否协商为服务端装饰（xdg-decoration server_side）。
     * 为 true 时桌面应绘制自己的标题栏/边框，客户端不再画 CSD；
     * 为 false 时窗口内容已包含客户端自己的装饰，桌面不要再加一层。
     */
    decorated: boolean;
    /**
     * 窗口几何。
     * - `w`/`h`：客户端 `xdg_surface.set_window_geometry` 声明的尺寸（未设置时为 surface 尺寸）。
     * - `x`/`y`：客户端声明的几何偏移（surface 局部坐标），**不是屏幕位置**——
     *   摆放由桌面负责，桌面渲染时几何原点即窗口元素左上角（renderTools 已按 offset 平移内容）。
     *
     * 命中检测用 `server.windows.hitTest(handle, p)`（窗口元素的局部坐标）：
     * 它包含 popup 树、subsurface 与 input region，popup 超出顶层窗口范围时也能命中；
     * 只比较这个 `rect` 会漏掉超出窗口的 popup。
     */
    rect: Rect;
    /**
     * 该窗口所在输出的缩放。桌面显示尺寸 = `rect` × `scale`（surface 逻辑 → 桌面 CSS/物理 px）。
     * 输入坐标要反向换算：surface 坐标 = 桌面坐标 ÷ `scale`。
     */
    scale: number;
    states: WindowStates;
    /**
     * 父窗口（`xdg_toplevel.set_parent`）。顶层窗口为 `null`。
     *
     * 父窗口只在同一连接里（Wayland 对象 id 不能跨连接）；桌面据此把子窗口
     * 叠在父窗口之上、跟随父窗口的位置，并在 `modal` 时阻塞父窗口的输入。
     * 父窗口关闭时 server 按协议把子窗口接到祖父窗口，并补发 `window.changed`。
     */
    parent: WinHandle | null;
    /**
     * 是否模态（xdg-dialog-v1 `set_modal`）。只是客户端的提示：
     * 桌面可选择阻塞父窗口的输入；没有 `parent` 时没有意义。
     */
    modal: boolean;
    /** 客户端 `set_min_size` 的逻辑尺寸；0 表示该轴不限制 */
    minSize: { width: number; height: number };
    /** 客户端 `set_max_size` 的逻辑尺寸；0 表示该轴不限制 */
    maxSize: { width: number; height: number };
    /** 渲染侧不透明 id：`render.getXdgSurfaceEle(info.renderId)` */
    renderId: string;
}

// ───────────────────────── 光标状态 ─────────────────────────

/**
 * 光标的语义状态（`host/cursor_store.ts` 是唯一写入点，经 `ctx.cursor` 供协议读写）。
 * `shape` 是 wp_cursor_shape 的纯枚举名，可序列化；`image` 是 surface 图像，
 * 图像是一等数据（cursor 协议传的是 surface，不能藏在 DOM 实现里），故内联画布。
 */
export type CursorState =
    | { kind: "hidden" }
    | { kind: "shape"; shape: string; hotspot: { x: 0; y: 0 } }
    | {
          kind: "image";
          surfaceId: SurfaceId;
          hotspot: { x: number; y: number };
          /** 该 surface 最近一次合成的帧；还没提交过帧时为 undefined，桌面应保留上一张 */
          canvas?: OffscreenCanvas;
          /** 光标的 surface-local 逻辑尺寸；桌面显示尺寸 = size × 输出 scale */
          size: Size;
      };

// ───────────────────────── 文本输入 ─────────────────────────

/**
 * 某个窗口的文本输入状态。桌面据此决定是否把按键交给输入法：
 * 只有 `supported && enabled` 时才会上屏（`input.text` 对未启用/未焦点的客户端静默丢弃）。
 */
export interface TextInputState {
    /** 客户端是否创建过 text-input 对象（v1/v3），不代表当前已获得文本焦点 */
    supported: boolean;
    /** 当前仲裁持有并启用的协议 */
    protocol?: "v1" | "v3";
    /** 该窗口当前的文本焦点已启用输入（v3 还需 entered + enabled） */
    enabled: boolean;
    /** 光标矩形，surface 局部坐标；v1 或客户端未上报时为 null */
    cursorRect: Rect | null;
}

// ───────────────────────── 剪贴板 / 数据中转 ─────────────────────────

/**
 * 一次客户端 selection 的身份。server 不保存字节，桌面按需读取：
 * `await server.request("clipboard.read", change.token, mime)`。
 *
 * token 只在这次 selection 存活期间有效（下一次复制、清空或源连接断开后失效），
 * 所以想要历史的桌面要在 `clipboard.changed` 到达时立刻读。
 */
export interface ClipboardChange {
    token: string;
    seat: string;
    /** 源客户端声明的全部 mime；桌面按自己关心的子集读取 */
    mimes: string[];
    appid: string;
    clientId: string;
    time: number;
}

/** `clipboard.changed(null)` 的原因：显式清空，还是源客户端退出/销毁了 data_source */
export type ClipboardClearReason = "cleared" | "sourceGone";

/**
 * 桌面把历史条目放回剪贴板时声明的身份。
 * 字节不进 server：客户端 `wl_data_offer.receive` 时，server 用 `id` 向桌面发
 * `clipboard.requestData` 要数据。
 */
export interface DesktopClipboard {
    /** 桌面自己的条目 id，原样带回 `clipboard.requestData` */
    id: string;
    mimes: string[];
    /** 缺省 `seat0`；多 seat 时指定放回哪把 seat 的剪贴板 */
    seat?: string;
}

/** `clipboard.offer` 的 selection 描述；桌面通常只传 handle，由 server 填入当前 selection */
export interface ClipboardOffer {
    token: string;
    mimes: string[];
}

/**
 * 一次客户端拖拽。`token` 在拖拽期间有效，桌面可以按需读取数据
 * （`server.request("dnd.read", token, mime)`），用于把内容存进中转站。
 */
export interface DragStartInfo {
    token: string;
    clientId: string;
    appid: string;
    seat: string;
    mimes: string[];
    actions: ("copy" | "move")[];
}

export type DragEndReason = "finished" | "cancelled";

// ───────────────────────── 客户端 ─────────────────────────

export interface ClientLogConfig {
    receive: boolean | string[];
    send: boolean | string[];
}

/**
 * 桌面能从 `server.clients` 拿到的东西。
 *
 * 常规路径（窗口 / 光标 / 剪贴板的事件、查询、命令）一律走 server；
 * 这里只留连接级的底层入口：日志开关、remote/调试等明确要 client 对象的场景。
 */
export interface Client {
    readonly id: string;
    setLogConfig(op: ClientLogConfig): void;
}

// ───────────────────────── 输入命令 ─────────────────────────

/** x、y 相对该窗口的 xdg_surface 元素左上角 */
export interface PointerCommand {
    type: "move" | "down" | "up";
    x: number;
    y: number;
    button: number;
}

export interface ScrollCommand {
    /** 滚动量，按桌面 CSS px；滚轮来源约定一格 100px */
    deltaX: number;
    deltaY: number;
    deltaZ: number;
    /**
     * 滚动来源，缺省 `wheel`：
     * - `wheel`：鼠标滚轮，发离散步进（`axis_value120` / `axis_discrete`）
     * - `finger`：触摸板双指等连续滚动，只发连续 `axis`，不发离散值
     * - `continuous`：其它连续滚动，同 `finger`
     */
    source?: "wheel" | "finger" | "continuous";
    /**
     * 高精度滚轮的离散步数，单位 1/120 格（`wl_pointer.axis_value120` 的单位）。
     * 只有 `wheel` 使用；缺省按 `delta` 每 100px 一格换算。
     * 不随窗口 `scale` 变化（是物理刻度，不是 surface 坐标）。
     */
    value120X?: number;
    value120Y?: number;
    /** 连续滚动结束（触摸板抬手）；为 true 时发 `axis_stop`，此时 delta 可为 0 */
    stop?: boolean;
    /**
     * 物理方向与 axis 方向的关系（v9 的 `axis_relative_direction`）。
     * 自然滚动下手指方向与内容方向相反，传 `inverted`；缺省不发送。
     */
    relativeDirection?: "identical" | "inverted";
}

/**
 * 触摸板语义手势（pointer-gestures-unstable-v1）。
 *
 * 序列由桌面保证：`begin` → 若干 `update` → `end`；`hold` 只有 `begin` / `end`。
 * `deltaX` / `deltaY` 是手势逻辑中心的**相对位移**（surface-local，按手指方向，
 * 不做自然滚动翻转）；`scale` 是相对 begin 的绝对比例；`rotation` 是相对上一次
 * 事件的顺时针角度（度）。
 */
export type GestureCommand =
    | { type: "swipe"; phase: "begin"; fingers: number }
    | { type: "swipe"; phase: "update"; deltaX: number; deltaY: number }
    | { type: "swipe"; phase: "end"; cancelled?: boolean }
    | { type: "pinch"; phase: "begin"; fingers: number }
    | { type: "pinch"; phase: "update"; deltaX: number; deltaY: number; scale: number; rotation: number }
    | { type: "pinch"; phase: "end"; cancelled?: boolean }
    | { type: "hold"; phase: "begin"; fingers: number }
    | { type: "hold"; phase: "end"; cancelled?: boolean };

// ───────────────────────── server 级事件 ─────────────────────────

/**
 * 服务端 → 桌面，按域分组、payload 自包含，一次订阅覆盖**全部**客户端。
 *
 * 注意键是扁平的 `"域.动作"`（EventEmitter 的键没有嵌套语义），
 * 写成 `window.created` 这种形式只是分组记号。
 */
export type ServerEvents = {
    /** 新窗口，`renderId` 内嵌在 `info` 里 */
    "window.created": [info: WindowInfo];
    /** rect / states / title / appid / decorated / parent / modal 任一变化；payload 自包含，无需反查 */
    "window.changed": [info: WindowInfo];
    /** 窗口关闭，**含客户端断开时由 server 统一补发的关闭** */
    "window.closed": [handle: WinHandle];
    /** 客户端请求移动窗口（xdg_toplevel.move） */
    "window.startMove": [handle: WinHandle];
    "cursor.changed": [clientId: string, state: CursorState];
    /**
     * 客户端复制（selection 变化）或清空。`null` 时用 `reason` 区分显式清空与源消失。
     * 桌面收到非空 change 后应立刻 `clipboard.read` 取走自己要存的历史 mime。
     * `seat` 只在 `null` 时给出：哪把 seat 的 selection 没了。
     */
    "clipboard.changed": [change: ClipboardChange | null, reason?: ClipboardClearReason, seat?: string];
    /** 客户端开始拖拽（`wl_data_device.start_drag`）；桌面可据此弹出中转站 */
    "dnd.started": [drag: DragStartInfo];
    /** 拖拽结束；`reason` 区分正常 drop 与取消 */
    "dnd.finished": [token: string, reason: DragEndReason];
    "client.opened": [clientId: string];
    /** 该客户端的窗口已在此之前逐个发出 `window.closed` */
    "client.closed": [clientId: string];
};

// ───────────────────────── 命令（桌面 → server → client） ─────────────────────────

/**
 * server 内部按 handle 反查 `(client, winId)` 后下发，桌面不接触 Wayland 对象 id。
 * client 级命令（`clipboard.set` / `clipboard.clear` / `dnd.move` / `dnd.drop` / `dnd.cancel`）
 * 没有 handle，由 server 直接处理。
 * 无返回值；查询用 `request` / `windows.*`。
 */
export type ServerNotifyMap = {
    "window.focus": [handle: WinHandle];
    "window.blur": [handle: WinHandle];
    "window.close": [handle: WinHandle];
    /** 只记录桌面配置的盒子，不发 configure */
    "window.setBox": [handle: WinHandle, size: Size];
    "window.setSize": [handle: WinHandle, size: Size];
    /** 不带 size 时沿用盒子尺寸 */
    "window.maximize": [handle: WinHandle, size?: Size];
    "window.unmaximize": [handle: WinHandle, size?: Size];
    /**
     * 全屏：桌面下发整块输出尺寸。退出全屏会恢复进入前的最大化状态；
     * 进入前是普通窗口时用 `size`（缺省沿用盒子尺寸）恢复。
     */
    "window.fullscreen": [handle: WinHandle, size?: Size];
    "window.unfullscreen": [handle: WinHandle, size?: Size];
    "window.minimize": [handle: WinHandle];
    /**
     * `seat` 是**选择器不是广播位**：缺省 `"seat0"`（本机光标），显式传 `"seat1"` 才驱动第二把。
     * 一个 seat = 一个人的一套设备，同一事件发给多个 seat 会被客户端当成 N 把同步光标。
     */
    "input.pointer": [handle: WinHandle, ev: PointerCommand, seat?: string];
    "input.scroll": [handle: WinHandle, ev: ScrollCommand, seat?: string];
    /** 触摸板手势；发给 handle 对应窗口，`begin`/`end` 的 serial、surface 由 server 补 */
    "input.gesture": [handle: WinHandle, ev: GestureCommand, seat?: string];
    "input.key": [handle: WinHandle, key: number, state: "pressed" | "released", seat?: string];
    "input.text": [handle: WinHandle, text: string, preedit: boolean, seat?: string];
    /**
     * 桌面把历史条目放回剪贴板（`null` = 清空）。字节不进 server，
     * 客户端真正粘贴时 server 用 `clipboard.requestData` 向桌面要。
     * 这是 client 级命令：server 不走 handle 反查。
     */
    "clipboard.set": [selection: DesktopClipboard | null];
    "clipboard.clear": [];
    /**
     * 把当前剪贴板或指定 selection offer 给该客户端，通常在获得键盘焦点时调用。
     * `selection` 仅供 server 内部填充，桌面只传 handle 即可。
     */
    "clipboard.offer": [handle: WinHandle, selection?: ClipboardOffer, seat?: string];
    /**
     * 桌面驱动拖拽目标：`target` 为 null 表示离开当前目标。
     * x/y 是目标窗口的 surface-local 逻辑坐标。
     */
    "dnd.move": [token: string, target: { handle: WinHandle; x: number; y: number } | null];
    /** 在目标窗口（或 null = 窗口外释放）松开，server 完成 drop 并转发数据 */
    "dnd.drop": [token: string, target: { handle: WinHandle; x: number; y: number } | null];
    /**
     * 取消拖拽会话（client 级命令）。中转站收下数据后调用；
     * 数据要先通过 `dnd.read` 读完，取消后 token 失效。
     */
    "dnd.cancel": [token: string];
    /** server 内部：桌面开始驱动目标时撤掉源客户端本地目标，桌面不直接调用 */
    "dnd.detachLocal": [];
    /** server 内部：会话结束后清掉源客户端本地拖拽状态 */
    "dnd.endLocal": [];
};

// ───────────────────────── 请求-应答 ─────────────────────────

/**
 * 请求-应答（形状同 `event-emitter` 的 `RequestEventMap`）。
 * 双向：`window.*` 由 server 自己应答（桌面查询），`surfaceBounds.request` 由桌面应答（server 查询）。
 *
 * 注意 `surfaceBounds.request` 必须**同步**应答——`xdg_surface.get_toplevel` 在同步
 * handler 里就要填 `configure_bounds`，Promise 版的 `EventEmitter.request` 来不及。
 * server 侧保留同步副本，见 `host/server.ts`。
 */
export type ServerRequests = {
    "window.get": { args: [handle: WinHandle]; result: WindowInfo };
    "window.getBounds": { args: [handle: WinHandle]; result: Rect };
    /** 该窗口的 text-input 状态与光标矩形，输入法候选窗定位/按键分流用 */
    "textInput.get": { args: [handle: WinHandle]; result: TextInputState };
    /** 桌面提供可用空间，注册一次，见 api.ts */
    "surfaceBounds.request": { args: []; result: Size };
    /** 读取客户端 selection 的字节；token 来自 `clipboard.changed`，失效/无数据返回 null */
    "clipboard.read": { args: [token: string, mime: string]; result: Uint8Array | null };
    /**
     * server 向桌面要数据（桌面作为剪贴板/拖拽源时）。
     * server 侧带超时；桌面没响应或返回 null 会关闭目标 fd。
     */
    "clipboard.requestData": { args: [id: string, mime: string]; result: Uint8Array | null };
    /** 读取拖拽源的数据；token 来自 `dnd.started`，拖拽结束后失效 */
    "dnd.read": { args: [token: string, mime: string]; result: Uint8Array | null };
    /** 桌面作为拖拽源开始一次会话；`id` 原样回到 `dnd.requestData` */
    "dnd.start": {
        args: [item: { id: string; mimes: string[] }, actions?: ("copy" | "move")[]];
        result: string;
    };
    /** 桌面作为拖拽源时，目标 receive 后向桌面要数据 */
    "dnd.requestData": { args: [id: string, mime: string]; result: Uint8Array | null };
};
