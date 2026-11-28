使用`myde-dbus`库，应该只引入类型

参考`blue.ts`

`lid.ts` 通过 logind 读取并监听笔记本合盖状态（`LidClosed`）。

`brightness.ts` 控制屏幕亮度：内置屏读 `/sys/class/backlight/*`，写入优先直接写 sysfs、没有权限时走 logind 的 `org.freedesktop.login1.Session.SetBrightness`（目标取席位的当前前台会话 `Seat.ActiveSession`，切 VT 后自动跟随；logind 只放行前台会话，其他会话会返回 `NotYourDevice`）；外接屏调用 `ddcutil`（DDC/CI，VCP 0x10），需要 i2c 权限（udev `uaccess` 规则或 i2c 组），`ddcutil` 不可用时只影响外接屏。内置屏用 `fs.watch` 监听 sysfs，Fn 键或其他程序修改亮度也会发出 `changed`；外接屏不轮询，热插拔后调用 `refresh()`。

`polkit.ts` 是 polkit 的认证前端 agent：在系统总线注册 logind session，接收 polkitd 的认证请求并通过事件交给桌面；PAM 由 polkit-agent-helper-1 完成。`init({ register: false })` 只连接总线，`start()`/`ready()` 才注册 agent。桌面模式下的 agent 跑在主进程最早启动的 `session_helper` 里（它在 Chromium 搬 cgroup 之前 fork，留在登录会话里），桌面报告认证 UI 就绪后才注册；helper 同时代 `runApp` 启动应用，应用及其子进程因此属于该会话，polkit 的会话级 agent 才能接住它们的认证。

`run.ts` 负责启动应用。桌面模式下 `runApp()` 优先让 session helper 代启动（应用留在登录会话里，polkit 会话级 agent 才能接住它派生的 systemctl 等），helper 不可用时本地 spawn。应用输出必须被读取（否则写满 64 KiB 后应用阻塞），写到 `$XDG_STATE_HOME/myde/logs/apps/`；helper 代启动时由 helper 写。`runApp(exec, { env })` 可以把应用自带的环境变量合并进子进程环境（最后合并，优先级最高）。子进程会拿到 `USER`/`LOGNAME`/`HOME`；启动身份取桌面进程自身，不依赖启动环境里的 `USER`（应用内再启动的桌面可能没有这个变量，按 `USER` 兜底会变成 root 并 `spawn EPERM`）。

`application.ts` 解析 .desktop：除 Name/Comment/Icon/Exec 外，还会从 `Exec=env A=1 cmd` 的前缀取出环境变量放进 `DesktopEntry.env`（`Exec` 同时还原成 `cmd`），交给 `runApp()`。

`app_control.ts` 提供进程树、进程控制和系统快照：`getPidTree()` 直接读 `/proc`；`getSystemSnapshot()` 读取整机 CPU/内存和所有进程（第一次采样 CPU 百分比为 null，第二次才有值），`watchSystem()` 周期性采样，`getProcessDetail()` 按需读取 cmdline/cgroup/affinity/PSS/IO；`getAffinity()` / `setAffinity()` 读写 CPU 亲和度，设置走 `taskset -apc`；`getCpuTopology()` 读取 CPU 型号和 P/E/LPE 核分类（优先 `cpu_core`/`cpu_atom`/`cpu_lowpower`，回退 `acpi_cppc`、`cpu_capacity`、最大频率）。进程 CPU 百分比是多线程累计值，可能超过 100；`nice` 等控制只对同 uid 进程有效。

`temperature.ts` 读 `/sys/class/hwmon` 和 `/sys/class/thermal` 的温度传感器，按 cpu/gpu/nvme/battery/wifi/acpi/other 归类；无需 root，没有内核事件，`init()` 后默认 5 秒轮询，变化时发出 `changed`。

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
