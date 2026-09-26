# wayland 重构计划

> **状态**：Phase 0–7 ✅ 全部完成（Phase 6 对外 API 打平 + Phase 7 文档收尾）。
> 本文件即交接文档。前提：当前版本不稳定，**允许破坏性变更**，不做兼容层/废弃期。
>
> **下一个 AI 的阅读顺序**：§1（对外 API 设计）→ **§5 约束与坑（必读，含 4 个会静默破坏代码的坑）**
> → §3 搁置与延后项 → §4 既存缺陷基线（不得顺手修）。§6 是已落地架构的参考手册，§10 是历史追溯。

**验证方式**（每次收尾都要跑）：

```bash
pnpm typecheck        # = tsc --noEmit -p tsconfig.typecheck.json，应为 0 错误
npx vitest run        # 22 文件 / 207 测试，应全绿
git diff --stat desktop/   # 桌面实现的变更，typecheck 必须覆盖其全部实现
npx biome check src/wayland/   # 注意 §5 的坑：不要对生成物运行 --write
```

---

## 进度速览

| 项 | 状态 | commit |
|---|---|---|
| Phase 0 · typecheck 覆盖扩大 | ✅ | `832032d` |
| Phase 0 · 测试基建修复（4 处 bug + 并行 socket 冲突） | ✅ | `d7767e9` |
| Phase 0 · 窗口生命周期 e2e | ✅ | `8eedf5f` |
| Phase 0 · `gen:protocols` script | ⬜ | — |
| Phase 1 · `index.ts` 入口收敛 | ✅ | `0c19daa` |
| Phase 1 · `module.ts` / `scene/types.ts` 契约 | ✅ | `c8ccf43` |
| Phase 2 · 三个 Store（对外形状不变） | ✅ | `2f61a24` `4f4f114` `d7cbf2a` |
| Phase 3 · core 11 模块 + `host/` + 声明合并 | ✅ | `ed567c2` `7bd7ac3` `d5563a2` `3c82091` |
| Phase 4 · 扩展三模块 + 反向钩子机制 | ✅ | `34f1872` |
| Phase 5 · xdg + text-input 迁出、`server.ts` 删除 | ✅ | `1b3e0bc` `f53e2af` |
| **Phase 6 · 对外 API 打平（破坏性）** | ✅ | — |
| Phase 7 · 文档收尾 | ✅ | — |
| 场景层重构（见 §3.1） | ⏸ 搁置 | 需先定 SceneSink 形态与 renderToolsOn 去留 |
| `ack_configure` + xdg 生命周期 e2e | ➖ 按决定跳过 | — |

---

## 0. 三条原则

1. **协议模块只依赖 core 接口，不互相 import**（规范层面 7 个已支持协议的外部引用全是 `wl_*`；唯一例外 xdg-decoration→xdg-shell 属单向链式依赖）。
2. **协议只产生语义事实**（window 状态、cursor 状态、clipboard、输入焦点），**渲染是语义状态的投影/订阅者**，不是协议的调用对象。
3. **对外 API 以"桌面需要回答的问题"建模**（有哪些窗口、多大、光标是什么、怎么操作），而不是以 Wayland 对象建模（xdg_toplevel id、renderId、serial）。

---

## 1. Phase 6 对外 API 打平与重塑 ✅（已落地，本节保留作为设计说明）

**以 server 为主通道**：用法见 `desktop/readme.md` 的「Wayland 服务器」，类型契约见 `src/wayland/api.ts`。

### 1.1 打平原则：事件与查询上提到 server，用全局 handle

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

选单调递增而非拼 `clientId-windowId`：客户端断开重连后对象 id 会复用，递增 handle 不会串台。

**机制**（都不重）：
1. server 订阅每个 client 的事件做 fan-in 转发（薄适配层）
2. 全局窗口表 `handle → (client, winId)`
3. **client 断开时由 server 统一关闭该客户端全部窗口**

### 1.2 事件：server 级、按域分组、payload 自包含

