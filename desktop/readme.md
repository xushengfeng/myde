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

### lid

笔记本合盖状态，来自 logind 的 `org.freedesktop.login1.Manager.LidClosed`：

```typescript
await MSysApi.lid.init();
MSysApi.lid.isClosed(); // 当前是否合盖
MSysApi.lid.on("changed", (closed) => {
    // closed=true 合盖，false 开盖
});
```

没有合盖开关的机器始终为 `false`。logind 的 `HandleLidSwitch` 默认可能是 `suspend`，桌面要自己处理合盖时需把 `HandleLidSwitch`（以及 `HandleLidSwitchDocked` / `HandleLidSwitchExternalPower`）设为 `ignore`，否则 logind 会在事件之后挂起系统。官方桌面收到合盖后锁屏并熄屏，开盖回到锁屏界面。

### display

桌面模式（`displayType=desktop`）下控制 wrap 的输出：

```typescript
// wrap 是否支持屏幕电源（只有 DRM 后端会设置 MYDE_WRAP_SCREEN_POWER）
if (MSysApi.display.supports("screen-power")) {
    // screenIndex 缺省表示所有屏幕；winit 后端返回 screens: []
    await MSysApi.display.setScreenPower(false);
    await MSysApi.display.setScreenPower(true);
}
```

`setScreenPower` 走 DRM connector 的 DPMS，只关显示输出，不挂起系统。官方桌面在锁屏进入息屏状态时先铺黑并等一帧，再关 DPMS；任意输入唤醒时先开屏并吞掉该输入。

### media

mpris，获取正在播放的媒体相关信息，并控制播放暂停等

播放器出现/退出会发出 `new-player` / `remove-player`；单个播放器的元数据和播放状态变化可通过 `onMetaChange` / `onStatusChange` 订阅

### notification

通知

新通知发出 `new`，用户或应用关闭通知时发出 `closed`，通知操作被触发时发出 `action`。桌面关闭通知用 `close(id, reason)`，触发操作事件用 `invokeAction(id, actionKey)`

### portal

xdg-desktop-portal 后端（`org.freedesktop.impl.portal.desktop.myde`）。当前实现 `FileChooser` 的 `OpenFile` / `SaveFile` / `SaveFiles`，由系统的 xdg-desktop-portal 前端转发；桌面只负责弹窗和返回用户选择。

```typescript
const portal = MSysApi.portal;

portal.on("fileChooser.request", async (req) => {
    // req.mode: "open" | "save" | "save-many"
    // req.filters / req.choices / req.currentFolder / req.currentName ...
    const places = await portal.browse.places();
    const entries = await portal.browse.list(req.currentFolder ?? places[0].path);

    // 用户确认后返回绝对路径，后端负责转成 file:// URI
    const result = await req.accept({
        paths: ["/home/me/file.txt"],
        choices: { encoding: "utf8" },
        currentFilter: req.filters[0],
    });
    if (!result.ok) console.warn(result.error);

    // 用户关闭窗口：await req.cancel()
    // 应用调用 Request.Close：req.onCancel(() => closeDialog())
});
```

- `browse` 只提供 `list` / `stat` / `places` / `home` / `matchFilter`，不提供 `readFile`
- `accept` 的路径由后端校验：打开要求存在，保存要求父目录存在、文件本身可以不存在
- `parent_window` 目前只保留原始字符串；没有 `xdg-foreign` 时不解析，模态由桌面自己用遮罩实现
- 需要系统安装 xdg-desktop-portal，并安装 `assets/portal` 里的 `myde.portal` 和 `myde-portals.conf`；会话设置 `XDG_CURRENT_DESKTOP=MyDE`。开发测试用 `XDG_DESKTOP_PORTAL_DIR` 指向 `assets/portal/portals`，不要改系统配置
- 窗口模式下可以加 `--internal-portal`（或 `MYDE_INTERNAL_PORTAL=1`）启动私有 dbus 和 xdg-desktop-portal，MyDE 启动的应用会连到私有总线，不影响宿主 portal

### polkit

polkit 认证前端 agent。加载器会在系统总线注册当前 logind session；需要用户认证时 polkitd 调用 agent，桌面通过事件弹窗，密码等输入交回 request。PAM 由 `polkit-agent-helper-1`（socket 激活或 setuid helper）完成，API 不包含 UI。

