import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // e2e 通过 `electron-vite preview` 启动 Electron，每次都会把构建产物写进
        // 同一个 out/，并行会互相覆盖；所以测试文件仍然串行。
        fileParallelism: false,
    },
});
