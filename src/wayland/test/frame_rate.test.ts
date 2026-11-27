import { describe, expect, it } from "vitest";
import { frameRateDivisor } from "../protocols/core/wayland";

/**
 * 帧率上限按输出刷新率的整数因数分频：`refresh / 因数` 是能整齐落在 rAF 上的
 * 最接近目标的帧率。120Hz 下 30fps 正好是每 4 帧一次，144Hz 下取 5 帧一次。
 */
describe("window frame rate", () => {
    it("取最接近 30Hz 的整数因数", () => {
        expect(frameRateDivisor(120_000, 30)).toBe(4); // 30Hz
        expect(frameRateDivisor(60_000, 30)).toBe(2); // 30Hz
        expect(frameRateDivisor(90_000, 30)).toBe(3); // 30Hz
        expect(frameRateDivisor(144_000, 30)).toBe(5); // 28.8Hz
        expect(frameRateDivisor(165_000, 30)).toBe(6); // 27.5Hz
        expect(frameRateDivisor(240_000, 30)).toBe(8); // 30Hz
    });

    it("目标不低于刷新率时不限速，刷新率缺失时按 60Hz 兜底", () => {
        expect(frameRateDivisor(120_000, 120)).toBe(1);
        expect(frameRateDivisor(120_000, 240)).toBe(1);
        expect(frameRateDivisor(0, 30)).toBe(2);
    });
});
