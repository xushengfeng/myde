## 支持的协议

以下协议的错误处理均未实现

- wayland
    - wl_display
    - wl_registry
    - wl_callback
    - wl_compositor
    - wl_shm_pool 部分
    - wl_shm 部分
    - wl_buffer
    - wl_surface 部分
    - wl_seat（`pointer` / `keyboard` / `touch`；registry **一次广播两把** `seat0`/`seat1`，见 `host/server.ts` 的 `initWaylandProtocols`）
    - wl_pointer 部分
    - wl_keyboard 还没有 repeat
    - wl_touch（down/move/up/frame/cancel；shape/orientation 未发送，release v3+）
    - wl_output 只是硬编码，还没有添加硬件处理
    - wl_region
    - wl_data_device 部分（selection + 同 client drag-and-drop）
    - wl_data_device_manager 部分
    - wl_data_offer 部分（selection / drag offer）
    - wl_data_source 部分
    - wl_subcompositor
    - wl_subsurface（同步模式按提交顺序缓存，父 surface 生效时依次应用；place_above/place_below、
      set_position 同样是父提交时应用的挂起状态；set_sync/set_desync 立即生效）

- xdg-shell
    - xdg_wm_base
    - xdg_surface
    - xdg_toplevel 部分（maximize / fullscreen / minimize；fullscreen 忽略 output 参数，单屏，
      退出全屏恢复进入前的最大化状态；`set_parent` 记父子关系，父窗口销毁时子窗口接到祖父窗口；
      `set_min_size` / `set_max_size` 进 `WindowInfo.minSize/maxSize`，负值和 min>max 报 `invalid_size`。
      未实现 `show_window_menu` / `resize` / `set_minimized`）
    - xdg_popup 部分（`reposition` 按新 positioner 重算位置，回 `repositioned` + 新的 configure 序列）
    - xdg_positioner 部分

- xdg-dialog-v1
    - xdg_wm_dialog_v1
    - xdg_dialog_v1
    - 只把 `set_modal` / `unset_modal` 映射到 `WindowInfo.modal`；父窗口输入是否阻塞由桌面决定

- xdg-foreign-unstable-v1 / v2
    - 只实现导出侧（`zxdg_exporter_*` / `zxdg_exported_*`），不广播 importer 的 global
    - 导出句柄经 `toplevelExported` / `toplevelUnexported` 交给 server，
      桌面用 `server.windows.lookupExport(handle)` 把 portal 的 `parent_window` 解析回窗口

- xdg-decoration-unstable-v1
    - zxdg_decoration_manager_v1
    - zxdg_toplevel_decoration_v1
    - 尊重客户端 `set_mode`：`server_side` 时桌面绘制标题栏（`WindowInfo.decorated`），
      `client_side` 时保留客户端 CSD；未表态默认 `server_side`。

- pointer-gestures-unstable-v1
    - zwp_pointer_gestures_v1
    - zwp_pointer_gesture_swipe_v1
    - zwp_pointer_gesture_pinch_v1（scale 相对 begin，rotation 相对上一次 update，单位度）
    - zwp_pointer_gesture_hold_v1
    - 手势对象挂在客户端创建的 `wl_pointer` 上，事件发给该 seat 的指针焦点 surface；
      焦点不在目标窗口时退回目标窗口主 surface。桌面用 `input.gesture` 驱动，
      `begin`/`end` 的 serial、time、surface 由 server 补。

- linux-dmabuf-v1
    - zwp_linux_dmabuf_v1 部分，只支持 LINEAR modifier；32 位 RGB(A)
      （ARGB/ABGR/XRGB/XBGR/RGBX/BGRX/RGBA/BGRA）、NV12、NV16、P010。不透明格式必须
      广播：Mesa 客户端请求 `EGL_EXT_present_opaque` 时，缺了对应不透明格式会让
      `eglCreateWindowSurface` 返回 `EGL_BAD_MATCH`（Blender 因此启动即退出）
    - zwp_linux_buffer_params_v1 部分
    - zwp_linux_dmabuf_feedback_v1

