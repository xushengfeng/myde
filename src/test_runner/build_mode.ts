/** `pnpm test` 先统一构建 `out/`，各 runner 不再各自构建（见 global_setup.ts） */
export function electronViteBuildArgs(): string[] {
    return process.env.MYDE_TEST_BUILD_ONCE === "1" ? ["--skipBuild"] : [];
}