```typescript
const polkit = MSysApi.polkit;

polkit.on("auth-request", (req) => {
    // req.id 进程内唯一；req.actionId / req.message / req.iconName
    // req.identities / req.details / req.command / req.vendor / req.vendorUrl
    // req.selectedIdentity
    openDialog(req, {
        onSubmit: (password) => req.submitPassword(password),
        onSelectIdentity: (id) => req.selectIdentity(id),
        onCancel: () => req.cancel(),
    });
});
polkit.on("auth-prompt", (req, prompt, echo) => {
    // echo=false 时输入密码；echo=true 是普通输入（如用户名）
    updateDialog(req, prompt, echo);
});
polkit.on("auth-info", (req, message) => updateInfo(req, message));
polkit.on("auth-error", (req, message) => updateError(req, message));
polkit.on("auth-identity-changed", (req, identity) => updateIdentity(req, identity));
polkit.on("auth-end", (req, { success, cancelled }) => closeDialog(req));
```

- 只处理 `unix-user` 身份；默认选中当前用户，`selectIdentity` 会重启 PAM 会话
- 同一时间只处理一个请求，后续请求排队；当前请求结束后才会为下一个发出 `auth-request`
- `req.id` 是进程内唯一编号（不是 polkit cookie），用于日志和自建状态表；`auth-end` 可能来自没发出过 `auth-request` 的排队请求，按 `id` 忽略即可
- `req` 只在 `auth-request` 之后可用；`submitPassword` 应在 `auth-prompt` 回调里调用，且每次 prompt 只调用一次（helper 的 stdin 会缓存，提前或重复发送会被后续 PAM 问题消费）；`cancel` / `selectIdentity` 可在 `auth-request` 到 `auth-end` 之间调用；`auth-end` 之后所有操作静默无效
- 依赖 `XDG_SESSION_ID` 或 logind 查询 session；认证依赖 `polkit-agent-helper-1`（`/run/polkit/agent-helper.socket` 或带 setuid 的 helper）
- 初始化失败（无 system bus、无 logind、无可用 helper）时只告警，`MSysApi.polkit` 保持 `undefined`；polkitd 重启后会自动重新注册

### verifyUserPassword

判断当前用户输入密码是否正确，用于锁屏，底层是pam

多次错误会导致验证锁定（视pam设置而定）

### tray

拖盘

托盘项新增/移除发出 `new` / `remove`，菜单变化发出 `menuUpdate`，图标、标题等属性变化发出 `changed`

### power

电量获取，包括笔记本电池、蓝牙设备电源等

监听 UPower 的 `PropertiesChanged` 和 `DeviceAdded`/`DeviceRemoved`：设备属性变化时 `powerDevice` 发出 `changed`，设备增减时 `power` 发出 `device-added`/`device-removed`，桌面可据此实时刷新电量

### blue

蓝牙设备，包括显示连接设备、记住的设备、设备连接断开

适配器属性变化发出 `adapter-changed`，设备属性变化发出 `changed`，设备增减发出 `device-added`/`device-removed`

### network

主要查看无线网络连接名称，包括设备连接和断开，还没有开发新连接

NetworkManager 属性变化发出 `changed`；无线设备属性、接入点增减和接入点属性变化分别发出对应事件

### volume

音频设备与应用音量控制。PipeWire/WirePlumber 没有音频控制的 D-Bus 接口，这里用 `pactl subscribe` 订阅事件，收到事件后再用 `pactl --format=json` 刷新，不做轮询

应用（stream）只包含播放/录音流，monitor source 不算输入设备。`id` 用于回传控制：sink 与输出流直接用 pactl 索引，source 与输入流用 `-(index + 1)`，因为 pactl 的这两类索引是独立命名空间、可能重号。`getDevices()` 只有 sink 和 source，不包含硬件 card

音量与静音变化会通过 `deviceVolumeChange` / `deviceMuteChange` / `streamVolumeChange` / `streamMuteChange` 事件通知，外部（如键盘音量键）修改也能收到

音量条拖动这类高频输入在桌面层用 `MUtils.throttle` 限制写入频率（见“MUtils”），API 本身每次都立即生效

### input

原生输入设备读取（evdev），支持键盘、鼠标、触控板、数位板、触屏、游戏手柄。由 `myde-input` 模块提供（Rust 子进程读取，不占用渲染进程线程）。

加载器已完成 `init()`，用 `input.isInitialized()` 判断是否可用（子进程缺失时为 false，此时应使用 DOM 事件回退）。`deviceAccess: "auto"`（默认）先直接读 `/dev/input/event*`（有权限时最省事、不影响 TTY），失败再走 systemd-logind `TakeDevice`（不需要权限，但会 `TakeControl` 接管 VT 并关闭该 VT 的键盘，TTY 的 Ctrl+C 不再送到启动它的 shell）；实际方式用 `input.getAccessMode()`（`"logind"` / `"direct"`）查看，构造时可用 `new InputManager({ deviceAccess: "auto" | "logind" | "direct" })` 指定。

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

