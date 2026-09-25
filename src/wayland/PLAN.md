# server.ts 架构重构计划

> 状态：草案（未实施）
> 前提：当前版本不稳定，**允许破坏性变更**，不做兼容层/废弃期，一步到位。
> 目标：外部调用 API 更简洁，内部新增协议更方便。

---

## 0. 三条原则

1. **协议模块只依赖 core 接口，不互相 import**（规范层面 7 个已支持协议的外部引用全部是 `wl_*`，见 `script/wayland/xml/*.xml` 分析；唯一例外 xdg-decoration→xdg-shell 属单向链式依赖，允许直接 import）。
2. **协议只产生语义事实**（window 状态、cursor 状态、clipboard、输入焦点），**渲染是语义状态的一个投影/订阅者**，不是协议的调用对象。
3. **对外 API 以"桌面需要回答的问题"建模**（有哪些窗口、窗口现在多大、光标是什么、怎么操作它），而不是以 Wayland 对象建模（xdg_toplevel id、renderId、serial）。

---

## 1. 现状问题（重构靶子）

| # | 问题 | 位置 | 后果 |
|---|---|---|---|
| P1 | 单 god file 2710 行；`WaylandClient` 1948 行；`newOp()` 单函数 1040 行装 74 个 handler | `server.ts:622/817` | 新协议无处安放，改一处难评估影响 |
| P2 | 协议间无接口层，同 class 内直接互访私有字段，双向耦合 | `:547/:558`（xdg→surface role）、`:1066-1072`（surface→xdg configure）、`:1095-1115`（surface 内联 viewporter）、`:2385`（keyboard→text-input） | 拆分即断 |
| P3 | 中央状态表 `WaylandData`，新协议不加条目则 `data` 推导为 `never` | `:52-110`, `:155-158` | 每加协议必改全局类型 |
| P4 | 客户端级状态巨型袋 `obj2`，`cursorSurface` 被 4 处散写 | `:642-684`, `:1215/:1121/:1141/:1738` | 隐式"后到者生效"协议，不可测 |
| P5 | `wl_registry.bind` 字符串 if 链 | `:844-902` | 新增带初始化的 global 必改中枢 |
| P6 | cursor 语义在协议层降级为渲染命令，经 `onCursorUpdata` 绕回桌面 | `:1121/:1216/:1238/:1739` → `render_tools_el.ts:137` | 桌面拿到 `OffscreenCanvas\|string`，丢失语义；remote 不可序列化（`RemoteRender` 已漏实现 `setCursor`） |
| P7 | 事件平铺 10 个、payload 不完整（`windowCreated(id, renderId)` 二元组、`windowResized` 不带 rect） | `:166-178` | 桌面要反查、事件数随协议线性增长 |
| P8 | `renderTools` 19 方法 × 4 实现无同步保障 | `render_tools.d.ts:8-26` | 接口一改 4 处漂移，typecheck 抓不到 |
| P9 | `emitSync("windowBound")` 同步阻塞拉取 | `:1444` | 时序脆弱，测试易死锁 |
| P10 | ~~模块级副作用：import 即 `require("electron")`~~ **判定为不处理**：GPU 渲染/dmabuf 本就需要 electron 独特 API，且已有调起 electron 的测试（`test_runner`、`test/electron_app`），electron 依赖是合理前提 | `:3, :2686-2710` | 仅将公开入口收敛到 `index.ts`，**不做 electron 延迟初始化拆分** |
| P11 | `check_proto_code/check.ts` 靠 grep `server.ts` 源码统计覆盖率 | `script/check_proto_code/check.ts:31-45` | 把"协议代码必须在 server.ts"固化，拆分即打破 |
| P12 | 无协议级测试脚手架，仅 2 条端到端链路 | `src/wayland/test/` | 重构无安全网 |

---

## 2. 目标架构

```
                          ┌──────────────────────────────────────────┐
   外部（桌面）           │  src/wayland/index.ts  ← 唯一公开入口      │
  ───────────────         │  createServer() / WaylandServer          │
   client.windows.*  ────▶│                                          │
   client.cursor.*   ────▶│  对外：ClientEvents + Windows + Cursor   │
   client.window.*   ◀────│        + Control（request/respond）      │
   render 订阅语义  ◀─────│                                          │
                          └───────────────┬──────────────────────────┘
                                          │ 装配
                          ┌───────────────▼──────────────────────────┐
   内部（协议层）         │  host/  薄壳：socket、objects ID 表、      │
  ───────────────         │  编解码、消息分发、模块装配、错误码        │
                          │                                          │
                          │  module.ts  ← 全部共享接口（无实现）      │
                          │   · CoreApi（wl_surface / wl_seat /      │
                          │     wl_registry / buffer 的窄接口）      │
                          │   · SurfaceHooks / SeatHooks（core→扩展）│
                          │   · ModuleCtx（sendMessage/postError/    │
                          │     objects/render）                     │
                          │   · WaylandDataRegistry（声明合并）       │
                          │   · ClientEventMap（分域事件）            │
                          │                                          │
                          │  protocols/  ← 每协议一个文件，互不 import │
                          │   core/{display,registry,compositor,     │
                          │         surface,subsurface,seat,shm,…}.ts│
                          │   xdg_shell.ts  viewporter.ts  dmabuf.ts │
                          │   text_input_v1.ts  text_input_v3.ts     │
                          │   cursor_shape.ts  clipboard.ts          │
                          │                                          │
                          │  state/  ← 跨协议语义状态（单写入点）      │
                          │   cursor_store.ts  windows_store.ts      │
                          └───────────────┬──────────────────────────┘
                                          │ 订阅语义状态
                          ┌───────────────▼──────────────────────────┐
   渲染/远程层             │  scene/  按 surfaceId 寻址的融合 API      │
  ───────────────         │   ① 命令流 SceneCmd（可序列化）           │
                          │      绑定/布局/锚点/geo… 全是纯值操作     │
                          │   ② 图片 KV：surfaceId → 图像            │
                          │   render_tools_el = DOM 实现（读②应用布局）│
                          │   remote = 传输①②；mock = 内存实现        │
                          └──────────────────────────────────────────┘
```

