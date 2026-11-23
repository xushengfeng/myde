import { describe } from "vitest";

/**
 * 真实宿主服务的冒烟测试：连接宿主的 session/system bus、PipeWire、fcitx5、
 * BlueZ、播放器、显示器等，依赖具体机器状态，部分还会改动系统状态。
 *
 * 这些不是回归测试的必备项，默认跳过；需要人工确认宿主服务时：
 *
 * ```bash
 * MYDE_TEST_HOST_SERVICES=1 npx vitest run src/sys_api/test
 * ```
 */
export const hostServicesEnabled = process.env.MYDE_TEST_HOST_SERVICES === "1";

export const describeHost = hostServicesEnabled ? describe : describe.skip;
