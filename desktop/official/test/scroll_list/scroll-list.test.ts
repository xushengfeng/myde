import { view } from "dkh-ui";
import type { Time, TimeerHandler } from "myde-ui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dynamicScrollList } from "../../src/scroll-list";

/** 最小 DOM 实现，只覆盖 dkh-ui view 和 dynamicScrollList 用到的部分 */
class FakeStyle {
    [key: string]: unknown;
    setProperty(name: string, value: unknown) {
        this[name] = value;
    }
    removeProperty(name: string) {
        delete this[name];
    }
}

class FakeElement {
    tagName: string;
    style = new FakeStyle();
    children: FakeElement[] = [];
    parentNode: FakeElement | null = null;
    private attrs = new Map<string, string>();

    constructor(tag: string) {
        this.tagName = tag.toUpperCase();
    }

    append(...nodes: (FakeElement | string)[]) {
        for (const node of nodes) {
            if (typeof node === "string") continue;
            this.appendChild(node);
        }
    }

    appendChild(node: FakeElement) {
        node.remove();
        node.parentNode = this;
        this.children.push(node);
        return node;
    }

    remove() {
        if (!this.parentNode) return;
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
    }

    setAttribute(name: string, value: string) {
        this.attrs.set(name, String(value));
    }

    getAttribute(name: string) {
        return this.attrs.get(name) ?? null;
    }

    addEventListener() {}
    removeEventListener() {}
    setPointerCapture() {}
    hasPointerCapture() {
        return false;
    }
}

const g = globalThis as unknown as Record<string, unknown>;
const originalGlobals = {
    HTMLElement: g.HTMLElement,
    DocumentFragment: g.DocumentFragment,
    document: g.document,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
};

beforeAll(() => {
    g.HTMLElement = FakeElement;
    g.DocumentFragment = class {};
    g.document = {
        createElement: (tag: string) => new FakeElement(tag),
        createTextNode: (text: string) => text,
        createDocumentFragment: () => new FakeElement("fragment"),
        body: new FakeElement("body"),
    };
    g.requestAnimationFrame = (cb: () => void) => {
        setTimeout(cb, 16);
        return 0;
    };
    g.cancelAnimationFrame = () => {};
});

afterAll(() => {
    Object.assign(g, originalGlobals);
});

/** 手动推进帧的 Time，用来精确控制动画进度 */
class FakeTime implements Time {
    now = 0;
    private frames: (() => void)[] = [];
    private timers = new Map<number, { at: number; cb: () => void }>();
    private timerId = 0;

    getTimeMs() {
        return this.now;
    }
    setTimeOut(ms: number, cb: () => void) {
        const id = ++this.timerId;
        this.timers.set(id, { at: this.now + ms, cb });
        return id as TimeerHandler;
    }
    clearTimeOut(handler: TimeerHandler) {
        this.timers.delete(handler);
    }
    reqNextFrame(cb: () => void) {
        this.frames.push(cb);
    }
    /** 前进一帧，执行本帧排队的 rAF 回调 */
    tick(ms = 16) {
        this.now += ms;
        for (const [id, timer] of Array.from(this.timers)) {
            if (timer.at <= this.now) {
                this.timers.delete(id);
                timer.cb();
            }
        }
        const frames = this.frames;
        this.frames = [];
        for (const cb of frames) cb();
    }
    /** 推进到所有动画结束 */
    settle(maxFrames = 200) {
        for (let i = 0; i < maxFrames; i++) this.tick();
    }
}

function createSeededRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface ListHandle {
    el: ReturnType<typeof view>;
}

interface Setup {
    list: ReturnType<typeof dynamicScrollList<string>>;
    time: FakeTime;
    container: FakeElement;
    keyByEl: WeakMap<FakeElement, string>;
    itemSize: number;
    gap: number;
    containerSize: number;
}

