# myde

基于 Electron 的 Linux 桌面环境

目标、进度：

-   [x] 显示窗口
-   [x] 添加 socket
-   [x] 解析 Wayland 协议
-   [x] 启动软件
-   [x] 显示软件（支持部分窗口显示）
-   [ ] 输入
-   [ ] 窗口管理器抽象

由于 Electron 展示无法直接输出，所以现在只能显示一个窗口作为桌面演示，就像通过窗口启动 Weston 一样。如果要用作真实桌面，需要一个桌面宿主，然后启动 myde 的全屏窗口。

当经过多层抽象后，就可以用 web 技术来控制窗口。无论是堆叠还是平铺，桌面还是手机 ui，都可以简单地通过 web api 自定义。

目前可以显示的窗口：`weston-flower`、`weston-simple-damage`、`weston-simple-shm`、`weston-simple-egl`、`weston-clickdot`
