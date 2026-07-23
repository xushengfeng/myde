import { view } from "dkh-ui";
import { AnimationGear, timingFunction } from "myde-ui";

type Direction = "up" | "down" | "left" | "right";

function isVertical(dir: Direction) {
    return dir === "up" || dir === "down";
}

interface AnimatedElement<T> {
    el: ReturnType<typeof view>;
    index: number;
    gear: AnimationGear<{ show: number }>;
    moveGear: AnimationGear<{ pos: number }>;
    state: "normal" | "moving";
    data: T;
}

export function dynamicScrollList<T>(options: {
    itemSize: number;
    containerSize: number;
    direction: Direction;
    renderItem: (item: T, index: number) => ReturnType<typeof view>;
    keyExtractor: (item: T, index: number) => string;
    snap?: boolean;
    onScroll?: (index: number, progress: number) => void;
    bufferSize?: number;
    animationDuration?: number;
}) {
    const {
        itemSize,
        containerSize,
        direction,
        renderItem,
        keyExtractor,
        snap = false,
        onScroll,
        bufferSize = 5,
        animationDuration = 300,
    } = options;

    const vertical = isVertical(direction);

    let items: T[] = [];
    const renderedEls = new Map<string, AnimatedElement<T>>();
    let currentPage = 0;
    let currentScroll = 0;

    const container = view().style({
        [vertical ? "height" : "width"]: `${containerSize}px`,
        [vertical ? "width" : "height"]: `${itemSize}px`,
        overflow: "hidden",
        position: "relative",
    });

    const scrollGear = new AnimationGear({ scroll: 0 }, { transition: { duration: 0, map: timingFunction.linear } });

    function getVisibleRange() {
        const start = Math.floor(currentScroll / itemSize);
        const end = Math.ceil((currentScroll + containerSize) / itemSize);
        return {
            start: Math.max(0, start - bufferSize),
            end: Math.min(items.length, end + bufferSize),
        };
    }

    function createAnimatedElement(data: T, index: number): AnimatedElement<T> {
        const el = renderItem(data, index);
        const gear = new AnimationGear<{ show: number }>(
            { show: 0 },
            { transition: { duration: animationDuration, map: timingFunction.easeOut } },
        );

        el.style({
            position: "absolute",
            [vertical ? "left" : "top"]: "0",
            [vertical ? "width" : "height"]: "100%",
            [vertical ? "height" : "width"]: `${itemSize}px`,
            [vertical ? "top" : "left"]: `${index * itemSize - currentScroll}px`,
        });

        gear.setUpdateCallback((state) => {
            el.style({
                opacity: `${state.show}`,
                filter: `blur(${10 * (1 - state.show)}px)`,
            });
        });
        gear.moveTo({ show: 0 }, 0);

        const moveGear = new AnimationGear<{ pos: number }>(
            { pos: index * itemSize - currentScroll },
            { transition: { duration: animationDuration, map: timingFunction.easeInOut } },
        );

        moveGear.setUpdateCallback((state) => {
            el.style({
                [vertical ? "top" : "left"]: `${state.pos}px`,
            });
        });

        return { el, index, gear, moveGear, state: "normal", data };
    }

    function animateEnter(item: AnimatedElement<T>, noAnimation?: boolean) {
        item.gear.moveTo({ show: 1 }, { duration: noAnimation ? 0 : animationDuration, map: timingFunction.easeOut });
    }

    function animateExit(item: AnimatedElement<T>, onComplete: () => void, noAnimation?: boolean) {
        item.gear.moveTo(
            { show: 0 },
            { duration: noAnimation ? 0 : animationDuration, map: timingFunction.easeIn },
            onComplete,
        );
    }

    function animateMove(item: AnimatedElement<T>, newIndex: number) {
        const targetPosition = newIndex * itemSize - currentScroll;
        const currentPosition = parseFloat(item.el.el.style[vertical ? "top" : "left"]) || 0;
        const distance = targetPosition - currentPosition;

        if (Math.abs(distance) < 1) return;

        item.state = "moving";
        item.index = newIndex;

        const gear = item.gear;
        gear.moveTo({ show: 1 }, 0);

        const moveGear = item.moveGear;

        moveGear.moveTo({ pos: targetPosition }, { duration: animationDuration, map: timingFunction.easeInOut }, () => {
            item.state = "normal";
        });
    }

    function diffAndUpdateVisibleItems(oldItems: T[], noAnimation: boolean) {
        const { start, end } = getVisibleRange();

        // 构建旧列表的 key -> index 映射
        const oldKeys = new Map<string, number>();
        for (let i = 0; i < oldItems.length; i++) {
            const key = keyExtractor(oldItems[i], i);
            oldKeys.set(key, i);
        }

        // 构建新列表的 key -> index 映射
        const newKeys = new Map<string, number>();
        for (let i = 0; i < items.length; i++) {
            const key = keyExtractor(items[i], i);
            newKeys.set(key, i);
        }

        // 处理新增和移动的元素（只处理可见范围）
        const vOldKeys: typeof oldKeys = new Map();
        const vNewKeys: typeof newKeys = new Map();
        for (const [k, v] of oldKeys) {
            if (start <= v && v <= end) vOldKeys.set(k, v);
        }
        for (const [k, v] of newKeys) {
            if (start <= v && v <= end) vNewKeys.set(k, v);
        }
        for (const [k, v] of newKeys) {
            if (!oldKeys.has(k)) {
                // 新增
                if (start <= v && v <= end) {
                    const newItem = createAnimatedElement(items[v], v);
                    renderedEls.set(k, newItem);
                    container.add(newItem.el);
                    animateEnter(newItem, noAnimation);
                }
            }
        }
        for (const [k] of vOldKeys) {
            if (!newKeys.has(k)) {
                // 移除
                const el = renderedEls.get(k);
                if (!el) continue;
                animateExit(
                    el,
                    () => {
                        el.el.remove();
                        renderedEls.delete(k);
                    },
                    noAnimation,
                );
            }
        }
        for (const [k, v] of oldKeys) {
            const newV = newKeys.get(k);
            if (newV !== undefined && newV !== v) {
                if ((start <= v && v <= end) || (start <= newV && newV <= end)) {
                    // move
                    const rel = renderedEls.get(k);
                    if (rel) {
                        animateMove(rel, newV);
                    } else {
                        const el = createAnimatedElement(oldItems[v], v);
                        if (el) animateMove(el, newV);
                    }
                }
            }
        }
    }

    function updateVisibleItems() {
        const { start, end } = getVisibleRange();

        // 移除不可见元素
        for (const [id, item] of Array.from(renderedEls.entries())) {
            if (item.index < start || item.index >= end) {
                item.el.remove();
                renderedEls.delete(id);
            }
        }

        // 添加可见元素
        for (let i = start; i < end; i++) {
            const data = items[i];
            if (!data) continue;

            const id = keyExtractor(data, i);
            if (!renderedEls.has(id)) {
                const newItem = createAnimatedElement(data, i);
                renderedEls.set(id, newItem);
                container.add(newItem.el);
                newItem.gear.moveTo({ show: 1 }, 0);
            }
        }
    }

    scrollGear.setUpdateCallback((state) => {
        currentScroll = state.scroll;

        // 更新所有元素位置（仅对非动画中的元素）
        const renderedArray = Array.from(renderedEls.values());
        for (const item of renderedArray) {
            if (item.state === "moving") {
                // todo gear添加判断方法
                item.moveGear.moveTo({ pos: item.index * itemSize - currentScroll });
            } else
                item.el.style({
                    [vertical ? "top" : "left"]: `${item.index * itemSize - currentScroll}px`,
                });
        }

        // 更新可见元素
        updateVisibleItems();

        // 回调
        if (onScroll && items.length > 0) {
            const exactIndex = currentScroll / itemSize;
            const index = Math.floor(exactIndex);
            const progress = exactIndex - index;
            onScroll(Math.min(index, items.length - 1), progress);
        }
    });

    function getMaxScroll() {
        return Math.max(0, items.length * itemSize - containerSize);
    }

    function scrollTo(val: number, animate = false) {
        const target = Math.max(0, Math.min(val, getMaxScroll()));
        if (animate) {
            scrollGear.moveTo({ scroll: target }, { duration: 400, map: timingFunction.easeInOut });
        } else {
            scrollGear.moveTo({ scroll: target }, 0);
        }
    }

    function scrollToPage(page: number, animate = true) {
        currentPage = Math.max(0, Math.min(page, items.length - 1));
        scrollTo(currentPage * itemSize, animate);
    }

    function setList(newItems: T[], disableAnimation?: boolean) {
        const oldItems = items;
        items = newItems;
        if (currentPage >= items.length) {
            currentPage = Math.max(0, items.length - 1);
        }

        // 使用 diff 算法更新可见元素
        diffAndUpdateVisibleItems(oldItems, Boolean(disableAnimation));

        // 更新滚动位置
        if (snap) {
            scrollToPage(currentPage, false);
        } else {
            scrollTo(Math.min(currentScroll, getMaxScroll()), false);
        }
    }

    function nextPage() {
        scrollToPage(currentPage + 1, true);
    }

    function prevPage() {
        scrollToPage(currentPage - 1, true);
    }

    function goToPage(page: number) {
        scrollToPage(page, true);
    }

    container.el.addEventListener("wheel", (e) => {
        e.preventDefault();
        const delta = vertical ? e.deltaY : e.deltaX || e.deltaY;

        if (snap) {
            if (delta > 0) nextPage();
            else if (delta < 0) prevPage();
        } else {
            scrollTo(currentScroll + delta, false);
        }
    });

    let touchStartPos = 0;
    let touchStartScroll = 0;

    container.el.addEventListener("touchstart", (e) => {
        touchStartPos = vertical ? e.touches[0].clientY : e.touches[0].clientX;
        touchStartScroll = currentScroll;
    });

    container.el.addEventListener("touchmove", (e) => {
        e.preventDefault();
        const pos = vertical ? e.touches[0].clientY : e.touches[0].clientX;
        if (!snap) {
            scrollTo(touchStartScroll + (touchStartPos - pos), false);
        }
    });

    container.el.addEventListener("touchend", (e) => {
        if (snap) {
            const pos = vertical ? e.changedTouches[0].clientY : e.changedTouches[0].clientX;
            const delta = touchStartPos - pos;
            if (Math.abs(delta) > 20) {
                delta > 0 ? nextPage() : prevPage();
            }
        }
    });

    return {
        el: container,
        setList,
        scrollTo: (val: number) => scrollTo(val, false),
        scrollToPage,
        nextPage,
        prevPage,
        goToPage,
        getCurrentPage: () => currentPage,
        getTotalPages: () => items.length,
    };
}