```ts
type ServerEvents = {
    window: {
        created(info: WindowInfo): void;
        changed(info: WindowInfo): void;     // rect/states/title/appid 任一变化，字段自包含，无需反查
        closed(handle: WinHandle): void;
        startMove(handle: WinHandle): void;
    };
    cursor: { changed(clientId: string, state: CursorState): void };
    clipboard: {
        copy(clientId: string, text: string): void;
        pasteRequested(clientId: string): void;
    };
    client: { opened(clientId: string): void; closed(clientId: string): void };
};

type CursorState =
    | { kind: "hidden" }
    | { kind: "shape"; shape: string; hotspot: { x: 0; y: 0 } }   // 纯枚举，可序列化
    | { kind: "image"; surfaceId: SurfaceId; hotspot: Point; canvas?: OffscreenCanvas };
```

**分组**：window / cursor / clipboard / client 共 4 个域，server 一次订阅覆盖全部客户端；
`renderId` 内嵌在 `WindowInfo` 里，不走二元组。

**实现**：窗口事件由 `state/windows_store.ts` 单点发出，`WindowsSink` 是薄适配层（`host/client.ts` 构造 `WindowsStore` 时注入），`host/server.ts` 订阅这一层做 fan-in，Store 与 handler 不参与对外形状。cursor 同理（`state/cursor_store.ts`，出口是 `render.setCursor` + `cursor.changed`）。

### 1.3 查询：`server.windows`

```ts
server.windows.list(): WindowInfo[]                 // 全部窗口的快照
server.windows.get(handle): WindowInfo | undefined
server.cursor.get(clientId): CursorState
```

### 1.4 控制：handle → 内部反查 client

用 `src/event-emitter/event-emitter.ts` 的 `request/respond` 提供查询与应答：

```ts
// 查询
await server.request("window.get", handle): WindowInfo
await server.request("window.getBounds", handle): Rect
// 窗口命令
server.notify("window.focus" | "window.blur" | "window.close", handle)
server.notify("window.setSize", handle, { width, height })
server.notify("window.maximize" | "window.unmaximize" | "window.minimize", handle)
// 输入注入，内部 handle → (client, winId)
server.notify("input.pointer", handle, event)
server.notify("input.scroll", handle, event)
server.notify("input.key", handle, key, "pressed" | "released")
server.notify("input.text", handle, text, preedit)
// 桌面提供可用空间
server.respond("surfaceBounds.request", () => ({ width, height }))
```

### 1.5 哪些**不**打平（保留 per-client 出口）

| 走 server（主通道） | 保留 `server.clients` |
|---|---|
| window / cursor / clipboard 的事件、查询、命令 | 连接生命周期、remote/调试等需要底层 client 的场景 |
| 输入注入（经 handle 反查） | 桌面明确要拿到具体 client 对象时 |

`server.clients` 保留给上表右列，桌面常规路径用不到它。

### 1.6 入口与导出

```ts
// src/wayland/index.ts（唯一入口，已存在）
export function createServer(op: { render: SceneSink; socketDir?: string }): WaylandServer;
export type { WaylandServer, ServerEvents, WindowInfo, WinHandle, CursorState, ... };
```

- `src/sys_api/run.ts` 从 `index.ts` 导入 ✅
- `src/desktop-api.ts` 的导出从 `index.ts` re-export ✅
- ✅ 对外只暴露 `Client` 接口（`WaylandClient` 是内部实现，不出现在导出里）；`ServerEvents` /
  `WindowInfo` / `ServerNotifyMap` / `ServerRequests` / `CursorState` 等类型放在 `src/wayland/api.ts`
  （与 `module.ts` 分工：module.ts 是协议 handler 的契约，api.ts 是桌面的契约，互不 import 实现）

### 1.7 桌面侧影响面

`desktop/{example,offical,remote}`、`src/renderer/view/desktop-test.ts`、`src/test_runner/test_runner.ts`、
`test/mock` 全部按 §1 构建，`pnpm typecheck` 覆盖其全部实现（typecheck 已覆盖 `desktop/**`、`test/mock/**`）。

### 1.8 验收 ✅

- 桌面侧只有 `server.windows.list()` 与 `info.handle`，没有客户端遍历与 id 拼接
  （`server.clients` 只剩 `setLogConfig` 这一处调试用法）
