# 测试 runner

自动化测试分两类，入口不同，不要混用。

| 测试类型 | 入口 | 控制接口 | 适合 |
| --- | --- | --- | --- |
| 单窗口 / 协议 / 系统 API | `testRunnerApp`（`test_runner.ts`） | `server.notify`、`server.windows.preview`、`serverX.runApp` | Wayland 协议、窗口生命周期、`MSysApi` |
| 完整桌面 | `startDesktopRunner` / `testRunnerDesktop`（`desktop_runner.ts`） | CDP（DOM、截图、输入、日志） | 官方桌面/其他桌面实现的 UI、面板、窗口管理 |

`testRunnerApp` 加载的是一个**测试桌面**：它自己调用 `myde.MSysApi.server()` 创建真实的 MyDE Wayland server，但没有官方桌面的面板和窗口管理，测试脚本直接操作 `server`。完整桌面测试加载真实桌面包，只能通过 CDP 操作它的页面。

## 无头要求

任何自动化测试都不允许直接使用宿主的 `DISPLAY`/`WAYLAND_DISPLAY`，也不允许在宿主桌面上开窗口。

- `testRunnerRaw` / `startDesktopRunner` 先启动私有的 **weston headless + Xwayland**，把 `DISPLAY=:N` 只给 Electron 测试宿主；宿主的显示变量在子进程环境里被删除。
- weston 没有输出窗口，Electron 窗口在 weston 里且处于隐藏状态；宿主合成器看不到它。
- 被测应用仍然连测试桌面自己的 Wayland server（`runApp` 设置的 `WAYLAND_DISPLAY`），不碰 weston，也不碰宿主。
- 没有 `weston`/`Xwayland` 时退回 Electron `--ozone-platform=headless`（固定屏幕尺寸）。这个模式没有 GPU，`dma-buf`/shared texture 相关测试可能失败，runner 会打一次警告。
- 仅做临时 UI 检查时，用 `startDesktopRunner` 截图，或用其他浏览器的无头模式/无头工具；不要退回宿主显示。
- 原生模式（`runAsDesktop` + `myde-wrap` DRM）不在自动测试范围内，窗口模式是当前自动化边界。

显示实现见 `headless_display.ts`，环境隔离见 `test_env.ts`。

## testRunnerApp

```ts
import { testRunnerApp } from "../../test_runner/test_runner";

const { waitExit } = testRunnerApp("test/simple_app/target/debug/dmabuf_one_frame", ({ server }) => {
    server.on("window.created", (info) => {
        server.notify("window.focus", info.handle);
        const canvas = server.windows.preview(info.handle);
        // 断言 canvas 像素 / 发输入 / 读 window.changed
    });
});
await waitExit();
```

- `server`：Wayland server 的窗口/光标/剪贴板事件、查询、命令。
- `serverX.runApp`：启动测试客户端，自动带 `WAYLAND_DISPLAY=server.socketName`。
- `render`：renderer 的 `renderToolsHtmlEl`，可取窗口元素。
- 测试结果用 `runner.sendData()` 回传；应用 stdout/stderr 以 `applog` 形式回传，用 `applog.ts` 的 `collectAppLogs()` 解析。

单窗口测试不要自己启动 Electron/浏览器；用 `testRunnerApp`。

## startDesktopRunner

```ts
import { startDesktopRunner } from "../../src/test_runner/desktop_runner";

const desktop = await startDesktopRunner({ desktop: "desktop/official" });
try {
    await desktop.waitFor("document.body.children.length > 2");
    await desktop.click(40, 40);
    await desktop.text("hello");
    const png = await desktop.screenshot();
    const logs = desktop.logs();
} finally {
    await desktop.close();
}
```

或使用 `testRunnerDesktop(fn, opts)`，失败也会关闭。