设备信息 (`DeviceInfo`)：`path`、`name`、`type`、`phys`、`vendor`/`product`/`version`、`capabilities`（`eventTypes`/`keyCodes`/`relAxes`/`absAxes`、`hasKeyboard`/`hasMouse`/`hasTouchpad`/`hasTouchscreen`、`maxTouchSlots`）、`touchInfo`（触屏物理轴信息）、`absInfo`（所有绝对轴量程 `Partial<Record<轴码, AxisInfo>>`，只有部分轴存在，绝对定位设备坐标校准用，归一化为小数见 `MInputMap.absRatio`/`absPosMapping`）、`access`（该设备的打开方式 `"logind"` / `"direct"`）、`errors`（如权限不足）

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
- `input.getAccessMode()`（实际：`"logind"` / `"direct"`）/ `input.getAccessError()`（回退 direct 时 logind 的失败原因）
- `dev.startReading()` / `dev.stopReading()` / `dev.isReading()`
- 方法返回 `Result`：`{ ok: true, value }` 或 `{ ok: false, error: { code, message, detail? } }`，不会抛出异常

按键码为 Linux evdev 键码（如 30=KEY_A、272=BTN_LEFT），浏览器 `e.code` 可用 `MInputMap.mapKeyCode` 转换

权限要求：logind 模式下只需从登录会话（TTY/显示管理器）启动；回退到 direct 时用户需要能读 `/dev/input/event*`（`input` 组或 `uaccess` 规则，`script/input_access.sh` 可一键配置），否则设备列表为空或 `errors` 提示 Permission denied。VT 切走时 logind 会让读取暂停，切回后用新的 fd 继续。

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

- `UniPointerEvent`：`kind: "pointer"`，`type: "move" | "down" | "up" | "wheel"`，`x`/`y`（视口坐标），`button?`（down/up，0左 1中 2右），`pointerType?`（"mouse"/"touch"/"pen"），`pointerId?`，`isPrimary?`（同一指针类型中的主指针，缺省 true；多指触摸只有第一根为 true），`deltaX?`/`deltaY?`/`deltaMode?`（wheel），`wheelSource?`（"wheel"/"finger"/"continuous"）、`value120X?`/`value120Y?`（高精度滚轮刻度，1/120 格）、`scrollEnd?`（连续滚动抬手），`target?`（指定派发目标，缺省按坐标命中测试）
- `UniKeyEvent`：`kind: "key"`，`type: "down" | "up"`，`code`（evdev 键码），`webCode?`（DOM `KeyboardEvent.code`，缺省由 evdev 码反查），`key?`（DOM `KeyboardEvent.key`，缺省按美式布局 + 修饰键推导），`repeat?`，`target?`（缺省为当前聚焦元素）
- `source`："dom"（DOM 原生事件）或 "evdev"（input api），聚合层用它区分/去重来源

行为细节：

- 左键按下后抬起才合成 `click`，并补齐聚焦（最近的 `input, textarea, select, [tabindex]`）；按钮位掩码按指针分开维护（多指互不影响），修饰键（Shift/Ctrl/Alt/Meta、CapsLock）状态由 api 自己维护
- `pointerover/out/enter/leave`、`mouseover/out/enter/leave` 在目标变化时由 api 补齐（`source` 为 `"dom"` 时跳过，浏览器已经生成过原生 hover 事件）；`mousedown/up`、`auxclick`、`dblclick`、`contextmenu` 不模拟
- 多指触摸按 `pointerId` 各自产生独立的 pointer 事件（第一根 `isPrimary`），按键状态也按指针分开维护，一根手指抬起不会清掉另一根的 buttons
- 触摸的 `click` 只在单指接触（这一轮没有出现两指以上）且主指针抬起时合成，多指手势（长按、双指缩放等）由交互层自己根据 pointer 事件处理
- 合成事件没有浏览器默认行为：按键派发后未被 `preventDefault` 时补齐文本输入（`input`/`textarea`/contenteditable 的插入、Backspace、Delete）；滚轮派发后未被 `preventDefault` 时滚动最近的可滚动祖先，原生 `overflow: auto/scroll` 容器也能滚动
- DOM 操作通过宿主接口 `InputSimHost`（`targetAt`/`activeTarget`/`focus`/`dispatch`）访问，默认实现 `domInputSimHost()` 操作真实 DOM，纯 node 环境可 `new inputSim(host)` 注入自定义宿主

