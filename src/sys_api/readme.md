使用`myde-dbus`库，应该只引入类型

参考`blue.ts`

`lid.ts` 通过 logind 读取并监听笔记本合盖状态（`LidClosed`）。

`xdg_desktop_portal/` 是 xdg-desktop-portal 的 desktop 后端（当前实现 FileChooser），前端由系统的 xdg-desktop-portal 提供。

`polkit.ts` 是 polkit 的认证前端 agent：在系统总线注册 logind session，接收 polkitd 的认证请求并通过事件交给桌面；PAM 由 polkit-agent-helper-1 完成。

`run.ts` 负责启动应用。`runApp()` 必须读取应用的 stdout/stderr（否则写满 64 KiB 后应用阻塞），输出写到 `$XDG_STATE_HOME/myde/logs/apps/`。`runApp(exec, { env })` 可以把应用自带的环境变量合并进子进程环境（最后合并，优先级最高）。子进程会拿到 `USER`/`LOGNAME`/`HOME`；启动身份取桌面进程自身，不依赖启动环境里的 `USER`（应用内再启动的桌面可能没有这个变量，按 `USER` 兜底会变成 root 并 `spawn EPERM`）。

`application.ts` 解析 .desktop：除 Name/Comment/Icon/Exec 外，还会从 `Exec=env A=1 cmd` 的前缀取出环境变量放进 `DesktopEntry.env`（`Exec` 同时还原成 `cmd`），交给 `runApp()`。

`nativefs.ts` 提供原生文件系统的只读目录枚举（当前只有 `list`），路径支持绝对路径和 `~`；文件选择器用它列目录。它不提供读取文件内容的接口。
