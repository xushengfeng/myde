import { describe, expect, it } from "vitest";
import { freeLayout } from "../../src/win_layout";

function checkSize(layout: freeLayout, data?: any) {
    const allSize = layout.getAllWindows().reduce((acc, win) => acc + win.size, 0);
    try {
        expect(allSize).toEqual(layout.getBaseSize().width * layout.getBaseSize().height);
    } catch (error) {
        if (data) data;
        throw error;
    }
}

function matchLayout(
    layout: freeLayout,
    expected: { x: number; y: number; width?: number; height?: number; x2?: number; y2?: number }[],
    order = false,
) {
    const wins = layout.getAllWindows();
    expect(wins.length).toEqual(expected.length);
    const m = order ? structuredClone(wins) : wins.toSorted((a, b) => a.x - b.x || a.y - b.y);
    const e = order ? structuredClone(expected) : expected.toSorted((a, b) => a.x - b.x || a.y - b.y);
    const re = e.map((win) => ({
        ...Object.fromEntries(
            Object.entries(win).map(([k, v]) => (["x", "y", "x2", "y2"].includes(k) ? [k, Math.round(v)] : [k, v])),
        ),
    }));
    const nm = [];
    for (const x of re) {
        const w = m.shift();
        if (!w) throw new Error("No more windows to match");
        const o = Object.fromEntries(Object.entries(w).flatMap(([k, v]) => (k in x ? [[k, v]] : [])));
        nm.push(o);
    }
    expect(nm).toEqual(re);

    checkSize(layout);
}

describe("a", () => {
    it("findSameDirectionWindows", () => {
        const layout = new freeLayout(800, 600);
        layout.loadState({
            baseWidth: 800,
            baseHeight: 600,
            windows: [
                { id: 1, x1: 0, y1: 0, x2: 200, y2: 600, minWidth: 1, minHeight: 1 },
                { id: 2, x1: 200, y1: 0, x2: 400, y2: 300, minWidth: 1, minHeight: 1 },
                { id: 3, x1: 200, y1: 300, x2: 400, y2: 600, minWidth: 1, minHeight: 1 },
                { id: 4, x1: 400, y1: 0, x2: 600, y2: 600, minWidth: 1, minHeight: 1 },
                { id: 5, x1: 600, y1: 0, x2: 800, y2: 600, minWidth: 1, minHeight: 1 },
            ],
        });
        // @ts-expect-error
        expect(layout.findSameDirectionWindows(4, "x")).toEqual([4, 5]);
    });
});

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
            { x: 0, y: 300, x2: 800 / 3, height: 300 },
            { x: 800 / 3, y: 300, x2: (800 / 3) * 2, height: 300 },
            { x: (800 / 3) * 2, y: 300, x2: 800, height: 300 },
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
                { x: 0, y: 0, x2: 800 / 3, height: 300 },
                { x: 800 / 3, y: 0, x2: (800 / 3) * 2, height: 300 },
                { x: (800 / 3) * 2, y: 0, x2: 800, height: 300 },
                { x: 0, y: 300, x2: (800 / 3) * 2 - 1, height: 300 },
                { x: (800 / 3) * 2 - 1, y: 300, width: 1, height: 300 },
                { x: (800 / 3) * 2, y: 300, x2: 800, height: 300 },
            ],
            false,
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

describe("随机测试", () => {
    it("随机添加删除", () => {
        const layout = new freeLayout(800, 600);
        function createSeededRandom(seed: number): () => number {
            let s = seed >>> 0; // 确保是无符号32位整数
            return () => {
                s = (s + 0x6d2b79f5) | 0;
                let t = Math.imul(s ^ (s >>> 15), 1 | s);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }
        const random = createSeededRandom(12345);
        function run(a: () => void, name: string) {
            const lastState = layout.getAllWindows();
            a();
            checkSize(layout, { lastState, currentState: layout.getAllWindows(), name });
        }
        for (let i = 0; i < 10000; i++) {
            const action = random();
            if (action < 0.6) {
                // 添加窗口
                const x = random() * 800;
                const y = random() * 600;
                run(() => {
                    layout.addWindow({ x, y });
                }, `添加窗口 ${x}, ${y}`);
                if (layout.getAllWindows().length > 100) {
                    run(() => {
                        for (const win of layout.getAllWindows()) {
                            layout.removeWindow(win.id);
                        }
                    }, "清空窗口");
                }
            } else {
                // 删除窗口
                const wins = layout.getAllWindows();
                if (wins.length > 1) {
                    const win = wins[Math.floor(random() * wins.length)];
                    run(() => {
                        layout.removeWindow(win.id);
                    }, `删除窗口 ${win.id}`);
                }
            }
        }
    });

    it("中途错误的情况1", () => {
        const layout = new freeLayout(800, 600);
        layout.loadState({
            baseWidth: 800,
            baseHeight: 600,
            windows: [
                {
                    id: 3,
                    x1: 0,
                    y1: 0,
                    x2: 200,
                    y2: 300,
                    minWidth: 1,
                    minHeight: 1,
                },
                {
                    id: 2,
                    x1: 300,
                    y1: 300,
                    x2: 600,
                    y2: 600,
                    minWidth: 1,
                    minHeight: 1,
                },
                {
                    id: 5,
                    x1: 600,
                    y1: 300,
                    x2: 800,
                    y2: 600,
                    minWidth: 1,
                    minHeight: 1,
                },
                {
                    id: 8,
                    x1: 400,
                    y1: 0,
                    x2: 800,
                    y2: 300,
                    minWidth: 1,
                    minHeight: 1,
                },
                {
                    id: 4,
                    x1: 0,
                    y1: 300,
                    x2: 300,
                    y2: 600,
                    minWidth: 1,
                    minHeight: 1,
                },
                {
                    id: 6,
                    x1: 200,
                    y1: 0,
                    x2: 400,
                    y2: 150,
                    minWidth: 1,
                    minHeight: 1,
                },
                {
                    id: 9,
                    x1: 200,
                    y1: 150,
                    x2: 400,
                    y2: 300,
                    minWidth: 1,
                    minHeight: 1,
                },
            ],
        });
        layout.addWindow({ x: 498.40820133686066, y: 100.7289751432836 });
        checkSize(layout);
    });
});