聚合层参考实现见 `desktop/offical`：`main.ts` 的"输入聚合层"完成聚合/融合/分发——window capture 捕获真实 DOM 事件（只收 `isTrusted`，合成事件不回流防环）归一化，`useEvdevDevice` 解码 input api 事件（EV_SYN 帧合并、相对位移积分、绝对轴小数映射、滚轮换算、按键分流，判定/换算工具在 `input_evdev.ts`），统一传入本 api；来源只以 `source` 标记保留类型数据，不做去重。

触摸板（`type === "touchpad"`）的绝对坐标**不直接映射到屏幕**，只用来计算相邻帧位移；`BTN_TOUCH` 只表示手指接触、不是点击（点击走 `BTN_LEFT`）。仓库的 `src/utils/touchpad.ts` 把设备事件封装成 `move`/`scroll`/`scrollEnd`/`button` 语义事件：单指轻触左键、双指轻触右键、三指轻触中键、双指自然滚动、轻触后第二下按住拖拽。轻触/拖拽行为对齐 libinput（COSMIC、KWin 都直接使用它）：接触不超过 180ms、位移不超过 1.3mm（按设备分辨率折算，缺失时按默认 DPI）才算轻触；接触中移动超过 1.3mm 或按住超过 180ms 都不点击。轻触在抬手时按下左键，并等 180ms 拖拽窗口：窗口内第二下按住（移动超阈值或保持到超时）沿用按住的左键进入拖拽，抬手结束；第二下快速抬起则按双击处理；没有第二下时窗口结束自动抬起完成点击。双指滚动是连续滚动，转发给 Wayland 时要带 `source: "finger"`（不发离散步进），手指数量变化时发 `scrollEnd` 让客户端补 `axis_stop`。三指及以上移动不发滚动，而是单独发 `multiStart`/`multiMove`/`multiEnd`，官方桌面不订阅。MT-B 用 `slot` + `ABS_MT_TRACKING_ID` 跟踪接触点，没有 tracking id 的旧设备用 `BTN_TOOL_*` 手指数兜底。触摸板常带一个同 `phys` 的伴随鼠标节点，如果那个相对通道真的在出事件，则忽略触摸板的绝对位移，避免双倍移动。

触屏（`type === "touchscreen"`）的绝对坐标直接映射到视口，MT-B 用 `slot` + `ABS_MT_TRACKING_ID` 跟踪每个接触点：一根手指对应一个 `pointerId`，各自产生独立的 down/move/up，第一根按下的手指 `isPrimary` 为 true。没有 tracking id 的旧设备退回单指 `BTN_TOUCH` 路径。统一输入事件的 `pointerType` 为 `"touch"`，`inputSim` 合成 `PointerEvent` 时保留 `pointerType`/`pointerId`/`isPrimary`，UI 只监听 pointer 事件即可同时响应鼠标、触摸板和触屏，多指手势由交互层处理。

注意被吞掉的原生事件只对**聚合层之后**注册的监听不可见：排在它之前的 window capture 监听仍会先收到原生事件，而原生 `click` 不受 `preventDefault` 影响（它不是兼容鼠标事件），且派发在 inputSim 合成的 `click` 之后——一次物理点击就被处理两遍，出现「合成 click 打开弹窗 → 原生 click 立刻关闭」的点击无反应（evdev 来源没有原生事件，只用 evdev 时看不出）。因此：① 吞事件的注册要早于所有 UI 监听（`desktop/offical` 把整个「输入聚合层」放在工具栏 plant 循环之前）；② 若确要在它之前注册监听，该监听必须忽略 `isTrusted` 事件（`desktop/offical` 的 Tools 关闭弹窗监听保留了这条守卫）。

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
// 交互式逐键输入：带修饰状态/keycode，并跳过 30ms 等待
const r2b = await ctx.keyEvent(0x61, { state: 1, keycode: 30, settleMs: 0 });

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

- `type(text)` 逐字符发按键（按下+抬起），返回合成快照；`keyEvent(keyval, opt?)` 单按键，`opt` 可带 `isRelease`、`state`（X11 modifier mask）、`keycode`、`time`、`settleMs`（交互式传 0 去掉固定等待）
- **插入文字的正确姿势（桌面 UI 必读）**：协议只有按键没有文本通道，文字经两条路上屏——
  1. `ctx.on("commit", cb)`：输入法主动提交（合成完成、选词整词、标点转全角等）
  2. `keyEvent`/`type` 返回 `handled=false` 且 `committed=""`：输入法**放行**该按键，客户端按默认行为自己插入字符（典型：无合成时的数字、输入法停用时的字母）
  - 合成中数字 `1-9` 会被输入法消费为选词快捷键（不放行）；合成中标点会连同合成一起上屏（一次 commit）
