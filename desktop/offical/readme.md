# 默认桌面

## 触控

触屏按接触点映射成独立指针：一根手指对应一个 `pointerId`，各自产生 down/move/up，第一根手指 `isPrimary` 为 true。点按由输入聚合层合成 `click`，只在单指接触（没有出现两指以上）且主指针抬起时合成，多指手势留给交互层。

- DOM 模式（window）：浏览器为触摸生成的 pointer 事件和其他指针一样进入聚合层，`pointerId`/`isPrimary` 原样保留；`html`/`body` 设置 `touch-action: none`，关闭浏览器自己的平移、缩放与双击放大手势
- evdev 模式（desktop）：MT-B 用 `slot` + `ABS_MT_TRACKING_ID` 跟踪每根手指，绝对坐标按屏幕量程映射；没有 tracking id 的旧设备退回单指 `BTN_TOUCH` 路径
- 桌面光标和窗口转发只跟随主指针，其余指针事件照常派发给 UI，供交互层实现长按、双指缩放等手势
- 桌面与 UI 只监听 pointer 事件，不依赖 mouse 事件

## 退出

`Super+Shift+E` 或 `Ctrl+Alt+Delete` 关闭桌面窗口，结束当前桌面进程。

## 输入法

通过 `MSysApi.inputMethod` 连接 fcitx5，桌面作为输入上下文客户端处理按键，不实现 Wayland 的 input-method 协议。

- 只拦截实现了 text-input 的聚焦窗口；没有 text-input 的客户端按键原样转发，输入法不生效
- 预编辑和上屏走 `input.text`，候选窗是桌面覆盖层，优先贴 text-input 光标矩形，缺失时贴鼠标
- 顶栏输入法工具显示 中/英/关，点击后在列表里直接切换输入法；`keyboard-us` 作为关闭输入法项，选中后按键直接转发给客户端
- 默认快捷键：`Ctrl+Space` 激活/停用合成，`Super+Space` / `Super+Shift+Space` 切换输入法
- 配置在 `settings.json` 的 `ime` 命名空间：`toggle`、`nextIM`、`prevIM`、`panelPreedit`
  - `panelPreedit`：`auto`（默认，fcitx 已在发内联预编辑时候选窗不重复显示）/ `always` / `never`
- 候选窗和托盘弹窗的视觉分别在 `src/ui.ts` 的 `imeCandidatePopup` / `imeTrayPanel`，静态预览见 `test/ui_example/ui_demo.ts`
