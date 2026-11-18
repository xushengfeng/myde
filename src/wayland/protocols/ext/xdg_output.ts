import type { OutputInfo } from "../../api";
import { defineModule, type ModuleCtx, type WaylandObjectId2 } from "../../module";

/**
 * xdg-output-unstable-v1
 *
 * 把输出的逻辑空间告诉客户端。`wl_output.scale` 只能是整数，分数缩放时服务端按
 * `ceil(scale)` 广播；支持 wp_fractional_scale_v1 的客户端用 120 为分母拿精确倍率，
 * 但 Chromium / Electron 仍从 xdg_output 的 `logical_size` 反推显示缩放
 * （physical / logical）。缺了这个 global 时 Electron 的 `screen` 只能看到整数
 * `wl_output.scale`，1.5 会变成 2。
 */
declare module "../../module" {
    interface WaylandDomainRegistry {
        xdgOutput: {
            /** 本连接创建的 xdg_output 对象 */
            objects: Set<WaylandObjectId2<"zxdg_output_v1">>;
        };
    }
}

/** 输出在合成器逻辑空间里的尺寸：物理模式经 transform 后除以缩放。 */
function logicalSize(output: OutputInfo): { width: number; height: number } {
    const rotated = output.transform === "90" || output.transform === "270";
    const width = rotated ? output.mode.height : output.mode.width;
    const height = rotated ? output.mode.width : output.mode.height;
    return {
        width: Math.max(1, Math.round(width / output.scale)),
        height: Math.max(1, Math.round(height / output.scale)),
    };
}

/**
 * 版本 2 起的 `name` / `description`。
 *
 * 虽然版本 3 推荐客户端改用 `wl_output.name`，但 Qt 的 `QWaylandScreen` 仍把
 * `zxdg_output_v1.name` 列为屏幕初始化的必需事件：缺了它真实屏幕永远不初始化，
 * Qt 落到 0×0 的占位屏幕，QMenu 等弹层被约束到 (0, 0)（Konsole/Dolphin 的右键菜单
 * 跑到左上角）。两个事件只在创建时发一次（name 在对象生命周期内不变）。
 */
function sendOutputIdentity(objectId: WaylandObjectId2<"zxdg_output_v1">, ctx: ModuleCtx, send: ModuleCtx["send"]) {
    const object = ctx.objects.getOption(objectId);
    if (object === undefined || object.version < 2) return;
    const output = ctx.client.output();
    send(objectId, "zxdg_output_v1.name", { name: output.name });
    send(objectId, "zxdg_output_v1.description", { description: output.description });
}

/**
 * 发送当前输出的逻辑位置/尺寸。
 *
 * 版本 3 起 `xdg_output.done` 废弃，改由随后的 `wl_output.done` 收尾：创建对象时这里
 * 自己补一个，输出变化时由 core 的 `onOutput` 补（本模块在模块清单里排在 core 之前，
 * 保证逻辑尺寸先于 done 发出）。
 */
function sendLogicalState(objectId: WaylandObjectId2<"zxdg_output_v1">, ctx: ModuleCtx, send: ModuleCtx["send"]) {
    const object = ctx.objects.getOption(objectId);
    if (object === undefined) return;
    const output = ctx.client.output();
    const size = logicalSize(output);
    send(objectId, "zxdg_output_v1.logical_position", { x: 0, y: 0 });
    send(objectId, "zxdg_output_v1.logical_size", size);
    if (object.version < 3) send(objectId, "zxdg_output_v1.done", {});
}

export const xdgOutputModule = defineModule({
    name: "xdg-output-unstable-v1",
    globals: [{ name: "zxdg_output_manager_v1" }],
    domain: {
        xdgOutput: () => ({ objects: new Set() }),
    },
    hooks: {
        /** 输出缩放/模式变化：重发逻辑尺寸，wl_output.done 由 core 随后发出。 */
        onOutput: (ctx) => {
            for (const objectId of ctx.domain.xdgOutput.objects) {
                if (!ctx.objects.has(objectId)) {
                    ctx.domain.xdgOutput.objects.delete(objectId);
                    continue;
                }
                sendLogicalState(objectId, ctx, ctx.sendNow);
            }
        },
    },
    requests: {
        "zxdg_output_manager_v1.get_xdg_output": (x, ctx) => {
            // 无效 output 由对象表统一报 invalid_object
            ctx.objects.get(x.args.output);
            const objectId = x.args.id;
            const object = ctx.objects.get(objectId);
            ctx.domain.xdgOutput.objects.add(objectId);
            sendOutputIdentity(objectId, ctx, ctx.send);
            sendLogicalState(objectId, ctx, ctx.send);
            // v3 的收尾事件是 wl_output.done；补发一次让客户端立即拿到逻辑尺寸。
            if (object.version >= 3) ctx.send(x.args.output, "wl_output.done", {});
        },
        "zxdg_output_v1.destroy": (x, ctx) => {
            ctx.domain.xdgOutput.objects.delete(x.id);
        },
    },
});