- `selectCandidate(index)` 选词上屏，下标对应 `state.candidates`（fcitx5 跳过占位符后的下标）；`commit(raw?)` 提交当前合成（true=回车上屏原文，false=空格上屏高亮候选）；`nextPage()`/`prevPage()` 翻页返回翻页后状态
- 事件（`ctx.on(event, cb)` 返回取消订阅函数）：`update`（合成状态更新）/ `commit`（提交文字）/ `im`（当前输入法变化）
- `getState()` 当前合成状态快照；`getCurrentIM()` 当前输入法（`{ name, uniqueName, language }`）
- 合成快照 `ImComposeState`：`preedit`（合并后的预编辑）/ `preeditCursor` / `panelPreedit`（面板预编辑）/ `clientPreedit`（客户端内联预编辑）/ `clientPreeditEnabled`（fcitx 是否在发内联预编辑）/ `auxiliary`（辅助文本）/ `candidates`（候选词）/ `candidateLabels`（候选标签）/ `candidateCursor` / `candidateLayout` / `hasPrev` / `hasNext`
  - `clientPreeditEnabled` 来自是否收到过 `UpdateFormattedPreedit`；fcitx 关闭“在应用中显示预编辑”或把应用列入 `FCITX_NO_PREEDIT_APPS` 时为 false，此时应把 `panelPreedit` 显示在候选窗里作为兜底
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

### throttle

高频输入（拖动滑块、滚轮等）的节流工具，默认第一次立即执行、结束时补发最后一次。节流放在桌面层做，系统 API 不做频率限制。

```typescript
const setVolume = MUtils.throttle((v: number) => {
    volume.setDeviceVolume(id, v);
}, 50);

setVolume(0.5); // 立即执行
setVolume(0.6); // 100ms 内只保留最后一次

setVolume.flush(); // 立即补发挂起的最后一次
setVolume.cancel(); // 丢弃挂起的调用
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

## MConnect

远程连接。设备 id、配对凭据和连接配置由连接层持久化，桌面只需按类似 NetworkManager 的方式查询和操作：

```typescript
const connect = myde.MConnect();
await connect.init();

const myId = connect.getId();
const saved = connect.getSavedConnections();
const active = connect.getActiveConnections();

await connect.connect("peer-device-id");
await connect.disconnect("peer-device-id");
connect.removeConnection("peer-device-id");

