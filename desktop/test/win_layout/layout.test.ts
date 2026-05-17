import { describe, expect, it } from "vitest";
import { freeLayout } from "../../src/win_layout";

function checkSize(layout: freeLayout) {
    const allSize = layout.getAllWindows().reduce((acc, win) => acc + win.size, 0);
    expect(allSize).toEqual(layout.getBaseSize().width * layout.getBaseSize().height);
}

function matchLayout(
    layout: freeLayout,
    expected: { x: number; y: number; width: number; height: number }[],
    order = false,
    round = 1,
) {
    const wins = layout.getAllWindows();
    expect(wins.length).toEqual(expected.length);
    if (order) {
        for (let i = 0; i < expected.length; i++) {
            expect(wins[i].x).toBeCloseTo(expected[i].x, -1);
            expect(wins[i].y).toBeCloseTo(expected[i].y, -1);
            expect(wins[i].width).toBeCloseTo(expected[i].width, -1);
            expect(wins[i].height).toBeCloseTo(expected[i].height, -1);
        }
    } else {
        const m = structuredClone(wins);
        const e = structuredClone(expected);
        for (const win of m) {
            const idx = e.findIndex(
                (item) =>
                    Math.abs(win.x - item.x) <= round &&
                    Math.abs(win.y - item.y) <= round &&
                    Math.abs(win.width - item.width) <= round &&
                    Math.abs(win.height - item.height) <= round,
            );
            if (idx === -1) {
                throw new Error(`Window ${JSON.stringify(win)} not found in expected layout.`);
            }
            e.splice(idx, 1);
        }
    }
    checkSize(layout);
}

describe("freeLayout", () => {
    it("basic", () => {
        const layout = new freeLayout(800, 600);
        for (let i = 0; i < 10; i++) {
            layout.addWindow();
            checkSize(layout);
        }
    });
    it("2分", () => {
        const layout = new freeLayout(800, 600);
        layout.addWindow();
        matchLayout(layout, [
            { x: 0, y: 0, width: 400, height: 600 },
            { x: 400, y: 0, width: 400, height: 600 },
        ]);
    });
    it("3分", () => {
        const layout = new freeLayout(800, 600);
        layout.addWindow();
        layout.addWindow({ x: 700, y: 0 }); // 右边分割
        matchLayout(layout, [
            { x: 0, y: 0, width: 400, height: 600 },
            { x: 400, y: 0, width: 400, height: 300 },
            { x: 400, y: 300, width: 400, height: 300 },
        ]);
    });
    it("4分", () => {
        const layout = new freeLayout(800, 600);
        layout.addWindow();
        layout.addWindow();
        layout.addWindow();
        matchLayout(layout, [
            { x: 0, y: 0, width: 400, height: 300 },
            { x: 400, y: 0, width: 400, height: 300 },
            { x: 0, y: 300, width: 400, height: 300 },
            { x: 400, y: 300, width: 400, height: 300 },
        ]);
    });
    it("比例分割，如带鱼屏", () => {
        const layout = new freeLayout(1200, 120);
        for (let i = 0; i < 4; i++) layout.addWindow();
        const wins = layout.getAllWindows();
        for (const win of wins) {
            expect(win.height).toEqual(120);
        }
        for (const win of wins) {
            expect(win.width).toBeCloseTo(1200 / wins.length, -1);
        }
    });
});

describe("removeWindow", () => {
    function getWinByPoint(layout: freeLayout, x: number, y: number) {
        const win = layout
            .getAllWindows()
            .find((win) => x > win.x && x < win.x + win.width && y > win.y && y < win.y + win.height);
        if (!win) throw new Error(`No window found at point (${x}, ${y})`);
        return win;
    }
    it("2分", () => {
        const layout = new freeLayout(800, 600);
        layout.addWindow();
        layout.removeWindow(getWinByPoint(layout, 100, 100).id);
        matchLayout(layout, [{ x: 0, y: 0, width: 800, height: 600 }]);
    });
    it("3分 应该由右边两个拓展", () => {
        const layout = new freeLayout(800, 600);
        layout.addWindow();
        layout.addWindow({ x: 700, y: 0 }); // 右边分割

        layout.removeWindow(getWinByPoint(layout, 100, 100).id);
        matchLayout(layout, [
            { x: 0, y: 0, width: 800, height: 300 },
            { x: 0, y: 300, width: 800, height: 300 },
        ]);
    });
    it("4分 移除后应该选择接近方形的大区域拓展", () => {
        const layout = new freeLayout(800, 600);
        layout.addWindow();
        layout.addWindow();
        layout.addWindow();
        layout.removeWindow(getWinByPoint(layout, 100, 100).id);
        matchLayout(layout, [
            { x: 0, y: 0, width: 400, height: 600 },
            { x: 400, y: 0, width: 400, height: 300 },
            { x: 400, y: 300, width: 400, height: 300 },
        ]);
    });
    it("6分 移除后应该选择面积大的区域拓展", () => {
        const layout = new freeLayout(800, 600);
        layout.addWindow();
        layout.addWindow();
        layout.addWindow();
        layout.addWindow();
        layout.addWindow();
        layout.removeWindow(getWinByPoint(layout, 100, 100).id);
        matchLayout(layout, [
            { x: 0, y: 0, width: 400, height: 300 },
            { x: 400, y: 0, width: 400, height: 300 },
            { x: 0, y: 300, width: 800 / 3, height: 300 },
            { x: 800 / 3, y: 300, width: 800 / 3, height: 300 },
            { x: (800 / 3) * 2, y: 300, width: 800 / 3, height: 300 },
        ]);
    });
    it("比例分割，如带鱼屏", () => {
        const layout = new freeLayout(1200, 120);
        for (let i = 0; i < 4; i++) layout.addWindow();
        layout.addWindow();
        layout.removeWindow(getWinByPoint(layout, 100, 100).id);
        const wins = layout.getAllWindows();
        for (const win of wins) {
            expect(win.height).toEqual(120);
        }
        for (const win of wins) {
            expect(win.width).toBeCloseTo(1200 / wins.length, -1);
        }
    });
});

