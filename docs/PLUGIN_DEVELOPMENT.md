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
cd /path/to/myde
export desktop='my-desktop'
npm run start
```

---

## 加载机制

`desktop-loader.ts` 读取插件目录的 `package.json`，获取 `main` 字段，动态加载脚本：

```
http://localhost/?desktop=/path/to/my-desktop
```

加载流程：

1. 读取 `{desktop}/package.json`
2. 获取 `main` 字段（默认 `dist/index.js`）
3. 读取脚本内容并执行

---

## window.myde

插件通过 `window.myde` 访问系统 API：

```typescript
const { MSysApi, MRootDir, MInputMap, MUtils } = window.myde;
```

| 对象        | 说明           |
| ----------- | -------------- |
| `MSysApi`   | 系统 API       |
| `MRootDir`  | 插件根目录路径 |
| `MInputMap` | 键盘映射       |
| `MUtils`    | 工具函数       |

---

## MRootDir

插件根目录的绝对路径，用于加载资源文件：

```typescript
const { MRootDir } = window.myde;

// 加载图片
const img = new Image();
img.src = `${MRootDir}/assets/icon.png`;

// 加载配置
const config = await fetch(`${MRootDir}/config.json`).then((r) => r.json());
```

目录结构：

```
my-desktop/
├── src/index.ts
├── dist/index.js
├── assets/wallpaper.png
└── package.json        # main: "dist/index.js"
```

---

## MSysApi

### 创建服务器

```typescript
const { server, runApp } = MSysApi.server({ render });
```

### 应用管理

```typescript
// 获取桌面应用列表
const apps = await MSysApi.getDesktopEntries();
// [{ name, nameLocal, exec, icon }]

// 获取应用信息
const app = await MSysApi.getDesktopEntry("firefox");

// 获取图标 (返回 blob URL，带缓存)
const iconUrl = await MSysApi.getDesktopIcon("firefox", { theme: "breeze" });
// iconUrl: "blob:http://localhost/xxxx"
img.src = iconUrl;

// 获取环境变量
const env = MSysApi.getEnv();
// { HOME, USER, LANG, XDG_RUNTIME_DIR, ... }
```

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

### vfs

只读虚拟文件系统，基于插件根目录，防止路径遍历：

```typescript
const fs = new MUtils.vfs(MRootDir);

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

## MInputMap

```typescript
// 浏览器键盘码 -> Linux 键码
const keyCode = MInputMap.mapKeyCode("KeyA");
```

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

## 参考

- [desktop 官方实现](../desktop)