export function carousel<T>(options: {
    itemSize: number;
    direction: Direction;
    renderItem: (item: T, index: number) => ReturnType<typeof view>;
    keyExtractor: (item: T, index: number) => string;
    onScroll?: (index: number, progress: number) => void;
}) {
    const { itemSize, direction, renderItem, keyExtractor, onScroll } = options;

    const list = dynamicScrollList({
        itemSize,
        containerSize: itemSize,
        direction,
        renderItem,
        keyExtractor,
        snap: true,
        onScroll,
        bufferSize: 1,
    });

    let isDragging = false;
    let startPos = 0;
    let startScroll = 0;
    let currentDragScroll = 0;
    const vertical = isVertical(direction);

    list.el.el.addEventListener("mousedown", (e) => {
        isDragging = true;
        startPos = vertical ? e.clientY : e.clientX;
        startScroll = list.getCurrentPage() * itemSize;
        currentDragScroll = startScroll;
        list.el.el.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        const pos = vertical ? e.clientY : e.clientX;
        currentDragScroll = startScroll + (startPos - pos);
        list.scrollTo(currentDragScroll);
    });

    window.addEventListener("mouseup", () => {
        if (!isDragging) return;
        isDragging = false;
        list.el.el.style.cursor = "";
        // 根据当前拖拽位置计算应该吸附到哪个页面
        const targetPage = Math.round(currentDragScroll / itemSize);
        list.scrollToPage(targetPage, true);
    });

    return list;
}
