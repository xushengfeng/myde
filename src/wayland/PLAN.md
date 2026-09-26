# server.ts 架构重构计划

> 状态：**进行中** —— Phase 0 ✅（仅剩 `gen:protocols` script）、Phase 1 ✅、Phase 2 ✅（text-input 仲裁推迟至 4-5）、**Phase 3 ✅**（core 全部迁出，`server.ts` 降至 129 行）、**Phase 4 ✅**（扩展三模块 + 反向钩子）。下一步 Phase 5。**场景层重构搁置**、**server 打平在 Phase 6**、**remote 只保证 typecheck**。进度见「进度速览」。
> 前提：当前版本不稳定，**允许破坏性变更**，不做兼容层/废弃期，一步到位。
> 目标：外部调用 API 更简洁，内部新增协议更方便。

## 进度速览

> 标记：✅ 已完成 ／ ⚠️ 部分 ／ ➖ 弃用或已调整 ／ ⬜ 未开始

| 项 | 状态 | 出处 |
|---|---|---|
| typecheck 覆盖扩大到 `desktop/**`、`test/mock/**`、`script/**` 并修复暴露的 13 处问题 | ✅ | `832032d` |
| 测试基建 4 处 bug（ASI 分号、stdout 丢弃、`waitExit` 竞态、按下标取值） | ✅ 计划外新增 | `d7767e9` |
| `vitest.config.ts` `fileParallelism:false`（固定 socket 名 `my-wayland-server-0` 并行互删） | ✅ 计划外新增 | `d7767e9` |
| `RemoteRender` 补 `setCursor` no-op（P8 实证） | ✅ | `832032d` |
| 现有行为基线 → 实际交付为独立窗口生命周期 e2e | ✅ 交付形态已变 | `8eedf5f` |
| `testRunnerApp` 暴露 `render`、`killTimeout` 10s→20s | ✅ 计划外新增 | `8eedf5f` |
| 已知缺陷基线（`ack_configure` 未实现、serial 硬编码、错误处理缺失） | ⚠️ 已记录于 §1 P-系列与 commit，未单列文档 | — |
| 修复 `check_proto_code` 扫目录 | ➖ 弃用：重构时才有用，或可能被替换（改为在 Phase 3 期间评估） | — |
| `package.json` 加 `gen:protocols` script | ⬜ | — |
| Phase 1 · `index.ts` 入口收敛 | ✅ | `0c19daa` |
| Phase 1 · `module.ts` / `scene/types.ts` 契约 | ✅ | `c8ccf43` |
| **场景层重构（§6）** | ⏸ **搁置**：SceneSink 形态与 `renderToolsOn` 去留待再设计，`renderTools` 保持不变 | 决定于本次 |
| **server 级打平** | ➡️ **移到最后**（原 Phase 2 → 现 Phase 6），桌面只迁一次 | 决定于本次 |
| **remote 桌面测试策略** | ➖ 不做行为测试，仅保证 typecheck 覆盖其全部实现 | 决定于本次 |
| Phase 2 · 三个 Store 抽取（对外形状不变） | ✅ `2f61a24` `4f4f114` `d7cbf2a` | — |
| Phase 2 · text-input v1/v3 仲裁归属 | ⬜ ➡️ 推迟到 Phase 3-5（模块边界 + 零覆盖） | — |
| Phase 3 · 管道（ModuleCtx 实现、模块注册、分发合并、冲突校验） | ✅ | `5f8e548` |
| Phase 3 · region 样板（含状态声明合并） | ✅ | `5f8e548` `2371bf1` |
| Phase 3 · 24 个 core handler 迁出 + bind if 链 + 状态类型声明合并 + `host/client.ts` | ✅ | `ed567c2` `7bd7ac3` `3c82091` `d5563a2` |
| Phase 3 · 46 个扩展 handler（现居 `host/client.ts`） | ⬜ → 归 Phase 4-5 | — |
| Phase 4 · viewporter / cursor-shape / dmabuf + 反向钩子机制 | ✅ | 见 Phase 4 |
| Phase 5（xdg 22 + text-input 13 = 35 handler，现居 `host/client.ts`） | ⬜ | — |

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
| P11 | ~~`check_proto_code/check.ts` 靠 grep `server.ts` 源码统计覆盖率~~ **已弃用**（重构时才有用，或可能被替换；Phase 3 拆分时必须改或删） | `script/check_proto_code/check.ts:31-45` | 拆分即失效 |
| P12 | 无协议级测试脚手架，仅 2 条端到端链路 | `src/wayland/test/` | 重构无安全网 |

---

## 2. 目标架构

