#!/bin/sh
# 透明窗口动画复现应用启动器。
#
# 在 myde 会话里直接跑（使用当前 WAYLAND_DISPLAY，不会去挑别的显示）：
#   test/transparent_overlap/run.sh          # 原生 Wayland，GPU/dmabuf 合成
#   test/transparent_overlap/run.sh x11      # 走 myde 的 XWayland（DISPLAY 已由 myde 设置）
set -e

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$DIR/../.." && pwd)

MODE=${1:-wayland}
[ $# -gt 0 ] && shift

if [ "$MODE" = "x11" ]; then
    if [ -z "$DISPLAY" ]; then
        echo "x11 模式需要 myde 的 XWayland（DISPLAY 未设置）。" >&2
        exit 1
    fi
    echo "模式: XWayland  DISPLAY=$DISPLAY"
    set -- --ozone-platform=x11 --enable-transparent-visuals "$@"
else
    if [ -z "$WAYLAND_DISPLAY" ]; then
        echo "WAYLAND_DISPLAY 未设置；请在 myde 会话里运行，或先 export WAYLAND_DISPLAY=<myde 的 socket>。" >&2
        exit 1
    fi
    echo "模式: Wayland  WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
    # myde 的 wayland 后端与 Vulkan 不兼容，禁用 Vulkan、保留 GL/EGL（dmabuf）
    set -- --ozone-platform=wayland --disable-features=Vulkan "$@"
fi

exec "$ROOT/node_modules/.bin/electron" "$@" "$DIR"
