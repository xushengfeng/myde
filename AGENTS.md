完整桌面由wayland api、系统api、具体桌面实现（web界面，如窗口布局控制、任务栏等）

通过加载器`src/renderer/view/desktop-loader.ts`初始化dbus、系统api。桌面实现初始化wayland服务器，创建页面

主要运行在electron环境中，为了测试方便，可能要求运行在纯node（无dom）或者纯web（无本地模块）。electron环境和纯node环境需要通过`require`引入模块并通过`as typeof import()`添加类型，但是引用ts文件就使用`import`即可。

由于最终需要运行在electron中，在开发node原生模块时（应该在其他仓库开发），应考虑electron内存墙，外部资源都需要先克隆

## 桌面实现

纯web环境

[桌面实现文档](desktop/readme.md)

`desktop/offical`官方桌面

`desktop/remote`远程特性演示桌面

## wayland api

纯node环境，但是dmabuf需要electron渲染进程环境，总之是无dom的electron渲染进程

`src/wayland/server.ts`是各个协议主要实现

## 系统api

纯node环境

`src/sys_api`定义大部分api，`src/setting`是统一设置

`src/desktop-api.ts`定义系统api类型

大部分api用了dbus，但是dbus的具体创建、连接在外部。class创建时应该传入dbus作为参数

## 测试工具

可以自定义应用，实现针对性测试

`test/simple_app`下可以创建rust bin应用，适用于wayland api

使用`test/electron_app`可以创建单脚本控制主进程和渲染进程的特殊应用，适用于wayland api和系统api相关

### Mock

`test/mock`提供myde全局变量的mock实现，用于桌面开发者快速开发参考界面，无需真实dbus/系统服务。

详细用法见[test/mock/readme.md](test/mock/readme.md)

## 常用开发流程

### 新增wayland协议

- 下载协议xml文件到`script/wayland/xml`
- 修改`script/wayland/gen_protocols.ts`的`supportedProtocols`变量并运行
- 编辑`src/wayland/server.ts`

由于最后窗口需要显示，所以有渲染器这个概念，比如`src/wayland/render_tools_el.ts`就把中间的窗口操作转成dom操作，桌面开发可引用，避免二次开发。当然，无头服务器或者其他可自定义渲染器

默认不进行测试，如果开发者要求添加测试，仿照`src/wayland/test/dma-buf.test.ts`

### 系统api开发

- `src/sys_api`或者`src/sys_api/xdg_desktop_portal`下创建文件
- 参考`src/sys_api/readme.md`
- 编写特定测试
- 添加到`src/desktop-api.ts`
- 在`src/renderer/view/desktop-loader.ts`添加初始化代码

如果是修改已有api，除了新增，在修改（包括修改bug）或删除都需向开发者确认

新增或修改后也在`desktop/readme.md`编辑添加新描述

### 桌面实现开发

下面流程部分仅用于官方而不是外部自定义桌面开发

所有与系统交互必须通过提供的wayland api和系统api交互，如果不存在，需要考虑进入wayland api开发流程或者系统api开发流程，进入前需要开发者批准，必须展示可能要构建的接口

参考`desktop/readme.md`

如果是开发新桌面，需要在项目根目录的`package.json`里添加相关script

## 其他

不用阅读`docs`文件夹

项目由vite、vitest、pnpm构建，biome格式化
