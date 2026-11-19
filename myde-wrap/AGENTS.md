# AGENTS.md

## 项目概述

myde-wrap 是一个轻量级的 Rust Wayland 桌面合成器，专注于渲染单个应用，并通过 Unix Socket 提供控制裁取缩放平移并指定到屏幕的能力。

通过 Unix Socket 实现显示控制，支持以下功能：

控制渲染窗口大小（应用全屏），可以突破物理尺寸，我们叫**原始画布**。只能有一个应用、一个窗口，这个窗口就是原始画布。窗口大小由应用自行控制；默认显示区域 = 应用内容范围（surface tree 包围盒，含阴影/悬出部分），与应用大小实时同步、永不裁切应用。`SetWindowSize` 可选，仅用于扩展画布坐标空间（rect 截取的坐标系，可突破物理屏幕），不改变默认显示。

截取/上屏语义：一个屏幕一个截取区域 `rect` `(x, y, width, height)` + 旋转角，以 `(x, y)` 为锚点旋转截取、转正后拉伸填充到目标屏幕（隐式缩放 scale = 屏幕尺寸 / 截取长宽，宽高比与屏幕不一致时画面变形，直角保持）。`rect` 缺省（或无配置）表示应用内容范围并拉伸铺满屏幕（默认行为，随应用大小同步、无黑边）。截取到应用绘制范围之外的像素显示为深灰（近黑）。`GetScreens` 返回渲染后端的真实输出参数（DRM 为显示模式分辨率，winit 为调试窗口大小）。

- 截取原始画布中的矩形区域（左上角 + 长宽 + 旋转），每个屏幕一个
- 截取结果拉伸填充到屏幕（隐式缩放）
- 将处理后的矩形分别渲染到多个屏幕
- 获取屏幕参数信息（当前模式 + 该屏幕支持的全部模式）
- 切换屏幕模式（分辨率 + 刷新率，仅 DRM 后端）
- 开启/关闭输入功能
- 开启/关闭屏幕电源（DPMS，仅 DRM 后端）

提供了更灵活的kiosk模式，应用可自由操纵屏幕渲染

还有个winit窗口后端，可以显示在如kde上作为一个窗口，方便调试wayland相关

wayland协议仅窗口显示相关，不需要其他过多协议

实现了 `wp_presentation`（presentation-time）：在 DRM vblank / winit 重绘后回 `presented`，`refresh` 取当前输出模式。Chromium 客户端靠它估算真实刷新率，否则即使 `wl_output.mode` 是 120Hz 也会退回 60Hz。

## 技术架构

### 核心模块

```
src/
├── main.rs          # 程序入口，命令行解析，后端选择
├── protocol.rs      # 协议数据结构定义
├── socket.rs        # Unix Socket 服务端实现
├── compositor.rs    # 消息处理和业务逻辑
├── renderer.rs      # 渲染状态和屏幕管理
├── wayland.rs       # Wayland compositor 核心状态（App 结构体）
├── backend.rs       # 渲染后端 trait 抽象
├── winit.rs         # winit 窗口后端实现
├── drm.rs           # DRM 物理屏幕后端实现
└── handlers/        # Wayland 协议处理器
    ├── mod.rs       # Seat、DataDevice 等处理器
    ├── compositor.rs # CompositorHandler、BufferHandler
    └── xdg_shell.rs # XdgShellHandler
```

## 开发指南

### 编译命令

`--backend` 缺省为 `auto`：先尝试 winit，初始化失败（如无宿主显示环境 `WAYLAND_DISPLAY`/`DISPLAY`）时自动回退 drm；显式指定 `winit` 或 `drm` 时严格按该后端初始化，失败即报错。

```bash
# 运行（winit 后端）
cargo run -- --backend winit <command> [args...]

# 运行（DRM 后端）
sudo cargo run -- --backend drm <command> [args...]

# 检查代码
cargo check

# 格式化
cargo fmt

# 代码检查
cargo clippy
```

## 屏幕操作 Socket 协议

应用通过环境变量`MYDE_WRAP_SOCKET`获取 Socket 路径，格式为`[4字节大端长度][JSON消息体]`。

屏幕电源能力通过`MYDE_WRAP_SCREEN_POWER=1`广告给子进程；只有 DRM 后端会设置，winit 不设置，应用据此跳过`SetScreenPower`。