function setup(options?: {
    itemSize?: number;
    gap?: number;
    align?: "start" | "center" | "end";
    containerSize?: number | { min?: number; max?: number };
    bufferSize?: number;
}): Setup {
    const itemSize = options?.itemSize ?? 100;
    const gap = options?.gap ?? 0;
    const containerSizeOption = options?.containerSize ?? 300;
    const containerSize =
        typeof containerSizeOption === "number" ? containerSizeOption : Math.max(0, containerSizeOption.min ?? 0);
    const time = new FakeTime();
    const keyByEl = new WeakMap<FakeElement, string>();

    const list = dynamicScrollList<string>({
        itemSize,
        gap,
        align: options?.align,
        containerSize: containerSizeOption,
        direction: "down",
        bufferSize: options?.bufferSize ?? 2,
        animationDuration: 100,
        time,
        keyExtractor: (item) => item,
        renderItem: (item) => {
            const el = view();
            keyByEl.set(el.el as unknown as FakeElement, item);
            return el;
        },
    });

    return {
        list,
        time,
        container: (list as unknown as ListHandle).el.el as unknown as FakeElement,
        keyByEl,
        itemSize,
        gap,
        containerSize,
    };
}

/**
 * 校验稳定后的 DOM：
 * - 每个元素都能对应到当前列表中的 key
 * - 同一个 key 只出现一次
 * - 所有元素的滑动偏移一致（位置 = index * (itemSize + gap) - scroll）
 * - 可见区域内每个槽位都有且只有一个元素，不空缺也不重叠
 */
function assertLayout(s: Setup, items: string[]) {
    const { container, keyByEl, itemSize, gap, containerSize } = s;
    const stride = itemSize + gap;
    const indexByKey = new Map(items.map((item, index) => [item, index]));

    const entries = container.children.map((el) => {
        const key = keyByEl.get(el);
        const top = Number.parseFloat(String(el.style.top));
        return { el, key, top };
    });

    for (const entry of entries) {
        expect(entry.key, "DOM 中存在不属于当前列表的元素").toBeDefined();
        expect(indexByKey.has(entry.key as string), `DOM 中残留 key=${entry.key}`).toBe(true);
        expect(Number.isFinite(entry.top), `key=${entry.key} 没有有效位置`).toBe(true);
    }

    const keys = entries.map((entry) => entry.key as string);
    expect(new Set(keys).size, `DOM 中 key 重复: ${keys.join(",")}`).toBe(keys.length);

    if (entries.length === 0) return;

    // 所有元素应该共享同一个 scroll 偏移：top = index * stride - scroll
    const scroll = (indexByKey.get(keys[0]) as number) * stride - entries[0].top;
    for (const entry of entries) {
        const expectedTop = (indexByKey.get(entry.key as string) as number) * stride - scroll;
        expect(
            entry.top,
            `key=${entry.key} 位置不对，可能有重叠或空缺 scroll=${scroll}\n列表=${items.join(",")}\nDOM=${entries
                .map((e) => `${e.key}@${indexByKey.get(e.key as string)}:${e.top}`)
                .join(" ")}`,
        ).toBeCloseTo(expectedTop, 6);
    }

    // 可见（含部分露出）的槽位必须全部渲染
    const renderedIndex = new Set(entries.map((entry) => indexByKey.get(entry.key as string) as number));
    for (let index = 0; index < items.length; index++) {
        const top = index * stride - scroll;
        const bottom = top + itemSize;
        if (bottom > 0 && top < containerSize) {
            expect(renderedIndex.has(index), `gap: index ${index} 可见但未渲染`).toBe(true);
        }
    }
}

function insertItem(items: string[], key: string, index: number) {
    const next = items.slice();
    next.splice(Math.max(0, Math.min(index, next.length)), 0, key);
    return next;
}

function topOf(s: Setup, key: string) {
    const el = s.container.children.find((child) => s.keyByEl.get(child) === key);
    expect(el, `找不到 key=${key}`).toBeDefined();
    return Number.parseFloat(String(el?.style.top));
}

