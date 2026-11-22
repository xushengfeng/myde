import { describe, expect, it } from "vitest";
import { rectsToClipPath, resolveRegion } from "./region";

const area = (rects: { width: number; height: number }[]) =>
    rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);

describe("resolveRegion", () => {
    it("重叠的 add 矩形取并集，不挖洞", () => {
        const rects = resolveRegion([
            { x: 0, y: 0, width: 10, height: 10, type: "+" },
            { x: 5, y: 0, width: 10, height: 10, type: "+" },
        ]);
        expect(rects).toEqual([{ x: 0, y: 0, width: 15, height: 10 }]);
        expect(area(rects)).toBe(150);
    });

    it("subtract 按顺序挖掉交集，剩余矩形互不重叠", () => {
        const rects = resolveRegion([
            { x: 0, y: 0, width: 20, height: 20, type: "+" },
            { x: 5, y: 5, width: 10, height: 10, type: "-" },
        ]);
        expect(area(rects)).toBe(300);
        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
                const a = rects[i];
                const b = rects[j];
                const overlap =
                    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
                    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
                expect(overlap).toBe(0);
            }
        }
    });

    it("裁剪到 surface 范围", () => {
        expect(
            area(resolveRegion([{ x: -10, y: -10, width: 20, height: 20, type: "+" }], { width: 5, height: 5 })),
        ).toBe(25);
        expect(resolveRegion([{ x: 10, y: 10, width: 5, height: 5, type: "+" }], { width: 5, height: 5 })).toEqual([]);
    });

    it("空区域与纯 subtract 都是空", () => {
        expect(resolveRegion([])).toEqual([]);
        expect(resolveRegion([{ x: 0, y: 0, width: 10, height: 10, type: "-" }])).toEqual([]);
    });

    it("路径按 scale 换算，每个矩形一个闭合子路径", () => {
        const rects = resolveRegion([
            { x: 0, y: 0, width: 10, height: 10, type: "+" },
            { x: 20, y: 0, width: 10, height: 10, type: "+" },
        ]);
        expect(rects).toHaveLength(2);
        expect(rectsToClipPath(rects, 2)).toBe("M0 0H20V20H0ZM40 0H60V20H40Z");
    });
});