关键转变：

- **`server.ts` 拆成 host + module + protocols + state + scene 五层**，`server.ts` 只保留 socket/ID 表/编解码/装配。
- **正向依赖（扩展→core）**：构造注入 `CoreApi` 接口，形态与现在 `deps.surfaces.setRole(...)` 几乎一致（现 `xdgSurfaceData.wl_surface` 的调用点 `:533/:547/:558` 平移）。
- **反向依赖（core→扩展）**：钩子注册，替换 `:1066-1072` 的字符串扫描与 `:1095-1115` 的内联合成。
- **跨协议共享状态（cursor、window）上收为 Store**，协议模块只调单写入点，渲染与桌面都是 Store 的订阅者。

---

## 3. 目录结构（目标）

```
src/wayland/
  index.ts                 # 新增：唯一对外入口（createServer、类型 re-export）
  PLAN.md                  # 本文件
  readme.md                # 协议清单（保留）
  module.ts                # 新增：所有共享接口与类型，零实现、零副作用
  host/
    server.ts              # WaylandServer：socket 监听、建连、模块装配
    client.ts              # WaylandClient：objects ID 表、解码分发、deleteObj/postError
    registry.ts            # global 注册表与 bind 分发（替代 if 链）
    encoder.ts             # sendMessage*（由现 server.ts:1941-2061 迁出）
  state/
    cursor_store.ts        # CursorStore：唯一 cursor 状态写入点
    windows_store.ts       # WindowsStore：窗口快照与生命周期
    seat_store.ts          # 焦点、serial、textInput 仲裁
  protocols/
    core/…                 # 每个 core 接口一个文件（surface.ts 最大）
    xdg_shell.ts
    viewporter.ts
    dmabuf.ts
    text_input_v1.ts / text_input_v3.ts
    cursor_shape.ts
    clipboard.ts
    index.ts               # 模块清单（替代 supportedProtocols 的运行时部分）
  scene/
    types.ts               # SceneCmd 定义 + ImageKV 接口（纯值，可序列化）
    render_tools.d.ts      # SceneSink 接口（现 renderTools 瘦身而来）
    render_tools_el.ts     # DOM 实现：保留 subsurface/xdg 布局细节 + 像素读写
  utils/                   # 编解码、dma-buf、xdg 工具（保留）
  protocols/               # 生成物 protocols.json + wayland-types.ts（保留路径）
  test/
```

---

## 4. 内部协议扩展接口（`module.ts`）

### 4.1 模块声明（书写用对象字面量，运行时才编译成 Map）

书写态不用 `new Map`：对象字面量能享受**键名合法性检查（excess property）+ 逐键参数类型推导**，而 `Map<string, handler>` 会把两者都丢掉。Map 是 host 的分发优化，不暴露给书写者。

```ts
type RequestKey = keyof WaylandRequestObj;                       // 生成类型，如 "xdg_wm_base.get_xdg_surface"

/** 书写态：对象字面量，键必须是生成类型里存在的 request，args 按键精确推导 */
type RequestHandlers = {
    [K in RequestKey]?: (msg: { id: WaylandObjectId; args: WaylandRequestObj[K] }, ctx: ModuleCtx) => void | Promise<void>;
};

type Globals = ReadonlyArray<{
    name: string; version: number;
    onBind?: (msg: { name: number; id: WaylandObjectId }, ctx: ModuleCtx) => void;
}>;

export interface ProtocolModuleDef {
    name: string;
    globals?: Globals;
    requests?: RequestHandlers;
    hooks?: Partial<SurfaceHooks & SeatHooks>;
}

/** 运行态：注册时（一次性）编译成 Map，分发循环 O(1) 查表 */
export interface ProtocolModule {
    name: string;
    globals: Globals;
    requests: ReadonlyMap<RequestKey, NonNullable<RequestHandlers[RequestKey]>>;
    hooks?: Partial<SurfaceHooks & SeatHooks>;
}

export function defineModule(def: ProtocolModuleDef): ProtocolModule {
    return { ...def, globals: def.globals ?? [], requests: new Map(Object.entries(def.requests ?? {})) as any };
}
```

书写效果：

```ts
export const xdgShellModule = defineModule({
    name: "xdg_shell",
    globals: [{ name: "xdg_wm_base", version: 6, onBind: (msg, ctx) => {
        ctx.objects.setData(msg.id, { pingSerials: new Map() });   // msg.id 是 bind 分配的新对象
    }}],
    requests: {
        // 键写错 → 编译期 excess property error
        // args 自动推导为 { id: WaylandObjectId2<"xdg_surface">; surface: WaylandObjectId2<"wl_surface"> }
        "xdg_wm_base.get_xdg_surface"(msg, ctx) {
            ctx.objects.setData(msg.args.id, { surface: msg.args.surface });   // 两侧 brand 都对
            ctx.core.surface.setRole(msg.args.surface, "xdg");
        },
        "xdg_wm_base.destroy"(msg, ctx) { ctx.state.xdg.onWmBaseDestroyed(msg.id); },
    },
    hooks: { onCommit(surfaceId, ctx) { /* … */ } },
});
```

注册时的运行时校验（`protocols/index.ts` 装配阶段，一次性）：
- 同一个 `接口.请求` 被两个模块声明 → **启动即抛错**（冲突检测）
- 键在 `WaylandRequestObj` 不存在 → 编译期已拦；再对 `protocols.json` 校验一次，防生成物过期

```ts
export interface ModuleCtx {
    /** 对象表：取 data、查协议、分配 id、销毁（类型保证见 §4.5） */
    objects: ObjectApi;
    /** 事件发送（类型安全签名见 §4.6） */
    send: EventApi["send"];
    sendNow: EventApi["sendNow"];
    postError: EventApi["postError"];
    /** core 窄接口 */
    core: CoreApi;
    /** 语义状态单写入点 */
    state: { cursor: CursorStore; windows: WindowsStore; seat: SeatStore };
    /** 场景图投影（只读由 state 驱动，协议不直接调用渲染，见 §6） */
    scene: SceneSink;
}
```