```
                          ┌──────────────────────────────────────────┐
   外部（桌面）           │  src/wayland/index.ts  ← 唯一公开入口      │
  ───────────────         │  createServer() / WaylandServer          │
   client.windows.*  ────▶│                                          │
   client.cursor.*   ────▶│  对外：ServerEvents + Windows + Cursor   │
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
  module.ts                # 契约：共享接口与类型，零实现、零副作用
  host/
    client.ts              # ✅ WaylandClient：对象表、解码分发、ModuleCtx、窗口门面
                           #    + 46 个扩展 handler（Phase 4-5 迁出对象）
  server.ts                # ✅ 仅剩 WaylandServer（监听/建连）+ initWaylandProtocols，129 行
  state/
    cursor_store.ts        # ✅ CursorStore：唯一 cursor 状态写入点
    windows_store.ts       # ✅ WindowsStore：窗口记录与窗口事件
    seat_store.ts          # ✅ SeatStore：焦点、serial、修饰键、seat 记录
  protocols/
    core/…                 # ✅ 11 个 core 模块（display/registry/compositor/surface/
                           #    shm/seat/pointer/subsurface/data_device/output/region）
    xdg_shell.ts           # ⬜ Phase 5
    viewporter.ts / dmabuf.ts / cursor_shape.ts      # ⬜ Phase 4
    text_input_v1.ts / text_input_v3.ts             # ⬜ Phase 4-5
    index.ts               # ✅ 模块清单 + 请求键冲突校验
  scene/
    types.ts               # ✅ SceneCmd + ImageKV（Phase 1；实现层随 §6 搁置）
    render_tools.d.ts      # ⏸ 现状保持
    render_tools_el.ts     # ⏸ 现状保持
  utils/
    wayland-proto.ts       # ✅ 协议元数据表、全局 name 表、枚举助手、brand 助手
    fd.ts                  # ✅ newFd（随 data_device 迁出）
    shared_texture.ts      # ✅ 共享纹理接收（随 wl_surface.attach 迁出）
    wayland-encoder/decoder, dma-buf, xdg       # 原有
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

现行契约见 `desktop/readme.md:371-418`、导出见 `src/desktop-api.ts:97-98`。重构后**以 server 为主通道**。

### 5.1 打平原则：事件与查询上提到 server，用全局 handle

**现状是桌面在替服务端做聚合**——`desktop/example/src/index.ts:24-25` 自己拼全局窗口 ID：

```ts
function createWindowId(clientId: string, windowId: WaylandWinId): MWinId {
    return `${clientId}-${windowId}` as MWinId;
}
```

配合 `desktop/example` + `desktop-test` **共 11 处** `for (const [clientId, client] of server.clients)` 遍历、`topWindow = { clientId, winId, zIndex }` 复合记录——跨客户端聚合、生成全局身份、清理断开客户端的残留窗口，全都是桌面的负担。

**硬约束**：Wayland 对象 ID 由**客户端本地分配**（实测两个客户端可同时用 `id: 9`），扁平事件不能直接用 windowId，必须有服务端全局身份：

```ts
type WinHandle = string;   // 服务端单调递增："w1"、"w2"…

interface WindowInfo {
    handle: WinHandle;
    clientId: string;                 // 需要按客户端过滤时用
    appid: string;
    title: string;
    rect: { x: number; y: number; w: number; h: number };
    states: { activated: boolean; maximized: boolean; minimized: boolean };
    renderId: string;
}
```

选单调递增而非拼 `clientId-windowId`：客户端断开重连后对象 id 会复用，递增 handle 不会串台，桌面也不用再拼字符串。

**新增机制**（都不重）：
1. server 订阅每个 client 的事件做 fan-in 转发（薄适配层）
2. 全局窗口表 `handle → (client, winId)`
3. **client 断开时由 server 统一关闭该客户端全部窗口**——现在 `clientClose` 只删 client，窗口残留靠桌面自己兜，交给 server 反而更可靠

### 5.2 事件：server 级、按域分组、payload 自包含

```ts
interface ServerEvents {
    window: {
        created(info: WindowInfo): void;
        changed(info: WindowInfo): void;     // rect/states/title/appid 任一变化，字段自包含，无需反查
        closed(handle: WinHandle): void;
        startMove(handle: WinHandle): void;
    };
    cursor: { changed(clientId: string, state: CursorState): void };
    clipboard: { copy(text: string): void; pasteRequested(): void };
    client: { opened(clientId: string): void; closed(clientId: string): void };
}

type CursorState =
    | { kind: "hidden" }
    | { kind: "shape"; shape: CursorShape; hotspot: { x: 0; y: 0 } }   // 纯枚举，可序列化
    | { kind: "image"; canvas: OffscreenCanvas; hotspot: Point; surfaceId?: SurfaceId };
