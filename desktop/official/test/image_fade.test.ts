import { describe, expect, it } from "vitest";
import { contentOpacityForGhost } from "../src/image_fade";

/** ghost 在上、content 在下的合成 alpha */
const compositeAlpha = (a: number, b: number, from: number, to: number) => from * a + to * b * (1 - from * a);

describe("内容淡化曲线", () => {
    it("前后透明度相同：合成 alpha 全程不变", () => {
        for (const alpha of [0.2, 0.5, 0.8, 1]) {
            for (const a of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
                const b = contentOpacityForGhost(a, alpha, alpha);
                expect(compositeAlpha(a, b, alpha, alpha), `alpha=${alpha} a=${a}`).toBeCloseTo(alpha, 6);
            }
        }
    });

    it("不透明窗口：内容保持 opacity 1，只淡出 ghost", () => {
        for (const a of [0, 0.1, 0.5, 0.9, 1]) {
            expect(contentOpacityForGhost(a, 1, 1)).toBe(1);
        }
    });

    it("50% 窗口在中间需要比线性更高的内容 opacity", () => {
        const b = contentOpacityForGhost(0.5, 0.5, 0.5);
        expect(b).toBeCloseTo(2 / 3, 6);
        expect(compositeAlpha(0.5, b, 0.5, 0.5)).toBeCloseTo(0.5, 6);
    });

    it("新内容变为不透明时内容始终为 1", () => {
        for (const a of [0, 0.2, 0.5, 0.8, 1]) {
            expect(contentOpacityForGhost(a, 0.5, 1)).toBe(1);
        }
    });

    it("旧内容比新内容更实：内容先保持隐藏，避免比目标更不透明", () => {
        expect(contentOpacityForGhost(0.8, 1, 0.5)).toBe(0);
        expect(compositeAlpha(0.8, 0, 1, 0.5)).toBeCloseTo(0.8, 6);
    });

    it("端点与非法值被收敛", () => {
        expect(contentOpacityForGhost(1, 0.5, 0.5)).toBe(0);
        expect(contentOpacityForGhost(0, 0.5, 0.5)).toBe(1);
        expect(contentOpacityForGhost(Number.NaN, 0.5, 0.5)).toBeGreaterThanOrEqual(0);
        expect(contentOpacityForGhost(Number.NaN, 0.5, 0.5)).toBeLessThanOrEqual(1);
        expect(contentOpacityForGhost(0.5, -1, 2)).toBeGreaterThanOrEqual(0);
        expect(contentOpacityForGhost(0.5, -1, 2)).toBeLessThanOrEqual(1);
    });
});
