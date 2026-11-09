# MyDE portal 配置

这两个文件用于让系统的 `xdg-desktop-portal` 选择 MyDE 后端：

- `portals/myde.portal` → `/usr/share/xdg-desktop-portal/portals/myde.portal`
- `myde-portals.conf` → `/usr/share/xdg-desktop-portal/myde-portals.conf`

会话需要设置 `XDG_CURRENT_DESKTOP=MyDE`。开发和测试时可以用
`XDG_DESKTOP_PORTAL_DIR` 指向 `assets/portal/portals`，不要改系统文件。

窗口模式可以用 `myde --internal-portal` 启动私有 dbus + xdg-desktop-portal；
配置文件会写到 MyDE 的 userData 目录，不会写入系统目录。
