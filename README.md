# myde

基于 Electron 的 Linux Wayland 桌面环境（合成器）

由于 Electron 展示无法直接输出，所以现在只能显示一个窗口作为桌面演示，就像通过窗口启动 Weston 一样。如果要用作真实桌面，需要一个桌面宿主，然后启动 myde 的全屏窗口。

期望：当经过多层抽象后，就可以用 web 技术来控制窗口。无论是堆叠还是平铺，桌面还是手机 ui，都可以简单地通过 web api 自定义。

目前可以显示的窗口：`weston-flower`、`weston-simple-damage`、`weston-simple-shm`、`weston-simple-egl`、`weston-clickdot`

许多协议只是看起来支持，实际上具体实现没有搞好。

现在没有处理 mmap，所以一些内存共享还要多一次复制。GPU 渲染只支持有限的颜色格式，并且也是要复制到内存再渲染。全程还是软件渲染合成。

## 运行

```shell
pnpm i
pnpm run pkgRebuild
pnpm run start
```