- `desktop/` 的变更由 typecheck 覆盖其全部实现
- e2e 全绿（`window.test.ts` 靠 `window.changed` 差分还原 resize/maximize/title）

### 1.9 几个容易踩的实现决定

| 决定 | 原因 |
|---|---|
| `clipboard.copy` / `clipboard.pasteRequested` 带 `clientId` | 粘贴要回填到**发起请求的那个连接**（`notify("clipboard.paste", clientId, text)`），没有 clientId 无法定位 |
| 提供同步的 `server.windows.preview(handle)` | e2e 采样与 offical 缩略图要同步取帧，`request` 是异步的 |
| `notify("window.setBox", …)` 单列一项；`window.maximize/unmaximize` 的 size 可选 | 只记盒子不发 configure 的场景不能并进 `setSize`（会多发一次 configure）；`maximize(w, h)` 的两个参数都要能传 |
| `respond` 在 `EventEmitter` 之外另存一份同步副本 | `EventEmitter.request` 返回 Promise，而 `xdg_surface.get_toplevel` 必须同步填 `configure_bounds`（见 §8 风险表） |
| `CursorState.image` 的 `canvas` 可选、`surfaceId` 必填 | 桌面要画 surface 图像；surface 还没提交过帧时没有画布，桌面保留上一张 |

---

## 2. Phase 7 文档收尾 ✅

- [x] `src/wayland/readme.md` 增加"新增协议指南"（+ 对外 API 摘要）
- [x] `desktop/readme.md` 的「Wayland 服务器」按 §1 重写（含 `window.changed` 差分范式与 clientId 去重）
- [x] `AGENTS.md` 的"新增 wayland 协议"流程与 wayland api 一节的文件指引更新
- [x] `test/mock/readme.md` 的 WaylandServer/WaylandClient 表随 mock 更新

---

## 3. 搁置与延后项

### 3.1 场景层：surfaceId 寻址的融合 API + 图片 KV ⏸ 整体搁置

需要先定两件事，**当前 `renderTools` / `renderToolsOn` / `SceneCmd` 保持不变**：

1. **`SceneSink` 形态**——方法式（`renderTools` 瘦身，改动小、remote 只删 `setCursor`）还是命令式（`apply(SceneCmd)` 单方法，接口最窄但 `desktop/remote/src/remote-render.ts` 362 行要重写）
2. **`renderToolsOn` 三条中继的去留**——实测 `setCursor`、`asToplevel`、`destroyXdgSurfaceEle(toplevel)` **都不碰 DOM，纯事件中继**，且与已有的 `windowCreated/windowClosed` 重复，属语义事件而非渲染

`scene/types.ts` 的 `SceneCmd`/`ImageKV` 已作为契约落地（`c8ccf43`），但**尚无实现方使用**。

**设计约束**（恢复时必须遵守）：
- `renderTools` 存在的目的是**远程**——操作与像素都要能序列化发送
- **client API 不与 DOM/canvas 实现融合**：融合的是**寻址方式（surfaceId）**，不是实现；DOM 细节一旦进入 client API 就无法远程
- `cursor` 协议需要 surface 图像（`wl_pointer.set_cursor` 传的是 surface），所以**图像是一等数据**，不能藏在 DOM 实现里
- `subsurface` / `xdg_toplevel` 的 DOM 布局细节多，这部分**保留在 `render_tools_el.ts`**，不进公共层

两条通道的设计草案（命令流 + 图片 KV，像素不内联进命令）见 git 历史中本节的完整内容。

### 3.2 `win().point.updatePointerFocus` 下沉 `windows_store` ⚠️ 调整

约 114 行 hit-test，依赖 objects / send / seat / keyboard / domain **六类**能力面（其中 `keyboard` 尚未进 `ModuleCtx`）。硬塞进 `WindowsStore` 会让一个纯状态容器变成带六项依赖的服务，反而更难测。

留在 `host/client.ts`（它本质是"指针按窗口几何路由"，属 host 职责）；待 `keyboard` 进契约后再评估是否独立成 `host/pointer.ts`。

### 3.3 `ack_configure` + xdg 生命周期 e2e ➖ 按决定跳过