- `desktop`：相对项目根的桌面目录，或绝对路径；`:test` 是内置测试桌面。
- 桌面需要先构建：`desktop/official` 读 `dist/index.js`，先 `pnpm build:desktop`；其他桌面按各自 README 构建。
- `showWindow`：在私有 headless 显示里真正显示窗口（默认隐藏）。逐帧像素/流畅度测试需要持续合成帧时必须打开；窗口不会出现在宿主桌面上。
- 接口：`evaluate`、`waitFor`、`screenshot`（可传 `clip`/`format`）、`move`/`click`/`mouse`、`key`/`text`、`logs`、`output`、`send`、`on`。
- 截图用 `Page.captureScreenshot({ fromSurface: false })`；隐藏窗口用 `fromSurface: true` 会等不到合成帧。
- 输入走 CDP 的 `Input.*`，对应窗口模式的 DOM 输入路径；原生 evdev 路径不在自动化范围。`key(key, { modifiers })` 会先按下 Meta/Alt 等修饰键再发主键，桌面按真实按键维护修饰状态。
- `logs()` 收 renderer 的 console、异常和 CDP browser log；`output()` 是 electron-vite/Electron 原始输出，启动失败时用于排查。

示例见 `desktop_runner.test.ts` 和 `desktop/official/test/desktop.e2e.test.ts`。

## 流畅度测试（逐帧像素）

`src/test_runner/smoothness.ts` 连续取帧、比对相邻帧像素，判断动画“看起来是否流畅”：

```ts
const desktop = await startDesktopRunner({ desktop: "desktop/official", showWindow: true });
await desktop.waitFor("document.documentElement.dataset.desktopReady === '1'", 60000);

const recorder = await FrameRecorder.start(desktop, {
    durationMs: 1000,
    // 只分析顶部区域，减少无关变化的影响
    region: { x: 0, y: 0, width: 4000, height: 400 },
});
await sleep(120);
const markAt = recorder.mark("open");
await desktop.key("Space", { modifiers: 1 });
const report = await recorder.stop();

const stats = motionStats(report, { fromMs: markAt - 20 });
console.log(formatReport(report));
```

- 用 `Page.startScreencast` 推合成帧，通常 40–60fps。必须有真实合成，所以桌面要用 `showWindow: true` 启动；隐藏窗口不产生帧，截屏会长时间阻塞。
- 帧时间取到达测试进程的时间：合成器给的 `metadata.timestamp` 同一次捕获/呈现偶尔会倒退十几毫秒，会让相邻帧间隔出现负数。
- `maxSide` 控制推流分辨率，默认 800；只看运动量、不看小元素时降到 480 能明显减少分析时间。
- `flow: false` 跳过逐帧位移估计（`estimateFlow` 是分析里最贵的一步）；只判断运动量/停顿时关掉。需要 `flow`/`flowX` 判断切屏、拖动方向时保持默认 `true`。
- `src/test_runner/smoothness.test.ts` 有一组对照用例：平滑动画的 `peakShare` 必须远低于 0.6，整屏一帧跳变的 `peakShare` 必须高于 0.6。第二个用例用 `flow:false、maxSide:480` 跑，确认窗口动画测试的省时配置仍然能识别跳变。
- 只关心到某次变化为止时，`durationMs` 可以给到那一刻之后，`stop()` 提前调用即可；不要为了统一时长把大段静止帧也录下来。
- `peakShare`：单帧变化占总运动量的比例。跳变/瞬移接近 1，分散到多帧的动画通常低于 0.2。
- `spanMs`：累计到 95% 运动量的时间跨度。easeOut 动画的大部分变化在前半段，跨度会小于动画时长。
- `maxStallMs`：运动过程中相邻变化帧的最大间隔，掉帧或停顿会变大。
- 响应延迟：`recorder.mark()` 记输入时刻，`responseLatencies(report)` 给出每个标记到第一帧变化的延迟；`flow` 是逐帧位移估计，连续拖动应持续有变化，打断后方向应立即翻转。
- 官方桌面的用例在 `desktop/official/test/smoothness.test.ts`：`pnpm test:smoothness`（需要先 `pnpm build:desktop`）。
- 三指手势走 evdev 触摸板，window 模式的 CDP 输入到不了 `multiStart`；用 `__mydeTest.touchpadFeed` 注入假触摸板原始事件（见下），连续输入也可以用内部窗口标题栏拖拽测“跟手”和“反向打断”。

