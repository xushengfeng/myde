import { defineModule, type WaylandObjectId2 } from "../../module";
import type { WaylandName, WaylandProtocol } from "../../utils/wayland-binary";

/**
 * wl_registry：global 的发现与绑定。
 *
 * 绑定的**通用部分**（按 name 找协议、登记对象、记版本）在这里；各 global 的
 * 绑定时初始化由模块声明的 `globals[].onBind` 负责。
 * 这样新增 global 只需在自己的模块里加一段，不必改中枢。
 */
export const registryModule = defineModule({
    name: "wl_registry",
    requests: {
        "wl_registry.bind": (x, ctx) => {
            const name = x.args.name as WaylandName;
            const proto: WaylandProtocol | undefined = ctx.core.registry.byName(name);
            if (!proto) {
                console.warn(`Unknown global name: ${name}`);
                return;
            }
            ctx.objects.bind({ name, id: x.args.id, protocol: proto });
            // 注意：协议元数据里 bind 只有 name/id 两个参数，没有 version，
            // 所以这里记到的始终是 undefined（勿当成已生效的版本记录）
            // 值恒为 undefined，用 0 兜底仅为了匹配 Map<string, number> 的类型（falsy 语义与 undefined 相同）
            ctx.client.protoVersions.set(proto.name, (x.args as unknown as { _version?: number })._version ?? 0);
            console.log(`Client ${ctx.client.id} bound ${proto.name} to id ${x.args.id}`);

            ctx.core.registry.globalOf(proto.name)?.onBind?.({ name, id: x.args.id, protocol: proto }, ctx);

            // TODO：xdg_shell 模块声明该 global 后，此分支随之删除
            if (proto.name === "xdg_wm_base") {
                const id = x.args.id as WaylandObjectId2<"xdg_wm_base">;
                ctx.client.state.xdg_wm_base.add(id);
                ctx.objects.setData(id, { pingSerials: new Map() });
            }
        },
    },
});