`xdg_surface.ack_configure` 未实现、serial 硬编码 `1`——属**新增协议实现**，不混入重构。恢复时应与 configure 握手重写绑在一起做（见 §4）。

### 3.4 `package.json` 加 `gen:protocols` script ⬜

`script/wayland/gen_protocols.ts` 至今仍需手动跑。

---

## 4. 既存缺陷基线（**知道是错的、但没有验证手段、所以不顺手改**）

重构期间**不得恶化**，也不得未经决定就"顺手修好"：

| 缺陷 | 位置 | 为什么没修 |
|---|---|---|
| `wl_registry.bind` 的协议元数据**没有 version 参数**，`protoVersions` 记的永远是 undefined → `sendMessage` 的 since 版本检查一直空转 | `protocols/ext/registry.ts`（有注释） | 要改生成器 `gen_protocols.ts` 并重新生成，风险独立于本次重构 |
| `xdg_surface.ack_configure` 未实现；serial 全部硬编码 `1` | 现象见 e2e 日志 `No matching operation found xdg_surface.ack_configure` | 属新增实现（见 §3.3） |
| **viewport 不跨帧保持**：`wl_surface.commit` 只在设置它的那次 commit 读到 viewport | `protocols/ext/viewporter.ts` 的 `onFrame` 读 `pending` 而非 `current` | 零测试覆盖，改了无法验证；协议规范其实要求读 `current` |
| 协议错误处理基本未实现 | `src/wayland/readme.md` 首行 | 同上 |

---

## 5. 约束与坑（**必读**）

### 5.1 会静默破坏代码的

1. **biome 会把空 `interface X {}` 转成 `type X = {}`**（`noBannedTypes` / `noEmptyInterface`）。对 `module.ts` 的 `WaylandDataRegistry` 这是**灾难性的**——各协议文件靠 `declare module` 向它合并，转成 type 后合并关系断裂，一次产生 96 个类型错误。已加定向 `// biome-ignore`，**不要删那条注释**。
2. **生成物不可格式化**：`protocols/protocols.json`、`protocols/wayland-types.ts` 是 `gen_protocols.ts` 的输出，biome 格式化后会产生数千行无意义 diff。跑 `biome check --write` 时**只指定具体目录/文件**，别写 `src/wayland/`；跑完 `git status` 检查这两个文件。
3. **模块图导入有副作用**：`utils/shared_texture.ts` 会注册 electron 共享纹理接收端并建 unix socket。协议模块单测直接 import 模块图，纯 node 环境没有 electron —— 已加环境守卫。**新增模块级副作用时同样要加守卫**。
4. **迁移脚本的括号匹配对联合类型会截断**：`wl_buffer: | {…} | {…};` 没有外层大括号，按第一个 `{` 配对只截到第一个分支。处理此类结构要"扫到 depth 0 的分号"。

### 5.2 设计上的不变量

5. **协议模块之间零 `import`**：只能 import `module.ts`、`utils/*`、`protocols/wayland-types`（生成物）。`assertModuleConflicts()` 在 `WaylandServer` 构造时校验请求键冲突。
6. **反向通信只有钩子**：扩展不被 core import，只能声明 `hooks.{onCommit,onFrame,onDestroy,onFocus}`，由 `host/client.ts` 聚合、`ctx.notify.*` 触发。钩子分阶段——`onCommit` 是"buffer 已应用、像素尚未合成"，`onFrame` 是"像素已合成、渲染之前（可返回替换画布）"，**不能合并**。
7. **`ctx` 是 handler 唯一的依赖来源**：handler 不碰 `this`（`WaylandClient`）。新增 handler 需要的能力先进 `module.ts` 的契约，再在 `buildCtx()` 里接实现。
8. **对外事件形状只能改一处接线**：`WindowsSink`/`CursorStore` 的出口是薄适配层，改对外形状只改那一处接线，Store 与 handler 不动。当前的接线是 client 级事件 → server fan-in，落在 `host/server.ts` 的 `bindClient` 与 `api.ts`。
9. **desktop 的改动必须 typecheck 全绿**，且 typecheck 覆盖其全部实现。

### 5.3 测试与提交

