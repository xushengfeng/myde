# MyDE Remote Desktop

远程桌面渲染系统，允许通过Web浏览器访问和控制桌面环境。

## 架构

- **启动器 (Launcher)**: 管理页面，可以启动应用和查看运行中的窗口
- **渲染器 (Renderer)**: 每个 toplevel 窗口一个标签页，只渲染该窗口的内容

## 文件结构

```
remote/
├── src/                    # 服务器代码
│   ├── index.ts            # 主入口，创建wayland和WebSocket服务器
│   ├── server.ts           # WebSocket服务器，支持客户端类型区分
│   └── remote-render.ts    # 远程渲染器，支持状态缓存和toplevel过滤
├── frontend/               # 前端代码（独立vite项目）
│   ├── src/
│   │   ├── index.html      # 统一入口页面
│   │   └── index.ts        # 前端逻辑，通过URL参数区分模式
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

### 2. 访问启动器

打开浏览器访问：`http://localhost:8080`

### 3. 启动应用

在启动器页面输入命令（如 `weston-terminal`），点击 "Run" 按钮。

### 4. 打开窗口

当应用创建新窗口时，启动器会显示窗口列表。点击 "Open in new tab" 在新标签页中打开渲染器。

渲染器 URL 格式：`http://localhost:8080/?toplevelId=<toplevel-id>`

## 功能特性

- **启动器**: 启动应用、查看运行中的窗口列表
- **渲染器**: 每个 toplevel 一个标签页，独立渲染
- **状态缓存**: 渲染器缓存所有窗口状态，新客户端连接时自动恢复
- **输入事件转发**: 支持鼠标和键盘输入

## 消息类型

### 客户端 -> 服务器

- `register`: 注册客户端类型和toplevelId
- `runApp`: 启动应用
- `inputEvent`: 输入事件

### 服务器 -> 客户端

- `toplevelList`: 窗口列表
- `asToplevel`: 新窗口创建
- `destroyXdgSurfaceEle`: 窗口移除
- `bindCanvas`, `canvas`, `destroyCanvas`: canvas 相关消息
- `createXdgSurfaceEle`, `setXdgSurfaceGeo`: surface 相关消息

## 构建

```bash
cd remote
pnpm run build:all
```
