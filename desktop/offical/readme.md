# 默认桌面

## 输入法

通过 `MSysApi.inputMethod` 连接 fcitx5，桌面作为输入上下文客户端处理按键，不实现 Wayland 的 input-method 协议。

- 只拦截实现了 text-input 的聚焦窗口；没有 text-input 的客户端按键原样转发，输入法不生效
- 预编辑和上屏走 `input.text`，候选窗是桌面覆盖层，优先贴 text-input 光标矩形，缺失时贴鼠标
- 顶栏输入法工具显示 中/英/关，点击后在列表里直接切换输入法；`keyboard-us` 作为关闭输入法项，选中后按键直接转发给客户端
- 默认快捷键：`Ctrl+Space` 激活/停用合成，`Super+Space` / `Super+Shift+Space` 切换输入法
- 配置在 `settings.json` 的 `ime` 命名空间：`toggle`、`nextIM`、`prevIM`
- 候选窗和托盘弹窗的视觉分别在 `src/ui.ts` 的 `imeCandidatePopup` / `imeTrayPanel`，静态预览见 `test/ui_example/ui_demo.ts`