const pairing = await connect.startPairing();
// pairing.pin 展示给对端；这里输入对端展示的 PIN
const result = await pairing.connect("peer-device-id", { remember: true });
result.inputOtherPin(remotePin);
await result.waitForPair();
```

`remember: false` 创建临时连接，不写入存储。事件：`connection-added`、`connection-removed`、`connection-changed`、`connected`、`disconnected`、`id-changed`、`error`。

## Wayland 服务器

从 `MSysApi.server({ render })` 导出的 `server` 变量的进一步用法。

**server 是主通道**：窗口、光标、剪贴板的事件/查询/命令都在它上面，一次订阅覆盖全部客户端。
`server.clients` 只留给连接生命周期、remote/调试等明确要底层 client 对象的场景。

### 窗口身份

Wayland 对象 id 由**客户端本地分配**（实测两个客户端可同时用 `id: 9`），不能当全局身份用。
服务端因此提供单调递增的 handle（`"w1"`、`"w2"`…）：客户端断开重连后对象 id 会复用，递增 handle 不会串台。

```typescript
interface WindowInfo {
    handle: string; // 全局身份，所有命令/查询都用它
    clientId: string; // 需要按连接过滤时才用
    appid: string;
    title: string;
    rect: { x: number; y: number; w: number; h: number };
    scale: number; // 输出缩放：显示尺寸 = rect × scale，输入坐标 = 桌面坐标 ÷ scale
    states: { activated: boolean; maximized: boolean; minimized: boolean };
    renderId: string; // render.getXdgSurfaceEle(info.renderId)
}
```

`rect` 的 `w`/`h` 是客户端 `set_window_geometry` 声明的 **surface 逻辑尺寸**；`x`/`y` 是 surface 局部的几何偏移，
**不是屏幕位置**（摆放由桌面负责，渲染时几何原点即窗口元素左上角）。
桌面显示尺寸是 `rect × scale`：渲染侧会按 scale 放大窗口 DOM，桌面输入转发前要除回 scale。
命中检测用 `server.windows.hitTest(handle, p)`（窗口元素的局部坐标）：它包含 popup 树、subsurface
与 input region，popup 超出顶层窗口范围时也能命中；只比较 `rect` 会漏掉超出的 popup。

### 事件

```typescript
server.on("window.created", (info: WindowInfo) => {});
server.on("window.changed", (info) => {}); // rect/states/title/appid 任一变化，payload 自包含
server.on("window.closed", (handle) => {});
server.on("window.startMove", (handle) => {});
server.on("cursor.changed", (clientId, state: CursorState) => {});
server.on("clipboard.copy", (clientId, text) => {});
server.on("clipboard.pasteRequested", (clientId) => {});
server.on("client.opened", (clientId) => {});
server.on("client.closed", (clientId) => {});
```

`window.changed` 是**合并事件**：客户端请求 resize / maximize、改标题、设 `app_id` 都从它下来。
桌面拿 `info.states` / `info.rect` 与自己已应用的状态做差分即可，参考：

```typescript
const applied = new Map<string, { w: number; h: number; maximized: boolean }>();
server.on("window.created", (info) => {
    applied.set(info.handle, { w: info.rect.w, h: info.rect.h, maximized: false });
});
server.on("window.changed", (info) => {
    const a = applied.get(info.handle);
    if (!a) return;
    if (a.w !== info.rect.w || a.h !== info.rect.h) {
        // 客户端改了几何
    }
    if (a.maximized !== info.states.maximized) {
        a.maximized = info.states.maximized;
        // 客户端请求最大化 / 取消
    }
});
```

客户端断开时，server **统一补发**该客户端全部窗口的 `window.closed`，再发 `client.closed`。

### 查询

```typescript
server.windows.list(); // WindowInfo[]
server.windows.get(handle); // WindowInfo | undefined
server.windows.preview(handle); // OffscreenCanvas | undefined（缩略图）
server.windows.hitTest(handle, { x, y }); // boolean：含 popup/subsurface/input region 的完整几何命中
server.cursor.get(clientId); // CursorState
await server.request("window.get", handle); // WindowInfo，未知 handle 会 reject
await server.request("window.getBounds", handle); // Rect
```

### 窗口命令

```typescript
server.notify("window.focus", handle);
server.notify("window.blur", handle);
server.notify("window.close", handle);
server.notify("window.setBox", handle, { width, height }); // 只记盒子，不发 configure
server.notify("window.setSize", handle, { width, height });
server.notify("window.maximize", handle, { width, height });
server.notify("window.unmaximize", handle, { width, height });
server.notify("window.minimize", handle);
```

`window.focus` / `window.blur` 是**键盘焦点的唯一入口**——`wl_keyboard.enter/leave`、text-input 的
enter/leave、剪贴板 selection 归属都跟它走。指针 hover **不**自动切键盘焦点，要不要 focus-follows-mouse
完全由桌面自己决定（想跟随就在 hover 时调 `window.focus`）。重复 focus/blur 会被内部去重，
与「目标 focus + 其余 blur」的全量循环配合时与遍历顺序无关。

### 输入事件

四个 `input.*` 末尾都可以带可选的 `seat`（缺省 `"seat0"`）：多光标 / 多 seat 时按**人**选择，
是选择器**不是广播**——同一事件发给多个 seat 会被客户端当成几把同步光标（点击双发、文本双打）。
第二个光标（如远程协作者）就 `server.notify("input.pointer", handle, ev, "seat1")`。

> 官方桌面有一个 Firefox 兼容回退：Firefox Nightly 的地址栏/select 弹层会给 `seat0` 的 pointer
> 留下未释放的 grab，弹层之后 motion 不再更新光标。没有远程连接时，官方桌面把 Firefox 的
> `move/down/up` 也镜像到 `seat1`；Firefox 会把两把 seat 上完全相同的按下/抬起去重，
> 因此不会双击。其它客户端不镜像。

```typescript
// x、y 相对该窗口的 xdg_surface 元素左上角（几何原点）
server.notify("input.pointer", handle, { type: "move" | "down" | "up", x, y, button });
// 滚轮（source 缺省 wheel）：delta 按桌面 px，一格 100px；
// value120 是高精度滚轮刻度（1/120 格），不填时按 delta 换算
server.notify("input.scroll", handle, { deltaX, deltaY, deltaZ, value120X, value120Y });
// 触摸板/连续滚动：delta 是 surface-local 像素，只发连续 axis；
// 自然滚动带 relativeDirection，抬手时发 stop 结束滚动序列（客户端据此收尾/惯性）
server.notify("input.scroll", handle, { deltaX, deltaY, deltaZ: 0, source: "finger", relativeDirection: "inverted" });
server.notify("input.scroll", handle, { deltaX: 0, deltaY: 0, deltaZ: 0, source: "finger", relativeDirection: "inverted", stop: true });
// mapKeyCode 转换过来的
server.notify("input.key", handle, keyCode, "pressed" | "released");
// 输入法文本（preedit为true表示合成中的预编辑），统一走该入口，
// 按客户端 text-input 焦点自动分发 zwp_text_input_v1 / zwp_text_input_v3
//（两者是竞争协议，单客户端内后激活者胜出：v1 activate / v3 enable 抢占，文本只发给持有对象）
server.notify("input.text", handle, text, preedit);

