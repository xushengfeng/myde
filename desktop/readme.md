# MyDE 桌面实现开发文档

开发流程见[AGENTS.md#桌面实现开发](../AGENTS.md#桌面实现开发)

## 背景介绍

通过electron运行桌面。

实际类似开发传统浏览器单页页面，可以使用浏览器的所有api，但是不需要提供html页面，而是操控已经存在的页面。

尽管运行在electron中，但是考虑到后续整合方便，**屏蔽了nodejs相关的系统操作api，包括fs之类**，统一由`myde`全局变量提供。

在这个框架中，提供了界面窗口渲染和内部的管理，插件需要把提供的数据添加到网页，按需创建壁纸、启动器等，把鼠标键盘等事件发送到框架内。

## 加载机制

启动器读取插件目录的 `package.json`，获取 `main` 字段，动态加载脚本。

不要使用动态加载机制，而是一起打包，建议使用vite。如果加载资源，可以使用`MSysApi.fs`，可以读取插件文件夹下的所有文件。

## myde 全局变量

插件通过 `myde` 访问系统 API：

```typescript
import type {} from "../../src/desktop-api";
const { MSysApi, MRootDir, MInputMap, MUtils } = myde;
```

定义自`src/desktop-api.ts`

## MSysApi

### 创建Wayland服务器

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

只读虚拟文件系统，基于插件根目录，可以读取插件目录下的内容（类似相对路径），但是不能读取外部的其他系统文件：

```typescript
const fs = MSysApi.fs;

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

### login

设置系统关机、挂起等，锁屏自己实现

### media

mpris，获取正在播放的媒体相关信息，并控制播放暂停等

### notification

通知

### verifyUserPassword

判断当前用户输入密码是否正确，用于锁屏，底层是pam

多次错误会导致验证锁定（视pam设置而定）

### tray

拖盘

### power

电量获取，包括笔记本电池、蓝牙设备电源等

### blue

蓝牙设备，包括显示连接设备、记住的设备、设备连接断开

### network

主要查看无线网络连接名称，包括设备连接和断开，还没有开发新连接

### input

原生输入设备读取（evdev），支持键盘、鼠标、触控板、数位板、触屏、游戏手柄。由 `myde-input` 模块提供（Rust 子进程读取，不占用渲染进程线程）。

加载器已完成 `init()`，用 `input.isInitialized()` 判断是否可用（无 `/dev/input` 权限或子进程缺失时为 false，此时应使用 DOM 事件回退）。

```typescript
const { input } = MSysApi;

if (input.isInitialized()) {
    // 获取所有输入设备信息（DeviceInfo[]，仅元数据，不含事件流）
    const devices = input.getDevices();

    // 获取单个设备并显式开始读取事件
    const dev = input.getDevice("/dev/input/event3");
    if (dev) {
        dev.startReading();
        dev.on("keyDown", (code) => console.log("按下", code));
        dev.on("relative", (code, value) => console.log("相对移动", code, value));
    }

    // 监听设备热插拔（管理器事件）
    input.on("deviceAdded", (info) => {
        console.log("设备接入:", info.name, info.type);
        input.getDevice(info.path)?.startReading();
    });
    input.on("deviceRemoved", (path) => {
        console.log("设备断开:", path);
    });
    input.on("error", (e) => {
        console.warn(e.code, e.message);
    });
}
```

设备信息 (`DeviceInfo`)：`path`、`name`、`type`、`phys`、`vendor`/`product`/`version`、`capabilities`（`eventTypes`/`keyCodes`/`relAxes`/`absAxes`、`hasKeyboard`/`hasMouse`/`hasTouchpad`/`hasTouchscreen`、`maxTouchSlots`）、`touchInfo`（触屏物理轴信息）、`absInfo`（所有绝对轴量程 `Partial<Record<轴码, AxisInfo>>`，只有部分轴存在，绝对定位设备坐标校准用，归一化为小数见 `MInputMap.absRatio`/`absPosMapping`）、`errors`（如权限不足）

设备类型 (`info.type`)：

- `"keyboard"` - 键盘
- `"mouse"` - 鼠标
- `"touchpad"` - 触控板
- `"touchscreen"` - 触屏
- `"tablet"` - 数位板
- `"gamepad"` - 游戏手柄
- `"unknown"` - 未知设备（常见于无权限读取能力信息）

每个设备 (`InputDevice`) 可监听的事件：

- `"key"` - `(code, value, timestamp)` 按键原始事件，value=1按下、value=0释放、value=2长按
- `"keyDown"` / `"keyUp"` / `"keyRepeat"` - `(code)` 语义化按键事件
- `"relative"` - `(code, value)` 相对移动（鼠标、触控板），code 区分轴向（0=REL_X、1=REL_Y、8=REL_WHEEL、6=REL_HWHEEL）
- `"absolute"` - `(code, value)` 绝对位置（触屏、数位板）
- `"sync"` - `()` 同步帧结束（一帧事件收齐，适合批量处理移动）
- `"raw"` - `(event)` 原始事件 `{ devicePath, type, code, value, timestamp }`
- `"error"` - `(error)` 读取错误

管理器 (`input`) 事件：`"deviceAdded"` `(info: DeviceInfo)`、`"deviceRemoved"` `(path: string)`、`"error"` `(error)`

方法：

- `input.getDevices()` / `input.getDevice(path)` / `input.isInitialized()` / `input.destroy()`
- `dev.startReading()` / `dev.stopReading()` / `dev.isReading()`
- 方法返回 `Result`：`{ ok: true, value }` 或 `{ ok: false, error: { code, message, detail? } }`，不会抛出异常

按键码为 Linux evdev 键码（如 30=KEY_A、272=BTN_LEFT），浏览器 `e.code` 可用 `MInputMap.mapKeyCode` 转换

权限要求：用户需要在 `input` 组中才能读取 `/dev/input/event*`，否则设备列表为空或 `errors` 提示 Permission denied

### inputSim

统一输入事件 → 模拟 DOM 事件。桌面主文件把 DOM 原生事件与 input api（`input`）聚合（区分来源、融合坐标/帧/按键）成统一输入事件后传入，当前行为是模拟对应的 DOM 事件（Pointer/Wheel/Mouse/Keyboard），UI 组件与 wayland 窗口转发照旧消费 DOM 事件。

```typescript
const { inputSim } = MSysApi;

// 指针移动（视口坐标）
inputSim.emit({ kind: "pointer", type: "move", x: 100, y: 100, pointerType: "mouse", source: "evdev" });
// 左键按下 / 抬起（抬起时合成 click 并补齐聚焦）
inputSim.emit({ kind: "pointer", type: "down", x: 100, y: 100, button: 0, source: "evdev" });
inputSim.emit({ kind: "pointer", type: "up", x: 100, y: 100, button: 0, source: "evdev" });
// 滚轮
inputSim.emit({ kind: "pointer", type: "wheel", x: 100, y: 100, deltaX: 0, deltaY: 100, source: "evdev" });
// 键盘（evdev 键码 30=KEY_A，自动补出 KeyboardEvent.code="KeyA"、key="a"）
inputSim.emit({ kind: "key", type: "down", code: 30, source: "evdev" });
inputSim.emit({ kind: "key", type: "up", code: 30, source: "evdev" });
```

统一输入事件：

- `UniPointerEvent`：`kind: "pointer"`，`type: "move" | "down" | "up" | "wheel"`，`x`/`y`（视口坐标），`button?`（down/up，0左 1中 2右），`pointerType?`（"mouse"/"touch"/"pen"），`pointerId?`，`deltaX?`/`deltaY?`/`deltaMode?`（wheel），`target?`（指定派发目标，缺省按坐标命中测试）
- `UniKeyEvent`：`kind: "key"`，`type: "down" | "up"`，`code`（evdev 键码），`webCode?`（DOM `KeyboardEvent.code`，缺省由 evdev 码反查），`key?`（DOM `KeyboardEvent.key`，缺省按美式布局 + 修饰键推导），`repeat?`，`target?`（缺省为当前聚焦元素）
- `source`："dom"（DOM 原生事件）或 "evdev"（input api），聚合层用它区分/去重来源

行为细节：

- 左键按下后抬起才合成 `click`，并补齐聚焦（最近的 `input, textarea, select, [tabindex]`），按钮位掩码与修饰键（Shift/Ctrl/Alt/Meta、CapsLock）状态由 api 自己维护
- `pointerover/out/enter/leave`、`mousedown/up`、`auxclick`、`dblclick`、`contextmenu` 不模拟（hover 类建议放行原生事件）
- 合成事件没有浏览器默认行为：按键派发后未被 `preventDefault` 时补齐文本输入（`input`/`textarea`/contenteditable 的插入、Backspace、Delete）
- DOM 操作通过宿主接口 `InputSimHost`（`targetAt`/`activeTarget`/`focus`/`dispatch`）访问，默认实现 `domInputSimHost()` 操作真实 DOM，纯 node 环境可 `new inputSim(host)` 注入自定义宿主

聚合层参考实现见 `desktop/offical`：`main.ts` 的"输入聚合层"完成聚合/融合/分发——window capture 捕获真实 DOM 事件（只收 `isTrusted`，合成事件不回流防环）归一化，`useEvdevDevice` 解码 input api 事件（EV_SYN 帧合并、相对位移积分、绝对轴小数映射、滚轮换算、按键分流，判定/换算工具在 `input_evdev.ts`），统一传入本 api；来源只以 `source` 标记保留类型数据，不做去重。

### inputMethod

输入法（fcitx5，dbus 连接）。传入字母（按键），返回合成中的预编辑文本、候选词、提交文本。fcitx5 不可用时 `MSysApi.inputMethod` 为 `undefined`（加载器初始化时探测）。

```typescript
const im = MSysApi.inputMethod;

// 创建合成会话（一个输入上下文）
const ctx = await im.createContext("myde");
await ctx.focus();

// 传入字母，返回合成结果
const r = await ctx.type("nihk"); // 自然码双拼：ni + hao →「你好」
// { preedit, preeditCursor, auxiliary, candidates, candidateLabels,
//   candidateCursor, candidateLayout, hasPrev, hasNext, handled, committed }

console.log(r.preedit, r.candidates); // "ni hao" ["你好","你好","你","拟","尼"]

// 事件订阅（合成状态实时推送）
const off1 = ctx.on("update", (state) => render(state)); // 合成状态更新（预编辑/候选词等）
const off2 = ctx.on("commit", (text) => insert(text)); // 提交文字
const off3 = ctx.on("im", (imInfo) => show(imInfo)); // 当前输入法变化

// 单个按键（X keysym，如 0x61='a'、0xff08=BackSpace）
const r2 = await ctx.keyEvent(0xff08);

// 选择候选词（下标对应 r.candidates，选中即上屏）
const r3 = await ctx.selectCandidate(0);
console.log(r3.committed); // 上屏文字

// 提交当前合成上屏
await ctx.commit(); // 回车：上屏原文
await ctx.commit(false); // 空格：上屏高亮/首选候选

// 候选翻页（返回翻页后的合成状态）
const p1 = await ctx.nextPage();
const p2 = await ctx.prevPage();

// 丢弃合成（不提交）
await ctx.reset();
await ctx.destroy();
```

- `type(text)` 逐字符发按键（按下+抬起），返回合成快照；`keyEvent(keyval, isRelease?)` 单按键
- `selectCandidate(index)` 选词上屏，下标对应 `state.candidates`（fcitx5 跳过占位符后的下标）；`commit(raw?)` 提交当前合成（true=回车上屏原文，false=空格上屏高亮候选）；`nextPage()`/`prevPage()` 翻页返回翻页后状态
- 事件（`ctx.on(event, cb)` 返回取消订阅函数）：`update`（合成状态更新）/ `commit`（提交文字）/ `im`（当前输入法变化）
- `getState()` 当前合成状态快照；`getCurrentIM()` 当前输入法（`{ name, uniqueName, language }`）
- 合成快照 `ImComposeState`：`preedit`（预编辑文本）/ `preeditCursor` / `auxiliary`（辅助文本）/ `candidates`（候选词）/ `candidateLabels`（候选标签）/ `candidateCursor` / `candidateLayout` / `hasPrev` / `hasNext`
- `ImKeyResult` 追加 `handled`（按键是否被输入法处理）与 `committed`（本次输入提交的文本）
- `createContext(program, capabilities?)` 可自定义能力位图（缺省 ClientSideUI|Preedit|FormattedPreedit|ClientSideInputPanel；**注意不要全置 1**，会带上 Disable/Password 位导致 fcitx5 退化为键盘布局不合成）
- 底层为 fcitx5 `org.fcitx.Fcitx.InputMethod1` → `org.fcitx.Fcitx.InputContext1`（信号 `UpdateClientSideUI`/`UpdateFormattedPreedit`/`CommitString`/`CurrentIM`）

输入法列出与切换（fcitx5 `org.fcitx.Fcitx.Controller1`）：

```typescript
const im = MSysApi.inputMethod;

// 列出全部可用输入法（含所有键盘布局，几百个）
const all = await im.listInputMethods(); // ImEntry[]
// { uniqueName ("rime"), name ("中州韵"), nativeName, icon, label ("中"), languageCode ("zh"), addon, layout, isConfigurable }

// 当前输入法 / 组
const cur = await im.getCurrentIM(); // ImEntry（无聚焦上下文时 uniqueName 为空）
const group = await im.getGroupInfo(); // 当前组：{ name, defaultInputMethod, defaultLayout, inputMethods }
const groups = await im.listGroups(); // 组名列表
await im.getCurrentGroup(); // 当前组名

// 切换输入法（uniqueName）
await im.setCurrentIM("rime"); // 切到合成输入法（激活）
await im.setCurrentIM("keyboard-us"); // 切回键盘布局（停用合成，等价 fcitx5-remote -s）
await im.switchGroup("默认"); // 切换输入法组

// 激活状态
await im.getState(); // 0 关闭 / 1 未激活（打英文）/ 2 激活（合成）
await im.activate();
await im.deactivate();
await im.toggle();
```

- 切换菜单用 `getGroupInfo().inputMethods`（组内启用项，第一个是键盘布局）；`listInputMethods()` 是全部可用（含几百个键盘布局，供设置页添加用）
- `setCurrentIM` 作用于最近聚焦的输入上下文；受 fcitx5 `ShareInputState` 设置影响（No=按窗口独立记忆）

### appControl

`getPidTree`获取所有进程树，包括pid、ppid、名称、内存使用

`getPid`返回一个对象可以进行进一步控制，如`setPriority`调节优先级，或者用`suspend`挂起应用，甚至可以用`kill`关闭应用

## MUtils

### renderToolsHtmlEl

myde不处理DOM，需要DOM渲染器帮忙，这是为了方便测试或者在纯nodejs环境使用

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

## MInputMap

把浏览器键盘码转换为Linux键码，才能发送给窗口

```typescript
const keyCode = MInputMap.mapKeyCode("KeyA");
```

abs 轴转换工具，abs 值统一为小数（abs值比上 abs 范围，即量程占比），需要目标坐标时再映射：

```typescript
// abs 值 → 小数：(值 - min) / (max - min)，min=0 时即 值 ÷ 量程；无量程信息返回 undefined
const ratio = MInputMap.absRatio(info, code, value);

// abs 轴量程（absInfo，旧固件/读取失败时 MT 定位轴可回退 touchInfo）
const range = MInputMap.absRange(info, code);

// 触屏/数位板的 X/Y 轴（单点 ABS_X/ABS_Y 优先，其次多点 ABS_MT_POSITION_*）→ 小数转换
const abs = MInputMap.absPosMapping(info);
if (abs) {
    const x = abs.ratioX(value) * (window.innerWidth - 1); // 需要时再映射到目标坐标
    const y = abs.ratioY(value) * (window.innerHeight - 1);
    // abs.xCode / abs.yCode 为使用的轴码，便于和事件 code 比较
}
```

## MSetting

提供设置读写，这个设置可以由启动器共享，意味着换桌面实现后还可以保留，比如壁纸等。桌面还可以创建读写命名空间，也就是自定义设置。

自带类型约束和默认配置。

## Wayland 服务器

从`MSysApi.server({ render });`导出的`server`变量的进一步用法

### 服务器事件

一般一个`client`对应一个应用，但是应用可以有多个窗口。有些应用则会多个`client`，每个`client`一个窗口。

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
// 它们的x、y或者clientX等应该相对于XdgSurfaceEle左上角
win.point.sendPointerEvent("move" | "down" | "up", pointerEvent);
win.point.sendScrollEvent({ p: wheelEvent });
// mapKeyCode转换过来的
client.keyboard.sendKey(keyCode, "pressed" | "released");
```

## 输入处理

推荐用聚合层统一输入：捕获 DOM 原生事件（只收 `isTrusted`，合成事件不回流）与 input api（evdev）事件，区分来源、融合（evdev EV_SYN 帧合并、相对位移积分、绝对轴映射、滚轮换算）后传给 `MSysApi.inputSim` 模拟 DOM 事件，下面的转发处理照旧消费 DOM 事件即可（两种输入来源走同一条路径）。`desktop/offical/src/main.ts` 的"输入聚合层"是完整参考实现。

```typescript
function sendPointerEvent(type, p) {
    for (const [_, client] of server.clients) {
        for (const [winId] of client.getWindows()) {
            const xwin = client.win(winId);
            const el = render.getXdgSurfaceEle(xwin.point.renderId());
            const rect = el.getBoundingClientRect();
            const nx = p.x - rect.left,
                ny = p.y - rect.top;

            // 实际上，对于堆叠桌面，还要看遮挡关系
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

## 开发提示

使用不了`require`，应该使用打包器打包成一个js文件。如果有复杂计算任务，使用 woker+wasm，如果需要其他系统 api，需要修改引擎，请提交 issuse 或 pr。

不建议使用网络加载外部内容。

避免复杂循环导致页面卡死，必要时添加`await scheduler.yield()`。

禁止了浏览器光标显示，需要自己实现绘制光标

不使用 title 属性，或者借助 title 实现自己的 tooltip

## 参考

- [desktop 简单演示](./example)