### 4.2 CoreApi（扩展唯一可依赖的 core 面）

```ts
export interface CoreApi {
    surface: WlSurfaceApi;   // getRole/setRole/getSize/getFrame/commit 钩子
    seat: WlSeatApi;         // 焦点、serial、按键
    registry: RegistryApi;   // global 广播
    buffer: BufferApi;       // shm/dmabuf buffer 解析
}
```

`setRole` 把现 `WaylandSurfaceRoleError` 异常转为返回值，`tryX` 收敛在 core 内部（调用点 `:385-390` 平移）。

### 4.3 钩子（core→扩展，唯一反向通道）

```ts
export interface SurfaceHooks {
    onCommit?(surfaceId, pending, ctx): void;   // 接管现 :1066-1072（xdg configure）与 :1095-1115（viewport 合成）
    onDestroy?(surfaceId, ctx): void;           // 接管现 :1141-1145（cursor 清理）
}
export interface SeatHooks {
    onFocus?(surfaceId | undefined, ctx): void; // 接管现 :2385/:2390（text-input enter/leave）
}
```

### 4.4 状态类型：声明合并替代中央表

```ts
// module.ts
export interface WaylandDataRegistry {}   // 空接口
export type WaylandData = WaylandDataRegistry;

// protocols/xdg_shell.ts 内
declare module "../module" {
    interface WaylandDataRegistry {
        xdg_surface: { surface: WaylandObjectId2<"wl_surface">; winGeo?: Rect; ... };
        xdg_positioner: PositionerState;
    }
}
```

消除 P3：新增带状态协议**零改动中央类型**。

### 4.5 `ctx.objects` 的类型保证（brand → 声明合并 → 运行时兜底）

**链路的第一环已经存在**：生成的 `WaylandRequestObj` 把对象参数标成 brand，而不是 `number`——

```ts
// wayland-types.ts:813-816（实测）
"xdg_wm_base.get_xdg_surface": { id: WaylandObjectId2<"xdg_surface">; surface: WaylandObjectId2<"wl_surface"> };
// :749-753
"wl_pointer.set_cursor":       { surface?: WaylandObjectId2<"wl_surface">; … };
```

所以 handler 里 `msg.args.surface` **天然是 branded id**，无需手写 cast。`ObjectApi` 以 brand 为键反查状态类型：

```ts
type DataOf<I extends WaylandInterfaces> = I extends keyof WaylandDataRegistry ? WaylandDataRegistry[I] : undefined;

interface ObjectApi {
    get<I extends WaylandInterfaces>(id: WaylandObjectId2<I>): ObjectInfo<I>;        // { protocol, version, data }
    getData<I extends WaylandInterfaces>(id: WaylandObjectId2<I>): DataOf<I>;
    setData<I extends WaylandInterfaces>(id: WaylandObjectId2<I>, data: DataOf<I>): void;
    create<I extends WaylandInterfaces>(iface: I): WaylandObjectId2<I>;              // 服务端自发对象
    delete(id: WaylandObjectId): void;
    /** wl_registry.bind 的新 id 接口由 name 决定，唯一需要动态 brand 的入口 */
    bind(name: number, id: WaylandObjectId): WaylandObjectId;
}
```

保证分三重：

| 层 | 机制 | 拦住什么 |
|---|---|---|
| 编译期 | brand 只从三个入口产生：① 生成类型的 args ② host 的 NEW_ID 登记 ③ `ctx.objects.create(iface)` | 把 `xdg_surface` 的 id 当 `wl_surface` 用 → `setData`/`getRole` 参数类型不符，编译错 |
| 编译期 | `DataOf<I>`：未在 `WaylandDataRegistry` 声明的接口 → `undefined` | 忘了声明状态就 `setData(id, {...})` → 编译错（`setData(id, undefined)` 仍合法，stateless 对象正常） |
| 运行时 | dev 模式 `get`/`getData` 断言 `objects.get(id).protocol.name === I` | 解码错误、brand 伪造、协议版本错配 → 立即失败而非读到脏状态 |

`waylandObjectId()`（现 `:188-196`）**不暴露给协议模块**（或只在 `host/` 内部可见），否则 brand 可被任意伪造，编译期保证失效。

### 4.6 事件发送（与请求接收完全对称）

请求侧靠 `WaylandRequestObj[K]` 出现在 handler 签名，事件侧靠 `WaylandEventObj[T]` 出现在 `ctx.send` 参数——**生成类型两头都已带好**，现有 `sendMessageImm`/`sendMessageX`（`server.ts:1956-1969`）的泛型签名就是现成答案，原样搬到 `ctx` 上：

```ts
interface EventApi {
    /** 入队，本批消息处理完统一 flush（现 toSend，:1935-1938）——请求上下文用这个 */
    send<I extends WaylandInterfaces, T extends keyof WaylandEventObj & `${I}.${string}`>(
        target: WaylandObjectId2<I>,
        event: T,
        args: WaylandEventObj[T],
    ): void;
    /** 立即写 socket（现 sendMessageImm）——非请求上下文：Store 回调、定时器、桌面主动推送 */
    sendNow<I extends WaylandInterfaces, T extends keyof WaylandEventObj & `${I}.${string}`>(
        target: WaylandObjectId2<I>, event: T, args: WaylandEventObj[T],
    ): void;
    /** 协议错误（现 :2048-2061，code 类型由接口名推导） */
    postError<I extends WaylandInterfaces>(
        iface: I, id: WaylandObjectId2<I>, code: WaylandEnumObj[`${I}.error`], message?: string,
    ): void;
}
```

两个泛型带来两重保证：

```ts
ctx.send(surfaceId, "xdg_toplevel.configure", { … });
//   ↑ 目标是 WaylandObjectId2<"wl_surface">        ↑ T 必须满足 "${I}.${string}" = "wl_surface.*"
//   → 编译错：不能给 wl_surface 发 xdg_toplevel.configure
//   → 且 args 按 "xdg_toplevel.configure" 精确校验

ctx.send(toplevelId, "xdg_toplevel.configure", { width, states: new Uint32Array([...]) });  // 通过
```

