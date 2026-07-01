# myde

[English](./README.en.md)

基于 Electron 构建的 Linux Wayland 桌面环境（合成器）。它通过 JavaScript 解析 Wayland 协议，将原生应用（如 Firefox）渲染至 Canvas，而非依赖 Web 定制软件。

> **当前状态**：开发中，仅支持部分应用。

## 项目愿景

myde 再次证明了 Web 技术栈在桌面环境领域的潜力（此前已有 [term.everything](https://github.com/mmulet/term.everything/tree/typescript) 和 [greenfield](https://github.com/udevbe/greenfield) 等探索性项目）。

前端开发者在美术设计、UX 交互和“造轮子”方面的热情，天然适合桌面窗口管理器的开发。事实上，KWin 和 GNOME 已或多或少提供了前端可编程接口。

myde 更进一步，它负责将应用渲染到 Canvas 并处理部分输入事件，合成与绘制交由 Chrome 完成。其余一切，包括窗口管理、装饰、桌面组件、任务栏等，均可由开发者自由定制。这意味着你可以设计前卫的交互界面，复刻 Windows/macOS 风格，甚至适配手机或平板布局。开发者无需处理底层显示协议，无需手动管理内存，在相比 C/Rust 更便利的开发环境下，希望孵化出更易用、功能更强的 Linux 桌面。

项目采用模块化插件架构，用户可切换已下载的桌面实现。

## 当前进展

目前仅少量示例应用可正常显示，自定义桌面 API 尚不稳定，请将其视为 **技术演示**。项目处于 **Alpha** 阶段，待其成为我的日常桌面环境时，将转入 Beta 阶段。更多局限请参考[局限](#局限)章节。

![演示截图](https://s1.img-e.com/20260630/6a43d2956b2a3.png)

> 背景是kde，浅蓝色的是myde，运行在kde宿主桌面上

## 运行指南

### 环境要求

- Linux 系统，已运行 X11 或 Wayland 会话
- 需安装 `xwayland-satellite`

### 安装依赖

（`pnpm` 可替换为 `npm`，依个人偏好）

```shell
pnpm i
```

### 启动桌面

- 启动默认桌面：
    ```shell
    pnpm run desktop:offical
    ```
- 启动简易 Windows 风格演示桌面：
    ```shell
    pnpm run desktop:example
    ```

执行后将会弹出窗口，你可以在其中启动系统已安装的应用程序。

## 开发指南

开发细节请参阅 [AGENTS.md](./AGENTS.md)，该文档面向开发者和 LLM 工具。

### 自定义桌面开发

- 默认桌面实现位于 `desktop/` 文件夹，可供参考。
- 提供窗口管理 API、统一设置/互联 API，以及众多系统 API（如 MPRIS 媒体控制、通知、电量、蓝牙、Wi-Fi 等）。详细进度和支持列表请参考[wayland协议支持列表](./src/wayland/readme.md)和[桌面 API 文档](./desktop/readme.md)。

> **许可说明**：尽管本项目采用 AGPL-3 协议，但自定义桌面插件理论上不受传染。出于用户安全和社区繁荣考虑，建议开源以方便社区审查；同时，若保留个人版权，可采用稍严格的许可证。

## 局限

### 当前已知局限

- 由于 Electron 无法直接输出到原生显示，目前仅能以窗口形式展示桌面（类似通过窗口启动 Weston）。若要作为真实桌面，需要一个桌面宿主，然后启动 myde 的全屏窗口。
- 可正常显示的示例应用：`weston-*`相关实例应用，以及 `gtk4-demos`、`google-chrome`、`firefox` 等应用。但依赖 GPU 渲染的部分应用（如 Blender）无法正常显示。
- 许多协议虽支持，但具体实现仍有偏差，细节待完善。

### 长期性能隐患

- JavaScript 可能耗费多余资源

## 实现原理

myde 基于 Node.js 与 Electron 框架，利用 Node.js 原生模块与系统底层组件（如 Wayland 客户端、dbus）通过 Unix Socket 进行进程间通信。所有 Wayland 协议消息经由 JavaScript 解析和处理，读取或者映射图形资源，最终通过 Electron 的渲染进程（即 Web 页面）中的 Canvas 完成图形绘制。

### 使用了原生编程的地方

- nodejs相关库如fs
- electron相关api，如`sharedTexture`
- Unix socket库（nodejs自带的socket库不支持fd传输）
- pam 模块
