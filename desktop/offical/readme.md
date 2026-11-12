# 默认桌面

## 触控

触屏按接触点映射成独立指针：一根手指对应一个 `pointerId`，各自产生 down/move/up，第一根手指 `isPrimary` 为 true。点按由输入聚合层合成 `click`，只在单指接触（没有出现两指以上）且主指针抬起时合成，多指手势留给交互层。

- DOM 模式（window）：浏览器为触摸生成的 pointer 事件和其他指针一样进入聚合层，`pointerId`/`isPrimary` 原样保留；`html`/`body` 设置 `touch-action: none`，关闭浏览器自己的平移、缩放与双击放大手势
- evdev 模式（desktop）：MT-B 用 `slot` + `ABS_MT_TRACKING_ID` 跟踪每根手指，绝对坐标按屏幕量程映射；没有 tracking id 的旧设备退回单指 `BTN_TOUCH` 路径
- 桌面光标和窗口转发只跟随主指针，其余指针事件照常派发给 UI，供交互层实现长按、双指缩放等手势
- 桌面与 UI 只监听 pointer 事件，不依赖 mouse 事件

### 触摸板

desktop（evdev）模式下触摸板事件由仓库的 `src/utils/touchpad.ts` 封装成 `move`/`scroll`/`button` 语义事件，桌面只订阅转换结果，window 模式由宿主系统处理。绝对坐标只用于计算位移与手指数，不映射成光标位置。

- 单指轻触左键、双指轻触右键、三指轻触中键；接触时间不超过 300ms 且位移不超过 16px 才算轻触
- 单指移动光标；两指移动产生自然滚动（内容跟随手指），不移动光标
- 三指及以上移动单独发 `multiStart`/`multiMove`/`multiEnd`（带手指数和位移），官方桌面不订阅，留给其他桌面实现多指手势
- 轻触后 300ms 内再次单指按下并移动超过阈值，进入左键拖拽，抬起结束
- 同一轮接触里按过物理按键（`BTN_LEFT` 等）就不再合成轻触，避免一次点击触发两次
- MT-B 设备用 `slot` + `ABS_MT_TRACKING_ID` 跟踪每根手指；没有 tracking id 的旧设备用 `BTN_TOOL_*` 手指数；完全没有接触信号的设备只保留光标移动

## 退出

`Super+Shift+E` 或 `Ctrl+Alt+Delete` 关闭桌面窗口，结束当前桌面进程。

## 设置

顶栏不放设置入口，设置作为模拟应用出现在开始菜单里。设置窗口是桌面自己创建的 DOM 窗口，不是 Wayland 客户端，但和客户端窗口共用同一套窗口逻辑：

- 占用一个虚拟桌面（`ViewData.newView`），打开时居中，参与多窗口总览
- 点击后聚焦，点击桌面或其他窗口时失焦，键盘事件留在 DOM 内处理
- 标题栏可拖动，关闭时回收虚拟桌面和居中管理
- 打开中的设置窗口再次点开始菜单里的设置会跳回它所在的虚拟桌面

设置项：
- 外观：`icon.theme` 应用图标主题
- 输入法：候选窗预编辑 `ime.panelPreedit`（`auto` / `always` / `never`）
- 窗口：新窗口居中，保存到 `desktop.centerWindows` 命名空间

## 输入法

通过 `MSysApi.inputMethod` 连接 fcitx5，桌面作为输入上下文客户端处理按键，不实现 Wayland 的 input-method 协议。

- 只拦截实现了 text-input 的聚焦窗口；没有 text-input 的客户端按键原样转发，输入法不生效
- 预编辑和上屏走 `input.text`，候选窗是桌面覆盖层，优先贴 text-input 光标矩形，缺失时贴鼠标
- 顶栏输入法工具显示 中/英/关，点击后在列表里直接切换输入法；`keyboard-us` 作为关闭输入法项，选中后按键直接转发给客户端
- 默认快捷键：`Ctrl+Space` 激活/停用合成，`Super+Space` / `Super+Shift+Space` 切换输入法
- 配置在 `settings.json` 的 `ime` 命名空间：`toggle`、`nextIM`、`prevIM`、`panelPreedit`
  - `panelPreedit`：`auto`（默认，fcitx 已在发内联预编辑时候选窗不重复显示）/ `always` / `never`
- 候选窗和托盘弹窗的视觉分别在 `src/ui.ts` 的 `imeCandidatePopup` / `imeTrayPanel`，静态预览见 `test/ui_example/ui_demo.ts`