- presentation-time
    - wp_presentation
    - wp_presentation_feedback（presented 的 refresh 用固定 120Hz，客户端据此确定刷新率）

- viewporter
    - wp_viewporter
    - wp_viewport

- fractional-scale-v1
    - wp_fractional_scale_manager_v1
    - wp_fractional_scale_v1
    - 与 `wl_surface.set_buffer_scale` / `wl_output.scale` 配合：surface 仍是逻辑坐标，
      buffer 按 `preferred_scale / 120` 放大，窗口 DOM 尺寸按输出 scale 放大。

- ext-background-effect-v1
    - ext_background_effect_manager_v1（bind 时广播 `blur` 能力）
    - ext_background_effect_surface_v1
    - `set_blur_region` 是双缓冲的 surface 状态（`WaylandSurfaceData.blurRegion`），随 commit /
      同步子 surface 事务生效；NULL region 与 destroy 都在下一次 commit 移除。
    - 渲染层（`renderTools.setBlurRegion`）把区域解析成互不重叠的裁剪路径，用 `backdrop-filter`
      垫在 surface 画布下面；没有 buffer（未 attach / `attach(nil)`）时不显示。
      模糊强度由合成器决定，当前为 16 surface px（渲染时乘输出 scale，`render_tools_el.ts`）。

- xdg-output-unstable-v1
    - zxdg_output_manager_v1
    - zxdg_output_v1
    - 单屏，`logical_position` 固定 (0, 0)；`logical_size` 为物理模式按 transform 转置后除以
      输出 scale。Chromium / Electron 用物理尺寸与逻辑尺寸的比值反推显示缩放，
      `wl_output.scale` 只有整数，分数缩放必须靠这个协议。

- text-input-unstable-v1
    - zwp_text_input_v1 部分
    - zwp_text_input_manager_v1

- text-input-unstable-v3
    - zwp_text_input_v3 部分（delete_surrounding_text 未实现）
    - zwp_text_input_manager_v3

v1 和 v3 是竞争协议，单客户端内仲裁：按协议（manager）一侧计，后激活者胜出（zwp_text_input_v1.activate / zwp_text_input_v3.enable 抢占），文本只发给持有对象，v3 的 enter/leave 跟随**该把 seat** 的键盘焦点（`get_text_input` 的 seat 参数记在 `TextInputV3Data.seat`，跨 seat 的输入直接忽略）。

## 合成策略：提交不丢 damage，上屏按刷新节流

窗口闪一帧透明比掉一帧显眼得多，但**丢内容**比丢呈现严重得多：damage 是「相对上一次
commit」的，被丢掉的提交不会有人再补画。所以像素链路分成两层：

- **提交 = 只合成**：每个 `wl_surface.commit` 都按顺序把它的 damage 贴进 surface 画布，
  不做「一个 rAF 只合成一帧」的丢弃。同一 surface 的提交走一条串行链
  （`enqueueSurfaceStates`）：dmabuf 导入是异步的，乱序完成会让前面的 damage 被后面的
  覆盖。串行同时就是背压——buffer 要等它的像素进画布才 `release`，客户端提交再快也会
  卡在自己有限的 buffer 上，显存不会按帧累积。
- **呈现 = 每 rAF 一次**：同一 surface 每帧最多上屏一次（`schedulePresent` / `presentSurface`），
  期间更晚的提交只更新画布并覆盖待呈现帧。rAF 被宿主节流时用 50ms 定时器兜底，
  迟到的呈现只会晚一拍，不会停在旧内容，也不会让 buffer 永远等不到归还。
