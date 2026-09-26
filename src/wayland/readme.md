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
    - wl_seat 还没有 touch
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

v1 和 v3 是竞争协议，单客户端内仲裁：按协议（manager）一侧计，后激活者胜出（zwp_text_input_v1.activate / zwp_text_input_v3.enable 抢占），文本只发给持有对象，v3 的 enter/leave 跟随键盘焦点。

## 对外 API（桌面侧）

桌面只从 `src/wayland/index.ts` 拿东西：`createServer({ render, socketDir })`、`Client` 接口、
以及 `api.ts` 里的类型（`ServerEvents` / `ServerNotifyMap` / `ServerRequests` / `WindowInfo` /
`WinHandle` / `CursorState` …）。

- **事件**：`server.on("window.created" | "window.changed" | "window.closed" | "window.startMove" |
  "cursor.changed" | "clipboard.copy" | "clipboard.pasteRequested" | "client.opened" | "client.closed", …)`
- **查询**：`server.windows.list() / get() / preview()`、`server.cursor.get(clientId)`、`await server.request(…)`
- **命令**：`server.notify("window.focus" | … | "input.pointer" | …, handle, …)`
- **应答**：`server.respond("surfaceBounds.request", () => ({ width, height }))`

桌面不接触 Wayland 对象 id：所有命令按全局 `WinHandle` 下发，由 `host/server.ts` 反查
`(client, winId)`。`server.clients` 只留给连接生命周期与调试。用法见 `desktop/readme.md` 的「Wayland 服务器」。

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
    hooks: { // 可选：core → 本模块的反向通知
        onCommit: (surfaceId, sizeChanged, ctx) => {},
        onFrame: (surfaceId, canvas, pending, ctx) => canvas,
        onDestroy: (surfaceId, ctx) => {},
        onFocus: (surfaceId, ctx) => {},
    },
});
```

### 3. 登记

1. `protocols/index.ts` 的模块清单数组加一行
2. 本文件顶部的「支持的协议」更新
3. （可选）需要新 core 能力时才动 `module.ts` 的 `CoreApi` —— 须先与开发者确认
4. 补一个 fake-ctx 单测（仿 `protocols/core/region.test.ts`、`protocols/modules.test.ts`）

### 4. 不变量

- **协议模块之间零 `import`**：只能 import `module.ts`、`utils/*`、`protocols/wayland-types`（生成物）。
  `assertModuleConflicts()` 在 `WaylandServer` 构造时校验请求键冲突。
- **`ctx` 是 handler 唯一的依赖来源**：handler 不碰 `this`（`WaylandClient`）。新增能力先进
  `module.ts` 的契约，再在 `host/client.ts` 的 `buildCtx()` 里接实现。
- **反向通信只有钩子**：扩展不被 core import，只能声明 `hooks`，由 `host/client.ts` 聚合、
  `ctx.notify.*` 触发。`onCommit`（buffer 已应用、像素尚未合成）与 `onFrame`（已合成、渲染之前）
  分阶段，**不能合并**。
- **语义事实进 Store**：跨协议 / 要给桌面看的状态放 `state/`（`windows_store` / `cursor_store` /
  `seat_store`），单写入点；桌面侧的 `window.*` / `cursor.*` 事件就是从这里 fan-in 出去的。
- **模块级副作用要加环境守卫**：`utils/shared_texture.ts` 会注册 electron 接收端并建 unix socket，
  纯 node 环境没有 electron。