官方桌面在同步初始化（快捷键、输入聚合层、工具栏注册完毕）后设置 `document.documentElement.dataset.desktopReady = "1"`，测试要等这个标记再发输入，否则第一次按键可能落在初始化完成之前。

### 窗口打开动画

`desktop/official/test/window_open.test.ts` 用真实的 Rust Wayland 窗口测启动动画。窗口应用在 `test/simple_app/src/bin/window_open.rs`：

- 环境变量控制时刻：`CREATE_AT`（创建 toplevel）、`BUFFER_AT`（提交首帧）、`FULLSCREEN_AT`（切全屏），都是 epoch 毫秒，`never` 表示不做。
- `WIDTH`/`HEIGHT` + `SIZE_MODE=fixed` 用来提交比桌面默认 800×600 更大的 buffer；客户端不发送 `set_window_geometry`、min/max 等 xdg 尺寸设置。
- 每个事件写到 `EVENTS_FILE`，测试按 epoch 时间和帧时间对齐。
- 桌面在 `testMode` 下提供 `__mydeTest.launchApp(req)` / `__mydeTest.closeWindows()`，测试直接走真实的 `launchApp`，不用依赖启动器搜索或临时 `.desktop`。

启动面板只是占位槽：第一个窗口一创建就替换面板，不等首帧；面板落到屏里仍然没有窗口时以透明+模糊淡入露出关闭按钮，可以提前取消。进程在面板还小时就退出不会提前露出按钮，避免压住启动图标。

用例覆盖：立即、回弹结束前、嵌入点、淡入结束后、首帧很晚，永不建窗（空面板可以提前关闭），建窗但永不首帧，窗口晚于面板落地才创建，1200×900 / 1600×1000 / 2560×1440 大 buffer，以及首帧前/后/飞行中/动画结束后的全屏。每个用例同时断言虚拟屏只增加一张、窗口只出现一个、尺寸来自客户端 buffer、启动动画有足够中间帧且没有长时间停顿；首帧内容由客户端整块画出，不算桌面动画。

为了控制时长，每个用例只录到“最后一次可见变化 + 余量”就 `stop()`（只有检查静止期的用例才录满 `wait`），不做无意义的静止帧采样；`flow: false` 跳过逐帧位移估计，推流用 `maxSide: 480`。

运行：先 `pnpm build:test-apps`（构建 Rust 窗口）和 `pnpm build:desktop`，再 `pnpm test:window-open`。

### 手势输入与状态快照

官方桌面在 `testMode` 下还提供：

- `__mydeTest.state()`：只读快照，含 `stage`、`screens`（顺序/窗口/used/current/visual）、`current`、`focus`、`overview`、`overviewProgress`、手势的 `level`/`horizontalMode`、启动器 binding 和窗口的屏归属/appid。断言窗口管理结果时用它，不要从 transform 或截图像素反推当前屏。
- `__mydeTest.setApps(apps)`：替换桌面看到的应用列表（启动台、搜索、开始菜单、窗口图标反查）。`apps` 是 `.desktop` 条目的形状，`undefined` 恢复真实的 `MSysApi` 扫描；启动台立即重建，开始菜单在首次展开时读取。把 `exec` 指向 `test/simple_app` 里的 mock 客户端，就能让假应用走真实的启动动画、窗口创建和 appid 认领（示例见 `desktop/official/test/mock_apps.test.ts`）。
- `__mydeTest.touchpadFeed(events)`：把原始 evdev 事件送进真实的 `useEvdevDevice → TouchpadInput → ViewData` 链路。事件是 `{ type: "abs"|"rel"|"key", code, value }` 或 `{ type: "sync" }`；第一次调用时挂一台纯 TS 假触摸板（MT-B、4000 单位量程），之后按帧喂入即可。
- `__mydeTest.touchpadDetach()`：拆掉假触摸板。