describe("dynamicScrollList", () => {
    it("新增项", () => {
        const s = setup();
        let items: string[] = [];
        for (let i = 0; i < 5; i++) {
            items = insertItem(items, `k${i}`, i);
            s.list.setList(items);
            s.time.settle();
            assertLayout(s, items);
        }
    });

    it("删除项", () => {
        const s = setup();
        let items = Array.from({ length: 10 }, (_, i) => `k${i}`);
        s.list.setList(items);
        s.time.settle();
        assertLayout(s, items);

        for (const index of [4, 0, 2, 5]) {
            items = items.filter((_, i) => i !== index);
            s.list.setList(items);
            s.time.settle();
            assertLayout(s, items);
        }
    });

    it("重排", () => {
        const s = setup();
        let items = Array.from({ length: 8 }, (_, i) => `k${i}`);
        s.list.setList(items);
        s.time.settle();
        assertLayout(s, items);

        const orders = [
            [...items].reverse(),
            [...items.slice(4), ...items.slice(0, 4)],
            [items[2], items[0], items[1], ...items.slice(3)],
        ];
        for (const order of orders) {
            items = order;
            s.list.setList(items);
            s.time.settle();
            assertLayout(s, items);
        }
    });

    it("删除动画未结束就重新加入同一项", () => {
        const s = setup();
        let items = ["a", "b", "c", "d", "e", "f"];
        s.list.setList(items);
        s.time.settle();
        assertLayout(s, items);

        // b 正在淡出时又把它加回来
        items = ["a", "c", "d", "e", "f"];
        s.list.setList(items);
        s.time.tick();
        items = ["a", "c", "d", "e", "f", "b"];
        s.list.setList(items);
        s.time.tick();

        // 再重排一次，新加入的元素必须继续被列表跟踪
        items = ["b", "a", "c", "d", "e", "f"];
        s.list.setList(items);
        s.time.settle();
        assertLayout(s, items);

        // 淡出动画结束后再更新一次，不能留下失去跟踪的旧元素
        items = ["a", "b", "c", "d", "e", "f"];
        s.list.setList(items);
        s.time.settle();
        assertLayout(s, items);
    });

    it("动画未结束就继续增删重排", () => {
        const s = setup();
        let items = Array.from({ length: 10 }, (_, i) => `k${i}`);
        s.list.setList(items);
        s.time.settle();

        // 模拟快速连续更新，每步只推进少量帧
        items = [...items.slice(3), ...items.slice(0, 3)];
        s.list.setList(items);
        s.time.tick();
        items = items.filter((_, i) => i % 2 === 0);
        s.list.setList(items);
        s.time.tick();
        items = ["new0", ...items, "new1"];
        s.list.setList(items);
        s.time.tick();
        s.time.settle();
        assertLayout(s, items);
    });

    it("随机 fuzz", () => {
        const random = createSeededRandom(0x5eed);
        const s = setup();
        let items = Array.from({ length: 12 }, (_, i) => `k${i}`);
        s.list.setList(items);
        s.time.settle();

        let nextKey = items.length;
        const removed: string[] = [];
        for (let step = 0; step < 400; step++) {
            const action = random();
            if (action < 0.2) {
                // 新增
                const key = `k${nextKey++}`;
                items = insertItem(items, key, Math.floor(random() * (items.length + 1)));
            } else if (action < 0.4) {
                // 删除
                if (items.length > 1) {
                    const index = Math.floor(random() * items.length);
                    removed.push(items[index]);
                    items = items.filter((_, i) => i !== index);
                }
            } else if (action < 0.5) {
                // 重新加入之前删除的项（淡出动画可能还没结束）
                if (removed.length > 0) {
                    const key = removed.splice(Math.floor(random() * removed.length), 1)[0];
                    items = insertItem(items, key, Math.floor(random() * (items.length + 1)));
                }
            } else if (action < 0.7) {
                // 重排：把一项挪到别处
                if (items.length > 1) {
                    const from = Math.floor(random() * items.length);
                    const to = Math.floor(random() * items.length);
                    const next = items.slice();
                    const [moved] = next.splice(from, 1);
                    next.splice(to, 0, moved);
                    items = next;
                }
            } else if (action < 0.8) {
                // 整体倒序
                items = items.toReversed();
            } else if (action < 0.9) {
                // 滚动
                s.list.scrollTo(random() * items.length * 100);
            } else {
                // 一次性换一批
                items = Array.from({ length: Math.floor(random() * 10) }, () => `k${nextKey++}`);
            }

            s.list.setList(items);

            // 一半概率不等动画结束就继续，制造打断
            if (random() < 0.5) {
                const frames = Math.floor(random() * 4);
                for (let i = 0; i < frames; i++) s.time.tick();
            } else {
                s.time.settle();
                assertLayout(s, items);
            }
        }

        s.time.settle();
        assertLayout(s, items);
    });

    it("setSize 带动画修改容器尺寸", () => {
        const s = setup();
        const items = Array.from({ length: 20 }, (_, i) => `k${i}`);
        s.list.setList(items, true);
        s.time.settle();
        assertLayout(s, items);

        s.list.setSize(500);
        s.time.tick();
        const midSize = Number.parseFloat(String(s.container.style.height));
        expect(midSize).toBeGreaterThan(300);
        expect(midSize).toBeLessThan(500);

        s.time.settle();
        expect(Number.parseFloat(String(s.container.style.height))).toBeCloseTo(500, 6);
        s.containerSize = 500;
        assertLayout(s, items);
    });

    it("setSize 无动画时立即生效", () => {
        const s = setup();
        const items = Array.from({ length: 20 }, (_, i) => `k${i}`);
        s.list.setList(items, true);
        s.time.settle();

        s.list.setSize(150, false);
        expect(Number.parseFloat(String(s.container.style.height))).toBe(150);
        s.containerSize = 150;
        assertLayout(s, items);
    });

    it("containerSize 为 min/max 时按内容自动撑开", () => {
        const s = setup({ itemSize: 50, containerSize: { min: 100, max: 250 } });
        const heights: number[] = [];

        for (const count of [0, 1, 3, 10]) {
            const items = Array.from({ length: count }, (_, i) => `k${i}`);
            s.list.setList(items, true);
            const height = Number.parseFloat(String(s.container.style.height));
            heights.push(height);
            s.containerSize = height;
            assertLayout(s, items);
        }

        expect(heights).toEqual([100, 100, 150, 250]);
    });

    it("自动撑开默认带动画", () => {
        const s = setup({ itemSize: 50, containerSize: { min: 100, max: 250 } });
        s.list.setList(["k0"], true);
        expect(Number.parseFloat(String(s.container.style.height))).toBe(100);

        s.list.setList(["k0", "k1", "k2"]);
        s.time.tick();
        const midSize = Number.parseFloat(String(s.container.style.height));
        expect(midSize).toBeGreaterThan(100);
        expect(midSize).toBeLessThan(150);

        s.time.settle();
        expect(Number.parseFloat(String(s.container.style.height))).toBeCloseTo(150, 6);
    });

    it("gap 计入项位置和内容长度", () => {
        const s = setup({ itemSize: 50, gap: 10, containerSize: 200 });
        const items = Array.from({ length: 10 }, (_, i) => `k${i}`);
        s.list.setList(items, true);
        s.time.settle();
        assertLayout(s, items);

        s.list.scrollTo(150);
        s.time.settle();
        assertLayout(s, items);

        // 内容长度 = 10 * 50 + 9 * 10 = 590，最大滚动 = 390
        s.list.scrollTo(9999);
        s.time.settle();
        assertLayout(s, items);
        const last = s.container.children.find((el) => s.keyByEl.get(el) === "k9");
        expect(last).toBeDefined();
        expect(Number.parseFloat(String(last?.style.top))).toBeCloseTo(150, 6);
    });

    it("自动撑开包含 gap", () => {
        const s = setup({ itemSize: 50, gap: 10, containerSize: { min: 0, max: 200 } });
        s.list.setList(["k0", "k1", "k2"], true);
        expect(Number.parseFloat(String(s.container.style.height))).toBe(170);

        s.list.setList(
            Array.from({ length: 10 }, (_, i) => `k${i}`),
            true,
        );
        expect(Number.parseFloat(String(s.container.style.height))).toBe(200);
    });

    it("内容小于容器时按 align 沿主轴对齐", () => {
        // 3 项、itemSize 50、gap 10：内容 170，容器 300，剩余 130
        const offsets = { start: 0, center: 65, end: 130 } as const;
        for (const align of ["start", "center", "end"] as const) {
            const s = setup({ itemSize: 50, gap: 10, containerSize: 300, align });
            const items = ["k0", "k1", "k2"];
            s.list.setList(items, true);
            s.time.settle();
            assertLayout(s, items);

            expect(topOf(s, "k0")).toBeCloseTo(offsets[align], 6);
            expect(topOf(s, "k2")).toBeCloseTo(offsets[align] + 2 * 60, 6);
        }
    });

    it("align 跟随容器尺寸变化", () => {
        const s = setup({ itemSize: 50, gap: 10, containerSize: 300, align: "center" });
        s.list.setList(["k0", "k1"], true);
        // 内容 110，剩余 190，居中偏移 95
        expect(topOf(s, "k0")).toBeCloseTo(95, 6);

        s.list.setSize(200, false);
        // 剩余 90，居中偏移 45
        expect(topOf(s, "k0")).toBeCloseTo(45, 6);
        assertLayout(s, ["k0", "k1"]);
    });
});
