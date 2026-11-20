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

### nativefs

原生文件系统的只读枚举接口，目前只提供目录列表，不读取文件内容。支持绝对路径和 `~`，默认列主目录：

```typescript
const listing = await MSysApi.nativefs.list("~/Documents", { showHidden: false });
// listing.path: 解析后的绝对路径
// listing.entries: [{ name, path, kind, targetKind?, size, mtime, hidden, mime }]

await MSysApi.nativefs.list("/", { showHidden: true });
```

目录项按目录优先、名称自然排序。符号链接的 `kind` 为 `symlink`，指向目录时 `targetKind` 为 `directory`。文件选择器用它列出目录。

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

// 屏幕当前模式与可切换模式；refresh_rate 单位 Hz，winit/旧版 wrap 的 modes 为空
const [screen] = await MSysApi.display.getScreens();
console.log(screen.width, screen.height, screen.refresh_rate, screen.modes);

// 切换刷新率（只有 DRM 后端、且 wrap 广告 MYDE_WRAP_SCREEN_MODE=1 时可用）
if (MSysApi.display.supports("screen-mode")) {
    await MSysApi.display.setScreenRefreshRate(0, 120);
    // 或指定完整模式：
    // await MSysApi.display.setScreenMode(0, { width: 1920, height: 1080, refresh_rate: 120 });
}
```

`setScreenPower` 走 DRM connector 的 DPMS，只关显示输出，不挂起系统。官方桌面在锁屏进入息屏状态时先铺黑并等一帧，再关 DPMS；任意输入唤醒时先开屏并吞掉该输入。

桌面模式下 `display` 会自动维持与 wrap 的心跳：wrap 每 3 秒发 `Ping`，但只有桌面入口脚本执行到末尾后 `display` 才回 `Pong`（加载器会自动在入口末尾调用 `display.markReady()`）。桌面初始化抛错或卡住时不会回 Pong，wrap 会在 30 秒启动超时后退出；就绪后页面事件循环卡死超过 10 秒也会退出并释放屏幕，避免最后一帧一直留在显示器上。

控制连接带认证：wrap 的一次性 token 经继承的 fd（`MYDE_WRAP_AUTH_FD`）交给主进程，主进程读出后经 `wrapSocket` / `wrapToken` 两个 URL 参数交给渲染进程，并把 `MYDE_WRAP_SOCKET`、`MYDE_WRAP_AUTH_FD` 从环境里删掉。加载器负责在连接后立刻发 `Auth`，桌面本身不用处理。

官方桌面的退出快捷键（Super+Shift+E、Ctrl+Alt+Delete）在输入聚合层（`dispatchInput`）判定，早于桌面 UI 和状态机，所以即使页面部分逻辑失效，只要输入读取和 JS 事件循环还在就能退出；整个事件循环卡死时则由上面的心跳兜底。

`getScreens` 的 `refresh_rate` 与 `modes` 来自真实输出模式。DRM 下 wrap 启动时会在 EDID 首选分辨率里选刷新率最高的模式，`wp_presentation` 的 `refresh` 也跟随当前输出，而不是固定 120Hz。官方桌面的 `ScreenManager` 已提供 `getResolution()` / `getResolutions()` / `setResolution()` 和 `getRefreshRate()` / `getRefreshRates()` / `setRefreshRate()`，切换后会把新模式同步给 wayland server 的 `outputs.set`，分辨率变化时还会重设窗口尺寸并让最大化窗口重新 configure；设置窗口的"显示 → 分辨率 / 刷新率"就是这些接口的入口。

### media

mpris，获取正在播放的媒体相关信息，并控制播放暂停等

播放器出现/退出会发出 `new-player` / `remove-player`；单个播放器的元数据和播放状态变化可通过 `onMetaChange` / `onStatusChange` 订阅

### notification

通知

新通知发出 `new`，用户或应用关闭通知时发出 `closed`，通知操作被触发时发出 `action`。桌面关闭通知用 `close(id, reason)`，触发操作事件用 `invokeAction(id, actionKey)`

`Notify` 的 `expire_timeout` 由 API 自动处理：`>0` 使用该毫秒数，`0` 不自动过期，`-1` 使用默认值；默认值可在 `init({ defaultTimeout })` 时设置，也可用 `setDefaultTimeout(ms)` 修改。超时关闭会发出 `closed(id, 1)`，并发送 D-Bus `NotificationClosed` 信号；用户关闭是 `2`，`CloseNotification` 是 `3`。`replaces_id` 指向不存在的通知时会分配新 id。

官方桌面的 `notification.list[]` 已导出 `appName`、`appIcon`、`actions`、`hints`、`expireTimeout`、`replacesId`、`closed`、`reason`；当前面板只显示 `title`/`content`，不区分活动与历史。关闭后的通知留在列表里作为历史；面板项的删除对活动通知先 `close(id, 2)` 再移除，对历史项直接移除；清空按钮逐项执行同样的删除逻辑。

### portal

xdg-desktop-portal 后端（`org.freedesktop.impl.portal.desktop.myde`）。当前实现 `FileChooser` 的 `OpenFile` / `SaveFile` / `SaveFiles`，`Screenshot` 的 `Screenshot` / `PickColor`，以及权限对话框 `Access`；由系统的 xdg-desktop-portal 前端转发，桌面只负责弹窗和返回用户选择。

```typescript
const portal = MSysApi.portal;