// 聚焦窗口的 text-input 状态：是否支持、是否已启用、光标矩形（surface 局部坐标）
const ti = await server.request("textInput.get", handle);
// { supported, protocol?, enabled, cursorRect: { x, y, w, h } | null }
// 只有 supported && enabled 时 input.text 才会真正上屏；cursorRect 由客户端
// zwp_text_input_v3.set_cursor_rectangle 上报，v1 或未上报时为 null。
```

发送门槛（没到门槛就静默丢弃，不报错）：`input.key` 只在**该 seat 有键盘焦点**时下发、
`input.scroll` 只在该 seat 有指针焦点时下发——所以**先 `window.focus` 再注入按键**。

触摸板连续滚动按规范只发 `axis`（连续、无离散步进）；`axis_value120` 是滚轮通道，只随 `wheel` 发送。滚轮的高精度事件可以同帧发 `axis` + `axis_value120`（v8+）或 `axis` + `axis_discrete`（v5-7）。自然滚动通过 `axis_relative_direction`（v9）告诉客户端物理方向。客户端之间轴值换算差异（Chromium 的 ×12、GTK3/Firefox 的 ÷10×40 等）属于客户端行为，官方桌面只提供全局/触摸板速度倍率，不按 appid 改轴值。

键盘与剪贴板是**连接级**的：同一客户端有多个窗口时按 `clientId` 去重后再发，否则会重复收键。
剪贴板回填也按 `clientId`（事件里带下来的那个），不走 handle：

```typescript
server.on("clipboard.pasteRequested", (clientId) => {
    server.notify("clipboard.paste", clientId, "文本");
});
server.notify("clipboard.offer", handle); // 获得焦点时把剪贴板 offer 给该客户端
```

拖拽（drag-and-drop）走 Wayland 的 `wl_data_device.start_drag`：目前支持**同一客户端内**拖动，客户端用
`wl_data_source.offer` 声明的 mime 会成为 `wl_data_offer`，指针移动时发 `wl_data_device.motion`，抬手发
`drop`/`dnd_drop_performed`/`dnd_finished`；目标 `wl_data_offer.receive` 的 fd 由 core 转给 source 写回。
目标 surface 不在本客户端时发 `wl_data_source.cancelled`，跨客户端拖拽尚未接入。

### 桌面提供可用空间

注册一次即可（server 在 `xdg_surface.get_toplevel` 的同步 handler 里取值，所以必须同步返回）。
参数是 **surface 逻辑尺寸**，高 DPI 下要用物理视口除以 `scale`：

```typescript
server.respond("surfaceBounds.request", () => ({
    width: window.innerWidth / scale,
    height: window.innerHeight / scale,
}));
```

### 输出与缩放

桌面把屏幕模式与客户端缩放交给 server：

```typescript
server.outputs.set({
    name: "eDP-1",
    description: "eDP-1",
    mode: { width: 3840, height: 2160, refresh: 60000 }, // 物理像素，refresh 单位 mHz
    scale: 2, // 1 surface 逻辑 px = 2 桌面物理 px
    transform: "normal",
});
```

server 会据此发送 `wl_output.mode/geometry/scale`、`wl_surface.preferred_buffer_scale`，
并让支持分数的客户端通过 `wp_fractional_scale_v1` 拿到精确值。修改 scale 不需要重连客户端：
客户端按新偏好重绘，渲染侧同时把窗口 DOM 尺寸按 `rect × scale` 重设。

默认 `scale = 1`；不调用 `outputs.set` 时保持旧行为（1920×1080、1x）。
myde-wrap 的 winit 后端（屏幕名 `winit`）以及普通窗口模式由宿主桌面负责缩放，
desktop 应把 `scale` 固定为 1，避免再叠一层内部缩放。

### 连接

```typescript
server.on("client.opened", (clientId) => {
    server.clients.get(clientId)?.setLogConfig({ receive: [], send: [] });
});
```

## 输入处理

推荐用聚合层统一输入：捕获 DOM 原生事件（只收 `isTrusted`，合成事件不回流）与 input api（evdev）事件，区分来源、融合（evdev EV_SYN 帧合并、相对位移积分、绝对轴映射、滚轮换算）后传给 `MSysApi.inputSim` 模拟 DOM 事件。滚轮/触摸板建议在聚合层**直接用统一输入事件的字段转发**给窗口，因为模拟成 DOM `WheelEvent` 会丢掉 `wheelSource`（滚轮还是触摸板）和高精度刻度；其它事件继续消费 DOM 事件即可（两种输入来源走同一条路径）。`desktop/offical/src/main.ts` 的"输入聚合层"是完整参考实现。

```typescript
function windowAtPoint(p) {
    for (const info of server.windows.list()) {
        const el = render.getXdgSurfaceEle(info.renderId);
        const rect = el.getBoundingClientRect();
        const nx = p.x - rect.left,
            ny = p.y - rect.top;
        // 完整几何命中（主 surface + popup + subsurface + input region），
        // popup 超出窗口范围时也能命中；堆叠桌面还要看遮挡关系
        if (server.windows.hitTest(info.handle, { x: nx, y: ny })) return { info, x: nx, y: ny };
    }
    return undefined;
}

