# myde-input

高性能 Linux 输入设备读取库，采用 Rust + TypeScript 混合架构。

通过 Rust 直接访问 Linux evdev 接口，以 MessagePack 二进制协议与 Node.js 通信，提供事件驱动的输入设备管理 API。

## 特性

- **高性能**：Rust 侧使用 epoll 非阻塞 I/O 直接读取 `/dev/input/event*`，零拷贝事件传递
- **设备扫描**：自动扫描并识别所有输入设备，支持键盘、鼠标、触摸板、触屏、数位板、手柄
- **多点触控**：完整支持 Multi-touch Protocol A 和 B，包含位置、压力、方向、跟踪 ID、槽位等详细触控轴信息
- **键码映射**：内置完整的 Linux evdev 键码常量表，支持 Web 键码 <-> Linux 键码双向映射
- **类型安全**：TypeScript strict 模式，完整的类型定义与泛型 Result 错误处理（无 throw）
- **事件驱动**：基于 EventEmitter 的 API，支持 `keyDown`/`keyUp`/`relative`/`absolute`/`sync` 等语义事件
- **设备能力检测**：通过 ioctl 读取设备的事件类型、按键、相对轴、绝对轴等能力信息
- **错误容错**：Rust 风格的 `Result<T, E>` 类型，设备操作失败不会抛出异常，错误信息结构化返回
- **跨平台构建**：CI/CD 支持 x86_64 和 aarch64 Linux 交叉编译

## 安装

```bash
npm install myde-input
# 或
pnpm add myde-input
```

> **前置条件**：需要 Linux 系统。设备打开方式可选：
>
> - `auto`（默认）：先直接打开 `/dev/input/event*`（`input` 组 / udev uaccess / root 可用时最省事），失败时回退 systemd-logind。
> - `logind`：通过 systemd-logind `TakeDevice` 取 fd，不需要设备文件权限。logind 要求调用者是会话控制器，所以会调用 `TakeControl`：这会把当前 VT 切到图形模式并**关闭该 VT 的键盘**。因此从 TTY 启动、又用 Ctrl+C 停程序的用法，请用 `direct`/`auto`；`logind` 模式退出需要从其它 VT 结束进程（或由桌面自行退出）。
> - `direct`：只直接打开，需要 `input` 组、udev uaccess 规则或 root。
>
> ```typescript
> const manager = new InputManager({ deviceAccess: "auto" });
> ```
>
> VT 切换时 logind 会让读取暂停，切回后用新 fd 自动继续。

## 快速开始

```typescript
import { InputManager } from "myde-input";

const manager = new InputManager();

// 初始化（启动 Rust 子进程）
const initResult = await manager.init();
if (!initResult.ok) {
  console.error("初始化失败:", initResult.error);
  process.exit(1);
}

// 监听设备添加
manager.on("deviceAdded", (device) => {
  console.log(`发现设备: ${device.name} (${device.type}) → ${device.path}`);

  const dev = manager.getDevice(device.path);
  if (!dev) return;

  // 开始读取事件
  const readResult = dev.startReading();
  if (!readResult.ok) {
    console.error("开始读取失败:", readResult.error);
    return;
  }

  // 监听键盘事件
  dev.on("keyDown", (code) => {
    console.log(`按键按下: ${code}`);
  });

  dev.on("keyUp", (code) => {
    console.log(`按键释放: ${code}`);
  });

  // 监听鼠标相对移动
  dev.on("relative", (code, value) => {
    console.log(`相对移动: axis=${code}, value=${value}`);
  });

  // 监听原始事件
  dev.on("raw", (event) => {
    console.log(`原始事件: type=${event.type}, code=${event.code}, value=${event.value}`);
  });
});

// 监听设备移除
manager.on("deviceRemoved", (path) => {
  console.log(`设备移除: ${path}`);
});

// 监听错误
manager.on("error", (error) => {
  console.error(`错误 [${error.code}]: ${error.message}`);
});
```

## API

### `InputManager`

设备管理器，负责 Rust 子进程生命周期和设备发现。

```typescript
const manager = new InputManager();

await manager.init(): Result<void>       // 初始化，启动子进程
manager.getDevices(): DeviceInfo[]       // 获取所有已发现设备
manager.getDevice(path): InputDevice     // 按路径获取单个设备
manager.isInitialized(): boolean         // 检查是否已初始化
await manager.destroy(): void            // 销毁管理器，停止子进程

// 事件
manager.on("deviceAdded", (info) => { ... })
manager.on("deviceRemoved", (path) => { ... })
manager.on("error", (error) => { ... })
```