portal.on("fileChooser.request", async (req) => {
    // req.mode: "open" | "save" | "save-many"
    // req.filters / req.choices / req.currentFolder / req.currentName ...
    const places = await portal.browse.places();
    const listing = await MSysApi.nativefs.list(req.currentFolder ?? places[0].path);
    const entries = listing.entries;

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

- 目录枚举用 `MSysApi.nativefs.list`；portal 自带的 `browse` 也保留 `list` / `stat` / `places` / `home` / `matchFilter`，不提供 `readFile`
- `accept` 的路径由后端校验：打开要求存在，保存要求父目录存在、文件本身可以不存在
- `parent_window` 用 xdg-foreign 导出的句柄解析（`server.windows.lookupExport`）；应用没导出或句柄失效时，文件选择器挂到当前聚焦窗口；模态按请求的 `modal` 处理，由桌面用自己的窗口遮挡
- 需要系统安装 xdg-desktop-portal，并安装 `assets/portal` 里的 `myde.portal` 和 `myde-portals.conf`；会话设置 `XDG_CURRENT_DESKTOP=MyDE`。开发测试用 `XDG_DESKTOP_PORTAL_DIR` 指向 `assets/portal/portals`，不要改系统配置
- 默认启动私有 dbus 和 xdg-desktop-portal，MyDE 启动的应用会连到私有总线，不影响宿主 portal；用 `--no-internal-portal` 或 `MYDE_INTERNAL_PORTAL=0` 关闭，测试实例默认关闭
- 总线归属用 `--bus-mode=internal|mixed|external` / `MYDE_BUS_MODE` 选择，默认 `mixed`：`internal` 连输入法也走私有总线，`mixed` 只有输入法走宿主，`external` 不启动私有总线、全部走宿主

### screenshot

截取桌面输出（所有窗口、壁纸、面板，不包含系统光标）。需要 Electron 渲染进程。

```typescript
// 整个桌面；HiDPI 下 png 的实际像素尺寸会大于 CSS 尺寸
const image = await MSysApi.screenshot.capture();
// 只截一块区域（CSS px，相对页面左上角）
const area = await MSysApi.screenshot.capture({ rect: { x, y, width, height } });
// 写到 <Pictures>/Screenshots，重名自动加序号
const saved = await MSysApi.screenshot.save(image); // { path, uri }
```

portal 的 Screenshot 后端：

```typescript
portal.on("screenshot.request", async (req) => {
    // req.interactive / req.target / req.permissionStoreChecked
    const image = await MSysApi.screenshot.capture({
        rect: req.target === "active-window" ? activeWindowRect() : undefined,
    });
    const result = await req.accept(image, { directory: "/home/me/Pictures/Screenshots", name: "shot.png" });
    // if (!result.ok) await req.fail(result.error)
});

portal.on("screenshot.pickColor", async (req) => {
    // 等用户点一个像素，返回 sRGB 0..1
    await req.accept([0.2, 0.4, 0.8]);
});
```

- 没有 `screenshot.request` 监听者时，后端直接截全屏并保存，应用无需桌面配合也能用
- `accept` 由后端把 PNG 写到图片目录（缺省 `<Pictures>/Screenshots`）并返回 `file://` URI；`cancel()` = 用户取消，`fail()` = 内部错误
- 截屏目标默认只广告 `screen`。桌面能处理窗口/区域选择时，在收到请求前调用 `portal.setScreenshotTargets(["screen", "window", "area", "active-window"])`
- `PickColor` 需要桌面自己做取色 UI；没有 `screenshot.pickColor` 监听者时请求失败
- 前端只有在配置了 `Access` 后端时才会提供 Screenshot portal，所以 `myde.portal` 里两个接口必须一起声明

### access

前端的权限对话框。需要用户确认时发出 `access.request`：

```typescript
portal.on("access.request", async (req) => {
    // req.title / req.subtitle / req.body / req.denyLabel / req.grantLabel / req.icon / req.choices
    const allow = await showDialog(req);
    if (allow) await req.accept({ remember: "true" });
    else await req.deny();
});
```

没有 `access.request` 监听者时默认允许（权限记录与控制后续在 myde 侧做）；`accept()` = response 0，`deny()` = response 1。


### polkit

polkit 认证前端 agent。主进程启动最早阶段会拉起一个 helper 进程（在 Electron 把主进程搬进 `app-*.scope` 之前），helper 留在登录会话里注册会话级 agent；需要用户认证时 polkitd 调用 agent，事件经主进程转到桌面，密码等输入再回传。PAM 由 `polkit-agent-helper-1`（socket 激活或 setuid helper）完成，API 不包含 UI。`MYDE_POLKIT_HELPER=0` 可关闭 helper。

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
- helper 注册会话级 agent，覆盖会话内所有进程（包括应用派生的子进程）；helper 不在会话里（例如从没有 logind 会话的环境启动）时，会话按 polkitd 的方式查找（PID → 用户 display session → `XDG_SESSION_ID`），失败则退化为按进程（`unix-process`）注册，`runApp` 启动的应用会再按应用 pid 补注册
- 只有桌面模式（`runAsDesktop`）启动 helper；窗口模式的认证交给宿主桌面，避免抢占宿主 agent
- 认证依赖 `polkit-agent-helper-1`（`/run/polkit/agent-helper.socket` 或带 setuid 的 helper）
- 初始化失败（无 system bus、无 logind、无可用 helper）时只告警，`MSysApi.polkit` 保持 `undefined`；polkitd 重启后会自动重新注册

### verifyUserPassword

判断当前用户输入密码是否正确，用于锁屏，底层是pam

多次错误会导致验证锁定（视pam设置而定）

### tray

拖盘

托盘项新增/移除发出 `new` / `remove`，菜单变化发出 `menuUpdate`，图标、标题等属性变化发出 `changed`

`init()` 会在当前会话总线上提供 `org.kde.StatusNotifierWatcher`（内部总线模式下由 MyDE 自己承担 watcher；外部已有 watcher 时排队并使用已有的那个），应用通过 `RegisterStatusNotifierItem` 注册托盘项；项所属连接断开后自动移除。

### power

电量获取，包括笔记本电池、蓝牙设备电源等

监听 UPower 的 `PropertiesChanged` 和 `DeviceAdded`/`DeviceRemoved`：设备属性变化时 `powerDevice` 发出 `changed`，设备增减时 `power` 发出 `device-added`/`device-removed`，桌面可据此实时刷新电量

`powerDevice.isCharging()` 返回是否正在充电

### powerProfiles

性能模式，来自 power-profiles-daemon。`init()` 会依次尝试新版 `org.freedesktop.UPower.PowerProfiles` 和旧版 `net.hadess.PowerProfiles`，都不可用时返回 `false`

`getProfiles()` 返回当前机器支持的模式（通常是 `power-saver` / `balanced` / `performance`），`getActiveProfile()` / `setActiveProfile()` 读写当前模式，外部切换时发出 `changed`

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

默认输出/输入设备变化（插拔、连接蓝牙、手动切换）会发出 `defaultDeviceChange`，参数是 `"sink"` / `"source"` 和新默认设备的 `id`（没有默认设备时为 `undefined`）

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

管理器 (`input`) 事件：`"deviceAdded"` `(info: DeviceInfo)`、`"deviceRemoved"` `(path: string)`、`"error"` `(error)`。热插拔由 Rust 侧 udev 监听推送，拔出也会在读取返回 `ENODEV` 时发现；`device_list` 是完整快照，不在列表里的设备按已移除处理

方法：

- `input.getDevices()` / `input.getDevice(path)` / `input.isInitialized()` / `input.destroy()`
- `input.getAccessMode()`（实际：`"logind"` / `"direct"` / `"none"`）/ `input.getAccessError()`（回退 direct 时 logind 的失败原因）
- `dev.startReading()` / `dev.stopReading()` / `dev.isReading()`
- 方法返回 `Result`：`{ ok: true, value }` 或 `{ ok: false, error: { code, message, detail? } }`，不会抛出异常

按键码为 Linux evdev 键码（如 30=KEY_A、272=BTN_LEFT），浏览器 `e.code` 可用 `MInputMap.mapKeyCode` 转换

权限要求：logind 模式下只需从登录会话（TTY/显示管理器）启动；找不到会话时还会用环境变量 `XDG_SESSION_ID` 定位登录会话（Electron 会把主进程移进 `app-*.scope`，此时按 PID 查不到会话）。回退到 direct 时用户需要能读 `/dev/input/event*`（`input` 组或 `uaccess` 规则，`script/input_access.sh` 可一键配置），否则设备列表为空或 `errors` 提示 Permission denied。VT 切走时 logind 会让读取暂停，切回后用新的 fd 继续。

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

- `UniPointerEvent`：`kind: "pointer"`，`type: "move" | "down" | "up" | "wheel"`，`x`/`y`（视口坐标），`button?`（down/up，0左 1中 2右），`pointerType?`（"mouse"/"touch"/"pen"），`pointerId?`，`isPrimary?`（同一指针类型中的主指针，缺省 true；多指触摸只有第一根为 true），`deltaX?`/`deltaY?`/`deltaMode?`（wheel），`wheelSource?`（"wheel"/"finger"/"continuous"）、`value120X?`/`value120Y?`（高精度滚轮刻度，1/120 格）、`ctrlKey?`（DOM wheel 的 Ctrl 状态；window 模式宿主用 Ctrl+wheel 合成 pinch）、`scrollEnd?`（连续滚动抬手），`target?`（指定派发目标，缺省按坐标命中测试）
- `UniKeyEvent`：`kind: "key"`，`type: "down" | "up"`，`code`（evdev 键码），`webCode?`（DOM `KeyboardEvent.code`，缺省由 evdev 码反查），`key?`（DOM `KeyboardEvent.key`，缺省按美式布局 + 修饰键推导），`repeat?`，`target?`（缺省为当前聚焦元素）
- `source`："dom"（DOM 原生事件）或 "evdev"（input api），聚合层用它区分/去重来源

行为细节：

- 左键按下后抬起才合成 `click`，并补齐聚焦（最近的 `input, textarea, select, [tabindex]`）；按钮位掩码按指针分开维护（多指互不影响），修饰键（Shift/Ctrl/Alt/Meta、CapsLock）状态由 api 自己维护
- `pointerover/out/enter/leave`、`mouseover/out/enter/leave` 在目标变化时由 api 补齐（`source` 为 `"dom"` 时跳过，浏览器已经生成过原生 hover 事件）；`mousedown/up`、`auxclick`、`dblclick`、`contextmenu` 不模拟
- 多指触摸按 `pointerId` 各自产生独立的 pointer 事件（第一根 `isPrimary`），按键状态也按指针分开维护，一根手指抬起不会清掉另一根的 buttons
- 触摸的 `click` 只在单指接触（这一轮没有出现两指以上）且主指针抬起时合成，多指手势（长按、双指缩放等）由交互层自己根据 pointer 事件处理
- 合成事件没有浏览器默认行为：按键派发后未被 `preventDefault` 时补齐文本输入（`input`/`textarea`/contenteditable 的插入、Backspace、Delete）；滚轮派发后未被 `preventDefault` 时滚动最近的可滚动祖先，原生 `overflow: auto/scroll` 容器也能滚动
- DOM 操作通过宿主接口 `InputSimHost`（`targetAt`/`activeTarget`/`focus`/`dispatch`）访问，默认实现 `domInputSimHost()` 操作真实 DOM，纯 node 环境可 `new inputSim(host)` 注入自定义宿主

聚合层参考实现见 `desktop/official`：`main.ts` 的"输入聚合层"完成聚合/融合/分发——window capture 捕获真实 DOM 事件（只收 `isTrusted`，合成事件不回流防环）归一化，`useEvdevDevice` 解码 input api 事件（EV_SYN 帧合并、相对位移积分、绝对轴小数映射、滚轮换算、按键分流，判定/换算工具在 `input_evdev.ts`），统一传入本 api；来源只以 `source` 标记保留类型数据，不做去重。input api 热插拔按 `deviceAdded`/`deviceRemoved` 接入：新设备按 path 注册，移除时解除监听并清掉该设备的共享状态（同 `phys` 的伴随节点还在就保留），同时把该设备还按着的键盘键、鼠标键、触屏接触点和触摸板手势补成抬起/结束，避免模拟层和 Wayland 客户端卡在按下状态。

触摸板（`type === "touchpad"`）的绝对坐标**不直接映射到屏幕**，只用来计算相邻帧位移；`BTN_TOUCH` 只表示手指接触、不是点击（点击走 `BTN_LEFT`）。仓库的 `src/utils/touchpad.ts` 把设备事件封装成 `move`/`scroll`/`scrollEnd`/`pinchStart`/`pinchUpdate`/`pinchEnd`/`holdStart`/`holdEnd`/`multiStart`/`multiMove`/`multiEnd`/`button` 语义事件：单指轻触左键、双指轻触右键、三指轻触中键、双指自然滚动、双指捏合缩放/旋转、按住、轻触后第二下按住拖拽。轻触/拖拽行为对齐 libinput（COSMIC、KWin 都直接使用它）：接触不超过 180ms、位移不超过 1.3mm（按设备分辨率折算，缺失时按默认 DPI）才算轻触；接触中移动超过 1.3mm 或按住超过 180ms 都不点击。轻触在抬手时按下左键，并等 180ms 拖拽窗口：窗口内第二下按住（移动超阈值或保持到超时）沿用按住的左键进入拖拽，抬手结束；第二下快速抬起则按双击处理；没有第二下时窗口结束自动抬起完成点击。双指滚动是连续滚动，转发给 Wayland 时要带 `source: "finger"`（不发离散步进），手指数量变化时发 `scrollEnd` 让客户端补 `axis_stop`。两指先分类再发滚动：质心移动超过 1.5mm 且大于两指距离变化才判为滚动；双指距离相对 begin 变化超过 8% 且不少于 2mm，或夹角变化超过 10° 判为捏合，分类前暂存滚动量；已判为滚动后本轮不再改判捏合，捏合期间滚动继续；`scale` 是相对 begin 的绝对比例，`rotation` 是相对上一次事件的顺时针角度，捏合期间不再发滚动。手指保持不动 300ms、质心位移不超过 2mm 发 hold，移动或换指则取消；官方桌面只把 1-2 指的 hold 转发给应用。三指及以上移动不发滚动，单独发 `multiStart`/`multiMove`/`multiEnd`（即 swipe 语义）；本轮出现过多指后，残留的两指/单指也不再产生滚动、捏合或光标移动，避免抬手不齐时误触双指滚动。手指数变多是允许的（单指→双指滚动→多指手势）；变少时本轮结束，例外是 2→1，剩下的单指继续移动光标。官方桌面把三指手势当作全局快捷键消费（切虚拟屏、总览/启动器），不转发给应用；四指及以上作为 swipe 发给应用。双指捏合和 hold 发给应用。MT-B 用 `slot` + `ABS_MT_TRACKING_ID` 跟踪接触点，没有 tracking id 的旧设备用 `BTN_TOOL_*` 手指数兜底。触摸板常带一个同 `phys` 的伴随鼠标节点，如果那个相对通道真的在出事件，则忽略触摸板的绝对位移，避免双倍移动。window 模式没有 evdev，宿主会把触摸板 pinch 合成成 `Ctrl+wheel`；官方桌面在物理 Ctrl 没按下时把它还原成 pinch 并转发，scale 按 `exp(-deltaY/100)` 累积，物理 Ctrl+wheel 仍按普通滚轮处理。

触屏（`type === "touchscreen"`）的绝对坐标直接映射到视口，MT-B 用 `slot` + `ABS_MT_TRACKING_ID` 跟踪每个接触点：一根手指对应一个 `pointerId`，各自产生独立的 down/move/up，第一根按下的手指 `isPrimary` 为 true。没有 tracking id 的旧设备退回单指 `BTN_TOUCH` 路径。统一输入事件的 `pointerType` 为 `"touch"`，`inputSim` 合成 `PointerEvent` 时保留 `pointerType`/`pointerId`/`isPrimary`，UI 只监听 pointer 事件即可同时响应鼠标、触摸板和触屏，多指手势由交互层处理。

注意被吞掉的原生事件只对**聚合层之后**注册的监听不可见：排在它之前的 window capture 监听仍会先收到原生事件，而原生 `click` 不受 `preventDefault` 影响（它不是兼容鼠标事件），且派发在 inputSim 合成的 `click` 之后——一次物理点击就被处理两遍，出现「合成 click 打开弹窗 → 原生 click 立刻关闭」的点击无反应（evdev 来源没有原生事件，只用 evdev 时看不出）。因此：① 吞事件的注册要早于所有 UI 监听（`desktop/official` 把整个「输入聚合层」放在工具栏 plant 循环之前）；② 若确要在它之前注册监听，该监听必须忽略 `isTrusted` 事件（`desktop/official` 的 Tools 关闭弹窗监听保留了这条守卫）。

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
    appid: string; // 该窗口自己的 set_app_id；同一连接里的窗口可以不同
    title: string;
    decorated: boolean; // xdg-decoration 是否协商为 server_side，桌面据此画标题栏
    rect: { x: number; y: number; w: number; h: number };
    scale: number; // 输出缩放：显示尺寸 = rect × scale，输入坐标 = 桌面坐标 ÷ scale
    states: { activated: boolean; maximized: boolean; minimized: boolean; fullscreen: boolean };
    parent: string | null; // 父窗口（xdg_toplevel.set_parent）；顶层窗口为 null
    modal: boolean; // 模态提示（xdg-dialog-v1）；只在有 parent 时有意义
    minSize: { width: number; height: number }; // set_min_size；0 = 该轴不限制
    maxSize: { width: number; height: number }; // set_max_size；0 = 该轴不限制
    renderId: string; // render.getXdgSurfaceEle(info.renderId)
}
```

`minSize` / `maxSize` 是 surface 逻辑尺寸，桌面缩放窗口时按 `× scale` 换算；`min>max`
或负数由 server 按协议报 `invalid_size`。桌面自己的兜底最小尺寸（200×150）取两者较大值。

`parent` / `modal` 是**客户端声明的**父子与模态信息：位置、层级、是否阻塞输入全归桌面。
父窗口销毁时 server 按协议把子窗口接到祖父窗口（没有祖父就置 null）并补发 `window.changed`，
所以桌面不要缓存过期的父 handle。

`decorated` 为 true 时，客户端已把装饰交给桌面：桌面画标题栏/边框，客户端不再画 CSD；
标题栏高度属于桌面布局，`rect`/configure 仍只表示客户端内容尺寸。为 false 时不要再加一层装饰。

`rect` 的 `w`/`h` 是客户端 `set_window_geometry` 声明的 **surface 逻辑尺寸**；客户端不声明时按协议退化为 surface 尺寸
（xwayland-satellite 就属于这种，靠 size 变化补发 `window.changed`）。`x`/`y` 是 surface 局部的几何偏移，
**不是屏幕位置**（摆放由桌面负责，渲染时几何原点即窗口元素左上角）。
桌面显示尺寸是 `rect × scale`：渲染侧会按 scale 放大窗口 DOM，桌面输入转发前要除回 scale。
命中检测用 `server.windows.hitTest(handle, p)`（窗口元素的局部坐标）：它包含 popup 树、subsurface
与 input region，popup 超出顶层窗口范围时也能命中；只比较 `rect` 会漏掉超出的 popup。

### 事件

```typescript
server.on("window.created", (info: WindowInfo) => {});
server.on("window.changed", (info) => {}); // rect/states/title/appid/decorated 任一变化，payload 自包含
server.on("window.closed", (handle) => {});
server.on("window.startMove", (handle) => {});
server.on("cursor.changed", (clientId, state: CursorState) => {});
server.on("clipboard.changed", (change, reason) => {});
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
server.windows.lookupExport(handle); // xdg-foreign 导出句柄 → WinHandle | undefined
server.cursor.get(clientId); // CursorState
await server.request("window.get", handle); // WindowInfo，未知 handle 会 reject
await server.request("window.getBounds", handle); // Rect
```

`lookupExport` 用于把 xdg-desktop-portal 请求里的 `parent_window` 解析回窗口：应用用
`xdg-foreign` 导出窗口得到不透明句柄，portal 原样转给后端；没有 valid 句柄时返回 `undefined`，
桌面可退回“当前聚焦窗口”。句柄随导出对象销毁或窗口关闭失效。

### 窗口命令

```typescript
server.notify("window.focus", handle);
server.notify("window.blur", handle);
server.notify("window.close", handle);
server.notify("window.setBox", handle, { width, height }); // 只记盒子，不发 configure
server.notify("window.setSize", handle, { width, height });
server.notify("window.maximize", handle, { width, height });
server.notify("window.unmaximize", handle, { width, height });
server.notify("window.fullscreen", handle, { width, height });
server.notify("window.unfullscreen", handle, { width, height });
server.notify("window.minimize", handle);
```

`window.maximize` 与 `window.fullscreen` 互斥（进入一个会清掉另一个），分别对应
`xdg_toplevel.configure` 的 `maximized` / `fullscreen` state。退出全屏会恢复进入前的
最大化状态（从最大化进入的全屏，退出后仍是最大化）。客户端自己调用
`set_fullscreen` / `unset_fullscreen` 时，桌面会收到 `window.changed`（看 `states.fullscreen`），
再由桌面用 `window.fullscreen` / `window.unfullscreen` 下发最终盒子。`wm_capabilities` 已声明
`minimize` / `maximize` / `fullscreen`。

官方桌面（`desktop/official`）对全屏的处理：舞台（`windowElWarp`/`windowEl`）始终铺满视口，
工具栏占位只体现为窗口可用区（最大化尺寸、普通窗口居中、`surfaceBounds`）的内缩，不再限制
舞台 DOM。全屏时只是让工具栏**模糊淡出**，全屏窗口按整块输出 configure；进入全局预览、
或切到没有全屏窗口的虚拟屏时工具栏原样恢复。`Super+F` 切换当前聚焦窗口的全屏。总览 grid
与顶部搜索栏按工具栏占位内缩，避免被顶部工具栏覆盖。

`window.focus` / `window.blur` 是**键盘焦点的唯一入口**——`wl_keyboard.enter/leave`、text-input 的
enter/leave、剪贴板 selection 归属都跟它走。指针 hover **不**自动切键盘焦点，要不要 focus-follows-mouse
完全由桌面自己决定（想跟随就在 hover 时调 `window.focus`）。重复 focus/blur 会被内部去重，
与「目标 focus + 其余 blur」的全量循环配合时与遍历顺序无关。

### 父子窗口

`WindowInfo.parent` 是客户端 `xdg_toplevel.set_parent` 声明的父窗口，`modal` 来自 `xdg-dialog-v1`
（没有 `parent` 时无意义）。服务器只负责**记录与转发**：子窗口怎么摆、是否挡住父窗口输入，
都是桌面的政策。

官方桌面（`desktop/official`）的做法：

- 子窗口**不占虚拟屏**：它叠在父窗口所在屏的上面，初始居中覆盖父窗口并夹在舞台内；
  客户端没有声明几何时桌面用 `configure(0×0)` 让客户端自己选尺寸（对话框通常有固有尺寸）。
- 顶层窗口仍按 800×600 起步；子窗口出现时视图切到父窗口所在的屏。
- 指针/滚动按「子窗口先」命中；`modal` 子窗口存在时，父窗口的指针、滚动、键盘都被挡住，
  点父窗口只会把焦点收回对话框并闪一下边框。焦点入口（`focusWin`）也会自动落到最内层模态子窗口。
- 子窗口跟随父窗口拖动；用户手动拖过子窗口后不再自动居中。父窗口关闭时，挂在它上面的
  桌面内部窗口（文件选择器）一起关闭，客户端子窗口由 server 的父关系更新兜底。
- 缩放窗口时尊重客户端的 `minSize` / `maxSize`（对话框常见的固有尺寸下限）。
- 总览里子窗口跟着父窗口那张卡片缩放，不单独成卡，也没有自己的关闭按钮。

桌面自己的内部窗口（文件选择器、设置等）走同一套映射：`openInternalWindow({ parent, modal })`
有 `parent` 时同样覆盖在父窗口上。官方桌面的文件选择器把 portal 请求的 `parent_window`
经 `server.windows.lookupExport` 解析成父窗口（解析不到时退回当前聚焦窗口），并按请求的
`modal` 决定是否挡住应用。

### 输入事件

`input.*` 末尾都可以带可选的 `seat`（缺省 `"seat0"`）：多光标 / 多 seat 时按**人**选择，
是选择器**不是广播**——同一事件发给多个 seat 会被客户端当成几把同步光标（点击双发、文本双打）。
第二个光标（如远程协作者）就 `server.notify("input.pointer", handle, ev, "seat1")`。

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
// 触摸板语义手势（pointer-gestures-unstable-v1）：begin → update* → end，hold 只有 begin/end。
// delta 按手指方向（不做自然滚动翻转）；scale 相对 begin；rotation 是相对上一次的顺时针角度。
server.notify("input.gesture", handle, { type: "pinch", phase: "begin", fingers: 2 });
server.notify("input.gesture", handle, { type: "pinch", phase: "update", deltaX, deltaY, scale, rotation });
server.notify("input.gesture", handle, { type: "pinch", phase: "end", cancelled: false });
server.notify("input.gesture", handle, { type: "hold", phase: "begin", fingers: 1 });
server.notify("input.gesture", handle, { type: "swipe", phase: "begin", fingers: 4 });
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
`input.scroll` 只在该 seat 有指针焦点时下发；`input.gesture` 按目标窗口下发，桌面要先按指针落点
选出窗口并锁住目标——所以**先 `window.focus` 再注入按键**。

触摸板连续滚动按规范只发 `axis`（连续、无离散步进）；`axis_value120` 是滚轮通道，只随 `wheel` 发送。滚轮的高精度事件可以同帧发 `axis` + `axis_value120`（v8+）或 `axis` + `axis_discrete`（v5-7）。自然滚动通过 `axis_relative_direction`（v9）告诉客户端物理方向。客户端之间轴值换算差异（Chromium 的 ×12、GTK3/Firefox 的 ÷10×40 等）属于客户端行为，官方桌面只提供全局/触摸板速度倍率，不按 appid 改轴值。

键盘与剪贴板是**连接级**的：同一客户端有多个窗口时按 `clientId` 去重后再发，否则会重复收键。

### 剪贴板与数据中转

server 不保存剪贴板字节，只记录“当前 selection 是哪个源、有哪些 mime”。字节、历史、持久化都在桌面：

```typescript
// 客户端复制：server 先给 token；桌面按需读取自己要存的 mime（立刻读，source 退出后就没了）
server.on("clipboard.changed", (change, reason) => {
    if (!change) {
        if (reason === "sourceGone") {
            // 源客户端退出了；桌面可以把最后一条放回剪贴板
            server.notify("clipboard.set", { id: "last", mimes: ["text/plain;charset=utf-8"] });
        }
        return;
    }
    void server.request("clipboard.read", change.token, "text/plain;charset=utf-8").then((bytes) => {
        // 存历史 / 更新中转站；bytes 是 Uint8Array | null
    });
});

// 桌面作为源：只声明 id 和 mime，不把字节交给 server
server.notify("clipboard.set", { id: "item-1", mimes: ["text/plain;charset=utf-8"] });
server.respond("clipboard.requestData", (id, mime) => items.get(id)?.bytes.get(mime) ?? null);

// 键盘焦点进入窗口时 offer 当前 selection
server.notify("clipboard.offer", handle);
```

- 应用 → 应用粘贴时，server 直接把目标 `receive` 的 fd 转给源客户端的 `wl_data_source.send`，**字节不经过桌面**。
- 桌面 → 应用时，server 在 `receive` 时用 `clipboard.requestData` 向桌面要（3 秒超时，超时关 fd）。
- `clipboard.set(null)` / `clipboard.clear()` 清空；`clipboard.changed(null, "cleared")` 是客户端主动清空。
- 读取失败、源已退出、token 过期都返回 `null`，桌面按“没有数据”处理。

拖拽（drag-and-drop）走 Wayland 的 `wl_data_device.start_drag`。源客户端开始拖拽后，桌面通过
`dnd.move` 决定目标窗口，`dnd.drop` 完成投递：

```typescript
server.on("dnd.started", (drag) => {
    // { token, clientId, appid, seat, mimes, actions }
    // 这里可以自动展开中转站弹窗
});
server.notify("dnd.move", drag.token, { handle, x, y });  // x/y 是目标窗口 surface-local 逻辑坐标
server.notify("dnd.move", drag.token, null);              // 离开当前目标
server.notify("dnd.drop", drag.token, { handle, x, y });  // 在目标窗口放下
server.notify("dnd.drop", drag.token, null);              // 窗口外释放（不是取消）
server.notify("dnd.cancel", drag.token);                  // 取消（Esc / 源销毁）
server.on("dnd.finished", (token, reason) => {});         // reason: finished | cancelled
```

`dnd.move` 第一次到达时 server 会撤掉源客户端自己的本地目标，之后由全局会话跨客户端发
`enter/motion/leave/drop`；目标 `receive` 的 fd 直接转给源客户端的 `wl_data_source.send`。
桌面不实现 `dnd.move` 时，同一客户端内的拖拽仍按本地路径工作。

桌面作为拖拽源（从中转站拖出）：

```typescript
const token = await server.request("dnd.start", { id: "item-1", mimes: ["text/plain;charset=utf-8"] }, ["copy"]);
server.notify("dnd.move", token, { handle, x, y });
server.notify("dnd.drop", token, { handle, x, y });
server.respond("dnd.requestData", (id, mime) => items.get(id)?.bytes.get(mime) ?? null);
```

中转站收下客户端拖拽仍走 `dnd.read(token, mime)` + `dnd.cancel(token)`（先读后取消）。
官方桌面把剪贴板历史和中转站做成同一个顶栏工具（`src/clipboard_tool.ts`），`dnd.started` 时自动展开，
指针落在弹窗上松手就收进拖拽分组；条目也可以拖出到应用窗口。

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

推荐用聚合层统一输入：捕获 DOM 原生事件（只收 `isTrusted`，合成事件不回流）与 input api（evdev）事件，区分来源、融合（evdev EV_SYN 帧合并、相对位移积分、绝对轴映射、滚轮换算）后传给 `MSysApi.inputSim` 模拟 DOM 事件。滚轮/触摸板建议在聚合层**直接用统一输入事件的字段转发**给窗口，因为模拟成 DOM `WheelEvent` 会丢掉 `wheelSource`（滚轮还是触摸板）和高精度刻度；其它事件继续消费 DOM 事件即可（两种输入来源走同一条路径）。`desktop/official/src/main.ts` 的"输入聚合层"是完整参考实现。

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

// 应用自带的环境变量（.desktop 里声明的）随启动传下去
serverX.runApp(app.exec, { env: app.env });

// 退出桌面时可选
serverX.stopXwayland();
```

`getDesktopEntries()` 会把 `Exec=env LIBVA_DRIVER_NAME=iHD mpv` 里的 `env A=1` 前缀解析到 `env` 上，并把 `Exec` 还原成真正的命令。`runApp(exec, { env })` 把这些变量合并进子进程环境，放最后，同名变量以它为准。

`runApp()` 启动的子进程会带上 `USER`/`LOGNAME`/`HOME` 等身份变量。以哪个用户启动由桌面进程自身身份决定，不依赖启动环境里的 `USER`：这样在应用内再启动的桌面（例如从 myde 原生模式的终端里启动窗口模式桌面）也能继续启动应用，而不会因为缺少 `USER` 退化成 root 导致 `spawn EPERM`。

`startXwayland()` 会找一个空闲的 `:N`，启动 `xwayland-satellite :N`，等待 `/tmp/.X11-unix/XN` 出现；可用 `MYDE_XWAYLAND_SATELLITE` 指定 binary 路径。

`runApp()` 会读取应用的 stdout/stderr，写入 `$XDG_STATE_HOME/myde/logs/apps/<可执行名>-<pid>.log`，每行带时间和 `[out]`/`[err]` 来源。管道必须被读取：应用写满 64 KiB 后会阻塞在 `write()`，看起来像窗口画面卡死。日志文件超过 10 MiB 会轮转，最多保留最近 50 份。

## 开发提示

使用不了`require`，应该使用打包器打包成一个js文件。如果有复杂计算任务，使用 woker+wasm，如果需要其他系统 api，需要修改引擎，请提交 issuse 或 pr。

不建议使用网络加载外部内容。

避免复杂循环导致页面卡死，必要时添加`await scheduler.yield()`。

禁止了浏览器光标显示，需要自己实现绘制光标

不使用 title 属性，或者借助 title 实现自己的 tooltip

## 参考

- [desktop 简单演示](./example)
