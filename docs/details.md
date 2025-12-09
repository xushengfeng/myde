# 项目解析

使用 nodejs 模块与系统软件进行 socket 交互，信息通过 js 处理，并由 canvas 渲染。整体框架是 Electron，可以把 web 和本地紧密结合。

## 对应

窗口合成用的是 web 渲染技术，层级管理、特效等自然也是 dom 的，所以渲染进程就是合成器。

同时窗口管理、窗口装饰、桌面组件由自定义桌面实现，但也是在渲染进程里面，甚至在同一个 document 里面。

所以自定义桌面是自定义窗口管理器和桌面 shell。

我的理解可能有误，总之一大堆功能集成在渲染进程里面。后续的架构可能因为性能、安全等改变。

## 项目构成

`src`：Wayland 服务器连接、协议处理、系统交互、桌面加载等。

`script`：把 Wayland 的 xml 协议文本和 input event code 等转化成 ts 类型和数据的脚本。

`desktop`：默认桌面实现。

## 支持的协议

以下协议的错误处理均未实现

-   wayland

    -   wl_display
    -   wl_registry
    -   wl_callback
    -   wl_compositor
    -   wl_shm_pool 部分
    -   wl_shm 部分
    -   wl_buffer
    -   wl_surface 部分
    -   wl_seat 还没有 touch
    -   wl_pointer 部分
    -   wl_keyboard 还没有 repeat
    -   wl_output 只是硬编码，还没有添加硬件处理
    -   wl_region
    -   wl_data_device 部分
    -   wl_data_device_manager 部分
    -   wl_data_offer 部分
    -   wl_data_source 部分
    -   wl_subcompositor
    -   wl_subsurface 部分

-   xdg-shell

    -   xdg_wm_base 部分
    -   xdg_surface
    -   xdg_toplevel 部分
    -   xdg_popup 部分
    -   xdg_positioner 部分

-   text-input-unstable-v1
    -   zwp_text_input_v1 部分
    -   zwp_text_input_manager_v1