要点：
- **`send` 与 `sendNow` 的语义差必须保留**：同批请求的响应入队（`:1935-1938` flush），保证写入顺序与协议语义；`offerTo`（`:1941`）、`wl_callback.done` 这类请求外触发必须 `sendNow`
- **destructor 事件**（`xdg_toplevel.configure` 之后的销毁链）仍由 host 的 `sendMessage` 处理 `op.isDestructor → objects.delete`（现 `:1988-1990`），协议模块不手动删
- **非请求上下文如何拿到 ctx**：`state/*` 的 Store 构造时注入 `ClientRuntime`（含 `sendNow`/`postError`），Store 事件 → 协议事件的路径（如帧回调、窗口状态变化回发 configure）不需要 handler 作用域
- 事件发送的目标 id 若是"服务端自发对象"，用 `ctx.objects.create(iface)` 拿 brand（如 `wl_callback`、`wl_data_offer`）

### 4.7 新增一个协议的改动清单（目标态）

1. XML 放入 `script/wayland/xml/`，`gen_protocols.ts` 白名单加一行，跑生成（**补 `package.json` script：`gen:protocols`**）
2. 新建 `protocols/<name>.ts`，实现 `ProtocolModule`（**唯一必写的文件**）
3. `protocols/index.ts` 的清单数组加一行
4. `readme.md` 协议清单更新
5. （可选）需要新 core 能力时才动 `module.ts` 的 CoreApi——须先与开发者确认

对比现状 **≥6 个必改文件 + 0 个新文件**。

---

## 5. 对外 API（破坏性，桌面侧）

现行契约见 `desktop/readme.md:371-418`、导出见 `src/desktop-api.ts:97-98`。重构后：

### 5.1 事件分域 + 完整 payload

```ts
interface ClientEvents {
    window: {
        created(snap: WindowSnapshot): void;
        closed(id: WindowId): void;
        resized(id: WindowId, rect: Rect): void;
        stateChanged(id: WindowId, states: WindowStates): void;  // maximized/activated/minimized
        moved(id: WindowId): void;
        titleChanged(id: WindowId, title: string): void;
        appidChanged(id: WindowId, appid: string): void;
    };
    cursor: { changed(state: CursorState): void };
    clipboard: { copy(text: string): void; pasteRequested(): void };
    closed(): void;   // client 断开，替代现 "close"
}

type CursorState =
    | { kind: "hidden" }
    | { kind: "shape"; shape: CursorShape; hotspot: { x: 0; y: 0 } }        // cursor-shape，纯枚举可序列化
    | { kind: "image"; canvas: OffscreenCanvas; hotspot: Point; surfaceId?: SurfaceId };
```

**合并/替换**：`windowCreated+windowClosed+windowStartMove+windowMaximized+windowUnMaximized+title+appid+copy+paste+close`（10 个平铺事件）→ 4 个域。`windowCreated(id, renderId)` 二元组取消，`renderId` 内嵌进 `WindowSnapshot`。

### 5.2 窗口快照（消除反查）

```ts
interface WindowSnapshot {
    id: WindowId;
    renderId: string;
    title: string;
    appid: string;
    rect: { x: number; y: number; w: number; h: number };
    states: WindowStates;
    preview(): OffscreenCanvas | Promise<OffscreenCanvas>;   // 现 win().getPreview()
}
```

### 5.3 控制门面：`win()` → 统一 Control（request/respond）

用 `src/event-emitter/event-emitter.ts` 的 `request/respond` 替代现 `win()` 手工对象（`server.ts:2097-2360`）与 `emitSync`（P9）：

```ts
// 查询
await client.request("window.get", id): WindowSnapshot
await client.request("window.getBounds", id): Rect        // 替代 onSync("windowBound") 的反向：桌面提供可用空间
// 命令
client.notify("window.focus" | "window.blur" | "window.close", id)
client.notify("window.setSize", id, { width, height })
client.notify("window.maximize" | "window.unmaximize" | "window.minimize", id)
client.notify("window.startMove", id)
// 输入注入（原 win().point.*、client.keyboard.*）
client.notify("input.pointer", id, event)
client.notify("input.scroll", id, event)
client.notify("input.key", id, key, "pressed" | "released")
client.notify("input.text", id, text, preedit)
// 桌面提供窗口可用空间（替代 onSync("windowBound")）
client.respond("surfaceBounds.request", (ev) => ({ width, height }))
```

`win.point.updatePointerFocus`（`:2157-2360`，约 200 行 hit-test）下沉到 `state/windows_store.ts`，不再挂在 win 对象上。

### 5.4 入口与导出

```ts
// src/wayland/index.ts（唯一入口）
export function createServer(op: { render: SceneSink; socketDir?: string }): WaylandServer;
export type { WaylandServer, Client, ClientEvents, WindowSnapshot, CursorState, ... };
```

- `src/sys_api/run.ts` 改为从 `index.ts` 导入（收敛公开入口；electron 依赖保留，见 P10 判定）
- `src/desktop-api.ts:97-98` 的导出改为从 `index.ts` re-export
- 删除对 `WaylandClient` 具体类的类型暴露，改暴露 `Client` 接口（桌面不需要内部类）

### 5.5 迁移对照（桌面侧）

| 现在 | 之后 |
|---|---|
| `client.on("windowCreated", (id, renderId) => ...)` | `client.on("window.created", (snap) => ...)` |
| `client.on("windowResized", (id, w, h))` + `win().getReRect()` | `client.on("window.resized", (id, rect))` + `client.request("window.get", id)` |
| `client.win(id)?.focus()` | `client.notify("window.focus", id)` |
| `client.onSync("windowBound", () => ({w,h}))` | `client.respond("surfaceBounds.request", ...)` |
| `render.on({ onCursorUpdata })` | `client.on("cursor.changed", ...)` |
| `win.point.renderId()` | `snap.renderId` |

---

## 6. 场景层：surfaceId 寻址的融合 API + 图片 KV（P6/P8）