屏幕模式切换能力通过`MYDE_WRAP_SCREEN_MODE=1`广告；只有 DRM 后端会设置，winit 的窗口尺寸由宿主决定，不支持切换。

调试参数由环境变量交给子进程（Electron 只认命令行开关，环境变量本身不生效）：`MYDE_REMOTE_DEBUGGING_PORT` → `--remote-debugging-port=<port>`、`MYDE_INSPECT_PORT` → `--inspect=<port>`、`MYDE_REMOTE_ALLOW_ORIGINS` → `--remote-allow-origins=<value>`（逗号分隔的 origin 列表或 `*`，在浏览器里打开 devtools 前端时用）。端口为空或非数字、origin 含空白字符时忽略；命令行里已经显式给过同名开关时不重复添加。例如 `MYDE_REMOTE_DEBUGGING_PORT=9222 MYDE_INSPECT_PORT=9229 MYDE_REMOTE_ALLOW_ORIGINS=* ./myde-wrap`，之后用 CDP 客户端连 `http://127.0.0.1:9222`，主进程用 `9229`。

DRM 启动模式取 EDID 首选分辨率下刷新率最高的模式，而不是`modes()[0]`，避免 120Hz 屏幕默认跑 60Hz。

控制连接建立后，wrap 每 3 秒向客户端发 `Ping`。客户端只有在桌面入口脚本执行到末尾（加载器自动调用 `display.markReady()`）后才回 `Pong`，因此 `Pong` 同时证明页面逻辑已经跑完，而不只是 socket 层还活着。连接建立后 30 秒内没有收到首次 `Pong`（桌面初始化抛错或卡住）时，wrap 判定启动失败；就绪后 10 秒内没有收到任何控制消息（`Pong` 或普通请求）时，判定页面卡死。两种情况都会退出并释放屏幕，避免把最后一帧一直留在显示器上。

### 消息格式

```
[4字节大端长度][JSON消息体]
```

- 长度字段: 32位无符号整数，大端序，表示后续 JSON 消息的字节长度
- 消息体: JSON 格式的请求或响应

### 请求消息 (Client -> Server)

#### 设置窗口大小

声明虚拟画布尺寸（不强制修改应用窗口大小，应用窗口由应用自行控制）。仅扩展 rect 截取的画布坐标空间（与应用内容范围取并集，不裁切应用），不改变默认显示（默认始终为应用内容范围拉伸铺满屏幕）。

```json
{
    "type": "SetWindowSize",
    "width": 1920,
    "height": 1080
}
```

#### 截取矩形区域并渲染

一个屏幕一个截取区域：`rect` 以 `(x, y)` 为锚点旋转 `transform.rotation` 度截取，转正后拉伸铺满 `screen_index` 屏幕。`rect` 缺省（null 或不传）表示应用内容范围；`transform` 缺省表示不旋转。

```json
{
    "type": "RenderToScreen",
    "screen_index": 0,
    "rect": { "x": 0, "y": 0, "width": 800, "height": 600 },
    "transform": { "rotation": 15.0 }
}
```

#### 获取屏幕信息

`modes` 是该屏幕支持的全部模式（同一分辨率/刷新率去重）。旧版 wrap 没有该字段。

```json
{
    "type": "GetScreens"
}
```

#### 切换屏幕模式

只接受 `GetScreens` 返回的 `modes` 中存在的模式，`refresh_rate` 单位为 Hz。
只在 DRM 后端生效；winit 返回 `Error`。

```json
{
    "type": "SetScreenMode",
    "screen_index": 0,
    "width": 1920,
    "height": 1080,
    "refresh_rate": 120
}
```

#### 设置输入状态

```json
{
    "type": "SetInputEnabled",
    "enabled": true
}
```

#### 设置屏幕电源

`screen_index` 缺省或为 `null` 表示所有屏幕。只在 DRM 后端生效，winit 后端忽略并返回空数组。

```json
{
    "type": "SetScreenPower",
    "on": false,
    "screen_index": 0
}
```

#### 心跳响应

桌面入口脚本执行到末尾（`display.markReady()`）之后才回应 wrap 的 `Ping`，证明页面逻辑已完整执行且事件循环仍在运行。

