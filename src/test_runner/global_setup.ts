import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `pnpm test` 的全局准备：先构建一次 `out/`。
 *
 * 所有 Electron runner 默认各自跑 `electron-vite preview`，而 preview 会重新构建并写
 * 同一个 `out/`；串行跑时只是变慢，并行跑会互相覆盖。开启 `MYDE_TEST_BUILD_ONCE`
 * 后统一在这里构建，runner 用 `--skipBuild` 只启动 Electron，测试文件就能并行。
 *
 * 不带这个环境变量的调用（单独的 `test:window-open` 等）仍然各跑各的构建，
 * 保证改完源码直接跑单个测试时用的是最新产物。
 */
export default function setup() {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    execFileSync("npx", ["electron-vite", "--ignoreConfigWarning", "build"], {
        cwd: root,
        stdio: "inherit",
    });
}