- **转换/导入失败**（shm/dmabuf 格式不支持、EGL 导入失败、fd 失效）只打日志并跳过本次提交的像素，
  画布保留上一帧；同时照常 `wl_buffer.release` 和跑 frame callback，客户端不会卡住。
  这是唯一会丢内容的地方，属于「宁可掉帧也不要透明」的兜底。
- **canvas 尺寸变化**不清成透明：先把上一帧拉伸铺满新尺寸，再让新帧的 damage 覆盖。
  客户端重绘前最多是短暂变形，不会露出壁纸。
- **`renderSeq` 只用于取消**：`unmap` / surface 销毁时推进序号，让还在异步导入的旧提交
  过期，避免解绑后又被画回来；正常提交按队列顺序应用，不会互相取代。
- **VideoFrame/导入资源等呈现之后再释放**：Canvas2D 没有完成事件（Chromium 可能只引用
  纹理、延迟栅格化），以「呈现后的下一帧」为界（`pendingReleases`）。稳定副本（GPU 拷贝 /
  CPU 转换）可以立刻归还客户端 buffer；零拷贝要等到那时才 `release`。
- **默认**把 dmabuf 先 GPU 拷贝到 myde 自己的 ARGB8888 dmabuf，再导入 Electron：
  `VideoFrame` 不再引用客户端的 dma-buf，客户端复用 buffer 时不会闪旧帧，也让「何时可以
  归还客户端 buffer」变成确定的事。myde-drm 按尺寸复用一个小 buffer 池，池子按**内存预算**
  自动分配（默认 256MB，`MYDE_DRM_POOL_MB` 可调），一个拷贝占用的槽位要等导入纹理释放后
  才归还；槽位按 client+surface 隔离，别的窗口只能回收空闲 ≥1s（`MYDE_DRM_STEAL_IDLE_MS`）
  的槽位，避免 A 窗口闪出 B 窗口的内容；4K 帧约 33MB、1080p 约 8MB，上限随窗口大小自动
  变化；池满时回退到零拷贝。`MYDE_DMABUF_COPY=0` 可强制零拷贝（接受「客户端 buffer 何时
  被改写」不可观测）。
- **不能拷贝的直接导入**：myde-drm 的转换器只支持单平面 32 位 + LINEAR；NV12/NV16/P010
  和带 tiled modifier 的 buffer 直接交给 Electron 导入，不尝试转换（否则这类客户端每帧
  都要抛一次错并打日志）。按格式/modifier 预先判断，不拿异常探测。
- **转换默认只 `glFlush`**，依赖 dma-buf 隐式 fence 与 Electron 的导入同步，避免每帧
  `glFinish` 把 JS 主线程按帧等 GPU。驱动对隐式 fence 支持不好时（整块透明/旧帧）用
  `MYDE_DRM_GPU_FINISH=1` 让转换器改回 `glFinish`。

## 对外 API（桌面侧）

桌面只从 `src/wayland/index.ts` 拿东西：`createServer({ render, socketDir })`、`Client` 接口、
以及 `api.ts` 里的类型（`ServerEvents` / `ServerNotifyMap` / `ServerRequests` / `WindowInfo` /
`WinHandle` / `CursorState` …）。

- **事件**：`server.on("window.created" | "window.changed" | "window.closed" | "window.startMove" |
  "cursor.changed" | "clipboard.changed" | "dnd.started" | "dnd.finished" | "client.opened" | "client.closed", …)`
  ——`window.changed` 覆盖 rect / states / title / appid / decorated / `parent` / `modal`
- **查询**：`server.windows.list() / get() / preview() / hitTest() / lookupExport()`、`server.cursor.get(clientId)`、`await server.request(…)`
  （`hitTest(handle, p)` 走 xdg 域的完整几何，含 popup/subsurface/input region，供桌面决定指针事件发给哪个窗口；
  `lookupExport(handle)` 把 xdg-foreign 导出的句柄解析成窗口身份，portal 的 `parent_window` 用它）