```json
{
    "type": "Pong"
}
```

### 响应消息 (Server -> Client)

#### 窗口大小已设置

```json
{
    "type": "WindowSizeSet",
    "width": 1920,
    "height": 1080
}
```

#### 已渲染到屏幕

```json
{
    "type": "RenderedToScreen",
    "screen_index": 0
}
```

#### 屏幕信息

```json
{
    "type": "Screens",
    "screens": [
        {
            "name": "DRM-Crtc(0)",
            "width": 1920,
            "height": 1080,
            "refresh_rate": 120,
            "modes": [
                { "width": 1920, "height": 1080, "refresh_rate": 60 },
                { "width": 1920, "height": 1080, "refresh_rate": 120 }
            ]
        }
    ]
}
```

#### 屏幕模式已切换

字段为实际生效的模式（Hz）。

```json
{
    "type": "ScreenMode",
    "screen_index": 0,
    "width": 1920,
    "height": 1080,
    "refresh_rate": 120
}
```

#### 输入状态

```json
{
    "type": "InputState",
    "enabled": true
}
```

#### 屏幕电源状态

`screens` 为实际被接受的屏幕下标；winit 后端返回空数组。

```json
{
    "type": "ScreenPower",
    "on": false,
    "screens": [0, 1]
}
```

#### 心跳检测

每 3 秒一次；客户端在桌面入口执行到末尾后才回 `Pong`（见上方心跳响应）。

```json
{
    "type": "Ping"
}
```

#### 错误响应

```json
{
    "type": "Error",
    "message": "错误描述"
}
```

## 渲染调度与整屏直出（改动前先看）

- **独立的 frame callback 心跳不能删**。DRM 的 vblank 事件是跟着 page flip 来的，没有新帧就没有 vblank；只靠 `on_vblank` 发 `wl_callback.done` 时，客户端错过一拍就会自锁在 60Hz（实测 62fps，KDE 下同内容 120）。`main.rs` 用输出刷新周期一半的 timer 调 `App::pump_frame_callbacks()`；frame callback 用 0.75 个周期做最小间隔，避免和真实 vblank 重复。不要改回 16ms 兜底或删掉 `pump_frame_callbacks`。
- `wl_callback.done` 和 `wp_presentation.presented` 必须用同一个 `CLOCK_MONOTONIC`（`crate::wayland::monotonic_now()`）。Chromium 会拿两者一起排帧，基准不同会算错 deadline。
- `MyElement` 已透传 `underlying_storage`，identity 路径也会跳过离屏纹理，但**实测 DrmCompositor 仍然选 Swapchain，direct scanout=0**（`MYDE_WRAP_STATS=1` 可看统计）。当前 GPU 合成 `avg_render≈2.2ms`，120Hz 已足够；**不要仅为了 `direct=0` 反复改 `underlying_storage` 或整屏判断**。若以后要继续追，先确认 Electron/Chromium buffer 的 opaque region、alpha 和 primary plane 格式是否满足直出条件，再用统计验证。
- `MYDE_WRAP_STATS=1` 会每 2 秒输出 `vblank/submitted/callbacks/renders/direct/avg_render/offscreen`，用于区分「客户端没提交」「wrap 渲染慢」「vblank 没发」；默认关闭，避免日志刷屏。
- 整屏 identity 直出路径与离屏/CropStretch 路径不要同时启用；`use_offscreen` 在非整屏、旋转或需要缩放时为 true，切换时会丢弃旧离屏纹理。

## TODO

- 屏幕电源权限：当前直接操作 DRM connector，依赖 wrap 以 root 或 `video` 组运行并成为 DRM master；后续接入 libseat/logind 的 `TakeDevice`。DPMS 本身不需要额外权限。
- VT 切换、热插拔、多 GPU 时的 DPMS 状态同步；退出前已强制把所有屏幕 DPMS 打开，避免恢复 fbcon 后黑屏。
- winit 后端不支持屏幕电源（物理屏幕属于宿主桌面），收到 `SetScreenPower` 时忽略。

## 测试

### 手动测试

```bash
# 使用 winit 后端启动合成器
cargo run -- --backend winit /usr/bin/weston-terminal
```

实际物理drm输出需要在虚拟机上测试，故不对agent做要求
