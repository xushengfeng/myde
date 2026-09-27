## 支持的协议

以下协议的错误处理均未实现

- wayland
    - wl_display
    - wl_registry
    - wl_callback
    - wl_compositor
    - wl_shm_pool 部分
    - wl_shm 部分
    - wl_buffer
    - wl_surface 部分
    - wl_seat 还没有 touch；registry **一次广播两把**（`seat0`/`seat1`，见 `host/server.ts` 的 `initWaylandProtocols`）
    - wl_pointer 部分
    - wl_keyboard 还没有 repeat
    - wl_output 只是硬编码，还没有添加硬件处理
    - wl_region
    - wl_data_device 部分
    - wl_data_device_manager 部分
    - wl_data_offer 部分
    - wl_data_source 部分
    - wl_subcompositor
    - wl_subsurface 部分

- xdg-shell
    - xdg_wm_base
    - xdg_surface
    - xdg_toplevel 部分
    - xdg_popup 部分
    - xdg_positioner 部分

- linux-dmabuf-v1
    - zwp_linux_dmabuf_v1 部分，format和modifier不支持
    - zwp_linux_buffer_params_v1 部分
    - zwp_linux_dmabuf_feedback_v1

- viewporter
    - wp_viewporter
    - wp_viewport

- text-input-unstable-v1
    - zwp_text_input_v1 部分
    - zwp_text_input_manager_v1

- text-input-unstable-v3
    - zwp_text_input_v3 部分（delete_surrounding_text 未实现）
    - zwp_text_input_manager_v3

v1 和 v3 是竞争协议，单客户端内仲裁：按协议（manager）一侧计，后激活者胜出（zwp_text_input_v1.activate / zwp_text_input_v3.enable 抢占），文本只发给持有对象，v3 的 enter/leave 跟随**该把 seat** 的键盘焦点（`get_text_input` 的 seat 参数记在 `TextInputV3Data.seat`，跨 seat 的输入直接忽略）。

## 对外 API（桌面侧）

桌面只从 `src/wayland/index.ts` 拿东西：`createServer({ render, socketDir })`、`Client` 接口、
以及 `api.ts` 里的类型（`ServerEvents` / `ServerNotifyMap` / `ServerRequests` / `WindowInfo` /
`WinHandle` / `CursorState` …）。

- **事件**：`server.on("window.created" | "window.changed" | "window.closed" | "window.startMove" |
  "cursor.changed" | "clipboard.copy" | "clipboard.pasteRequested" | "client.opened" | "client.closed", …)`
- **查询**：`server.windows.list() / get() / preview()`、`server.cursor.get(clientId)`、`await server.request(…)`
- **命令**：`server.notify("window.focus" | … | "input.pointer" | …, handle, …)`
  → `host/server.ts` 按 handle 反查 `(client, winId)` → 协议模块的 `actions` 表，组包在协议文件里。
  `input.pointer|scroll|key|text` 末尾可带 `seat`（缺省 `"seat0"`，选择器语义、不广播）：
  桌面喂第二把光标（如远程协作者）时传 `"seat1"`。
- **应答**：`server.respond("surfaceBounds.request", () => ({ width, height }))`

桌面不接触 Wayland 对象 id：所有命令按全局 `WinHandle` 下发，由 `host/server.ts` 反查
`(client, winId)`。`server.clients` 只留给连接生命周期与调试。用法见 `desktop/readme.md` 的「Wayland 服务器」。

## 测试

`src/wayland/test/` 是端到端测试：起真 Electron 客户端连本服务端，注入输入/命令，再从客户端回传的日志断言。

| 文件 | 覆盖 |
| --- | --- |
| `dma-buf.test.ts` | dmabuf 单帧渲染，`preview()` 像素采样 |
| `window.test.ts` | 窗口创建、内容显示、resize、maximize、cursor、关闭 |
| `keyboard.test.ts` | `input.key` 的键码映射与按键序列（按键事件按顺序对账） |
| `pointer.test.ts` | `input.pointer`（move / down / up 三键落点与坐标）、`input.scroll` 滚轮方向、`cursor.changed` |
| `text_input.test.ts` | `input.text` → `zwp_text_input_v3` 的 `commit_string` 落进编辑框 |
| `clipboard.test.ts` | 双向剪贴板：`clipboard.offer` → `pasteRequested` → `paste` 回填；客户端 `set_selection` → `clipboard.copy` |

```bash
npx vitest run src/wayland/test/pointer.test.ts
```

写法上的四个硬约束（踩过一遍，违反基本跑不起来）：

1. **必须串行**：都用默认 socket 名 `my-wayland-server-0`，后启动的 `setupSocket` 会 unlink 掉前一个的 socket，
   见 `vitest.config.ts` 的 `fileParallelism: false`。
2. **`testRunnerApp` 的回调是 `script.toString()` 拼进桌面脚本里求值的**：访问不到本文件的模块作用域，
   计划与常量要写在**回调体内**，再用 `runner.sendData()` 带出来给外层断言（回调里要的工具函数同理，
   比如 `mapKeyCode` 只能在回调外校验回调内写死的键码）。