```

**合并/替换**：`windowCreated+windowClosed+windowStartMove+windowMaximized+windowUnMaximized+title+appid+copy+paste+close`（10 个平铺事件、且需逐 client 订阅）→ 4 个域、server 一次订阅覆盖全部客户端。`windowCreated(id, renderId)` 二元组取消，`renderId` 内嵌 `WindowInfo`。

### 5.3 查询：`server.windows`，不再遍历 clients

```ts
server.windows.list(): WindowInfo[]                 // 替代 for (client of server.clients) 收集
server.windows.get(handle): WindowInfo | undefined
server.cursor.get(clientId): CursorState
```

### 5.4 控制：handle → 内部反查 client

用 `src/event-emitter/event-emitter.ts` 的 `request/respond` 替代现 `win()` 手工对象（`server.ts:2097-2360`）与 `emitSync`（P9）：

```ts
// 查询
await server.request("window.get", handle): WindowInfo
await server.request("window.getBounds", handle): Rect
// 窗口命令
server.notify("window.focus" | "window.blur" | "window.close", handle)
server.notify("window.setSize", handle, { width, height })
server.notify("window.maximize" | "window.unmaximize" | "window.minimize", handle)
// 输入注入（原 win().point.*、client.keyboard.*），内部 handle → (client, winId)
server.notify("input.pointer", handle, event)
server.notify("input.scroll", handle, event)
server.notify("input.key", handle, key, "pressed" | "released")
server.notify("input.text", handle, text, preedit)
// 桌面提供可用空间（替代现 onSync("windowBound")，原来是逐 client 注册）
server.respond("surfaceBounds.request", () => ({ width, height }))
```

`win.point.updatePointerFocus`（`:2157-2360`，约 200 行 hit-test）下沉到 `state/windows_store.ts`，不再挂在 win 对象上。

### 5.5 哪些**不**打平（保留 per-client 出口）

| 走 server（主通道） | 保留 `server.clients` |
|---|---|
| window / cursor / clipboard 的事件、查询、命令 | 连接生命周期、remote/调试等需要底层 client 的场景 |
| 输入注入（经 handle 反查） | 桌面明确要拿到具体 client 对象时 |

**增量而非替代**：`server.clients` 不删除，但桌面的常规路径不再需要它，11 处遍历消失。

### 5.6 入口与导出

```ts
// src/wayland/index.ts（唯一入口）
export function createServer(op: { render: SceneSink; socketDir?: string }): WaylandServer;
export type { WaylandServer, ServerEvents, WindowInfo, WinHandle, CursorState, ... };
```

- `src/sys_api/run.ts` 改为从 `index.ts` 导入（收敛公开入口；electron 依赖保留，见 P10 判定）
- `src/desktop-api.ts:97-98` 的导出改为从 `index.ts` re-export
- 删除对 `WaylandClient` 具体类的类型暴露；`Client` 仅在需要低层访问时导出

### 5.7 迁移对照（桌面侧）

| 现在 | 之后 |
|---|---|
| `server.on("newClient", (c,id) => c.on("windowCreated", …))` | `server.on("window.created", (info) => …)` |
| `for (const [cid, c] of server.clients)` 收集窗口 | `server.windows.list()` |
| `createWindowId(clientId, windowId)` 自己拼 | `info.handle` |
| `client.on("windowResized", (id, w, h))` + `win().getReRect()` | `server.on("window.changed", info)` |
| `client.win(id)?.focus()` | `server.notify("window.focus", handle)` |
| `client.onSync("windowBound", () => ({w,h}))` | `server.respond("surfaceBounds.request", …)` |
| `render.on({ onCursorUpdata })` | `server.on("cursor.changed", …)` |
| `win.point.renderId()` | `info.renderId` |

影响面：`desktop/{example,offical,remote}`、`desktop-test.ts`、`test/mock` 全部要改——它们在 Phase 2 本来就要动一次，打平**没有额外成本**。

---

## 6. 场景层：surfaceId 寻址的融合 API + 图片 KV（P6/P8）

> ### ⏸ 本节整体搁置（暂不实施）
> 需要先定两件事，**当前 `renderTools` / `renderToolsOn` / `SceneCmd` 保持不变**：
> 1. `SceneSink` 形态——方法式（`renderTools` 瘦身，改动小、remote 只删 `setCursor`）还是命令式（`apply(SceneCmd)` 单方法，接口最窄但 `remote-render.ts` 362 行要重写）
> 2. `renderToolsOn` 三条中继的去留——实测 `setCursor`（`:136-138`）、`asToplevel`（`:107-114`）、`destroyXdgSurfaceEle(toplevel)`（`:83-92`）**都不碰 DOM，纯事件中继**，且与已有的 `windowCreated/windowClosed` 重复，属语义事件而非渲染
>
> `scene/types.ts` 的 `SceneCmd`/`ImageKV` 已作为契约落地（Phase 1 `c8ccf43`），但**尚无实现方使用**。

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
| **T2 外部**：client API | **server 级打平**（事件/查询/控制上提 + 全局 WinHandle）、事件分域、Control 门面 | **6**（最后） | 桌面调用简洁、11 处遍历消失；不做则新协议再多，对外仍难用 |
| **共享**：前提 | 安全网、接口与入口、**状态 Store 抽取** | 0, 1, 2 | 两轨都依赖 |
| ⏸ 场景层 | SceneSink 形态、`renderToolsOn` 去留 | 搁置 | 见 §6 |

**共享接缝（必须先落，否则两轨互相牵制）**：✅ **已落地** —— `WindowsStore`/`CursorStore`/`SeatStore` 已从 `obj2` 抽出（Phase 2，`2f61a24`/`4f4f114`/`d7cbf2a`）。它是 T1 handler 摆脱 `this` 的前提，也是 T2 事件的数据源。缺了它，handler 搬出 `WaylandClient` 时会连带 `this.emit(...)`/`this.obj2` 一起搬走——等于迁两次。

**三处真实耦合点**：
1. `emit` 调用点**全部位于 handler 内部**（`:1459/:1465/:1548/:1552/:1559/:1562/:1573/:1296/:1354`）——T2 改这些行，T1 移动这些行
2. `emitSync("windowBound")`（`:1444`）跨轨：T2 换 request/respond，T1 的 xdg_shell 调用点跟着改
3. `renderTools` 契约（删 `setCursor`/`on()`）既是外部 API 又是协议写入点 → 归 T2，以 cursor 作交汇样板

**推荐顺序**：`0 → 1 → 2(Store，对外不变) → 3 → 4 → 5 → 6(对外打平) → 7`

两边**各只动一次**：
- **handler 只动一次**——Phase 2 把 handler 内的 `this.emit(...)` 换成写 Store（内部形态），Phase 3-5 搬 handler 时搬的是「写 Store」这个稳定调用，Phase 6 只改 Store 的**出口**，handler 不再动
- **桌面只迁一次**——Phase 2 对外事件名与形状保持不变，Phase 2-5 全程 `git diff desktop/` 为空；所有外部调用方式的变更集中在 Phase 6

代价：外部 API 的收益要等到最后才兑现（原先设想先改外部）。换来的是 Phase 3-5 那段最高风险的内部拆分期间，桌面侧完全静止，回归面只有 e2e。

**并行注意**：两轨都重度编辑 `server.ts`（Phase 2 与 Phase 3 都会碰 handler），**不宜真正并行**；但可各自独立 commit/revert。

### Phase 0 — 安全网与工具（纯工具 + 现有行为基线，**不新增任何协议实现**）

- [x] ~~修复 `check_proto_code/check.ts`（P11）~~ **➡️ 弃用**：重构时才有用，且可能被整体替换；移出 Phase 0，改为 Phase 3 拆分期间再评估（届时必须改或删，否则脚本会因 `server.ts` 消失而失效）
- [x] `typecheck` 覆盖 `desktop/**`、`test/mock/**`、`script/**`（修 P8）——**已完成** `832032d`，暴露并修复 13 处（含 `RemoteRender` 缺 `setCursor`、`test/mock` 三处 API 漂移）
- [ ] `package.json` 增加 `gen:protocols` script
- [x] **现有行为基线**——**已完成，交付形态变化**：原计划"榨取 `dmabuf_one_frame` 断言"，实际发现原有两个 e2e 全部失败，先修基建（`d7767e9`），再交付独立的 `src/wayland/test/window.test.ts`（`8eedf5f`），覆盖 `windowCreated` 恰好一次、`renderId`、预览绿色像素、`windowResized`、`windowMaximized`、cursor 形态、`windowClosed`——**超出原计划范围**
- [x] **测试基建修复**（计划外）：ASI 分号缺失导致模板中止、runner 丢弃非 JSON stdout、`waitExit` 只监听 `exit` 的竞态、`dma-buf` 按下标取 `result[0]`；另加 `vitest.config.ts` 串行化（固定 socket 名并行互删）、`testRunnerApp` 暴露 `render`、`killTimeout` 10s→20s
- [x] **已知缺陷基线**——**⚠️ 部分完成**：`ack_configure` 未实现、serial 硬编码 `1`（`:1069/:1449/:2085/:2135`）已记录在 §1 P 系列与 commit；错误处理缺失沿用 `src/wayland/readme.md:3`。未单列独立文档，测试也**未断言其应有行为**（`window.test.ts` 不碰 ack/serial）

> 原则：Phase 0 只断言**现在已成立的行为**。需要新增协议才能测的场景，挪到对应阶段与改动同步写（见 §9）。

验收：**已达** —— 全量 20 文件 / 200 测试全绿；typecheck 0 错误（394 文件）。剩余 `gen:protocols` script 未做。

### Phase 1 — 建接口与入口收敛（纯新增）
- [x] 新建 `module.ts`：品牌类型（`WaylandObjectId2/3`）、状态表（`WaylandDataRegistry`，由中央表上移）、`ProtocolModule`/`RequestHandlers`/`defineModule`、`ModuleCtx`/`ObjectApi`/`EventApi`、`CoreApi`、`SurfaceHooks`/`SeatHooks` —— **已完成** `c8ccf43`
- [x] 新建 `scene/types.ts`（`SceneCmd` + `ImageKV`）—— **归属调整**：原清单把它列在 `module.ts`，实际是渲染契约，协议模块不该因它依赖 module.ts（与 §3 目录一致）
- [x] 新建 `index.ts` 作为唯一公开入口；`sys_api/run.ts`、`desktop-api.ts`、`desktop-test.ts` 改从 `index.ts` 导入 —— **已完成** `0c19daa`，`server.ts` 在 `src/wayland/` 之外的引用已清零，顺带引入 `createServer({ render, socketDir })` 统一创建签名
- [x] **保留** electron 依赖与现有副作用（GPU/dmabuf 必需，已有 electron 测试），不延迟初始化 —— 已在 P10 判定，无待办
- ➖ **`ServerEvents` 移到 Phase 2**：它依赖 `WindowInfo`/`WinHandle`/`CursorState`，属 server 级打平的对外面，与事件接线一起落地更不易返工（原清单里的 `ClientEvents` 已随打平改名）

**Phase 1 各接口的实现尚未存在**——`ObjectApi`/`EventApi`/`CoreApi` 是空契约，落地在 Phase 3-5；当前无调用方，纯类型。

验收：**已达** —— typecheck 0 错误、20 文件 / 200 测试全绿，行为不变。

### Phase 2 — 语义状态 Store（**内部整理，不改对外事件形状**）
- [x] `state/cursor_store.ts`：收敛 `render.setCursor` 全部调用点 —— **已完成** `2f61a24`，`cursorHotspot` 不再属于对象状态，`WaylandClient.render` 字段成为死代码并删除
- [x] `state/windows_store.ts`：`obj2.windows` 上收，窗口事件改为写 Store —— **已完成** `4f4f114`
- [x] `state/seat_store.ts`：焦点/serial/修饰键/seat 记录 —— **已完成** `d7cbf2a`
- [ ] **text-input v1/v3 仲裁**（原属 seat_store）**➡️ 推迟到 Phase 3-5**：它决定两个未来模块的边界（各协议私有状态 vs 共享仲裁点），且**零测试覆盖**，拆 `text_input_*.ts` 时与归属一起定
- [x] handler 内的 `this.emit(...)` 改为写 Store —— **窗口事件完成**；`copy`/`paste`/`appid`/`close` 不属窗口域，随 Phase 6 的域事件一起处理
- **约束**：本阶段**不动** `desktop/*`、`desktop-test`、`test/mock` 的调用方式——外部 API 变更全部集中到 Phase 6，桌面只迁一次
- 验收：**已达** —— typecheck 0 错误、全量 20 文件 / 200 测试全绿、`git diff desktop/` 为空

**Phase 2 挖出的两处顺序契约**（原本只隐含在调用点里，现已写进 Store 注释）：
1. `xdg_toplevel.destroy` 是「删记录 → `toplevelDestroyed` → 发 `windowClosed`」三步，中间那步会触发桌面可见的 `onToplevelRemove`，两者先后桌面能观察到 —— 所以 Store 拆成 `remove()` + `notifyClosed()` 两步保住顺序
2. `set_title` 是**先发事件后改记录**，保持原样未"顺手修正"

### Phase 3 — 拆 core 模块（内部，不改外 API）

**全部完成**（✅ = `5f8e548` `2371bf1` `9a92104` `875cb7d` `ed567c2` `7bd7ac3` `d5563a2` `3c82091`）：
- [x] `ModuleCtx` 真实实现：`buildCtx()` 接上对象表 / 事件通道 / `CoreApi` / 域服务 / 语义 Store / 客户端自身 —— `875cb7d`
- [x] `protocols/index.ts` 模块清单 + `assertModuleConflicts()` 请求键冲突校验（原 `Map.set` 静默覆盖）—— `5f8e548`
- [x] 分发合并：模块 handler 并进 `newOp()` 的同一张表，与 `isOp` 共用 `m.get()` 路径 —— `5f8e548`
- [x] **24 个 core handler 全部迁出** → `protocols/core/{display,registry,compositor,surface,shm,seat,pointer,subsurface,data_device,output,region}.ts`（11 个模块，800 行）—— `ed567c2` `7bd7ac3`
- [x] **P5** `wl_registry.bind` 的字符串 if 链 → 各模块 `globals[].onBind`（`wl_output` 为此单开模块：它只有绑定自报、零请求）—— `7bd7ac3`；`xdg_wm_base` 分支暂留 registry 模块，标了 Phase 5 TODO
- [x] **P3** 对象状态类型移入各自 `declare module`，`WaylandDataRegistry` 只剩 5 个扩展条目（xdg×2 / dmabuf / viewport / cursor-shape）—— `3c82091`
- [x] **`host/client.ts`**：`WaylandClient` 从 `server.ts` 拆出 —— `d5563a2`
- [x] 依赖下沉 `utils/`：`wayland-proto.ts`（协议元数据 + 枚举助手 + 全局 name 表）、`fd.ts`、`shared_texture.ts` —— `9a92104` 等

**形态调整**：原计划的 `host/registry.ts` 由 **`protocols/core/registry.ts`（bind 的通用部分）+ `utils/wayland-proto.ts`（global 注册表）** 取代——bind 的分发本就该跟着模块走，不该再在 host 里开一个文件。

**现状**：
| 文件 | 行数 | 内容 |
|---|---|---|
| `server.ts` | **129** | 只剩 `WaylandServer`（监听/建连）、`initWaylandProtocols` |
| `host/client.ts` | 1882 | 对象表、解码分发、`ModuleCtx`、窗口门面，**以及 46 个扩展 handler（`newOp()`）** ← Phase 4-5 的迁移对象 |
| `protocols/core/*` | 800 | 11 个 core 模块 + region 单测 |
| `module.ts` | 471 | 契约（含只剩 5 条的中央表） |

**Phase 4-5 待办**：
- [ ] 46 个扩展 handler 从 `host/client.ts` 迁出（xdg / text-input v1,v3 / dmabuf / viewporter / cursor-shape）
- [ ] 中央表剩余 5 条随各自模块迁走
- [ ] 每迁一个模块补 fake-ctx 单测（仿 `region.test.ts`；目前只有 region 有）

验收：**已达** —— 行为不变（21 文件 / 202 测试全绿）、typecheck 0、`git diff desktop/` 为空；~~覆盖率脚本~~ 已随 P11 弃用

### Phase 4 — 拆低耦合扩展 ✅ **完成**

- [x] `viewporter.ts`（4 handler）+ `hooks.onFrame` —— `commit 里的内联合成逻辑随之搬进模块`
- [x] `cursor_shape.ts`（2 handler）
- [x] `dmabuf.ts`（5 handler）
- [x] **反向钩子机制落地**（此前只有接口声明）：`host/client.ts` 聚合 `protocolModules` 的 hooks，`ctx.notify.{commit,frame,destroy,focus}` 触发
- [x] `modules.test.ts`（5 测试）：模块注册完整性、请求键无冲突、cursor-shape 行为
- 验收：**已达** —— 每个模块零 `import` 其他协议文件；typecheck 0；22 文件 / 207 测试全绿

**关键设计：钩子分两阶段**
| 钩子 | 时机 | 用途 |
|---|---|---|
| `onCommit` | buffer 已应用、**像素尚未合成** | xdg 发 configure（Phase 5） |
| `onFrame` | 像素已合成、**渲染之前**，可返回替换画布 | viewporter 裁剪缩放 |

两者不能合并：合成必须在 damage 绘制之后，合并成一个 `onCommit` 会让 viewport 拿到还没画完的画布。

**⚠️ 既存缺陷基线新增一条**（与 `protoVersions` 空转、`ack_configure` 未实现并列，均**未顺手修**）：
> `wp_viewport` 只在设置它的那次 commit 生效——`wl_surface.commit` 读的是 `pending.viewport` 而非合并后的 `current.viewport`，所以 viewport 不跨帧保持。按协议规范应读 current，但这段零测试覆盖，改成 current 无法验证，先原样保留（`onFrame` 因此特意传 pending 而非 current）。

### Phase 5 — 攻 xdg-shell 与反向耦合（最难）
- [ ] `protocols/xdg_shell.ts`：`xdgSurfaceData`（`:480-620`）+ handler（`:1376-1574`）迁出，`this.wl_surface` → `ctx.core.surface`
- [ ] `wl_surface.commit` 的 `:1066-1072`（xdg configure 扫描）、`:1095-1115`（viewport 内联合成）→ `SurfaceHooks.onCommit`
- [ ] `:1141-1145`（destroy 清 cursor）→ `onDestroy`；`:2385/:2390` → `SeatHooks.onFocus`
- [ ] `win()` 剩余 hit-test 下沉 `windows_store`；`WaylandClient` 类消解，只剩 `host/client.ts`
- [ ] **configure 握手语义补全**：实现 `xdg_surface.ack_configure` + serial 计数器（替换硬编码 `serial:1` 于 `:1069/:1449/:2085/:2135`）——属本阶段握手重写范围，**不是凭空新增**
- [ ] **xdg 生命周期 e2e**（与上一项同步）：创建→configure→ack→commit→resize→关闭，断言事件恰好一次 + 无对象泄漏
- [ ] `server.ts` 最终删除或退化为 re-export shim（**建议直接删除**，强制所有调用方走 `index.ts`）
- 验收：`server.ts` 不存在或 <100 行；`protocols/**` 互相无 import（除 xdg-decoration 类链式依赖）；全部测试通过

### Phase 6 — 对外 API 打平与重塑（破坏性，**放在最后**）
> 原本属于 Phase 2，现后移：内部整理（Phase 2-5）全部不碰外部调用方式，桌面**只在这一阶段迁一次**。

- [ ] **全局窗口身份**：`WinHandle` 单调递增、`handle → (client, winId)` 反查表（对象 id 是客户端本地的，实测会撞）
- [ ] **server 级 fan-in**：server 订阅各 client 事件转发；client 断开时统一关闭其全部窗口（§5.1）
- [ ] 按 §5 改造对外事件/查询/Control（`ServerEvents`、`WindowInfo`、`CursorState` 在此落地）
- [ ] 更新 `desktop/readme.md`、`desktop/{example,offical,remote}`、`desktop-test.ts`、`test_runner`、`test/mock`（11 处 `for (client of server.clients)` 消失，`createWindowId` 拼接消失）
- [ ] 若届时 §6 场景层已解封：一并处理 `renderToolsOn` 三条中继的去留
- 验收：e2e 全绿；桌面代码不再自己拼 `createWindowId`；`git diff desktop/` 本阶段有意变更且 typecheck 覆盖其全部实现

### Phase 7 — 文档与收尾
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
- ~~`script/check_proto_code/check.ts`（扫描目标）~~ **➡️ 已弃用**，Phase 3 拆分时改或删
- `package.json`（`gen:protocols` script ⬜ 未做；typecheck 范围 ✅ 已完成）
- `desktop/readme.md`、`src/wayland/readme.md`、`AGENTS.md`
- `src/test_runner/test_runner.ts`（✅ 已改：暴露 `render`、`killTimeout` 20s、4 处 bug 修复）
- `src/main/main.ts`（✅ 已改：测试数据同步写 fd、kill 延迟退出）
- `vitest.config.ts`（✅ 新增：`fileParallelism:false`，待 socket 名改为实例唯一后可移除）
- `src/wayland/test/window.test.ts`（✅ 新增：窗口生命周期 e2e）

**新增**：`module.ts`（✅ Phase 1）、`scene/types.ts`（✅ Phase 1）、`index.ts`（✅ Phase 1）、`host/*`、`state/*`、`protocols/**`、`state` 单测、1 条 xdg configure 序列 e2e

**不动**：`src/wayland/utils/*`（编解码独立可单测，`wayland-codec.test.ts` 保留）、`script/wayland/gen_protocols.ts`（仅加白名单行）、生成物

---

## 9. 测试策略

| 层 | 手段 | 阶段 | 状态 |
|---|---|---|---|
| 编解码 | 现有 `utils/wayland-codec.test.ts` | 已有 | ✅ |
| 现有行为基线 | `src/wayland/test/window.test.ts`：窗口创建/预览像素/resize/maximize/cursor/关闭 | Phase 0 | ✅ `8eedf5f` |
| 基建 | e2e runner 4 处 bug + `fileParallelism:false` | Phase 0 | ✅ `d7767e9` |
| 协议模块单测 | fake `ModuleCtx`（stub CoreApi + fake scene）直接调 handler | Phase 1 后 | ⬜ |
| 端到端（按改动同步补） | 见下表 | 与改动同阶段 | ⬜ |
| 静态覆盖 | ~~`check_proto_code` 改扫目录~~ | ➖ 弃用 | ➖ |
| 接口漂移 | typecheck 覆盖全部 Scene 实现（实为 `src/**+desktop/**+test/**+script/**` 394 文件） | Phase 0 | ✅ `832032d` |

> **remote 桌面（`desktop/remote`）不做行为测试**：网络链路难以在 e2e 里复现，验收标准降为**类型不报错**——由 typecheck 覆盖其全部实现保证（`RemoteRender implements renderTools`）。凡改动 `renderTools`/场景契约，只需 `pnpm typecheck` 绿即可，不写 remote 行为测试。

**测试与阶段的对应**（新增协议才能测的，不在 Phase 0 做）：

| 测试 | 前置改动 | 阶段 | 状态 |
|---|---|---|---|
| cursor `image`/`hidden` 分支 | CursorStore + `cursor.changed` 事件（**`shape` 分支已由 `window.test.ts` 覆盖**，走的是现 `render.on`） | Phase 2 同步 | ⬜ |
| clipboard copy/paste | clipboard 域事件 | Phase 2 同步 | ⬜ |
| subsurface 父子/销毁级联 | core 拆分 + `:1147` todo 修复 | Phase 3 同步 | ⬜ |
| shm buffer 路径 | core surface 拆分 | Phase 3 同步 | ⬜ |
| viewporter 合成 | 模块迁移 + `onCommit` 钩子 | Phase 4 同步 | ⬜ |
| **xdg configure 序列 + `ack_configure` 实现 + serial 计数** | configure 握手重写（本就属该阶段范围）。**注**：`window.test.ts` 已覆盖窗口生命周期，此处只补 ack/serial 序列断言，两者不重复 | **Phase 5 同步** | ⬜ |
| role 冲突等错误路径 | 错误处理实现 | 随实现补 | ⬜ |

**前置已满足**：Phase 0 基线（`window.test.ts` + 修复后的两个 e2e）已全绿，Phase 3-5 具备回归依据。

---

## 10. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| `commit` 钩子化改变时序（`:1066/:1095`） | 高 | Phase 5 单独进行；逐行对齐语义；先写 e2e 断言 configure 序列 |
| 事件分域破坏 4 个桌面实现 + mock | 中 | Phase 2 一次性改完，不留兼容别名（前提：不稳定，允许破坏） |
| 拆分期间双改冲突（生成物/类型路径） | 中 | Phase 1 先落接口，Phase 3 起才动文件布局；生成物路径不变 |
| ~~测试安全网薄~~ | 已消除 | ✅ Phase 0 已交付：`window.test.ts` + 修复后的两个 e2e（全量 20 文件 / 200 测试全绿）；协议类测试仍与对应改动**同阶段落地**，否则不进下一阶段 |
| 固定 wayland socket 名 `my-wayland-server-0` 令测试无法并行 | 中 | 现以 `vitest.config.ts` `fileParallelism:false` 兜底（代价：全量串行变慢）；根治需把 socket 名改为实例唯一——**服务端行为变更，待确认** |
| `check_proto_code` 在 `server.ts` 拆分后失效 | 中 | 已弃用（P11）；Phase 3 拆分时必须改或删，否则 CI 报假错 |
| `emitSync` 移除导致窗口初始尺寸回归 | 中 | `surfaceBounds.request` 保留同步应答语义（EventEmitter `request` 支持），仅换 API 形态 |
| ~~`SceneCmd`/`ImageKV` 切分遗漏隐式依赖~~ | — | ⏸ 场景层已整体搁置（§6），该风险随之后延；恢复时先以 cursor 作交汇样板 |
| remote 桌面行为回归不可测 | 低 | 已接受：仅以 typecheck 覆盖其全部实现作为验收，不写行为测试 |
| ~~dmabuf/共享纹理依赖 electron 渲染环境~~ | 低 | **不拆分**：electron 是既定运行环境（GPU/dmabuf 需要，且已有 electron 测试），保持现状 |

---

## 11. 验收标准（整体）

1. `src/wayland/server.ts` 删除，全部经 `index.ts` 导入
2. `protocols/**` 文件间无相互 import（链式依赖除外）；新增协议只写 1 个文件 + 白名单 1 行
3. 桌面侧 API：事件/查询/控制都在 **server 级**（全局 `WinHandle`，payload 自包含、无 `renderId` 二元组、无反查）、无 `onSync`；桌面不再需要 `for (client of server.clients)` 遍历与 `createWindowId` 拼接
4. cursor 状态单写入点，`obj2` 巨型袋消失
5. typecheck 全绿且覆盖 `src/**`、`desktop/*/src/**`、`test/**`、`script/**`（~~覆盖率脚本扫描~~ 已随 P11 弃用）
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

// ③ 跨协议语义状态：集中在 state/，单写入点，桌面与渲染都从这里读。
//    注意是 server 级（跨客户端），不是 per-client：WinHandle 在这里分配，
//    断开清理也在这里做 —— 这样 server.windows.list() 才有唯一数据源
class WindowsStore {
    #wins = new Map<WinHandle, WindowInfo & { client: ClientRef }>();
    /** 由 client 的 xdg_shell 模块调用，内部完成 handle 分配与反查表维护 */
    upsert(clientId: string, winId: WaylandWinId, patch: Partial<WindowInfo>): WinHandle;
    remove(handle: WinHandle): void;
    /** client 断开时批量移除其全部窗口，并 emit closed —— 替代桌面自己兜残留 */
    removeByClient(clientId: string): WinHandle[];
    list(): WindowInfo[];                       // server.windows.list()
    resolve(handle: WinHandle): { client: ClientRef; winId: WaylandWinId } | undefined;
    get(handle: WinHandle): WindowInfo | undefined;
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

