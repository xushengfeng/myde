import { view } from "dkh-ui";
import { AnimationGear, timingFunction } from "myde-ui";

type Direction = "up" | "down" | "left" | "right";

function isVertical(dir: Direction) {
    return dir === "up" || dir === "down";
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
    } = options;

    const vertical = isVertical(direction);

    let items: T[] = [];
    const renderedEls = new Map<string, { el: ReturnType<typeof view>; index: number }>();
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
                const el = renderItem(data, i);
                el.style({
                    position: "absolute",
                    [vertical ? "left" : "top"]: "0",
                    [vertical ? "width" : "height"]: "100%",
                    [vertical ? "height" : "width"]: `${itemSize}px`,
                    [vertical ? "top" : "left"]: `${i * itemSize - currentScroll}px`,
                });
                renderedEls.set(id, { el, index: i });
                container.add(el);
            }
        }
    }

    scrollGear.setUpdateCallback((state) => {
        currentScroll = state.scroll;

        // 更新所有元素位置
        const renderedArray = Array.from(renderedEls.values());
        for (const item of renderedArray) {
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

    function setList(newItems: T[]) {
        items = newItems;
        if (currentPage >= items.length) {
            currentPage = Math.max(0, items.length - 1);
        }

        // 清除所有元素
        const renderedArray = Array.from(renderedEls.values());
        for (const item of renderedArray) {
            item.el.remove();
        }
        renderedEls.clear();

        // 重新渲染
        updateVisibleItems();

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
    const vertical = isVertical(direction);

    list.el.el.addEventListener("mousedown", (e) => {
        isDragging = true;
        startPos = vertical ? e.clientY : e.clientX;
        startScroll = list.getCurrentPage() * itemSize;
        list.el.el.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        const pos = vertical ? e.clientY : e.clientX;
        list.scrollTo(startScroll + (startPos - pos));
    });

    window.addEventListener("mouseup", () => {
        if (!isDragging) return;
        isDragging = false;
        list.el.el.style.cursor = "";
        list.scrollToPage(list.getCurrentPage(), true);
    });

    return list;
}
