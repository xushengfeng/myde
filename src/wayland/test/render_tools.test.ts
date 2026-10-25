import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
    const calls: string[] = [];
    const ctx = {
        clearRect: (...args: number[]) => {
            calls.push(`clear:${args.join(",")}`);
        },
        drawImage: () => {
            calls.push("draw");
        },
    };
    const canvas = { width: 0, height: 0, getContext: () => ctx };
    const el = {
        el: canvas,
        attr: () => el,
        style: () => el,
        add: () => el,
    };
    return { calls, ctx, canvas, el };
});

vi.mock("dkh-ui", () => ({
    ele: () => h.el,
    view: () => h.el,
}));

import { renderToolsHtmlEl } from "../render_tools_el";

/**
 * 每个 surface 的新帧必须“替换”上一帧，而不是 source-over 叠加。
 * 旧实现同尺寸时只 drawImage，半透明/透明区域会累积在 DOM canvas 上
 * （半透明窗口越来越实、popup 收缩后旧内容残留）。
 */
describe("renderToolsHtmlEl.renderCanvas", () => {
    it("每帧先 clearRect 再 drawImage", () => {
        const render = new renderToolsHtmlEl();
        render.bindCanvas("c");
        const frame = { width: 4, height: 3 } as OffscreenCanvas;

        h.calls.length = 0;
        render.renderCanvas(frame, "c");
        expect(h.calls).toEqual(["clear:0,0,4,3", "draw"]);

        h.calls.length = 0;
        render.renderCanvas(frame, "c");
        expect(h.calls).toEqual(["clear:0,0,4,3", "draw"]);
    });
});