10. **remote 桌面不做行为测试**：网络链路难以在 e2e 复现，验收降为**类型不报错**——由 typecheck 覆盖其全部实现保证。
11. e2e 走 `testRunnerApp`（`src/test_runner/test_runner.ts`），内部用 electron 起真客户端；`killTimeout` 20s，测试自己 `runner.kill()` 收尾。
12. **commit 只写动机**：diff 能看出来的不写。

---

## 6. 已落地架构（as-built）

### 6.1 目录

```
src/wayland/
  index.ts          33   唯一入口：createServer + Client 接口 + api.ts 类型 re-export
  api.ts           190   桌面侧契约（零实现）：WinHandle / WindowInfo / CursorState /
                         ServerEvents / ServerNotifyMap / ServerRequests / Client
  module.ts        475   协议模块契约（零实现零副作用）
  host/
    server.ts     ~400   WaylandServer：socket 监听、建连、模块装配，
                         + 事件 fan-in、全局窗口表、windows./cursor. 查询、
                         notify 分发、request/respond（含同步副本）
    client.ts    ~1390   对象表、解码分发、ModuleCtx、窗口/输入方法、键盘仲裁
  protocols/
    core/  ×11          display registry compositor surface shm seat pointer
                        subsurface data_device output region
    ext/   ×6           xdg_shell text_input_v1 text_input_v3
                        viewporter cursor_shape dmabuf
    index.ts            模块清单 + assertModuleConflicts()
    protocols.json      生成物（勿格式化）
    wayland-types.ts    生成物（勿格式化）
  state/
    windows_store.ts    窗口记录与窗口事件（WindowsSink 薄适配层）
    cursor_store.ts     光标唯一写入点（render.setCursor + onChanged 双出口）
    seat_store.ts       焦点 / serial / 修饰键 / seat 记录
  scene/types.ts        SceneCmd + ImageKV 契约（⏸ 搁置，无实现方）
  render_tools.d.ts     渲染接口（⏸ 保持现状）
  render_tools_el.ts    DOM 实现
  utils/                wayland-proto（元数据+枚举助手+全局表）、fd、
                        shared_texture、text_input、wayland-encoder/decoder、
                        dma-buf、xdg
  test/                 e2e：window / dma-buf / keyboard
  PLAN.md               本文件
```

全部经 `index.ts` 导入。

### 6.2 模块怎么写

```ts
// protocols/ext/example.ts
import { defineModule, type WaylandObjectId2 } from "../../module";

// 状态类型归本模块声明
declare module "../../module" {
    interface WaylandDataRegistry {
        my_iface: { someState: number };
    }
}

export const exampleModule = defineModule({
    name: "example",
    globals: [                    // 可选：绑定时自报
        { name: "my_iface", version: 1, onBind: (msg, ctx) => { … } },
    ],
    requests: {                   // 书写态用对象字面量：键写错编译期报错
        "my_iface.do_thing"(x, ctx) { … },   // x.args 按生成类型精确推导，x.id 已带 brand
    },
    hooks: {                      // 可选：core → 本模块的反向通知
        onCommit: (surfaceId, sizeChanged, ctx) => { … },
        onFrame: (surfaceId, canvas, pending, ctx) => canvas,   // 可返回替换画布
        onDestroy: (surfaceId, ctx) => { … },
        onFocus: (surfaceId | undefined, ctx) => { … },
    },
});
```

新增协议的改动清单：
1. XML 放入 `script/wayland/xml/`，`gen_protocols.ts` 的 `supportedProtocols` 加一行，跑生成（**`package.json` 尚无 `gen:protocols` script，需手动 `npx tsx script/wayland/gen_protocols.ts`**）
2. 新建 `protocols/core/` 或 `protocols/ext/<name>.ts`（**唯一必写的文件**）
3. `protocols/index.ts` 的清单数组加一行
4. `src/wayland/readme.md` 协议清单更新
5. （可选）需要新 core 能力时才动 `module.ts` 的 `CoreApi` —— 须先与开发者确认
6. 补一个 fake-ctx 单测（仿 `protocols/core/region.test.ts`、`protocols/modules.test.ts`）

### 6.3 `ctx` 能拿到什么

