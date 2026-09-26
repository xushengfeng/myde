import { defineModule } from "../../module";

/**
 * wl_region：矩形集合，供 wl_surface.set_input_region 等使用。
 *
 * `wl_compositor.create_region` 是它的工厂，状态类型也归本模块所有，因此一并放这里。
 * 这是 Phase 3 迁出的样板模块：只认 `ctx`，不 import 任何 host 实现。
 */
export const regionModule = defineModule({
    name: "wl_region",
    requests: {
        "wl_compositor.create_region"(msg, ctx) {
            ctx.objects.setData(msg.args.id, { rects: [] });
        },
        "wl_region.add"(msg, ctx) {
            ctx.objects.getData(msg.id).rects.push({ ...msg.args, type: "+" });
        },
        "wl_region.subtract"(msg, ctx) {
            ctx.objects.getData(msg.id).rects.push({ ...msg.args, type: "-" });
        },
    },
});
