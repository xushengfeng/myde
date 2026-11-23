完整桌面由wayland api、系统api、具体桌面实现（web界面，如窗口布局控制、任务栏等）

通过加载器`src/renderer/view/desktop-loader.ts`初始化dbus、系统api。桌面实现初始化wayland服务器，创建页面

主要运行在electron环境中，为了测试方便，可能要求运行在纯node（无dom）或者纯web（无本地模块）。electron环境和纯node环境需要通过`require`引入模块并通过`as typeof import()`添加类型，但是引用ts文件就使用`import`即可。

由于最终需要运行在electron中，在开发node原生模块时（见下文 `packages`），应考虑electron内存墙，外部资源都需要先克隆

## 桌面实现

纯web环境

[桌面实现文档](desktop/readme.md)

`desktop/official`官方桌面

`desktop/remote`远程特性演示桌面

## wayland api

纯node环境，但是dmabuf需要electron渲染进程环境，总之是无dom的electron渲染进程

`src/wayland/index.ts`是唯一入口（`createServer` + 对外类型），协议实现都在`src/wayland/protocols/`，连接与事件在`src/wayland/host/`，桌面侧的事件/查询/命令契约在`src/wayland/api.ts`

## 系统api

纯node环境

`src/sys_api`定义大部分api，`src/setting`是统一设置

`src/desktop-api.ts`定义系统api类型

大部分api用了dbus，但是dbus的具体创建、连接在外部。class创建时应该传入dbus作为参数

## packages

`packages/` 是 pnpm workspace 内的内部包（`private: true`，不发布到 npm），主项目通过 `"myde-drm": "workspace:*"`、`"myde-input": "workspace:*"` 引用。各包由原独立仓库以 `git subtree` 并入，提交历史保留；需要同步时 `git subtree pull --prefix=packages/<name> <仓库路径> main`。

- `packages/myde-drm/`：DRM dmabuf / wl_shm 像素格式转换（Rust neon 原生模块 + TS），产物 `dist/` 与 `prebuilds/<platform>-<arch>/index.node`
- `packages/myde-input/`：evdev 输入读取（Rust 子进程 + TS），产物 `dist/` 与 `bin/myde-input-reader-<platform>-<arch>`

编译：根目录 `pnpm build` / `pnpm dev` / `pnpm typecheck` 会先跑 `pnpm build:packages`（`pnpm -r --filter "./packages/*"`）。单独开发某个包时进入该目录执行它自己的 `pnpm dev` / `pnpm build` / `pnpm test`。

## myde-wrap

`myde-wrap/` 是 Rust 实现的轻量 Wayland 合成器：没有宿主桌面时用它把 `myde` 直接输出到 DRM，也提供 winit 后端便于在宿主桌面上调试。

- 编译：`npm run build:myde-wrap`（产物 `resources/myde-wrap`，打包时自动带上），或进入 `myde-wrap/` 直接 `cargo build`
- 应用通过 `MYDE_WRAP_SOCKET` 连接 Unix Socket 与它交互；消息格式、屏幕语义和开发说明见 [`myde-wrap/AGENTS.md`](myde-wrap/AGENTS.md)

## 测试工具

测试分两类，入口不同：

- 单窗口 / Wayland 协议 / 系统 API：`testRunnerApp`（`src/test_runner/test_runner.ts`）。加载测试桌面，测试脚本直接操作 `myde.MSysApi.server()` 返回的 `server`，针对单窗口注入输入、查状态、取 `server.windows.preview()` 像素。
- 完整桌面（官方桌面或其他桌面实现）：`startDesktopRunner` / `testRunnerDesktop`（`src/test_runner/desktop_runner.ts`）。加载真实桌面包，用 CDP 操作 DOM、截图、输入、读日志。

完整说明与示例见[测试 runner](src/test_runner/readme.md)。

任何自动化测试都不得直接使用宿主 `DISPLAY`/`WAYLAND_DISPLAY`，也不得在宿主桌面开窗口：

