# MyDE 桌面插件开发文档

## Quick Start

### 1. 创建项目

```bash
mkdir my-desktop && cd my-desktop
mkdir src dist
```

### 2. 创建 package.json

```json
{
    "name": "my_desktop",
    "main": "dist/index.js",
    "type": "module"
}
```

### 3. 编写 src/index.ts

```typescript
const { MSysApi, MUtils } = window.myde;

const render = new MUtils.renderToolsHtmlEl();
render.on({
    onToplevelCreate: (_, el) => document.body.appendChild(el),
    onToplevelRemove: (_, el) => el.remove(),
});

const { runApp, server } = MSysApi.server({ render });

server.on("newClient", (client) => {
    client.onSync("windowBound", () => ({ width: 800, height: 600 }));
});

runApp("weston-terminal");
```

### 4. 编译并运行

```bash
# 编译
npx tsc src/index.ts --outDir dist --module esnext --target esnext

# 在主项目中启动
export desktop='my-desktop'
npm run start
```

---

## 背景介绍

通过electron运行桌面。

实际类似开发传统浏览器单页页面，可以使用浏览器的所有api，但是不需要提供html页面，而是操控已经存在的页面。

尽管运行在electron中，但是考虑到安全屏蔽了nodejs相关的系统操作api，统一由`myde`提供。

在这个框架中，提供了界面窗口渲染和内部的管理，插件需要把提供的数据添加到网页，按需创建壁纸、启动器等，把鼠标键盘等事件发送到框架内。

---

## 加载机制

启动器读取插件目录的 `package.json`，获取 `main` 字段，动态加载脚本。

不要使用动态加载机制，而是一起打包，建议使用vite。如果加载资源，可以使用`MSysApi.fs`，可以读取插件文件夹下的所有文件。

---

## window.myde

插件通过 `window.myde` 访问系统 API：

```typescript
const { MSysApi, MRootDir, MInputMap, MUtils } = window.myde;
```

| 对象        | 说明     |
| ----------- | -------- |
| `MSysApi`   | 系统 API |
| `MSetting`  | 设置     |
| `MInputMap` | 键盘映射 |
| `MUtils`    | 工具函数 |

---

## MSysApi

### 创建服务器

```typescript
const { server, runApp } = MSysApi.server({ render });
```

### 应用管理

```typescript
// 获取桌面应用列表（带缓存，自动监听目录变化）
const apps = await MSysApi.getDesktopEntries();
// [{ name, nameLocal, exec, icon }]

// 强制刷新缓存
const apps = await MSysApi.refreshDesktopEntries();

// 获取单个应用信息
const app = await MSysApi.getDesktopEntry("firefox");

// 获取图标 (返回 blob URL，带缓存)
const iconUrl = await MSysApi.getDesktopIcon("firefox", { theme: "breeze" });
img.src = iconUrl;

// 获取环境变量
const env = MSysApi.getEnv();
// { HOME, USER, LANG, XDG_RUNTIME_DIR, ... }
```

### fs

只读虚拟文件系统，基于插件根目录，防止路径遍历：

```typescript
const fs = new MSysApi.fs(MRootDir);

// 读取文件
const text = await fs.readTextFile("config.json");
const data = await fs.readFile("data.bin"); // ArrayBuffer
const dataUrl = await fs.readFileAsDataURL("icon.png");
const blob = await fs.readFileAsBlob("image.png");

// 目录
const files = await fs.readdir("assets");
const entries = await fs.readdirWithTypes("assets");

// 检查
const exists = await fs.exists("file.txt");
const isFile = await fs.isFile("file.txt");
const isDir = await fs.isDirectory("dir");
const stat = await fs.stat("file.txt"); // { size, mtime, isFile, isDirectory }
```

所有方法都有同步版本（如 `readTextFileSync`）。

---

## MUtils

### renderToolsHtmlEl

内置的 DOM 渲染器：