| 分组 | 内容 |
|---|---|
| `ctx.objects` | `get/getOption/getData/setData/create/delete/has/bind/entries` —— id 品牌类型推导，未声明状态的接口 `setData(x, {...})` 编译报错 |
| `ctx.send / sendNow / postError` | 事件发送（入队 vs 立即写）与协议错误，签名与请求接收完全对称，事件名前缀必须匹配目标对象接口 |
| `ctx.core` | `surface`（role/尺寸/帧/idScope 等 11 方法）、`subsurface`、`registry`（globals/byName/globalOf）、`buffer`、`seat`（focus/nextSerial）—— **扩展唯一可依赖的 core 面** |
| `ctx.domain.xdgSurface` | 过渡字段，Phase 后续若把 `xdgSurfaceData` 迁入 xdg 模块则删除 |
| `ctx.state` | `windows` / `cursor` / `seat` 三个 Store |
| `ctx.client` | `id`、`displayId`、`protoVersions`、`emit`（client 级内部管道）、`surfaceBounds`（同步取桌面可用空间）、`state`（clipboard、text-input 仲裁、appid 等 client 级字段） |
| `ctx.notify` | `commit(surfaceId, sizeChanged)` / `frame(surfaceId, canvas, pending)` / `destroy` / `focus` |
| `ctx.scene` | 渲染投影（`renderTools`） |

### 6.4 数据三层（分界规则）

- **只有这一个对象要用** → `ctx.objects.setData(id, …)`（对象随身状态）
- **同协议多对象要互相查** → 模块内私有 Map（如 `xdgSurfaceData` 的双向映射）
- **跨协议 / 要给桌面看** → `state/` 下的 Store，单写入点

### 6.5 事件流

```
协议 handler
    → Store（windows/cursor/seat）
    → [薄适配层 sink] → client 级平铺事件（内部管道，桌面看不到）
    → host/server.ts 的 bindClient fan-in：分配 WinHandle、组装自包含 WindowInfo
    → server 级域事件（window.* / cursor.* / clipboard.* / client.*） → 桌面
                              ↑ renderToolsOn 仍在渲染侧并行送达（未删）
```

反向：

```
桌面 → server.notify(key, handle, …) → handle 反查 (client, winId) → 窗口/输入方法 → 协议事件
桌面 → server.respond("surfaceBounds.request", fn) → ctx.client.surfaceBounds()（同步）
```

---

## 7. 测试策略

| 层 | 手段 | 状态 |
|---|---|---|
| 编解码 | `utils/wayland-codec.test.ts` | ✅ |
| 窗口生命周期 e2e | `test/window.test.ts`（创建/预览像素/resize/maximize/cursor/关闭） | ✅ |
| 回归 e2e | `test/dma-buf.test.ts`、`test/keyboard.test.ts` | ✅ |
| 协议模块单测 | fake-ctx 直接调 handler：`protocols/core/region.test.ts`、`protocols/modules.test.ts` | ✅ 2 个文件 |
| 静态覆盖 | ~~`check_proto_code` 扫目录~~ 已随 P11 弃用 | ➖ |
| 接口漂移 | typecheck 覆盖 `src/**`、`desktop/*/src/**`、`test/**`、`script/**`（394 文件） | ✅ |
| remote 行为 | **不做**，只保证 typecheck | ➖ |

**测试与改动同阶段落地**：改哪个协议就给它补 fake-ctx 单测；改动桌面侧事件时，
`window.test.ts` 的断言同步更新（当前靠 `window.changed` 差分还原 resize/maximize/title）。

---

## 8. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 桌面实现与 mock 的接口改造 | 中 | 一次性改完不留兼容别名（前提：不稳定，允许破坏）；typecheck 覆盖全部实现，207 测试全绿 |
| ~~`emitSync` 移除导致窗口初始尺寸回归~~ | ✅ 已消解 | `server.respond("surfaceBounds.request", …)` 注册时**另存一份同步副本**（EventEmitter 的 `request` 是异步的，来不及填 `configure_bounds`），`ctx.client.surfaceBounds()` 走这条 |
| 固定 wayland socket 名 `my-wayland-server-0` 令测试无法并行 | 中 | 现以 `vitest.config.ts` `fileParallelism:false` 兜底；根治需把 socket 名改为实例唯一——**服务端行为变更，待确认** |
| `check_proto_code` 指向已删除的 `server.ts` | 低 | 已弃用（P11）；如恢复需改扫描目标 |
| `SceneCmd`/`ImageKV` 切分遗漏隐式依赖 | — | ⏸ 场景层已搁置，恢复时先以 cursor 作交汇样板 |

