import type { ProtocolModule } from "../module";
import { regionModule } from "./core/region";

/**
 * 全部协议模块清单（运行期聚合，替代原 `supportedProtocols` 的手工 if 链）。
 *
 * 新增协议：实现一个 `defineModule(...)`，在这里加一行即可。
 * 装配时会校验同一 `接口.请求` 被两个模块声明——现在 `Map.set` 会静默覆盖。
 */
export const protocolModules: readonly ProtocolModule[] = [regionModule];

/** 启动时校验请求键冲突，重复即抛 */
export function assertModuleConflicts(): void {
    const seen = new Map<string, string>();
    for (const mod of protocolModules) {
        for (const key of mod.requests.keys()) {
            const prev = seen.get(key);
            if (prev) {
                throw new Error(`wayland 请求 ${key} 同时由 ${prev} 与 ${mod.name} 声明`);
            }
            seen.set(key, mod.name);
        }
    }
}