- **命令**：`server.notify("window.focus" | … | "input.pointer" | …, handle, …)`
  → `host/server.ts` 按 handle 反查 `(client, winId)` → 协议模块的 `actions` 表，组包在协议文件里。
  `input.pointer|scroll|gesture|touch|key|text` 末尾可带 `seat`（缺省 `"seat0"`，选择器语义、不广播）：
  桌面喂第二把光标（如远程协作者）时传 `"seat1"`。
- **应答**：`server.respond("surfaceBounds.request", () => ({ width, height }))`
- **输出**：`server.outputs.get()` / `server.outputs.set({ name, mode, scale, transform })`。
  `scale` 是桌面显示倍率：`WindowInfo.rect` 仍是 surface 逻辑尺寸，桌面显示尺寸 = `rect × scale`；
  输入坐标要反向除回 `scale`。修改后 server 会重发 `wl_output`、`preferred_*` 与 fractional
  `preferred_scale`，并按新 scale 重设窗口 DOM 尺寸。

桌面不接触 Wayland 对象 id：所有命令按全局 `WinHandle` 下发，由 `host/server.ts` 反查
`(client, winId)`。`server.clients` 只留给连接生命周期与调试。用法见 `desktop/readme.md` 的「Wayland 服务器」。

## 测试

`src/wayland/test/` 是端到端测试：起真 Electron 客户端（或真实应用）连本服务端，注入输入/命令，再从客户端回传的日志断言。

自动化测试全部无头：`testRunnerApp` 先启动私有 weston headless + Xwayland，测试客户端连测试桌面自己的 Wayland server，不连宿主 `DISPLAY`/`WAYLAND_DISPLAY`，也不在宿主桌面开窗口。完整桌面（官方桌面等）用 `startDesktopRunner` 走 CDP，见[测试 runner](../test_runner/readme.md)。临时 UI 检查用无头浏览器/无头工具或 `startDesktopRunner` 截图，不要退回宿主显示。

| 文件 | 覆盖 |
| --- | --- |
| `dma-buf.test.ts` | dmabuf 单帧渲染，`preview()` 像素采样 |
| `window.test.ts` | 窗口创建、内容显示、resize、maximize、cursor、关闭 |
| `keyboard.test.ts` | `input.key` 的键码映射与按键序列（按键事件按顺序对账） |
| `pointer.test.ts` | `input.pointer`（move / down / up 三键落点与坐标）、`input.scroll` 滚轮方向、`cursor.changed` |
| `text_input.test.ts` | `input.text` → `zwp_text_input_v3` 的 `commit_string` 落进编辑框 |
| `clipboard.test.ts` | 双向剪贴板：`clipboard.set`/`offer` → `requestData` 回填；客户端 `set_selection` → `clipboard.changed` → `clipboard.read` |
| `dnd_cross.test.ts` | 跨客户端 DnD：A 的选区拖拽 → 桌面 `dnd.move/drop` 到 B → B 的 drop 拿到文字 |
| `popup.test.ts` | 真实 Qt/KDE 客户端（konsole）右键菜单：`xdg_popup` 初始 configure/ack 后提交首帧、`constraint_adjustment` 把菜单约束在窗口内、点击外部收回 grab 并销毁弹层（无 konsole 时跳过） |
| `parent_child.test.ts` | 临时子窗口：Chromium 的 `xdg_toplevel.set_parent` → `WindowInfo.parent`，父窗口关闭后子窗口不再指向已死的 handle |
| `window_close.test.ts` | 客户端断线 / `xdg_toplevel.destroy` 后撤掉 canvas DOM（konsole `--separate`，无 konsole 时跳过） |
| `render_tools.test.ts` | `renderCanvas` 每帧先清空再绘制：半透明/透明帧是替换而不是 source-over 叠加 |
| `viewporter.test.ts` | `wp_viewport` 的 source/destination 跨 commit 持续生效（Chrome popup 用 set_source 裁剪旧内容） |