---

## 9. 验收标准（整体）

1. ✅ `src/wayland/server.ts` 删除，全部经 `index.ts` 导入
2. ✅ `protocols/**` 文件间无相互 import；新增协议只写 1 个文件 + 白名单 1 行
3. ✅ 桌面侧 API：事件/查询/控制都在 **server 级**（全局 `WinHandle`，payload 自包含、无 `renderId` 二元组、无反查、无 `onSync`）；桌面侧只有 `server.windows.list()` 与 `info.handle`
4. ✅ cursor 状态单写入点，`obj2` 巨型袋消失（`obj2` 仍在 `ClientState`，但已收窄为 clipboard/text-input/appid 等 client 级字段）
5. ✅ typecheck 全绿且覆盖 `src/**`、`desktop/*/src/**`、`test/**`、`script/**`
6. ✅ 全部 e2e + 单测通过（22 文件 / 207 测试）；`desktop/readme.md`、`AGENTS.md`、`src/wayland/readme.md` 更新

---

## 10. 历史记录（Phase 0–6，供追溯）

| 阶段 | 内容 | 关键 commit |
|---|---|---|
| 0 | typecheck 覆盖扩大到 desktop/test/script 并修 13 处；测试基建 4 个 bug（ASI 分号、stdout 丢弃、`waitExit` 竞态、按下标取值）+ `fileParallelism:false`；窗口生命周期 e2e | `832032d` `d7767e9` `8eedf5f` |
| 1 | `index.ts` 入口收敛（3 处引用改道）；`module.ts` 契约 + `scene/types.ts`；品牌类型与状态表从 server.ts 上移 | `0c19daa` `c8ccf43` |
| 2 | `CursorStore` / `WindowsStore` / `SeatStore` 抽取，对外事件形状不变；挖出两处隐含顺序契约（destroy 三步、title 先发后改）；text-input 仲裁推迟 | `2f61a24` `4f4f114` `d7cbf2a` |
| 3 | `ModuleCtx` 真实实现；协议元数据与枚举助手下沉 utils；core 11 模块 24 handler 迁出；bind if 链 → `globals[].onBind`；状态类型声明合并；`WaylandClient` → `host/client.ts` | `875cb7d` `9a92104` `ed567c2` `7bd7ac3` `3c82091` `d5563a2` |
| 4 | 扩展三模块迁出；反向钩子机制落地（onCommit/onFrame 分阶段）；`shared_texture` 环境守卫 | `34f1872` |
| 5 | 扩展模块移入 `protocols/ext/`；xdg 22 + text-input 13 handler 迁出；configure → `onCommit`、键盘焦点 → `onFocus`；扩展状态类型入模块（中央表归零）；`server.ts` → `host/server.ts` | `4395236` `1b3e0bc` `f53e2af` |
| 6 | 对外 API 打平：新增 `api.ts`（`WinHandle` / `WindowInfo` / `CursorState` / `ServerEvents` / `ServerNotifyMap` / `ServerRequests`）；server 订阅 client 事件做 fan-in + 全局 handle 表 + 断线统一关窗；`surfaceBounds.request` 同步应答；对外只暴露 `Client` 接口；`desktop/{example,offical,remote}`、`desktop-test`、`test_runner`、3 个 e2e、`test/mock`（新增 `createMockServer`）与 `mock_demo` 按新契约构建 | — |

**历史问题**（详见 git 历史）：P1 god file、P2 协议间双向直连、P3 中央状态表、P4 cursor 散写、P5 bind if 链、P6 cursor 混进渲染、P7 事件平铺、P8 renderTools 4 实现漂移、P9 `emitSync`、P10 electron 依赖（判定不拆）、P11 覆盖率脚本（弃用）、P12 无测试脚手架。
