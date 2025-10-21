# myde

基于 Electron 的 Linux Wayland 桌面环境（合成器）

目前在开发中，不能原生启动，仅支持部分软件，性能不行

这个项目再次证明了 web 技术开发的潜力（之前也有人开发了 [term.everything](https://github.com/mmulet/term.everything) 和 [greenfield](https://github.com/udevbe/greenfield)）

前端的美术基础、ux 交互以及造轮子的热情很适合开发桌面窗口管理器，kwin 和 gnome 也或多或少提供了前端开发接口。

这个项目更进一步，只负责把软件渲染到 canvas 上以及处理部分输入，合成渲染由 chrome 负责，其他的一切，无论是窗口管理，还是窗口装饰、桌面组件、任务栏……等等都可以自己开发。你可以开发前卫的桌面和交互方式，或者模仿 win、mac，甚至开发手机平板 ui。开发者不用处理显示协议，不用管理内存，在相对 c、rust 开发更方便的条件下，希望可以孵化出更易用、功能更强大的 Linux 桌面。

通过模块化插件形式，用户可以直接切换下载好的桌面。

现在项目怎么样了？目前只有少量软件可以显示，自定义桌面 api 还不稳定，你可以视为 demo 演示。项目现在是 alapha 状态，等到我将其作为我电脑的桌面时，进入 beta 状态。其他见[文档局限条目](#局限)

![演示](https://youke1.picui.cn/s1/2025/10/21/68f76fd90a9ae.png)

## 运行

运行环境为 Linux，带有 X11 或 Wayland 的桌面

在`script/xcb/`下运行`xkbcomp $DISPLAY x.xcb`（需要 X11 支持）

安装依赖：

```shell
pnpm i
pnpm run pkgRebuild
```

运行默认桌面：

```shell
pnpm run desktop
```

将弹出一个窗口，可以在里面启动你自己系统的软件。

## 自定义桌面

默认桌面的实现在`desktop`文件夹下面，作为参考。

可以通过环境变量`desktop`传递自定义桌面的文件夹，本质是一个 npm 模块，包含`package.json`，`main`属性指向核心 js 文件。

尽管此项目是 AGPL-3，但自定义桌面插件理论上不会被传染。考虑到用户安全和社区繁荣，建议开源以提供社区审查，考虑到个人版权，建议使用稍微严格的许可证。

## 调试

运行调试窗口：

```shell
pnpm run start
```

将弹出一个窗口，固定了一些开发调试的软件。

## 局限

### 目前局限

下面的局限大部分存在明确的解决方向，但现在我还在努力开发。

由于 Electron 展示无法直接输出，所以现在只能显示一个窗口作为桌面演示，就像通过窗口启动 Weston 一样。如果要用作真实桌面，需要一个桌面宿主，然后启动 myde 的全屏窗口。

目前可以显示的窗口：`weston-flower`、`weston-simple-damage`、`weston-simple-shm`、`weston-simple-egl`、`weston-clickdot`等

以及：`gtk4-demos` `google-chrome`

许多协议只是看起来支持，实际上具体实现没有搞好。目前支持鼠标、键盘输入，popup 弹窗等。

现在没有处理 mmap，所以一些内存共享还要多一次复制。暂时不支持 GPU 渲染，全程还是软件渲染合成。

### 其他局限

js 的性能在高帧率下可能不足。单进程模型可能导致阻塞界面。

## 原理

关于此项目的实现原理和架构安排可以见[此文档](./docs/details.md)