> 设计约束（明确记录）：
> - `renderTools` 存在的目的是**远程**——操作与像素都要能序列化发送。
> - **client API 不与 DOM/canvas 实现融合**：融合的是**寻址方式（surfaceId）**，不是实现。DOM 细节一旦进入 client API 就无法远程。
> - `cursor` 协议本身需要 surface 图像（`wl_pointer.set_cursor` 传的是 surface），所以**图像是一等数据**，不能藏在 DOM 实现里。
> - `subsurface` / `xdg_toplevel` 的 DOM 布局细节多，这部分**保留在 `render_tools_el.ts`**，不进公共层。

### 6.1 两条通道

```ts
/** ① 命令流：全部纯值，天然可序列化，远程直接转发 */
type SceneCmd =
    | { op: "bind"; sid: string }
    | { op: "render"; sid: string; image: ImageRef }      // ImageRef = KV key，不内联像素
    | { op: "destroy"; sid: string }
    | { op: "anchor"; sid: string; parent?: string }
    | { op: "offset"; sid: string; x: number; y: number }
    | { op: "bufferOffset"; sid: string; x: number; y: number }
    | { op: "xdgEle"; sid: string; kind: "create" | "destroy"; role?: "toplevel" | "popup" }
    | { op: "xdgGeo"; sid: string; w: number; h: number; ox: number; oy: number }
    | { op: "toplevel"; sid: string }
    | { op: "popup"; child: string; parent: string; x?: number; y?: number };

/** ② 图片 KV：surfaceId → 图像（协议产生像素的地方写入） */
interface ImageKV {
    put(key: ImageRef, img: OffscreenCanvas | Uint8Array): void;
    get(key: ImageRef): OffscreenCanvas | Uint8Array | undefined;
    onPut(cb: (key: ImageRef, img: Uint8Array) => void): () => void;   // 远程同步源
}
```

- **本地**：`SceneSink` 直接把 `SceneCmd` 应用到 DOM；`ImageKV` 存 `OffscreenCanvas`。
- **远程**：`SceneCmd` 数组序列化发送（无 DOM、无 canvas 内联），`ImageKV` 走独立同步（`onPut` 推 bytes）。两端是**同一套 API**，只是 sink 不同。
- **cursor 的 surface 图像**：`wl_pointer.set_cursor` 拿到 surface 帧后写 `ImageKV`，`SceneCmd` 发 `{op:"cursor", image: ref, hotspot}` —— 语义枚举（cursor-shape）则直接发字符串，两者都可序列化，**`setCursor` 不再是 `renderTools` 的必选方法**（消除 P6 与 `RemoteRender` 漂移）。

### 6.2 `render_tools_el.ts` 的切分

| 归属 | 内容 |
|---|---|
| 公共层（`scene/`） | `SceneCmd` 定义、`ImageKV`、`idScope` |
| `render_tools_el.ts`（保留） | DOM 布局细节：subsurface 树、xdg_toplevel/popup 的 element 结构、anchor/offset 的 CSS 落地、`getXdgSurfaceEle`、像素读写（`getPreview`） |
| `desktop/remote` | `SceneCmd` 序列化传输 + `ImageKV` over wire |
| `test/mock` | 内存实现 |

### 6.3 类型安全

- 4 个实现全部纳入 `typecheck`（修复 P8），或抽 `implements` 断言文件。
- `renderTools` 与 `SceneSink` 合一，避免两套概念；**方法数从 19 → 12**（删 `setCursor`/`on`/`renderToolsOn`，其余映射为 `SceneCmd` 的便捷方法）。


---

## 7. 迁移阶段（允许破坏性变更，每阶段可独立验收）

> 顺序设计：先建安全网与接口，再迁低耦合协议，最后攻 xdg-shell 与 commit 钩子化。

### 7.0 两条轨道的可分离性

| 轨道 | 内容 | 阶段 | 独立价值（只做这条也有意义） |
|---|---|---|---|
| **T1 内部**：协议模块化 | 拆 `server.ts`、CoreApi/Hooks、模块声明 | 3-5 | 新协议 1 个文件；不做则外部 API 再干净，底层仍是 god file |
| **T2 外部**：client API | 事件分域、Control 门面、SceneCmd/渲染契约 | 2, 6 | 桌面调用简洁；不做则新协议再多，对外仍难用 |
| **共享**：前提 | 安全网、接口与入口、**状态 Store 抽取** | 0, 1, 2a | 两轨都依赖 |

**共享接缝（必须先落，否则两轨互相牵制）**：`WindowsStore`/`CursorStore`/`SeatStore` 从 `obj2`（`:642-684`）抽出。它是 T1 handler 摆脱 `this` 的前提，也是 T2 事件的数据源。缺了它，handler 搬出 `WaylandClient` 时会连带 `this.emit(...)`/`this.obj2` 一起搬走——等于迁两次。

**三处真实耦合点**：
1. `emit` 调用点**全部位于 handler 内部**（`:1459/:1465/:1548/:1552/:1559/:1562/:1573/:1296/:1354`）——T2 改这些行，T1 移动这些行
2. `emitSync("windowBound")`（`:1444`）跨轨：T2 换 request/respond，T1 的 xdg_shell 调用点跟着改
3. `renderTools` 契约（删 `setCursor`/`on()`）既是外部 API 又是协议写入点 → 归 T2，以 cursor 作交汇样板

**推荐顺序**：`0 → 1 → 2a(Store) → 2b(外部 API) → 3 → 4 → 5`
先改外部的理由：桌面侧（`desktop×3` + `desktop-test` + `test_runner` + `test/mock`）**一次性迁完**，此后内部拆分对桌面零影响；反之先拆内部，`emit` 点会随 handler 被移动两次。

**并行注意**：两轨都重度编辑 `server.ts`（T2 改 handler 内的 emit 行，T1 搬 handler），**不宜真正并行**；但可各自独立 commit/revert。

### Phase 0 — 安全网与工具（1 项，先做）
- [ ] 修复 `check_proto_code/check.ts`（P11）：改为扫描 `protocols/**` 目录 + `module.ts` 的 handlers，而非 grep `server.ts`
- [ ] 补 1 条 xdg 窗口端到端测试（创建→configure→resize→关闭），作为后续阶段回归基线
- [ ] `package.json` 增加 `gen:protocols` script；`typecheck` 覆盖 desktop/test/mock
- 验收：现有 `dma-buf.test.ts`、`keyboard.test.ts` 通过；新 e2e 通过

