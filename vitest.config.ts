import { defineConfig } from "vitest/config";

// 测试文件默认串行：dma-buf GPU 内存、逐帧流畅度这类用例会被其他 Electron 实例
// 干扰。`pnpm test` 用 MYDE_TEST_BUILD_ONCE 让 globalSetup 只构建一次 out/，
// 各 runner 直接 --skipBuild 启动，省掉每个文件重复构建。
// 纯桌面的 UI/e2e 用例可以用 `--fileParallelism` 单独并行（见 test:desktop）。
const buildOnce = process.env.MYDE_TEST_BUILD_ONCE === "1";

export default defineConfig({
    test: {
        fileParallelism: false,
        globalSetup: buildOnce ? ["./src/test_runner/global_setup.ts"] : [],
    },
});
