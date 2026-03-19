# MyDE Remote Desktop

远程桌面渲染系统，允许通过Web浏览器访问和控制桌面环境。

## 文件结构

```
remote/
├── src/                    # 服务器代码
│   ├── index.ts            # 主入口，创建wayland和WebSocket服务器
│   ├── server.ts           # WebSocket服务器
│   └── remote-render.ts    # 远程渲染器
├── frontend/               # 前端代码（独立vite项目）
│   ├── src/
│   │   ├── main.ts         # 前端JavaScript
│   │   └── index.html      # 前端HTML
│   └── package.json
├── dist/
│   └── server.js           # 服务器构建输出
└── package.json
```

## 使用方式

### 1. 启动远程桌面（electron + WebSocket服务器）

```bash
pnpm run remote
```

### 2. 启动前端（单独终端）

```bash
pnpm run remote:frontend
```

前端默认运行在 `http://localhost:8081`，连接到 WebSocket 服务器 `ws://localhost:8080`。

### 3. 访问

打开浏览器访问：`http://localhost:8081`

## 功能特性

- 实时桌面渲染：通过WebSocket实时传输桌面内容
- 输入事件转发：支持鼠标和键盘输入
- 启动应用：通过前端UI输入命令启动应用程序
- 前端独立运行：前端可以单独启动，方便开发调试

## 启动应用

在前端UI中，可以在 "Launch Application" 输入框中输入命令，如 `weston-terminal`，然后点击 "Run" 按钮或按回车键启动应用。

## 构建

### 构建服务器

```bash
cd remote
pnpm install
pnpm run build
```

### 构建前端

```bash
cd remote/frontend
pnpm install
pnpm run build
```

### 构建全部

```bash
cd remote
pnpm run build:all
```