### Phase 1 — 建接口与入口收敛（纯新增）
- [ ] 新建 `module.ts`（CoreApi/Hooks/ModuleCtx/WaylandDataRegistry/ClientEvents/SceneCmd 类型）
- [ ] 新建 `index.ts` 作为唯一公开入口；`sys_api/run.ts`、`desktop-api.ts` 改从 `index.ts` 导入
- [ ] **保留** electron 依赖与现有副作用（GPU/dmabuf 必需，已有 electron 测试），不延迟初始化
- 验收：不改任何行为，typecheck + 全部测试通过

### Phase 2 — 语义状态 Store（改外部 API，破坏性）
- [ ] `state/cursor_store.ts`：收敛 4 处 `render.setCursor`（`:1121/:1144/:1216/:1238/:1739`）与 `onCursorUpdata`（P4/P6）
- [ ] `state/windows_store.ts`：`obj2.windows` 上收，事件分域 + `WindowSnapshot`（P7）
- [ ] `state/seat_store.ts`：焦点/serial/textInput 仲裁（`:2436-2490`）
- [ ] 按 §5 改造对外事件与 Control；更新 `desktop/readme.md`、`desktop/{example,offical,remote}`、`desktop-test.ts`、`test_runner`、`test/mock`
- 验收：e2e 全绿；`RemoteRender` 不再需要 `setCursor`；桌面侧编译通过

### Phase 3 — 拆 core 模块（内部，不改外 API）
- [ ] `protocols/core/{display,registry,shm,compositor,region}.ts` 迁出（handler `:828-1000` 附近）
- [ ] `host/client.ts` 保留 ID 表/分发；`host/registry.ts` 替代 bind if 链（P5）
- [ ] `WaylandData` 中央表改为声明合并（P3）
- 验收：行为不变，覆盖率检查脚本通过

### Phase 4 — 拆低耦合扩展（样板）
- [ ] `viewporter.ts`（现 `:1642-1724`，仅依赖 `wl_surface`）
- [ ] `cursor_shape.ts`（现 `:1727-1740`）
- [ ] `dmabuf.ts`（现 `:1576-1640`）
- [ ] 三个模块的 commit/focus 依赖改走 Hooks
- 验收：每个模块零 `import` 其他协议文件；e2e 通过

### Phase 5 — 攻 xdg-shell 与反向耦合（最难）
- [ ] `protocols/xdg_shell.ts`：`xdgSurfaceData`（`:480-620`）+ handler（`:1376-1574`）迁出，`this.wl_surface` → `ctx.core.surface`
- [ ] `wl_surface.commit` 的 `:1066-1072`（xdg configure 扫描）、`:1095-1115`（viewport 内联合成）→ `SurfaceHooks.onCommit`
- [ ] `:1141-1145`（destroy 清 cursor）→ `onDestroy`；`:2385/:2390` → `SeatHooks.onFocus`
- [ ] `win()` 剩余 hit-test 下沉 `windows_store`；`WaylandClient` 类消解，只剩 `host/client.ts`
- [ ] `server.ts` 最终删除或退化为 re-export shim（**建议直接删除**，强制所有调用方走 `index.ts`）
- 验收：`server.ts` 不存在或 <100 行；`protocols/**` 互相无 import（除 xdg-decoration 类链式依赖）；全部测试通过

### Phase 6 — 文档与收尾
- [ ] `src/wayland/readme.md` 增加"新增协议指南"（§4.5 清单）
- [ ] `desktop/readme.md:371-418` 按 §5 更新
- [ ] AGENTS.md 的"新增 wayland 协议"流程更新

---

## 8. 受影响文件清单

**必须改动**：
- `src/wayland/server.ts`（拆解，Phase 6 删除）
- `src/wayland/render_tools.d.ts`、`render_tools_el.ts`（瘦身）
- `src/sys_api/run.ts`、`src/desktop-api.ts`（入口切换）
- `src/renderer/view/desktop-test.ts`、`src/test_runner/test_runner.ts`
- `src/wayland/test/*.test.ts`、`test/mock/*`（API 适配）
- `desktop/{example,offical,remote}/src`（API 适配；remote 含 `RemoteRender`）
- `script/check_proto_code/check.ts`（扫描目标）
- `package.json`（`gen:protocols`、typecheck 范围）
- `desktop/readme.md`、`src/wayland/readme.md`、`AGENTS.md`

**新增**：`module.ts`、`index.ts`、`host/*`、`state/*`、`protocols/**`、`state` 单测、1 条 xdg e2e

**不动**：`src/wayland/utils/*`（编解码独立可单测，`wayland-codec.test.ts` 保留）、`script/wayland/gen_protocols.ts`（仅加白名单行）、生成物

---

## 9. 测试策略

| 层 | 手段 | 阶段 |
|---|---|---|
| 编解码 | 现有 `utils/wayland-codec.test.ts` | 已有 |
| 协议模块单测 | 新增：构造 `ModuleCtx` fake（注入 stub CoreApi + fake scene），直接调 handler——**Phase 1 引入 fake ctx 后才可行** | Phase 0 起补 |
| 端到端 | 现有 2 条 + 新增 xdg 窗口生命周期 1 条 | Phase 0 |
| 静态覆盖 | `check_proto_code` 改扫目录 | Phase 0 |
| 接口漂移 | typecheck 覆盖 4 个 scene 实现 | Phase 0 |

**关键前置**：Phase 0 的 e2e 基线必须先绿，否则 Phase 3-5 无回归依据（现仅有 pixel/按键两条断言，覆盖不足）。

---

