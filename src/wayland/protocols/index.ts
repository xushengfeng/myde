import type { ProtocolModule } from "../module";
import { compositorModule } from "./core/compositor";
import { dataDeviceModule } from "./core/data_device";
import { displayModule } from "./core/display";
import { outputModule } from "./core/output";
import { pointerModule } from "./core/pointer";
import { regionModule } from "./core/region";
import { registryModule } from "./core/registry";
import { seatModule } from "./core/seat";
import { shmModule } from "./core/shm";
import { subsurfaceModule } from "./core/subsurface";
import { surfaceModule } from "./core/surface";
import { cursorShapeModule } from "./cursor_shape";
import { dmabufModule } from "./dmabuf";
import { viewporterModule } from "./viewporter";

/**
 * 全部协议模块清单（运行期聚合，替代原 `supportedProtocols` 的手工 if 链）。
 *
 * 新增协议：实现一个 `defineModule(...)`，在这里加一行即可。
 * 装配时会校验同一 `接口.请求` 被两个模块声明——现在 `Map.set` 会静默覆盖。
 */
export const protocolModules: readonly ProtocolModule[] = [
    displayModule,
    regionModule,
    compositorModule,
    shmModule,
    surfaceModule,
    seatModule,
    pointerModule,
    registryModule,
    outputModule,
    viewporterModule,
    cursorShapeModule,
    dmabufModule,
    subsurfaceModule,
    dataDeviceModule,
];

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
