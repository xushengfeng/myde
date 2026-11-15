使用`myde-dbus`库，应该只引入类型

参考`blue.ts`

`lid.ts` 通过 logind 读取并监听笔记本合盖状态（`LidClosed`）。

`xdg_desktop_portal/` 是 xdg-desktop-portal 的 desktop 后端（当前实现 FileChooser），前端由系统的 xdg-desktop-portal 提供。

`polkit.ts` 是 polkit 的认证前端 agent：在系统总线注册 logind session，接收 polkitd 的认证请求并通过事件交给桌面；PAM 由 polkit-agent-helper-1 完成。

`run.ts` 负责启动应用。`runApp()` 必须读取应用的 stdout/stderr（否则写满 64 KiB 后应用阻塞），输出写到 `$XDG_STATE_HOME/myde/logs/apps/`。