```bash
npx vitest run src/wayland/test/pointer.test.ts
```

### 手动复现背景模糊（不属于自动测试）

这一节是人工视觉检查，会打开真实窗口，不要把它作为 vitest/CI 用例。需要自动检查画布时，用 `testRunnerApp` 启动客户端并采样 `server.windows.preview()`；临时 UI 检查用 `startDesktopRunner` 截图或其他无头工具。

`test/simple_app` 里的 `background_effect` 是真实 Wayland 客户端：半透明窗口、圆角、
右下角一个 subtract 出来的透明洞（应看到清晰桌面）。在桌面里（`WAYLAND_DISPLAY` 已指向
本服务器）运行：

```bash
cd test/simple_app
cargo run --bin background_effect
cargo run --bin background_effect -- --no-blur   # 对照：不设置模糊区域
```

它会打印协商到的 capability、区域矩形和每帧尺寸。

写法上的四个硬约束（踩过一遍，违反基本跑不起来）：

1. **socket 名每次实例唯一**：`WaylandServer` 默认用 `uniqueSocketName("my-wayland-server")`（pid + 随机后缀），
   多实例不会互相 unlink 或连错服务端；客户端从 `server.socketName` 取 `WAYLAND_DISPLAY`。
2. **`testRunnerApp` 的回调是 `script.toString()` 拼进桌面脚本里求值的**：访问不到本文件的模块作用域，
   计划与常量要写在**回调体内**，再用 `runner.sendData()` 带出来给外层断言（回调里要的工具函数同理，
   比如 `mapKeyCode` 只能在回调外校验回调内写死的键码）。
3. **客户端日志是双层 JSON**：renderer 的 `console.log` 先被 `test/electron_app/start.js` 的 console-message
   包成 `{"data": …}`，再被 `main.ts` 包成 `{"applog": …}`，且一个 chunk 可能含多行。
   统一用 `src/test_runner/applog.ts` 的 `collectAppLogs()` / `logOfType()` 解析，**别按下标取日志行**。
4. **等首帧再注入**：`window.created` 只说明 xdg_toplevel 建好了，页面脚本未必已挂上监听，
   固定 `sleep` 早晚会在慢机器上翻车。`server.windows.preview(handle)` 初始是 1×1 的占位画布，
   `width > 1` 才代表客户端提交了首帧（页面就绪），四个输入测试都是这么等的。

客户端与几何坐标的换算（`pointer.test.ts` 的做法）：`ev.x/y` 相对**窗口几何原点**，几何里还含着 CSD 标题栏，
所以「页面坐标 = 注入坐标 − (几何宽−视口宽, 几何高−视口高)」，两个尺寸都在运行时现取，不写死。
`wl_pointer.axis` 与 DOM wheel 的数值单位也不同（滚轮一格在 `axis` 里是 10、在 DOM 里是约 120），只断言方向与所在轴。

剪贴板的数据所有权在桌面（`clipboard.changed` → `clipboard.read`），server 只保存 selection 的 token 与 mime：
- 客户端复制 → `set_selection` → `clipboard.changed(change)`；桌面立刻 `clipboard.read(token, mime)` 取字节存历史。
- 客户端粘贴 → `clipboard.offer(handle)` → 目标 `receive(fd)` → server 直接把 fd 转给源客户端的
  `wl_data_source.send`（应用间传输不经过桌面）。
- 桌面回放历史 → `clipboard.set({ id, mimes })` → 目标 `receive` 时 server 用
  `clipboard.requestData(id, mime)` 向桌面要字节（3s 超时）。
- 源客户端退出 / 销毁 source → `clipboard.changed(null, "sourceGone")`；桌面想保留内容就自己 `clipboard.set` 回去。
- 桌面没在 `clipboard.changed` 到达时读的 mime 会随 source 一起消失，不会有人替它缓存。