3. **客户端日志是双层 JSON**：renderer 的 `console.log` 先被 `test/electron_app/start.js` 的 console-message
   包成 `{"data": …}`，再被 `main.ts` 包成 `{"applog": …}`，且一个 chunk 可能含多行。
   统一用 `src/test_runner/applog.ts` 的 `collectAppLogs()` / `logOfType()` 解析，**别按下标取日志行**。
4. **等首帧再注入**：`window.created` 只说明 xdg_toplevel 建好了，页面脚本未必已挂上监听，
   固定 `sleep` 早晚会在慢机器上翻车。`server.windows.preview(handle)` 初始是 1×1 的占位画布，
   `width > 1` 才代表客户端提交了首帧（页面就绪），四个输入测试都是这么等的。

客户端与几何坐标的换算（`pointer.test.ts` 的做法）：`ev.x/y` 相对**窗口几何原点**，几何里还含着 CSD 标题栏，
所以「页面坐标 = 注入坐标 − (几何宽−视口宽, 几何高−视口高)」，两个尺寸都在运行时现取，不写死。
`wl_pointer.axis` 与 DOM wheel 的数值单位也不同（本环境 120 → 1440），只断言方向与所在轴。

剪贴板的顺序坑（`clipboard.test.ts`）：客户端自己持有剪贴板时，粘贴直接吃本地缓存、不会向合成器发
`wl_data_offer.receive`，所以「桌面回填」的用例必须排在客户端复制**之前**；复制的文案用 `input.text` 打进去，
空选择走的读取分支不会 emit `clipboard.copy`。

## 新增协议指南

### 1. 生成类型

把协议 XML 放进 `script/wayland/xml/`，在 `script/wayland/gen_protocols.ts` 的
`supportedProtocols` 加一行，然后跑：

```bash
npx tsx script/wayland/gen_protocols.ts   # package.json 尚无 gen:protocols script
```

产物是 `protocols/protocols.json` 与 `protocols/wayland-types.ts`，**是生成物、不要格式化**
（`biome check --write` 只指定具体目录/文件，别写 `src/wayland/`）。

### 2. 写模块（唯一必写的文件）

新建 `protocols/core/<name>.ts` 或 `protocols/ext/<name>.ts`：

```typescript
import { defineModule, type WaylandObjectId2 } from "../../module";

// 状态类型归本模块声明
declare module "../../module" {
    interface WaylandDataRegistry {
        my_iface: { someState: number };
    }
}

export const exampleModule = defineModule({
    name: "example",
    globals: [ // 可选：绑定时自报
        { name: "my_iface", version: 1, onBind: (msg, ctx) => { /* … */ } },
    ],
    requests: { // 书写态用对象字面量：键写错编译期报错
        "my_iface.do_thing"(x, ctx) { /* x.args 按生成类型精确推导，x.id 已带 brand */ },
    },
    actions: { // 可选：桌面命令的出口（`server.notify` → 这里），键来自 api.ts 的 ServerNotifyMap
        "input.key"(msg, ctx) { /* msg.winId 是 handle 反查后的 xdg_toplevel，msg.args 已去掉 handle */ },
    },
    core: (ctx) => {  // 可选：只有 core 模块用，提供 Omit<CoreApi,"registry">（surface / subsurface / focusKeyboard）
        const surface = new wlSurfaceData(ctx.scene);
        return { surface, subsurface: new wlSubSurfaceData(surface), focusKeyboard: (s, seat) => {} };
    },
    domain: {  // 可选：本模块的域状态实例；key 先在本文件 declare module 进 WaylandDomainRegistry
        xdgSurface: (ctx) => new xdgSurfaceData(ctx.core.surface),
    },
    hooks: { // 可选：core → 本模块的反向通知
        onCommit: (surfaceId, sizeChanged, ctx) => {},
        onFrame: (surfaceId, canvas, pending, ctx) => canvas,
        onDestroy: (surfaceId, ctx) => {},
        onFocus: (seat, surfaceId, ctx) => {},   // 某把 seat 的键盘焦点变化（surfaceId undefined = 失焦）
        onTextInput: (seat, text, preedit, ctx) => {}, // input.text 的仲裁：各 text_input 模块自判是否持有
    },
});
```

`core` / `domain` 的 initializer 由 `buildCtx()` 跑两趟执行（先全部 `core`，再 `domain`，
所以 `domain` 构造函数里能读 `ctx.core`），host 不 import 任何域状态的构造函数。

### 3. 登记

1. `protocols/index.ts` 的模块清单数组加一行
2. 本文件顶部的「支持的协议」更新
3. （可选）需要新 core 能力时才动 `module.ts` 的 `CoreApi` —— 须先与开发者确认
4. （可选）带自己的域状态时，在本文件 `declare module` 进 `WaylandDomainRegistry` 并给出 `domain` initializer；
   跨模块重复 key 由 `assertModuleConflicts()` 拦
5. 补一个 fake-ctx 单测（仿 `protocols/modules.test.ts`）

### 4. 不变量