## 10. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| `commit` 钩子化改变时序（`:1066/:1095`） | 高 | Phase 5 单独进行；逐行对齐语义；先写 e2e 断言 configure 序列 |
| 事件分域破坏 4 个桌面实现 + mock | 中 | Phase 2 一次性改完，不留兼容别名（前提：不稳定，允许破坏） |
| 拆分期间双改冲突（生成物/类型路径） | 中 | Phase 1 先落接口，Phase 3 起才动文件布局；生成物路径不变 |
| 测试安全网薄 | 高 | Phase 0 强制先补 e2e 与 fake ctx，否则不进 Phase 3 |
| `emitSync` 移除导致窗口初始尺寸回归 | 中 | `surfaceBounds.request` 保留同步应答语义（EventEmitter `request` 支持），仅换 API 形态 |
| `SceneCmd`/`ImageKV` 切分遗漏隐式依赖 | 中 | 先迁 cursor（图像 + 语义两分支都要过）作为样板，验证通道完备性 |
| ~~dmabuf/共享纹理依赖 electron 渲染环境~~ | 低 | **不拆分**：electron 是既定运行环境（GPU/dmabuf 需要，且已有 electron 测试），保持现状 |

---

## 11. 验收标准（整体）

1. `src/wayland/server.ts` 删除，全部经 `index.ts` 导入
2. `protocols/**` 文件间无相互 import（链式依赖除外）；新增协议只写 1 个文件 + 白名单 1 行
3. 桌面侧 API：事件按域、payload 自包含（无 `renderId` 二元组、无反查）、无 `onSync`
4. cursor 状态单写入点，`obj2` 巨型袋消失
5. `typecheck` 覆盖全部 4 个 Scene 实现；覆盖率脚本扫描目录
6. 全部 e2e + 单测通过；`desktop/readme.md` 与 `AGENTS.md` 更新

---

## 12. 附录：一个协议从绑定到销毁的完整示例

以 `xdg_shell` 创建窗口并绘制一帧为主线，四个维度各对应一段代码。**以下均为目标态代码。**

### 12.1 协议绑定（registry → global → 模块）

客户端连上后第一件事是拿 registry、绑定 global。现状是 `wl_registry.bind` 里的字符串 if 链（`:844-902`）；目标态改为**模块声明自己的 global，host 只做分发**。

```ts
// protocols/xdg_shell.ts
export const xdgShellModule: ProtocolModule = {
    name: "xdg_shell",

    // ① 声明我提供哪些 global（替代 if (proto.name === "xdg_wm_base")）
    globals: [{
        name: "xdg_wm_base",
        version: 6,
        onBind: (msg, ctx) => {
            // 绑定时初始化的 per-object 状态（原 `:897` 分支）
            ctx.objects.setData(msg.newId, { pingSerials: new Map() });
        },
    }],

    // ② 请求处理器（替代 newOp() 里的 isOp，key 同为 "接口.请求"）
    requests: new Map([
        ["xdg_wm_base.get_xdg_surface", (msg, ctx) => {
            const surface = msg.args.surface as SurfaceId;
            ctx.objects.setData(msg.args.id, { surface });       // 数据管理见 12.2
            ctx.core.surface.setRole(surface, "xdg");            // 只经 CoreApi，不 import core 模块
        }],
        ["xdg_surface.get_toplevel", (msg, ctx) => { /* … */ }],
        // …
    ]),

    // ③ 反向钩子（core 通知我，我不被 core import）
    hooks: {
        onCommit(surfaceId, ctx) {
            if (!ctx.state.windows.hasPendingConfigure(surfaceId)) return;
            const xdgId = ctx.core.surface.getXdgOf(surfaceId);
            ctx.send(xdgId, "xdg_surface.configure", { serial: ctx.nextSerial() });
        },
        onDestroy(surfaceId, ctx) {
            ctx.state.windows.onSurfaceDestroyed(surfaceId);   // 级联清理，修 :1147 的 todo
        },
    },
};
```

```ts
// protocols/index.ts —— 新增协议只改这一行
export const protocolModules = [coreDisplay, coreRegistry, coreCompositor, coreSurface,
    coreSeat, xdgShellModule, viewporterModule, dmabufModule, cursorShapeModule];
```

`host/registry.ts` 的分发退化为：

```ts
onBind({ interface: name, version, newId }) {
    const mod = protocolModules.find(m => m.globals?.some(g => g.name === name));
    mod.globals.find(g => g.name === name).onBind(msg, ctx);   // 无 if 链
    ctx.objects.set(newId, { protocol: WaylandProtocols[name], version });
}
```

广播侧不变：`wl_display.get_registry` 遍历 `protocolModules[].globals` 发 `wl_registry.global`。

### 12.2 数据管理（三层，职责互斥）

```ts
// ① 对象层：host 的 objects 表（唯一 ID 权威，协议不自建 id 映射）
private objects = new Map<ObjectId, { protocol: WaylandProtocol; version: number; data?: unknown }>();

// ② 协议私有状态：类型经声明合并挂进 WaylandData，不再改中央表
declare module "../module" {
    interface WaylandDataRegistry {
        xdg_surface: { surface: SurfaceId; winGeo?: Rect; role?: ObjectId };
        xdg_toplevel: { parentId?: ObjectId };
    }
}
// 用法：ctx.objects.setData(id, {...}) / ctx.objects.getData<xdg_surface>(id)

// ③ 跨协议语义状态：集中在 state/，单写入点，桌面与渲染都从这里读
class WindowsStore {           // 替代 obj2.windows（:648）+ xdgSurfaceData 部分字段
    #wins = new Map<WinId, WindowSnapshot>();
    upsert(snap) { …; this.emit("created"|"changed", snap); }
    get(id): WindowSnapshot | undefined;
    hasPendingConfigure(surfaceId): boolean;
}
```

分界规则：
- **只有这一个对象要用** → ① 的 `data`
- **同协议多对象要互相查**（如 xdg_surface↔toplevel↔popup 双向 map，`:480-620`）→ ② 模块私有字段
- **跨协议/要给桌面看**（窗口、cursor、焦点）→ ③ Store

现状三者混在 `obj2`（`:642-684`）+ 3 个领域类里，`cursorSurface` 被 4 处散写即因 ③ 不在 Store 中。

### 12.3 生命周期（host 统一管理，协议只管语义）

`wl_compositor.create_surface` → `xdg_wm_base.get_xdg_surface` → `get_toplevel` → 绘制 → `destroy`：