剪贴板的顺序坑（`clipboard.test.ts`）：客户端自己持有剪贴板时，粘贴直接吃本地缓存、不会向合成器发
`wl_data_offer.receive`，所以「桌面回填」的用例必须排在客户端复制**之前**；复制的文案用 `input.text` 打进去，
保证是非空内容。

拖拽（DnD）的目标发现由桌面驱动：`start_drag` 后 server 建一个全局会话并保留同 client 的本地目标作为回退；
桌面一旦调用 `dnd.move(token, { handle, x, y })`，就撤掉本地目标，由 server 把 `enter/motion/leave/drop`
发给目标客户端（跨 client 也可）。目标 `wl_data_offer` 上带 `dndSessionId`，它的 accept / set_actions /
receive / finish 由 core 转给全局会话；`receive` 的 fd 直接转给源客户端的 `wl_data_source.send`。
目标不 `finish` 时 server 2 秒兜底，`dnd.drop` 之后的目标事件顺序与本地路径一致。

拖拽开始/结束会发 `dnd.started` / `dnd.finished`，并给出一个只读 token：
桌面可以在拖拽进行中用 `dnd.read(token, mime)` 取数据（例如中转站收下拖拽内容），再用
`dnd.cancel(token)` 结束会话。桌面作为源时用 `dnd.start` 建会话，目标 `receive` 时 server 用
`dnd.requestData(id, mime)` 向桌面要字节。

注意 `dnd.drop(token, null)` 和 `dnd.cancel` 的区别：前者是“在窗口外释放”，给源发
`action=none` + `dnd_drop_performed` + `dnd_finished`，GTK/Firefox 的标签撕出依赖这个结果；
后者是用户取消（Esc、源销毁），发 `cancelled`。hub 驱动时收尾还会补一个 `wl_pointer.button(released)`，
避免 GTK 停在 drag 状态。
单测见 `host/dnd_hub.test.ts` 与 `protocols/core/data_device.test.ts`；真实 Chromium 的选区拖动见
`test/text_drag.test.ts`（含拖拽中读取），跨客户端投递见 `test/dnd_cross.test.ts`，轻触 FSM 到选区拖动的
链路见 `test/tap_drag.test.ts`。

## 新增协议指南

### 1. 生成类型

把协议 XML 放进 `script/wayland/xml/`，在 `script/wayland/gen_protocols.ts` 的
`supportedProtocols` 加一行，然后跑：

```bash
npx tsx script/wayland/gen_protocols.ts   # package.json 尚无 gen:protocols script
```

产物是 `protocols/protocols.json` 与 `protocols/wayland-types.ts`，**是生成物、不要格式化**
（`biome check --write` 只指定具体目录/文件，别写 `src/wayland/`）。

### 2. 写模块（唯一必写的文件）

新建 `protocols/core/<name>.ts` 或 `protocols/ext/<name>.ts`：

```typescript
import { defineModule, type WaylandObjectId2 } from "../../module";

// 状态类型归本模块声明
declare module "../../module" {
    interface WaylandDataRegistry {
        my_iface: { someState: number };
    }
}

export const exampleModule = defineModule({
    name: "example",
    globals: [ // 可选：绑定时自报
        { name: "my_iface", version: 1, onBind: (msg, ctx) => { /* … */ } },
    ],
    requests: { // 书写态用对象字面量：键写错编译期报错
        "my_iface.do_thing"(x, ctx) { /* x.args 按生成类型精确推导，x.id 已带 brand */ },
    },
    actions: { // 可选：桌面命令的出口（`server.notify` → 这里），键来自 api.ts 的 ServerNotifyMap
        "input.key"(msg, ctx) { /* msg.winId 是 handle 反查后的 xdg_toplevel，msg.args 已去掉 handle */ },
    },
    core: (ctx) => {  // 可选：只有 core 模块用，提供 Omit<CoreApi,"registry">（surface / subsurface / focusKeyboard）
        const surface = new wlSurfaceData(ctx.scene);
        return { surface, subsurface: new wlSubSurfaceData(surface), focusKeyboard: (s, seat) => {} };
    },
    domain: {  // 可选：本模块的域状态实例；key 先在本文件 declare module 进 WaylandDomainRegistry
        xdgSurface: (ctx) => new xdgSurfaceData(ctx.core.surface),
    },
    hooks: { // 可选：core → 本模块的反向通知
        onCommit: (surfaceId, sizeChanged, ctx) => {},
        onFrame: (surfaceId, canvas, pending, ctx) => canvas,
        onDestroy: (surfaceId, ctx) => {},
        onFocus: (seat, surfaceId, ctx) => {},   // 某把 seat 的键盘焦点变化（surfaceId undefined = 失焦）
        onTextInput: (seat, text, preedit, ctx) => {}, // input.text 的仲裁：各 text_input 模块自判是否持有
    },
});
```

