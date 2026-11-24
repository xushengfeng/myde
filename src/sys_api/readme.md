使用`myde-dbus`库，应该只引入类型

参考`blue.ts`

`lid.ts` 通过 logind 读取并监听笔记本合盖状态（`LidClosed`）。

`brightness.ts` 控制屏幕亮度：内置屏读 `/sys/class/backlight/*`，写入优先直接写 sysfs、没有权限时走 logind 的 `org.freedesktop.login1.Session.SetBrightness`（目标取席位的当前前台会话 `Seat.ActiveSession`，切 VT 后自动跟随；logind 只放行前台会话，其他会话会返回 `NotYourDevice`）；外接屏调用 `ddcutil`（DDC/CI，VCP 0x10），需要 i2c 权限（udev `uaccess` 规则或 i2c 组），`ddcutil` 不可用时只影响外接屏。内置屏用 `fs.watch` 监听 sysfs，Fn 键或其他程序修改亮度也会发出 `changed`；外接屏不轮询，热插拔后调用 `refresh()`。

`polkit.ts` 是 polkit 的认证前端 agent：在系统总线注册 logind session，接收 polkitd 的认证请求并通过事件交给桌面；PAM 由 polkit-agent-helper-1 完成。

`run.ts` 负责启动应用。`runApp()` 必须读取应用的 stdout/stderr（否则写满 64 KiB 后应用阻塞），输出写到 `$XDG_STATE_HOME/myde/logs/apps/`。`runApp(exec, { env })` 可以把应用自带的环境变量合并进子进程环境（最后合并，优先级最高）。子进程会拿到 `USER`/`LOGNAME`/`HOME`；启动身份取桌面进程自身，不依赖启动环境里的 `USER`（应用内再启动的桌面可能没有这个变量，按 `USER` 兜底会变成 root 并 `spawn EPERM`）。

`application.ts` 解析 .desktop：除 Name/Comment/Icon/Exec 外，还会从 `Exec=env A=1 cmd` 的前缀取出环境变量放进 `DesktopEntry.env`（`Exec` 同时还原成 `cmd`），交给 `runApp()`。

`nativefs.ts` 提供原生文件系统的只读接口：`list` 枚举目录和元数据，`readImage` 只读取图片文件并返回 data URL（默认上限 32MB）；路径支持绝对路径和 `~`。文件选择器用它列目录，桌面壁纸等只需要图片内容的场景用 `readImage`，不提供读取其他文件内容的接口。

`screenshot.ts` 截取桌面页面（整个输出或一块矩形），返回 PNG 字节并提供保存到图片目录的接口；主进程侧用 Electron `webContents.capturePage` 实现。portal 的 Screenshot 后端用它完成截图，沙箱应用通过 xdg-desktop-portal 请求。

`xdg_desktop_portal/` 是 xdg-desktop-portal 的 desktop 后端（当前实现 FileChooser、Screenshot、Access），前端由系统的 xdg-desktop-portal 提供。

## 测试

`src/sys_api/test` 下分两类：

- 可隔离的测试：默认跑。`DBusTestEnv`、`internal_portal`、`notification`/`notification_internal`、`tray_watcher`、`xdg_desktop_portal` 都在私有 bus 或私有内部 portal 上，不依赖宿主服务。
- 真实宿主服务冒烟：默认跳过，入口是 `host_services.ts` 的 `describeHost`。这些测试连接宿主 session/system bus、PipeWire、fcitx5、BlueZ、播放器或显示器，部分会修改系统状态（音量、亮度、播放/暂停、输入法），不应作为回归测试的必备项。需要人工确认时：

```bash
pnpm test:host-services
```

涉及文件：`appIndicator`、`blue`、`brightness`（硬件部分）、`input_method`、`lid`、`mpris`、`network`、`power`、`volume`。

系统 API 测试不要求统一的 dbus 隔离：能隔离的用 `DBusTestEnv` 或内部 portal，不能隔离的归到宿主服务冒烟，不要为了跑测试去改宿主 session。
