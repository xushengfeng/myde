# myde-wrap

一个轻量级的 Rust Wayland 桌面合成器，专注于渲染单个应用，并通过 Unix Socket 提供控制裁取缩放平移并指定到屏幕的能力。

主要用于[myde](https://github.com/xushengfeng/myde)显示

## 功能特性

单应用渲染: 专注于渲染一个应用，类似cage的kiosk模式

通过 Unix Socket 实现显示控制，支持以下功能：

- 控制渲染窗口大小（应用全屏）
- 截取渲染画面中的多个可倾斜的矩形区域
- 矩形区域分别渲染到多个屏幕
- 获取屏幕参数信息
- 开启/关闭输入功能
- 开启/关闭屏幕电源（DPMS，仅 DRM 后端）
- 页面存活检测：控制页面未完成启动或无响应时自动退出，释放屏幕

提供了更灵活的kiosk模式，应用可自由操纵屏幕渲染，在一些如多屏、旋转动画起到帮助

还有个winit窗口后端，可以显示在如kde上作为一个窗口，方便调试wayland相关

## 技术架构

- **smithay** (v0.7): Wayland compositor 框架
- **wayland-server** (v0.31): Wayland 协议实现
- **drm** (v0.14): DRM 设备控制
- **gbm** (v0.18): GBM 缓冲区管理
- **wayland-protocols** (v0.32): Wayland 协议扩展

## 快速开始

### 编译

```bash
cargo build --release
```

在 x86_64 和 aarch64 Linux 上都可以直接本机编译，产物分别用于对应架构。

### 运行

```bash
# 简写（默认 drm 后端）
cargo run -- /usr/bin/weston-terminal
```

未指定程序时，会在当前目录和 `myde-wrap` 所在目录查找 `myde`。裸命令名（不含 `/`）同样
先在这两个目录查找，找不到再按 PATH 查找；因此解包目录里直接 `./myde-wrap myde` 即可。

### 命令行参数

```
myde-wrap [OPTIONS] <COMMAND> [ARGS]...

OPTIONS:
    -b, --backend <BACKEND>    渲染后端: winit 或 drm [默认: drm]
    -h, --help                 打印帮助信息
    -V, --version              打印版本信息

ARGS:
    <COMMAND>    要渲染的程序命令
    [ARGS]...    程序参数
```

## 屏幕操作 Socket 协议

见 agents.md

应用通过环境变量`MYDE_WRAP_SOCKET`获取 Socket 路径，格式为`[4字节大端长度][JSON消息体]`。具体见 agents.md 的api定义

## 依赖

- `smithay`: Wayland 合成器框架
- `tokio`: 异步运行时
- `serde` / `serde_json`: JSON 序列化
- `tracing`: 日志追踪
- `drm`: DRM 设备控制
- `gbm`: GBM 缓冲区管理

## 许可证

Apache License 2.0
