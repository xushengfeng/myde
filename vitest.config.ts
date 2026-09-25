import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // wayland e2e 的桌面服务固定监听 my-wayland-server-0（WaylandServer.socketName 默认值），
        // 两个测试文件并行时后启动的实例会 unlinkSync 掉对方的 socket 文件（setupSocket 会删除
        // 已存在的 socket），导致客户端连到错误的服务端，表现为间歇性失败。
        // 在把 socket 名改为每次实例唯一之前，测试文件必须串行执行。
        fileParallelism: false,
    },
});
