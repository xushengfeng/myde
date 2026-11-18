# AGENTS.md — 项目开发指南

## 项目概述

`myde-input` 是一个高性能 Linux 输入设备读取库（npm 包），采用 **Rust + TypeScript** 混合架构：

- **Rust 二进制** (`myde-input-reader`)：直接通过 Linux evdev 接口读取 `/dev/input/event*` 设备，使用 epoll 实现非阻塞多设备事件监听。
- **TypeScript 库** (`myde-input`)：将 Rust 二进制作为子进程启动，通过 stdin/stdout 以 MessagePack（长度前缀二进制帧）进行通信，对外暴露事件驱动的 Node.js API。

## 项目结构

```
myde-input/
├── src/                          # TypeScript 源码
│   ├── index.ts                  # 入口文件，重新导出所有公共 API
│   ├── types.ts                  # 类型定义（DeviceType, DeviceInfo, InputEvent 等）
│   ├── protocol.ts               # Rust<->TS 消息协议定义与转换函数
│   ├── codes.ts                  # Linux evdev 事件码常量与键码映射表
│   ├── result.ts                 # Result<T, E> 错误处理类型（无 throw）
│   ├── device.ts                 # InputDevice 类（单设备事件发射器）
│   ├── manager.ts                # InputManager 类（设备生命周期管理器）
│   └── subprocess.ts             # RustBridge 子进程管理与 MessagePack I/O
│
├── test/                         # 测试文件
│   ├── codes.test.ts             # 键码常量与映射测试
│   ├── result.test.ts            # Result 类型测试
│   └── protocol.test.ts          # Rust->TS 协议转换测试
│
├── rust/                         # Rust 二进制源码
│   ├── Cargo.toml                # Rust 包清单
│   ├── Cargo.lock                # Rust 依赖锁定
│   └── src/
│       ├── main.rs               # 二进制入口（命令循环 + 事件分发）
│       ├── protocol.rs           # 消息类型定义（RustMessage, TsCommand, DeviceFullInfo 等）
│       ├── scanner.rs            # 设备扫描器（解析 /proc/bus/input/devices + ioctl）
│       ├── reader.rs             # epoll 多设备事件读取器
│       └── device_info.rs        # 设备能力读取（ioctl EVIOCGBIT, EVIOCGABS 等）
│
├── cli.ts                        # CLI 工具（类似 evtest 的设备监控）
├── bin/                          # 编译后的 Rust 二进制（构建时生成）
├── dist/                         # TypeScript 构建输出
├── package.json                  # Node.js 包配置
├── tsconfig.json                 # TypeScript 配置
├── vite.config.ts                # Vite 构建配置（library 模式）
├── vitest.config.ts              # Vitest 测试配置
├── biome.json                    # Biome 代码格式化/检查配置
└── .github/workflows/release.yml # CI/CD 发布工作流
```

## 工具链

### Rust 侧

| 工具 | 版本 | 用途 |
|------|------|------|
| Rust edition | 2021 | 语言版本 |
| `evdev-rs` | 0.6 | Linux evdev 绑定 |
| `nix` | 0.27 | POSIX API（epoll, ioctl, fs） |
| `libc` | 0.2 | 底层 C 库绑定 |
| `serde` + `rmp-serde` | 1.x / 1.1 | MessagePack 序列化 |

构建命令：

```bash
# 开发构建
cargo build --manifest-path rust/Cargo.toml

# 发布构建（LTO + 最高优化）
cargo build --release --manifest-path rust/Cargo.toml

# 复制二进制到 bin/ 目录（带平台后缀）
pnpm build:rust
```

### TypeScript 侧

| 工具 | 版本 | 用途 |
|------|------|------|
| TypeScript | ^5.6.0 | 类型检查 |
| Vite | ^6.0.0 | 构建工具（library 模式） |
| Vitest | ^3.0.0 | 测试框架 |
| Biome | ^1.9.0 | 代码检查与格式化 |
| pnpm | - | 包管理器 |
| `msgpackr` | ^1.11.0 | 运行时 MessagePack 编解码 |

## 常用命令

```bash
# 安装依赖
pnpm install

# TypeScript 构建
pnpm build

# 运行 CLI 工具（类似 evtest）
pnpm cli list                        # 列出设备
pnpm cli list --all                  # 列出所有设备
pnpm cli info /dev/input/event0      # 查看设备能力
pnpm cli monitor                     # 交互选择设备并监听事件
pnpm cli monitor /dev/input/event0   # 监听指定设备
pnpm cli monitor --event=key         # 只看键盘事件

# 运行测试
pnpm test           # watch 模式
pnpm test:run       # 单次运行

# 类型检查
pnpm typecheck

# 代码检查
pnpm lint
pnpm lint:fix       # 自动修复

# 代码格式化
pnpm format

# 完整 Rust + TS 构建
pnpm build:rust && pnpm build
```

## 测试

测试使用 Vitest，位于 `test/` 目录：

- **`result.test.ts`**：验证 `Result<T, E>` 类型的 `ok()`、`okVoid()`、`err()`、`errFromUnknown()` 函数。
- **`codes.test.ts`**：验证 Linux 事件类型常量、键码定义，以及 Web 键码 <-> Linux 键码的双向映射一致性。
- **`protocol.test.ts`**：验证 `convertDeviceInfo()` 函数将 Rust 格式（snake_case）设备信息正确转换为 TypeScript 格式（camelCase），覆盖键盘、触屏、鼠标等设备类型。

测试配置（`vitest.config.ts`）：
- 全局 API 启用（`describe`, `it`, `expect`）
- Node 环境
- v8 覆盖率，覆盖 `src/**/*.ts`

运行测试：

```bash
pnpm test:run
```

## 类型检查

项目使用 TypeScript strict 模式。运行类型检查：

```bash
pnpm typecheck
```

等价于 `tsc --noEmit`，仅做类型检查不产生输出文件。构建由 Vite 负责。

## 通信协议

Rust 子进程与 TypeScript 父进程之间通过 stdin/stdout 使用 **MessagePack** 通信：

- **帧格式**：4 字节小端长度前缀 + MessagePack 消息体
- **Rust -> TS 消息**：`RustMessage` 枚举（device_list, device_added, device_removed, input_event, error, ok）
- **TS -> Rust 命令**：`TsCommand` 枚举（list_devices, start_reading, stop_reading, exit）

## CI/CD

GitHub Actions 工作流位于 `.github/workflows/release.yml`：

- 触发条件：推送 `v*` 标签
- 构建矩阵：`x86_64-unknown-linux-gnu` 和 `aarch64-unknown-linux-gnu`
- 流程：Rust 交叉编译 -> 上传产物 -> TS 构建 -> 测试 -> npm 发布 -> GitHub Release

## 注意事项

- 运行时需要 Linux 系统且有 `/dev/input/event*` 设备访问权限（通常需要 `input` 用户组或 root）。
- `msgpackr` 是运行时依赖但列在 `devDependencies` 中，因为它在 Vite 构建中被标记为 external，消费者需要自行安装。
- Rust 二进制在构建时复制到 `bin/` 目录，文件名包含平台和架构后缀（如 `myde-input-reader-linux-x64`）。