function sendPointerEvent(type, p) {
    const at = windowAtPoint(p);
    if (!at) return;
    server.notify("input.pointer", at.info.handle, {
        type,
        x: at.x,
        y: at.y,
        button: p.button,
    });
    if (type === "down") server.notify("window.focus", at.info.handle);
}

document.addEventListener("pointermove", (e) => sendPointerEvent("move", e));
document.addEventListener("pointerdown", (e) => sendPointerEvent("down", e));
document.addEventListener("pointerup", (e) => sendPointerEvent("up", e));

document.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (focusHandle === undefined) return; // 桌面自己记录的焦点窗口
    server.notify("input.key", focusHandle, MInputMap.mapKeyCode(e.code), "pressed");
});

document.addEventListener("wheel", (e) => {
    const info = windowAtPoint(e);
    if (!info) return;
    // 真实触摸板的 DOM wheel 是像素连续滚动，应标 finger；滚轮按缺省 wheel 处理
    server.notify("input.scroll", info.handle, { deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ });
});
```

要把按键广播给每个连接（而不是只给焦点窗口），按 `clientId` 去重：

```typescript
const seen = new Set<string>();
for (const info of server.windows.list()) {
    if (seen.has(info.clientId)) continue;
    seen.add(info.clientId);
    server.notify("input.key", info.handle, keyCode, "pressed");
}
```

## 启动应用

```typescript
const serverX = MSysApi.server({ render });

// 启动 xwayland-satellite，之后 runApp 自动带 DISPLAY
const display = await serverX.startXwayland();
if (display === undefined) {
    console.warn("xwayland-satellite 不可用，X11 应用将无法启动");
}

// Wayland / X11 应用都由 runApp 启动；有 xwayland 时会自动带 DISPLAY
serverX.runApp("weston-terminal");
serverX.runApp("chrome");

// 显式指定 display 仍然可以覆盖自动值
serverX.runApp("chrome", 0);

// 退出桌面时可选
serverX.stopXwayland();
```

`startXwayland()` 会找一个空闲的 `:N`，启动 `xwayland-satellite :N`，等待 `/tmp/.X11-unix/XN` 出现；可用 `MYDE_XWAYLAND_SATELLITE` 指定 binary 路径。

## 开发提示

使用不了`require`，应该使用打包器打包成一个js文件。如果有复杂计算任务，使用 woker+wasm，如果需要其他系统 api，需要修改引擎，请提交 issuse 或 pr。

不建议使用网络加载外部内容。

避免复杂循环导致页面卡死，必要时添加`await scheduler.yield()`。

禁止了浏览器光标显示，需要自己实现绘制光标

不使用 title 属性，或者借助 title 实现自己的 tooltip

## 参考

- [desktop 简单演示](./example)