- 必须通过 `testRunnerApp`（内部 `testRunnerRaw`）或 `startDesktopRunner` 启动；它们先起私有 weston headless + Xwayland，宿主显示变量不会传进测试进程。
- 被测应用连测试桌面自己的 Wayland server，不碰 weston，也不碰宿主。
- 没有 weston/Xwayland 时退回 Electron headless ozone；GPU 相关测试可能失败，会警告。
- 仅做临时 UI 检查时，用 `startDesktopRunner` 截图，或其他浏览器的无头模式/无头工具；不要退回宿主显示。
- 原生模式（`runAsDesktop` + `myde-wrap` DRM）不在自动测试范围内。

系统 API 测试不要求统一的 dbus 隔离：可隔离的用 `DBusTestEnv` / 内部 portal 默认跑；真实宿主服务冒烟（`src/sys_api/test/host_services.ts` 的 `describeHost`，涉及 fcitx5、PipeWire、BlueZ、网络、电源、亮度、播放器等）默认跳过，非必要不跑；需要时 `pnpm test:host-services`。全量默认测试用 `pnpm test`。

`test/simple_app`下可以创建rust bin应用，适用于wayland api。使用`test/electron_app`可以创建单脚本控制主进程和渲染进程的特殊应用，适用于wayland api和系统api相关；它们由 `testRunnerApp` 的 `runApp` 启动，不要直接 `node test/electron_app/start.js` 作为测试步骤。

### Mock

`test/mock`提供myde全局变量的mock实现，用于桌面开发者快速开发参考界面，无需真实dbus/系统服务。自动化 UI 检查用 `startDesktopRunner` 或无头浏览器，不要启动可见窗口。

详细用法见[test/mock/readme.md](test/mock/readme.md)

## 常用开发流程

### 新增wayland协议

- 下载协议xml文件到`script/wayland/xml`
- 修改`script/wayland/gen_protocols.ts`的`supportedProtocols`变量并运行（`npx tsx script/wayland/gen_protocols.ts`）
- 新建`src/wayland/protocols/core/`或`src/wayland/protocols/ext/<name>.ts`（唯一必写的文件）
- 在`src/wayland/protocols/index.ts`的模块清单里登记，并更新`src/wayland/readme.md`的协议清单

完整步骤与不变量见[新增协议指南](src/wayland/readme.md)。注意生成物`protocols/protocols.json`、`protocols/wayland-types.ts`不要格式化。

由于最后窗口需要显示，所以有渲染器这个概念，比如`src/wayland/render_tools_el.ts`就把中间的窗口操作转成dom操作，桌面开发可引用，避免二次开发。当然，无头服务器或者其他可自定义渲染器

默认不进行测试，如果开发者要求添加测试，仿照`src/wayland/test/dma-buf.test.ts`，用`testRunnerApp`（无头，不直接开窗口）

### 系统api开发

- `src/sys_api`或者`src/sys_api/xdg_desktop_portal`下创建文件
- 参考`src/sys_api/readme.md`
- 编写特定测试
- 添加到`src/desktop-api.ts`
- 在`src/renderer/view/desktop-loader.ts`添加初始化代码

如果是修改已有api，除了新增，在修改（包括修改bug）或删除都需向开发者确认

新增或修改后也在`desktop/readme.md`编辑添加新描述

### 桌面实现开发

下面流程部分仅用于官方而不是外部自定义桌面开发

所有与系统交互必须通过提供的wayland api和系统api交互，如果不存在，需要考虑进入wayland api开发流程或者系统api开发流程，进入前需要开发者批准，必须展示可能要构建的接口

参考`desktop/readme.md`

如果是开发新桌面，需要在项目根目录的`package.json`里添加相关script

## 通用工具

创建事件发射器时，使用`src/event-emitter/event-emitter.ts`提供的`EventEmitter`类。支持类型安全的`on`/`off`/`once`/`emit`、`request`/`respond`请求响应模式、`waitFor` Promise等待，以及`AbortSignal`清理。

`request`/`respond`在交互上很方便，`waitFor`方便写测试，但是要注意双向事件会出现死锁问题。

## 其他

不用阅读`docs`文件夹

项目由vite、vitest、pnpm构建，biome格式化