```typescript
const render = new MUtils.renderToolsHtmlEl();

render.on({
    onToplevelCreate: (wid, el) => document.body.appendChild(el),
    onToplevelRemove: (wid, el) => el.remove(),
});

// 获取窗口元素
const el = render.getXdgSurfaceEle(renderId);
```

---

## MInputMap

```typescript
// 浏览器键盘码 -> Linux 键码
const keyCode = MInputMap.mapKeyCode("KeyA");
```

---

## MSetting

提供设置读写，这个设置可以由启动器共享，意味着换桌面插件后还可以保留，比如壁纸等。桌面还可以创建读写命名空间，也就是自定义设置。

自带类型约束和默认配置。

---

## Wayland 服务器

### 服务器事件

```typescript
server.on("newClient", (client, clientId) => {});
server.on("clientClose", (client, clientId) => {});
```

### 客户端事件

```typescript
client.onSync("windowBound", () => ({ width: 1920, height: 1080 }));
client.on("windowCreated", (windowId, renderId) => {});
client.on("windowClosed", (windowId) => {});
client.on("windowMaximized", (windowId) => {});
client.on("windowStartMove", (windowId) => {});
client.on("close", () => {});
```

### 窗口操作

```typescript
const win = client.win(windowId);
win.focus();
win.blur();
win.close();
win.maximize(w, h);
win.getTitle();
win.getPreview(); // OffscreenCanvas
win.point.renderId();
win.point.inWin({ x, y });
```

### 输入事件

```typescript
win.point.sendPointerEvent("move" | "down" | "up", pointerEvent);
win.point.sendScrollEvent({ p: wheelEvent });
client.keyboard.sendKey(keyCode, "pressed" | "released");
```

---

## 输入处理

```typescript
function sendPointerEvent(type, p) {
    for (const [_, client] of server.clients) {
        for (const [winId] of client.getWindows()) {
            const xwin = client.win(winId);
            const el = render.getXdgSurfaceEle(xwin.point.renderId());
            const rect = el.getBoundingClientRect();
            const nx = p.x - rect.left,
                ny = p.y - rect.top;

            if (xwin.point.inWin({ x: nx, y: ny })) {
                xwin.point.sendPointerEvent(
                    type,
                    new PointerEvent(p.type, {
                        ...p,
                        clientX: nx,
                        clientY: ny,
                    }),
                );
                if (type === "down") xwin.focus();
                break;
            }
        }
    }
}

document.addEventListener("pointermove", (e) => sendPointerEvent("move", e));
document.addEventListener("pointerdown", (e) => sendPointerEvent("down", e));
document.addEventListener("pointerup", (e) => sendPointerEvent("up", e));

document.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    for (const client of server.clients.values()) {
        client.keyboard.sendKey(MInputMap.mapKeyCode(e.code), "pressed");
    }
});

document.addEventListener("wheel", (e) => {
    for (const [_, client] of server.clients) {
        for (const [winId] of client.getWindows()) {
            client.win(winId).point.sendScrollEvent({ p: e });
            return;
        }
    }
});
```

---

## 启动应用

```typescript
// Wayland 应用
runApp("weston-terminal");

// X11 应用 (需要 xwayland-satellite)
let xServerNum = NaN;
for (let i = 0; i < 100; i++) {
    if (!fs.existsSync(`/tmp/.X11-unix/X${i}`)) {
        xServerNum = i;
        runApp("xwayland-satellite", [`:${xServerNum}`]);
        break;
    }
}
runApp("chrome", [], xServerNum);
```

---

## 开发提示

使用不了`require`，应该使用打包器打包成一个js文件。如果有复杂计算任务，使用 woker+wasm，如果需要其他系统 api，需要修改引擎，请提交 issuse 或 pr。

不建议使用网络加载外部内容。

避免复杂循环导致页面卡死，必要时添加`await scheduler.yield()`。

不使用 css 的`cursor`属性，需要自己实现光标

不使用 title 属性，或者借助 title 实现自己的 tooltip

--

## 参考

- [desktop 官方实现](../desktop)