`core` / `domain` 的 initializer 由 `buildCtx()` 跑两趟执行（先全部 `core`，再 `domain`，
所以 `domain` 构造函数里能读 `ctx.core`），host 不 import 任何域状态的构造函数。

### 3. 登记

1. `protocols/index.ts` 的模块清单数组加一行
2. 本文件顶部的「支持的协议」更新
3. （可选）需要新 core 能力时才动 `module.ts` 的 `CoreApi` —— 须先与开发者确认
4. （可选）带自己的域状态时，在本文件 `declare module` 进 `WaylandDomainRegistry` 并给出 `domain` initializer；
   跨模块重复 key 由 `assertModuleConflicts()` 拦
5. 补一个 fake-ctx 单测（仿 `protocols/modules.test.ts`）

### 4. 不变量

- **协议模块之间零运行时 `import`**：只能 import `module.ts`、`api.ts`、`utils/*`、`render_tools`、
  `protocols/wayland-types`（生成物）。`import type` 允许跨协议引类型（编译期擦除、不产生运行时依赖），
  运行时的跨协议关系只能靠 `ctx` 注入或 `hooks`。`assertModuleConflicts()` 在 `WaylandServer`
  构造时校验三类冲突：请求键、桌面命令键、域状态 key。
- **域状态类住协议文件，实例由协议自己造**：`wlSurfaceData` / `wlSubSurfaceData` 在
  `protocols/core/wayland.ts`（经 `core` initializer 提供），`xdgSurfaceData` 在
  `protocols/ext/xdg_shell.ts`（经 `domain.xdgSurface` 提供）；`module.ts` 用 `import type`
  取它们作为 `CoreApi` / `WaylandDomainRegistry` 的形状。host 只跑装配清单，不 `new` 任何域状态。
- **桌面命令进 `actions`**：`server.notify` 的命令由 `host/server.ts` 反查 handle 后派发
  （`client.runAction`），组包、serial、**按 seat 分发**、状态维护全在协议文件里，host 不写协议事件。
  例外是 client 级的 `clipboard.set` / `clipboard.clear`（由 server 记录 selection 并广播，没有 handle），
  以及 `clipboard.offer`（server 先填入当前 selection 再走 `actions`）。
  命令里**只改 `WindowRecord` / 只发 Wayland 事件**，语义事件（`window.changed` 等）仍由 Store fan-in。
- **`ctx` 是 handler 唯一的依赖来源**：handler 不碰 `this`（`WaylandClient`）。新增能力先进
  `module.ts` 的契约，再接到 `ctx`：连接级的口（`objects`/`send*`/`scene`/`registry`）由
  `host/client.ts` 的 `buildCtx()` 接实现，core 能力与协议域状态由各模块的 `core` / `domain`
  initializer 提供、`buildCtx` 只按清单装配（见上一条）。指针几何命中归 xdg 域
  （`ctx.domain.xdgSurface.hitTest`，由 core 的 `input.pointer` 调用），焦点转移与
  enter/leave 的协议动作留在 core。