describe("移动", () => {
    it("基本移动", () => {
        const layout = new freeLayout(800, 600);
        layout.addWindow();
        layout.moveStart({ x: 400, y: 300 });
        layout.move({ x: 410, y: 310 });
        layout.moveEnd();
        matchLayout(layout, [
            { x: 0, y: 0, width: 410, height: 600 },
            { x: 410, y: 0, width: 390, height: 600 },
        ]);
    });
    it("外部禁止移动", () => {
        const layout = new freeLayout(800, 600);
        layout.moveStart({ x: 0, y: 0 });
        layout.move({ x: 400, y: 300 });
        layout.moveEnd();
        matchLayout(layout, [{ x: 0, y: 0, width: 800, height: 600 }]);
    });
    it("禁止面积为负", () => {
        const layout = new freeLayout(800, 600);
        layout.addWindow();
        layout.addWindow();
        layout.addWindow();
        layout.addWindow();
        layout.addWindow();
        layout.moveStart({ x: 800 / 3, y: 500 }, 4);
        layout.move({ x: 790, y: 500 });
        layout.moveEnd();
        matchLayout(
            layout,
            [
                { x: 0, y: 0, width: 800 / 3, height: 300 },
                { x: 800 / 3, y: 0, width: 800 / 3, height: 300 },
                { x: (800 / 3) * 2, y: 0, width: 800 / 3, height: 300 },
                { x: 0, y: 300, width: (800 / 3) * 2, height: 300 },
                { x: (800 / 3) * 2, y: 300, width: 1, height: 300 },
                { x: (800 / 3) * 2, y: 300, width: 800 / 3, height: 300 },
            ],
            false,
            5,
        );
    });
    it("错开", () => {
        const layout = new freeLayout(800, 600);
        layout.addWindow();
        layout.addWindow();
        layout.addWindow();
        // 四分，下面移动上面的
        layout.moveStart({ x: 400, y: 10 });
        layout.move({ x: 410, y: 20 });
        layout.moveEnd();
        matchLayout(layout, [
            // 上面动，下面不动
            { x: 0, y: 0, width: 410, height: 300 },
            { x: 410, y: 0, width: 390, height: 300 },
            { x: 0, y: 300, width: 400, height: 300 },
            { x: 400, y: 300, width: 400, height: 300 },
        ]);
    });
    it("三分├ 控制", () => {
        const layout = new freeLayout(800, 600);
        layout.addWindow();
        layout.addWindow({ x: 700, y: 0 });
        layout.moveStart({ x: 400, y: 10 });
        layout.move({ x: 410, y: 310 });
        layout.moveEnd();
        matchLayout(layout, [
            { x: 0, y: 0, width: 410, height: 600 },
            { x: 410, y: 0, width: 390, height: 300 },
            { x: 410, y: 300, width: 390, height: 300 },
        ]);
    });
    it("十字控制", () => {
        const layout = new freeLayout(800, 600);
        layout.addWindow();
        layout.addWindow();
        layout.addWindow();
        layout.moveStart({ x: 400, y: 300 });
        layout.move({ x: 410, y: 310 });
        layout.moveEnd();
        matchLayout(layout, [
            { x: 0, y: 0, width: 410, height: 310 },
            { x: 410, y: 0, width: 390, height: 310 },
            { x: 0, y: 310, width: 410, height: 290 },
            { x: 410, y: 310, width: 390, height: 290 },
        ]);
    });
    it("十字控制 模糊点", () => {
        const layout = new freeLayout(800, 600);
        layout.addWindow();
        layout.addWindow();
        layout.addWindow();
        layout.moveStart({ x: 402, y: 302 }, 4);
        layout.move({ x: 412, y: 312 });
        layout.moveEnd();
        matchLayout(layout, [
            { x: 0, y: 0, width: 410, height: 310 },
            { x: 410, y: 0, width: 390, height: 310 },
            { x: 0, y: 310, width: 410, height: 290 },
            { x: 410, y: 310, width: 390, height: 290 },
        ]);
    });
});
