import { describe, expect, it } from "vitest";
import type { ModuleCtx } from "../../module";
import { regionModule } from "./region";

/** handler 不使用 proto/op，构造消息时留空即可；args 按被调请求给 */
function msg(id: number, args: Record<string, unknown>) {
    return { id, proto: {}, op: {}, args } as never;
}

/** 最小 fake ctx：region 只碰对象表 */
function fakeCtx() {
    const store = new Map<
        number,
        { rects: { x: number; y: number; width: number; height: number; type: "+" | "-" }[] }
    >();
    const ctx = {
        objects: {
            setData: (id: number, data: unknown) => store.set(id, data as never),
            getData: (id: number) => store.get(id),
        },
    } as unknown as ModuleCtx;
    return { ctx, store };
}

function handler(key: string) {
    const h = regionModule.requests.get(key as never);
    if (!h) throw new Error(`未声明 ${key}`);
    return h;
}

describe("region 模块", () => {
    it("三个请求都注册进了分发表", () => {
        expect([...regionModule.requests.keys()].sort()).toEqual([
            "wl_compositor.create_region",
            "wl_region.add",
            "wl_region.subtract",
        ]);
    });

    it("create_region 建出空矩形表，add/subtract 追加并带上方向", () => {
        const { ctx, store } = fakeCtx();

        handler("wl_compositor.create_region")(msg(10, { id: 10 }), ctx);
        expect(store.get(10)).toEqual({ rects: [] });

        handler("wl_region.add")(msg(10, { x: 1, y: 2, width: 30, height: 40 }), ctx);
        handler("wl_region.subtract")(msg(10, { x: 5, y: 6, width: 7, height: 8 }), ctx);

        expect(store.get(10)).toEqual({
            rects: [
                { x: 1, y: 2, width: 30, height: 40, type: "+" },
                { x: 5, y: 6, width: 7, height: 8, type: "-" },
            ],
        });
    });
});
