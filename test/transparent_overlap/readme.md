# 透明窗口动画复现

一个透明、无边框、GPU 合成的 Electron 窗口：多个元素用 `transform: translate3d`
（合成器动画，走 dmabuf）、一个 Canvas 动画、半透明面板和光斑同时运动。
如果 myde 合成时 damage 处理不对，会看到**拖尾、残影、旧内容叠在新内容上**。

窗口里也有操作提示：

- `空格`：暂停动画（方便截图对比）
- `R`：每 2.5 秒改一次窗口大小（覆盖 resize 路径）
- `H`：隐藏提示
- `Esc`：退出

## 运行

在 myde 会话里（终端已经带着 myde 的 `WAYLAND_DISPLAY`），于项目根目录：

```bash
test/transparent_overlap/run.sh
```

脚本只使用当前的 `WAYLAND_DISPLAY`，不会去挑别的显示；同时强制
`--ozone-platform=wayland --disable-features=Vulkan`，保留 GPU/dmabuf 合成。

走 myde 的 XWayland（`DISPLAY` 已由 myde 设置）：

```bash
test/transparent_overlap/run.sh x11
```

## 输出

终端会打印 `WAYLAND_DISPLAY`、`DISPLAY`、GPU 合成状态。
`[repro] GPU: {"compositing":"..."}` 里应该是 `enabled`；如果是
`disabled_software`，说明这条链路没有走 GPU/dmabuf。