// —— 事件：server 级一次订阅覆盖所有客户端，payload 自包含 ——
server.on("window.created", (info) => {
    // info: { handle, clientId, renderId, title, appid, rect, states } —— 一次拿全，无需反查
    taskbar.add(info);
    render.focus(info.renderId);
});
server.on("window.changed", (info) => taskbar.update(info));
server.on("cursor.changed", (clientId, s) => {
    if (s.kind === "shape") osd.showCursorIcon(s.shape);      // 纯枚举，远程可透传
    else if (s.kind === "image") osd.setCursor(s.canvas, s.hotspot);
    else osd.hideCursor();
});
server.on("clipboard.copy", (text) => clip.set(text));

// —— 桌面提供可用空间（替代原来逐 client 注册的 onSync("windowBound")）——
server.respond("surfaceBounds.request", () => ({ width: screen.w, height: screen.h }));

// —— 查询：不再遍历 server.clients ——
const all = server.windows.list();                            // WindowInfo[]
const info = await server.request("window.get", handle);      // WindowInfo
const rect = await server.request("window.getBounds", handle);

// —— 命令（原 win().xxx，经 handle 反查到具体 client）——
server.notify("window.focus", handle);
server.notify("window.setSize", handle, { width: 800, height: 600 });
server.notify("window.maximize", handle);
server.notify("window.close", handle);

// —— 输入注入（原 win().point.* / client.keyboard.*）——
server.notify("input.pointer", handle, { type: "move", x, y });
server.notify("input.key", handle, code, "pressed");
```

对照现契约 `desktop/readme.md:371-418`：`server.on("newClient")` + 逐 client 订阅 → `server.on("window.created")`；11 处 `for (client of server.clients)` → `server.windows.list()`；桌面自己拼的 `createWindowId(clientId, windowId)` → `info.handle`；`client.win(id)?.focus()` → `server.notify("window.focus", handle)`；`windowCreated(id, renderId)` 二元组与 `win.point.renderId()` 一并消失。

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
windows_store.upsert(info)      →  server.on("window.created", info)   // 结构化，不经 scene
cursor store.set(shape)        →  server.on("cursor.changed", cid, {kind:"shape", shape:"grab"})
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