```ts
// host/client.ts 解码循环（对应现 :1897-1928，逻辑不变，位置下沉到 host）
for (const arg of op.args) if (arg.type === NEW_ID) {
    ctx.objects.set(args[arg.name], { protocol: WaylandProtocols[arg.interface], data: undefined });
    // NEW_ID 自动登记 + 版本继承，协议模块零参与
}

// 分发
const handler = module.requests.get(`${proto.name}.${op.name}`);
handler?.(msg, ctx);

if (op.isDestructor) {
    ctx.hooks.fireDestroy(objId);      // ← 新增：通知关心它的模块做级联清理
    ctx.objects.delete(objId);         // 现 deleteObj（:2044），发 wl_display.delete_id
}
```

三类销毁路径统一：
| 销毁方式 | 处理 |
|---|---|
| 客户端发 destructor 请求（`xdg_toplevel.destroy`） | 上表：hooks → delete |
| 客户端断开 | `objects.clear()`，Store 侧按 clientId 批量清理 |
| 服务端主动（`postError` 后） | 同 destructor |

**修掉的现状问题**：`:1147` 的 `// todo 相关的如subsurface、xdgsurface等`——以前 `wl_surface.destroy` 只删自己，xdg 侧残留；现在由 `hooks.onDestroy` 让 xdg_shell/subsurface 各自清理自己的记录。

### 12.4 外部操作（桌面侧，打平 + surfaceId 寻址）

```ts
import { createServer } from "src/wayland";       // 唯一入口

const { server, runApp } = createServer({ render });

// —— 事件：按域、payload 自包含 ——
server.on("newClient", (client) => {
    client.on("window.created", (snap) => {
        // snap: { id, renderId, title, appid, rect, states } —— 一次拿全，无需反查
        taskbar.add(snap);
        render.focus(snap.renderId);
    });
    client.on("window.resized", (id, rect) => taskbar.resize(id, rect));
    client.on("cursor.changed", (s) => {
        if (s.kind === "shape") osd.showCursorIcon(s.shape);      // 纯枚举，远程可透传
        else if (s.kind === "image") osd.setCursor(s.canvas, s.hotspot);
        else osd.hideCursor();
    });
    client.on("clipboard.copy", (text) => clip.set(text));

    // —— 反向：桌面提供可用空间（替代 onSync("windowBound")）——
    client.respond("surfaceBounds.request", () => ({ width: screen.w, height: screen.h }));
});

// —— 查询 ——
const snap = await client.request("window.get", id);     // WindowSnapshot
const ok = await client.request("window.getBounds", id); // {width,height}

// —— 命令（原 win().xxx 打平）——
client.notify("window.focus", id);
client.notify("window.setSize", id, { width: 800, height: 600 });
client.notify("window.maximize", id);
client.notify("window.close", id);

// —— 输入注入（原 win().point.* / client.keyboard.*）——
client.notify("input.pointer", id, { type: "move", x, y });
client.notify("input.key", id, code, "pressed");
```

对照现契约 `desktop/readme.md:371-418`：`client.win(id)?.focus()` → `client.notify("window.focus", id)`；`windowCreated(id, renderId)` 二元组消失；`win.point.renderId()` → `snap.renderId`。

### 12.5 同一流程在远程下（证明通道完备）

协议侧代码**零改动**，只换 sink：

```ts
// 本地
class SceneEl { apply(cmd: SceneCmd) { /* 落 DOM，细节全在 render_tools_el.ts */ } }
class ImageKVLocal { put(key, img: OffscreenCanvas) { … } }

// 远程（desktop/remote）
class SceneRemote implements SceneSink {
    apply(cmd: SceneCmd) { ws.send(JSON.stringify(cmd)); }        // 纯值，直接序列化
}
class ImageKVRemote {                                             // 像素单独走
    put(key, img) { ws.send(encodeFrame(key, img)); }
}
```

同一帧绘制产生的两类数据：

```
协议侧                              传输                     桌面/渲染侧
────────────────────────────────────────────────────────────────────
wl_surface.commit → 帧像素     →  ImageKV: {sid → bytes}  →  render_tools_el.drawImage(sid, bytes)
windows_store.upsert(snapshot) →  client.on("window.created", snap)   // 结构化，不经 scene
cursor store.set(shape)        →  client.on("cursor.changed", {kind:"shape", shape:"grab"})
xdg 布局（anchor/offset/geo）  →  SceneCmd {op:"xdgGeo", sid, w,h}    →  DOM 细节在 render_tools_el
```

**关键**：`subsurface`/`xdg_toplevel` 的 DOM 布局复杂度全部锁在 `render_tools_el.ts` 内部（它消费 `SceneCmd` + `ImageKV`），公共层只有纯值命令——所以远程不需要复刻任何 DOM 逻辑。

### 12.6 cursor 特例（说明"协议需要 surface 图像"如何落地)

`wl_pointer.set_cursor(surface, hotspot)` 与 `wp_cursor_shape_device_v1.set_shape(shape)` 是两条不同数据源，汇入同一个 Store：

```ts
// protocols/core/pointer.ts —— 提供 surface 帧
onRequest("wl_pointer.set_cursor", (msg, ctx) => {
    const img = ctx.core.surface.getFrame(msg.args.surface);    // 通过 CoreApi 取帧
    ctx.state.cursor.set(img
        ? { kind: "image", canvas: img, hotspot: msg.args.hotspot, surfaceId: msg.args.surface }
        : { kind: "hidden" });
});

// protocols/cursor_shape.ts —— 只有枚举，无图像
onRequest("wp_cursor_shape_device_v1.set_shape", (msg, ctx) => {
    ctx.state.cursor.set({ kind: "shape", shape: toShape(msg.args.shape), hotspot: { x: 0, y: 0 } });
});
```

`CursorStore` 内部：更新状态 → `emit("cursor.changed", state)` 给桌面 → `scene.apply({op:"cursor", ...})` 给渲染。**协议层既不碰 `render.setCursor`，也不碰 DOM**；`obj2.cursorSurface` 四处散写（`:1215/:1121/:1141/:1738`）归一为单点。