### `InputDevice`

单个输入设备的封装，提供事件读取和语义事件分发。

```typescript
const dev = manager.getDevice("/dev/input/event0");

dev.info: DeviceInfo                     // 设备信息
dev.startReading(): Result<void>         // 开始读取事件
dev.stopReading(): Result<void>          // 停止读取事件
dev.isReading(): boolean                 // 是否正在读取
dev.destroy(): void                      // 销毁设备

// 语义事件
dev.on("key", (code, value, timestamp) => { ... })  // 任意键事件 (value: 0=释放, 1=按下, 2=重复)
dev.on("keyDown", (code) => { ... })                 // 键按下
dev.on("keyUp", (code) => { ... })                   // 键释放
dev.on("keyRepeat", (code) => { ... })               // 键重复
dev.on("relative", (code, value) => { ... })         // 相对轴 (鼠标移动)
dev.on("absolute", (code, value) => { ... })         // 绝对轴 (触屏/摇杆)
dev.on("sync", () => { ... })                        // 同步事件
dev.on("raw", (event) => { ... })                    // 原始 InputEvent
dev.on("error", (error) => { ... })                  // 错误
```

### `Result<T, E>`

Rust 风格的错误处理类型，避免使用 throw/try-catch。

```typescript
import { ok, okVoid, err, ErrorCode } from "myde-input";

const result: Result<number> = ok(42);
if (result.ok) {
  console.log(result.value);  // 42
} else {
  console.error(result.error.code, result.error.message);
}
```

### 键码常量

```typescript
import { KEY_A, KEY_ENTER, BTN_LEFT, ABS_MT_POSITION_X } from "myde-input/dist/codes.js";
```

## 架构

```
┌─────────────────────────────────────────────────────┐
│  Node.js 进程                                        │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ InputManager│──│  RustBridge  │──│  msgpackr  │  │
│  │ InputDevice │  │ (subprocess) │  │ (encode/   │  │
│  │ EventEmitter│  │              │  │  decode)   │  │
│  └─────────────┘  └──────┬───────┘  └────────────┘  │
│                          │ stdin/stdout              │
│                    ┌─────┴──────┐                    │
│                    │ 4-byte len │                    │
│                    │ + msgpack  │                    │
│                    └────────────┘                    │
└──────────────────────────┬──────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────┐
│  Rust 子进程 (myde-input-reader)                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ scanner  │  │ reader   │  │ device_info       │  │
│  │ /proc/   │  │ epoll    │  │ ioctl EVIOCGBIT   │  │
│  │ bus/     │  │ 非阻塞   │  │ EVIOCGABS         │  │
│  │ input/   │  │ 多设备   │  │ 能力检测          │  │
│  │ devices  │  │ 事件循环 │  │                   │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│                          │                           │
│                    /dev/input/event*                 │
└─────────────────────────────────────────────────────┘
```

## CLI 工具

项目附带一个类似 `evtest` 的命令行工具，用于交互式查看输入设备和实时事件。

```bash
# 列出所有输入设备
npx tsx cli.ts list

# 列出所有设备（含未知类型）
npx tsx cli.ts list --all

# 查看设备详细能力
npx tsx cli.ts info /dev/input/event0

# 实时监听事件（交互选择设备）
npx tsx cli.ts monitor

# 监听指定设备
npx tsx cli.ts monitor /dev/input/event0

# 只看键盘事件
npx tsx cli.ts monitor --event=key

# 只看鼠标移动和按键
npx tsx cli.ts monitor /dev/input/event3 --event=key,rel
```

> **注意**：`direct` 模式需要访问 `/dev/input/event*` 的权限（`input` 组或 uaccess 规则，或以 root 运行）；`logind` 模式则要求进程属于一个前台登录会话。程序先用 logind 的 `GetSessionByPID` 按进程所在 cgroup 找会话，找不到时退回环境变量 `XDG_SESSION_ID`（例如 Electron/Chromium 会把主进程搬进 `app-*.scope`，此时 cgroup 不在 `session-*.scope` 下）。

## 开发

详见 [AGENTS.md](./AGENTS.md)。

## 许可证

[AGPL-3.0-only](LICENSE)