`desktop/official/test/window_gesture.test.ts` 用三指上滑/下滑/横滑覆盖 `multiStart`/`multiMove`/`multiEnd` 到预览、搜索和切屏的接线。手势要按帧喂（帧之间留十几毫秒），同一帧只放一次 `sync`。

## 截屏 / 输入 / 日志

| 层 | 截屏 | 输入 | 日志 |
| --- | --- | --- | --- |
| 应用 surface | `server.windows.preview(handle)`（OffscreenCanvas） | `server.notify("input.*", handle, ...)` | `runApp` applog |
| 完整桌面 | `desktop.screenshot()`（页面） | `desktop.click/mouse/key/text`（DOM） | `desktop.logs()` / `output()` |
| 桌面自身 | `MSysApi.screenshot.capture()`（桌面页面，含窗口/面板） | 窗口模式 DOM，原生模式 evdev | 主进程 `myde.log` |

`webContents.capturePage()` 对隐藏的测试宿主窗口可用；CDP 截图对隐藏窗口要 `fromSurface: false`。

## DBus

- `testRunnerRaw` 不强制私有 session bus，沿用现有环境。`window_close`、`popup` 等测试会 spawn `konsole`，Qt/KDE 客户端需要真实会话总线。
- `startDesktopRunner` 默认启动私有 session bus，避免官方桌面把通知/托盘 watcher 注册到宿主会话。测试自己用 `DBusTestEnv` 时，通过 `env: { DBUS_SESSION_BUS_ADDRESS }` 覆盖。
- `MYDE_INTERNAL_PORTAL=1` 的测试实例自己拉起内部 dbus/portal，不依赖继承值。
- 从宿主继承的 `MYDE_INTERNAL_BUS_ADDRESS` 会被丢弃；测试在运行时设置的总线保留。
- `MYDE_WRAP_*`、`runAsDesktop`、`DISPLAY`、`WAYLAND_DISPLAY` 不会传给测试子进程。

## 运行

```bash
# 全量默认：可隔离的系统 API + Wayland + 桌面；真实宿主服务冒烟跳过
pnpm test

# 只跑 Wayland / 桌面 runner（串行）
npx vitest run src/wayland
npx vitest run src/test_runner/desktop_runner.test.ts
npx vitest run desktop/official/test/desktop.e2e.test.ts
# 桌面 UI/e2e 一组：构建一次 out/ 后并行跑，比逐个文件串行快
pnpm test:desktop
# 官方桌面逐帧流畅度（需要先 pnpm build:desktop）
pnpm test:smoothness
# 官方桌面窗口打开动画（还需要 pnpm build:test-apps）
pnpm test:window-open

# 额外跑真实宿主服务冒烟（fcitx5、PipeWire、BlueZ、网络、电源、亮度、播放器）
pnpm test:host-services
```

`pnpm test` 先由 `src/test_runner/global_setup.ts` 构建一次 `out/`，各 runner 用 `--skipBuild` 只启动 Electron，省掉每个测试文件重复构建；测试文件仍然串行，因为 dma-buf GPU 内存、逐帧流畅度这类用例会被同时运行的 Electron 实例干扰。

`pnpm test:desktop` 只跑桌面 UI/e2e 用例并加 `--fileParallelism`：这些用例互不测 GPU 内存，并行不会互相影响。逐帧流畅度用例默认配置不变（`flow` 开、`maxSide` 800），并行时实测采样率和中位间隔与单独跑一致；如果要最干净的帧间隔数据，还是单独跑 `pnpm test:smoothness` / `pnpm test:window-open`。单独 `vitest run` 或跑 `test:xxx` 单文件脚本时仍然每个文件自己构建，保证改完源码后用的是最新产物。每个 runner 的 weston/Xwayland、私有总线、userData 都是独立的。