- **协议间双向通信都走 `ctx`，协议文件之间零 import**：ext 调 `ctx.core`、core 调
  `ctx.domain.<ext>` 的**查询方法**都是普通同步调用（core `input.pointer` → `ctx.domain.xdgSurface.hitTest`，
  host 的 `windows.hitTest` 也走同一个查询）。`hooks` 是 core → 扩展的**通知/扇出**通道：扩展注册回调，
  由 `host/client.ts` 聚合、`ctx.notify.*` 触发。`onCommit`（每次 commit，含无 buffer 的初始 commit）与 `onFrame`（已合成、渲染之前）
  分阶段，**不能合并**；`onTextInput` 是 `input.text` 的仲裁通道（core 不认识 `zwp_*` 事件）。
- **跨 client 拖拽会话在 `host/dnd_hub.ts`**：server 创建一次，各连接在 `buildCtx` 里注册 peer；
  core 只负责把源/目标的 `wl_data_*` 事件转给 hub，hub 用 peer 的对象表和 `sendNow` 组目标侧消息。
  字节仍然只走 fd（源客户端 → 目标客户端）或桌面的 `dnd.requestData`，hub 不缓存内容。
- **语义事实进域状态，谁拥有谁持有（单写入点）**：窗口记录与它的 `window.*` fan-in 在
  `protocols/ext/windows_store.ts`（`ctx.domain.windows`）、输入设备记录在
  `protocols/core/seat_store.ts`（`ctx.domain.seat`），两者由各自模块的 `domain` initializer `new`；
  光标留 `host/cursor_store.ts`（`ctx.cursor`）——它被 core 与 cursor_shape 两个协议读写，
  且出口 `ClientHost.cursorChanged` 不在 `ctx`。原 `state/` 目录已删除。
  Store 只放数据，协议动作（发 `wl_keyboard.*` / `wl_pointer.*`）在 `protocols/core/wayland.ts`。
- **焦点 per-seat，键盘焦点由桌面驱动**：`SeatRecord` 的 `pointerFocus` / `keyboardFocus` 各 seat
  一份（多光标 = 多 seat；`input.*` 的 `seat` 参数是**选择器不是广播位**，缺省 `"seat0"`）。
  seat 是 registry **一次性广播两把**（`seat0`/`seat1`）的——Firefox/GTK 不认运行中新增的 seat，
  而 `wl_seat.onBind` 按**广播顺序**算 seat 名（客户端只 bind 第二把也得叫 `seat1`）。
  指针焦点由 core 的 `input.pointer` → `updatePointerFocus` 维护，**只发该 seat 的 pointer、不碰键盘**
  （hover 要不要切键盘焦点是桌面政策）。键盘焦点只有一个写入口 `ctx.core.focusKeyboard`：同值去重 →
  旧焦点按住的键补 `key(released)` 并清空 → `leave`(旧) → `enter`(新) + `modifiers` → 写槽 →
  `ctx.notify.focus(seat, surface)` 扇出；调用方是
  桌面 `window.focus` / `window.blur`（blur 只清**自己拥有**的焦点，所以全量 focus+blur 循环与顺序无关）。
  释放必须在 `leave` 之前发（leave 之后客户端就不能收 `key`）；清空后桌面迟到的真实 release 会被
  `input.key` 的去重吞掉，焦点切换不保留上一焦点的按键状态。
  xdg 的 `actived` 是另一条独立的轴，规范对 `configure(activated)` 与 `wl_keyboard.enter` 的顺序无要求。
  `wl_surface.destroy` 只**静默清**焦点槽（不能向已销毁对象发事件），text-input 经 `onDestroy` 收敛。
- **模块级副作用要加环境守卫**：`utils/shared_texture.ts` 会注册 electron 接收端并连主进程的 unix socket
  （路径来自 `MYDE_SHARED_TEXTURE_SOCKET`），纯 node 环境没有 electron。