- **协议模块之间零运行时 `import`**：只能 import `module.ts`、`api.ts`、`utils/*`、`render_tools`、
  `protocols/wayland-types`（生成物）。`import type` 允许跨协议引类型（编译期擦除、不产生运行时依赖），
  运行时的跨协议关系只能靠 `ctx` 注入或 `hooks`。`assertModuleConflicts()` 在 `WaylandServer`
  构造时校验三类冲突：请求键、桌面命令键、域状态 key。
- **域状态类住协议文件，实例由协议自己造**：`wlSurfaceData` / `wlSubSurfaceData` 在
  `protocols/core/wayland.ts`（经 `core` initializer 提供），`xdgSurfaceData` 在
  `protocols/ext/xdg_shell.ts`（经 `domain.xdgSurface` 提供）；`module.ts` 用 `import type`
  取它们作为 `CoreApi` / `WaylandDomainRegistry` 的形状。host 只跑装配清单，不 `new` 任何域状态。
- **桌面命令进 `actions`**：`server.notify` 的命令由 `host/server.ts` 反查 handle 后派发
  （`client.runAction`），组包、serial、**按 seat 分发**、状态维护全在协议文件里，host 不写协议事件。
  例外只有 `clipboard.paste`（写 fd，不发协议消息，server 直达 `client.paste`）。
  命令里**只改 `WindowRecord` / 只发 Wayland 事件**，语义事件（`window.changed` 等）仍由 Store fan-in。
- **`ctx` 是 handler 唯一的依赖来源**：handler 不碰 `this`（`WaylandClient`）。新增能力先进
  `module.ts` 的契约，再接到 `ctx`：连接级的口（`objects`/`send*`/`scene`/`registry`）由
  `host/client.ts` 的 `buildCtx()` 接实现，core 能力与协议域状态由各模块的 `core` / `domain`
  initializer 提供、`buildCtx` 只按清单装配（见上一条）。指针几何命中归 xdg 域
  （`ctx.domain.xdgSurface.hitTest`，由 core 的 `input.pointer` 调用），焦点转移与
  enter/leave 的协议动作留在 core。
- **协议间双向通信都走 `ctx`，协议文件之间零 import**：ext 调 `ctx.core`、core 调
  `ctx.domain.<ext>` 的**查询方法**都是普通同步调用（现役仅一条：core `input.pointer` →
  `ctx.domain.xdgSurface.hitTest`）。`hooks` 是 core → 扩展的**通知/扇出**通道：扩展注册回调，
  由 `host/client.ts` 聚合、`ctx.notify.*` 触发。`onCommit`（buffer 已应用、像素尚未合成）与 `onFrame`（已合成、渲染之前）
  分阶段，**不能合并**；`onTextInput` 是 `input.text` 的仲裁通道（core 不认识 `zwp_*` 事件）。
- **语义事实进域状态，谁拥有谁持有（单写入点）**：窗口记录与它的 `window.*` fan-in 在
  `protocols/ext/windows_store.ts`（`ctx.domain.windows`）、输入设备记录在
  `protocols/core/seat_store.ts`（`ctx.domain.seat`），两者由各自模块的 `domain` initializer `new`；
  光标留 `host/cursor_store.ts`（`ctx.cursor`）——它被 core 与 cursor_shape 两个协议读写，
  且出口 `ClientHost.cursorChanged` 不在 `ctx`。原 `state/` 目录已删除。
  Store 只放数据，协议动作（发 `wl_keyboard.*` / `wl_pointer.*`）在 `protocols/core/wayland.ts`。
- **焦点 per-seat，键盘焦点由桌面驱动**：`SeatRecord` 的 `pointerFocus` / `keyboardFocus` 各 seat
  一份（多光标 = 多 seat；`input.*` 的 `seat` 参数是**选择器不是广播位**，缺省 `"seat0"`）。
  seat 是 registry **一次性广播两把**（`seat0`/`seat1`）的——Firefox/GTK 不认运行中新增的 seat，
  而 `wl_seat.onBind` 按**广播顺序**算 seat 名（客户端只 bind 第二把也得叫 `seat1`）。
  指针焦点由 core 的 `input.pointer` → `updatePointerFocus` 维护，**只发该 seat 的 pointer、不碰键盘**
  （hover 要不要切键盘焦点是桌面政策）。键盘焦点只有一个写入口 `ctx.core.focusKeyboard`：同值去重 →
  `leave`(旧) → `enter`(新) + `modifiers` → 写槽 → `ctx.notify.focus(seat, surface)` 扇出；调用方是
  桌面 `window.focus` / `window.blur`（blur 只清**自己拥有**的焦点，所以全量 focus+blur 循环与顺序无关）。
  xdg 的 `actived` 是另一条独立的轴，规范对 `configure(activated)` 与 `wl_keyboard.enter` 的顺序无要求。
  `wl_surface.destroy` 只**静默清**焦点槽（不能向已销毁对象发事件），text-input 经 `onDestroy` 收敛。
- **模块级副作用要加环境守卫**：`utils/shared_texture.ts` 会注册 electron 接收端并建 unix socket，
  纯 node 环境没有 electron。
