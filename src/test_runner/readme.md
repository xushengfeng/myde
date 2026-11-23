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
- 接口：`evaluate`、`waitFor`、`screenshot`、`move`/`click`/`mouse`、`key`/`text`、`logs`、`output`、`send`。
- 截图用 `Page.captureScreenshot({ fromSurface: false })`；隐藏窗口用 `fromSurface: true` 会等不到合成帧。
- 输入走 CDP 的 `Input.*`，对应窗口模式的 DOM 输入路径；原生 evdev 路径不在自动化范围。
- `logs()` 收 renderer 的 console、异常和 CDP browser log；`output()` 是 electron-vite/Electron 原始输出，启动失败时用于排查。

示例见 `desktop_runner.test.ts` 和 `desktop/official/test/desktop.e2e.test.ts`。

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

# 只跑 Wayland / 桌面 runner
npx vitest run src/wayland
npx vitest run src/test_runner/desktop_runner.test.ts
npx vitest run desktop/official/test/desktop.e2e.test.ts

# 额外跑真实宿主服务冒烟（fcitx5、PipeWire、BlueZ、网络、电源、亮度、播放器）
pnpm test:host-services
```

`vitest.config.ts` 里 `fileParallelism: false` 是因为 `electron-vite preview` 共用 `out/`；每个 runner 的 weston/Xwayland 是独立的，未来可以放开并行。
