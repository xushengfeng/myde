import { button, type ElType, image, pack, spacer, trackPoint, txt, view } from "dkh-ui";
import { AnimationGear, timingFunction } from "myde-ui";
import type { ImComposeState } from "../../../src/sys_api/input_method";
import type { MenuItem } from "../../../src/sys_api/menu";
import { throttle } from "../../../src/utils/throttle";
import { getIconXEl } from "./icon";
import type { BindingSource } from "./registry";
import { carousel, dynamicScrollList, type ScrollListSize } from "./scroll-list";

export function sSize(s: 1 | 1.5 | 2 | 2.5 | 3 | 3.5 | 4 | 4.5 | 5 | 5.5 | 6 | 6.5 | 7 | 7.7 | 8 | 9 | 10 | 11 | 12) {
    const baseSize = 12;
    const gap = 8;
    const n = s / 0.5;
    return n * baseSize + (n - 1) * gap;
}

export const sSize2 = {
    paddingx: 8,
    radius1: 10,
    padding: 8,
    radius2: 18,
};

/**
 * 圆角只有这几种来源：第一层容器、第二/三层条目、应用图标。
 * 窗口圆角由设置里的 --window-radius 单独控制。
 */
export const gRadius = {
    /** 第一层：毛玻璃容器、面板外壳 */
    container: sSize2.radius2,
    /** 第二层：面板；第三层：条目 */
    item: sSize2.radius1,
    /** 应用图标容器 */
    icon: 12,
} as const;

const gFontWeight = {
    regular: "400",
    medium: "500",
    strong: "600",
} as const;

/**
 * 文字层级：用字号、字重和颜色区分，不用 opacity。
 * display 页面/分区标题，title 面板标题，subtitle 窗口标题，
 * body 正文与列表项，strong 正文强调，caption/captionStrong 次要说明，
 * micro/microStrong 标签和快捷键提示。
 * 字重走 weight token，后面换主题时只改这里。
 * 默认搭配 aLineText（单行、溢出省略、不可选）；需要文章式换行时才刻意使用 txt 等。
 */
export const gTextStyle = {
    family: "sans-serif",
    monoFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    weight: gFontWeight,
    display: {
        fontSize: "20px",
        fontWeight: gFontWeight.strong,
        lineHeight: "1.3",
    },
    title: {
        fontSize: "14px",
        fontWeight: gFontWeight.strong,
        lineHeight: "1.4",
    },
    subtitle: {
        fontSize: "13px",
        fontWeight: gFontWeight.medium,
        lineHeight: "1.45",
    },
    body: {
        fontSize: "13px",
        fontWeight: gFontWeight.regular,
        lineHeight: "1.45",
    },
    strong: {
        fontSize: "13px",
        fontWeight: gFontWeight.strong,
        lineHeight: "1.45",
    },
    caption: {
        fontSize: "12px",
        fontWeight: gFontWeight.regular,
        lineHeight: "1.4",
    },
    captionStrong: {
        fontSize: "12px",
        fontWeight: gFontWeight.strong,
        lineHeight: "1.4",
    },
    micro: {
        fontSize: "10px",
        fontWeight: gFontWeight.regular,
        lineHeight: "1.2",
    },
    microStrong: {
        fontSize: "10px",
        fontWeight: gFontWeight.strong,
        lineHeight: "1.2",
    },
    color: {
        primary: "#111111",
        secondary: "#666666",
        muted: "#999999",
        inverse: "#ffffff",
        error: "#c0392b",
    },
} as const;

/** 只有两种表面阴影：窗口框架，和工具弹窗/搜索框这类小面板 */
export const gShadowStyle = {
    /** 窗口：服务端绘制的窗口框架 */
    window: "0 12px 40px #00000033",
    /** 面板：工具弹窗、搜索框、开始菜单等浮层 */
    panel: "0 2px 12px #0000001f",
} as const;

export const gGlassStyle = {
    bg: {
        backdropFilter: "blur(12px)",
        background: "rgba(245, 245, 245, 0.8)",
        boxShadow: gShadowStyle.panel,
    },
    itemInBg: {
        backgroundColor: "#ffffff88",
    },
    justItem: {
        backdropFilter: "blur(12px)",
        backgroundColor: "rgb(250.88, 250.88, 250.88, 0.9066)",
        boxShadow: gShadowStyle.panel,
    },
} as const;

/**
 * 三层材质：第一层是唯一使用毛玻璃的层，第二层只叠透明，第三层是实心白强调。
 * 第一层内部只直接放第二层面板，文字等内容放在第二/三层里。
 * 第二、三层不带 padding / gap，间距统一由第一层给；第三层 item 用 iItem，自带 item 圆角。
 */
export const gSurfaceStyle = {
    backdrop: gGlassStyle.bg,
    panel: {
        backgroundColor: gGlassStyle.itemInBg.backgroundColor,
    },
    solid: {
        backgroundColor: "#ffffff",
    },
} as const;

const fontStyle = {
    title: gTextStyle.title,
    low: {
        ...gTextStyle.body,
        color: gTextStyle.color.secondary,
    },
};

export function px(n: number) {
    return `${n}px`;
}
export function aLineText() {
    const textEl = view().style({
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        overflow: "hidden",
        textBoxTrim: "trim-both",
        userSelect: "none",
        width: "100%",
    });
    const wrapEl = view().style({
        overflow: "hidden",
    });
    wrapEl.add(textEl);
    return wrapEl
        .bindSet((t: string) => {
            textEl.el.innerText = t;
        })
        .bindGet(() => {
            return textEl.el.innerText;
        });
}

/** 顶栏临时提示里的等级条：图标和轨道各是一个 L2，轨道内部是 L3 */
export function uLevelRow(op: { icon: string; width?: number }) {
    const iconEl = getIconXEl(op.icon, { size: 20, width: 24, height: 24 });
    const iconBox = view()
        .style({
            width: px(sSize(1)),
            height: px(sSize(1)),
            borderRadius: px(gRadius.item),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: "0",
            ...gGlassStyle.itemInBg,
        })
        .add(iconEl);
    const fill = view().style({
        background: "#ffffff",
        height: "100%",
        width: "0%",
        transition: "width 120ms",
    });
    const track = view()
        .style({
            flexGrow: "1",
            height: px(sSize(1)),
            borderRadius: px(gRadius.item),
            overflow: "hidden",
            ...gGlassStyle.itemInBg,
        })
        .add(fill);
    const row = view("x")
        .style({
            width: px(op.width ?? sSize(5)),
            height: px(sSize(1)),
            alignItems: "center",
            gap: px(sSize2.paddingx),
            flexShrink: "0",
        })
        .add([iconBox, track]);
    return {
        el: row,
        sv(value: number, muted = false) {
            fill.style({
                width: `${Math.min(1, Math.max(0, value)) * 100}%`,
                background: muted ? gTextStyle.color.muted : "#ffffff",
            });
            iconEl.el.style.opacity = muted ? "0.5" : "1";
        },
    };
}

/** 顶栏临时提示里的文字消息：图标 + 标题 + 可选说明 */
export function uStatusToast(op: { icon: string; title: string; detail?: string; width?: number }) {
    const text = view("y").style({
        flexGrow: "1",
        minWidth: "0",
        justifyContent: "center",
        gap: "1px",
    });
    text.add(
        aLineText()
            .sv(op.title)
            .style({
                ...gTextStyle.strong,
                color: gTextStyle.color.primary,
            }),
    );
    if (op.detail) {
        text.add(
            aLineText()
                .sv(op.detail)
                .style({
                    ...gTextStyle.caption,
                    color: gTextStyle.color.secondary,
                }),
        );
    }
    return ui
        .barItem()
        .style({
            width: px(op.width ?? sSize(5)),
            height: px(sSize(1.5)),
            display: "flex",
            alignItems: "center",
            gap: px(sSize2.paddingx),
            padding: `0 ${px(sSize2.paddingx)}`,
            boxSizing: "border-box",
            overflow: "hidden",
            flexShrink: "0",
        })
        .add([getIconXEl(op.icon, { size: 20, width: 24, height: 24 }), text]);
}

export function uPasswdInput() {
    /** 每个字符一个稳定 id，滚动列表用它做进出动画 */
    const keys: number[] = [];
    const chars = new Map<number, string>();
    let nextId = 0;
    const dotSize = sSize2.paddingx;
    const dotGap = 4;

    const textEl = view("x")
        .style({
            position: "relative",
            overflow: "hidden",
            width: "100%",
            cursor: "text",
            height: "100%",
            alignItems: "center",
        })
        .attr({ tabIndex: 0 });

    const field = uScrollList<number>({
        itemSize: dotSize,
        gap: dotGap,
        align: "center",
        containerSize: 0,
        crossSize: "100%",
        listCrossSize: dotSize,
        direction: "right",
        bufferSize: 2,
        animationDuration: 200,
        keyExtractor: (id) => id.toString(),
        renderItem: () =>
            view().style({
                background: "#000",
                borderRadius: "50%",
            }),
        empty: "",
    });
    // 密码框不响应滚轮/拖拽，只跟随输入滚动到最新字符
    field.el.style({ display: "flex", alignItems: "center", pointerEvents: "none" });
    textEl.add(field.el);

    const wrapEl = view().style({
        overflowX: "hidden",
    });
    wrapEl.add(textEl);

    /** 输入框宽度由布局决定，用 ResizeObserver 同步给滚动列表 */
    let listWidth = 0;
    function syncWidth() {
        const width = textEl.el.clientWidth;
        if (width > 0 && Math.abs(width - listWidth) > 0.5) {
            listWidth = width;
            field.setSize(width, false);
        }
    }
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(syncWidth);
    resizeObserver?.observe(textEl.el);
    requestAnimationFrame(syncWidth);

    function setKeys() {
        field.setList(keys.slice());
        // 内容变化时让列表滚动 / 对齐动画接管，最新字符保持可见
        field.scrollTo(Number.MAX_SAFE_INTEGER, 200);
    }

    textEl.el.addEventListener("click", () => {
        textEl.el.focus();
    });

    wrapEl.on("click", () => {
        textEl.el.focus();
    });

    textEl.el.addEventListener("keydown", (e) => {
        e.preventDefault();

        if (e.key === "Enter") {
            wrapEl.el.dispatchEvent(new Event("change"));
            return;
        }

        if (e.key === "Backspace") {
            const id = keys.pop();
            if (id !== undefined) {
                chars.delete(id);
                setKeys();
            }
            return;
        }

        if (e.key.length !== 1) return;

        const id = nextId++;
        chars.set(id, e.key);
        keys.push(id);
        setKeys();
        wrapEl.el.dispatchEvent(new Event("input"));
    });

    return {
        el: wrapEl.bindGet(() => keys.map((id) => chars.get(id) ?? "").join("")),
        focus: () => textEl.el.focus(),
        disable: (d: boolean) => {
            if (d) {
                textEl.el.removeAttribute("tabIndex");
                textEl.style({ opacity: "0.5", cursor: "default" });
            } else {
                textEl.attr({ tabIndex: 0 });
                textEl.style({ opacity: "1", cursor: "text" });
            }
        },
        placeholder: (t: string) => {
            field.setEmpty(t);
        },
        clear: () => {
            keys.length = 0;
            chars.clear();
            setKeys();
        },
        inputKey: (k: string) => {
            textEl.el.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
        },
    };
}

export function iItem(op: { type: "h" | "v" | "sq"; size: 1 | 1.5 | 2 }) {
    const el = view().style({ borderRadius: `${gRadius.item}px` });
    const s = `${sSize(op.size)}px`;
    if (op.type === "h") {
        return el.style({ height: s });
    } else if (op.type === "v") {
        return el.style({ width: s });
    } else if (op.type === "sq") {
        return el.style({ width: s, height: s });
    }
    return el;
}

export function uToggleItem() {
    view().style({});
}

/** 来源标签：搜索结果右侧的「应用 / 窗口 / 虚拟屏」等小标签 */
export function sourceTag(text: string) {
    return aLineText()
        .sv(text)
        .style({
            ...gTextStyle.micro,
            color: gTextStyle.color.secondary,
            background: "#0000000a",
            padding: "2px 6px",
            borderRadius: px(gRadius.item),
            width: "fit-content",
            flexShrink: "0",
        });
}

/**
 * 带空提示的滚动列表：空时提示水平 / 垂直居中，非空时隐藏。
 * 其它方法直接转发给 dynamicScrollList。
 */
export function uScrollList<T>(op: {
    itemSize: number;
    /** 相邻项之间的间距，默认 0 */
    gap?: number;
    /** 内容小于容器时沿主轴对齐，默认 start */
    align?: "start" | "center" | "end";
    /** 主轴尺寸；传 `{ min, max }` 时按内容自动撑开 */
    containerSize: ScrollListSize;
    direction: "up" | "down" | "left" | "right";
    /** 垂直列表的宽度 / 水平列表的高度；缺省为 itemSize */
    crossSize?: number | string;
    /** 列表本身在交叉轴上的尺寸；缺省填满 crossSize（100%） */
    listCrossSize?: number | string;
    renderItem: (item: T, index: number, list: T[]) => ReturnType<typeof view>;
    keyExtractor: (item: T, index: number) => string;
    snap?: boolean;
    onScroll?: (index: number, progress: number) => void;
    bufferSize?: number;
    animationDuration?: number;
    dragByMouse?: boolean;
    /** 没有项时显示的单行提示 */
    empty: string;
}) {
    const vertical = op.direction === "up" || op.direction === "down";
    const crossSize = op.crossSize ?? op.itemSize;
    const listCrossSize = op.listCrossSize ?? "100%";
    const listCross = typeof listCrossSize === "number" ? px(listCrossSize) : listCrossSize;
    const duration = op.animationDuration ?? 300;

    const wrap = view();
    const list = dynamicScrollList<T>({
        ...op,
        onContainerSizeChange: (size) => {
            wrap.style({ [vertical ? "height" : "width"]: px(size) });
        },
    });
    list.el.style(vertical ? { width: listCross } : { height: listCross });

    const emptyEl = view("x").style({
        position: "absolute",
        inset: "0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
    });
    const emptyText = aLineText()
        .sv(op.empty)
        .style({
            ...gTextStyle.body,
            color: gTextStyle.color.secondary,
            width: "fit-content",
            maxWidth: "90%",
        });
    emptyEl.add(emptyText);

    wrap.style({
        position: "relative",
        [vertical ? "width" : "height"]: typeof crossSize === "number" ? px(crossSize) : crossSize,
        [vertical ? "height" : "width"]: px(list.getSize()),
        overflow: "hidden",
    });
    wrap.add([list.el, emptyEl]);

    const crossGear = new AnimationGear(
        { size: typeof crossSize === "number" ? crossSize : 0 },
        { transition: { duration: 0, map: timingFunction.linear } },
    );
    crossGear.setUpdateCallback((state) => {
        wrap.style({ [vertical ? "width" : "height"]: px(state.size) });
    });

    /** 设置交叉轴尺寸（垂直列表的宽 / 水平列表的高）；数字可动画 */
    function setCrossSize(size: number | string, animate = true) {
        if (typeof size === "string") {
            wrap.style({ [vertical ? "width" : "height"]: size });
            return;
        }
        if (!Number.isFinite(size)) return;
        crossGear.moveTo({ size: Math.max(0, size) }, animate ? { duration, map: timingFunction.easeInOut } : 0);
    }

    /**
     * 设置尺寸：数字表示主轴尺寸，对象可同时设置宽高。
     * 主轴尺寸走列表内部计算，交叉轴尺寸走外层容器。
     */
    function setSize(size: number | { width?: number; height?: number }, animate = true) {
        if (typeof size === "number") {
            list.setSize(size, animate);
            return;
        }
        if (vertical) {
            if (size.height !== undefined) list.setSize(size.height, animate);
            if (size.width !== undefined) setCrossSize(size.width, animate);
        } else {
            if (size.width !== undefined) list.setSize(size.width, animate);
            if (size.height !== undefined) setCrossSize(size.height, animate);
        }
    }

    const setList = (items: T[], disableAnimation?: boolean) => {
        list.setList(items, disableAnimation);
        emptyEl.style({ display: items.length === 0 ? "flex" : "none" });
    };

    return {
        ...list,
        el: wrap,
        setList,
        setSize,
        setCrossSize,
        setEmpty: (text: string) => emptyText.sv(text),
    };
}

/** 统一开关：44 × 24，开启蓝底白钮 */
export function uSwitch(initial: boolean, onChange: (value: boolean) => void) {
    let value = initial;
    const knob = view().style({
        width: "20px",
        height: "20px",
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 3px #00000033",
        transition: "all 0.15s ease",
    });
    const track = view("x")
        .style({
            width: "44px",
            height: "24px",
            padding: "2px",
            boxSizing: "border-box",
            borderRadius: "12px",
            cursor: "pointer",
            flexShrink: "0",
            transition: "background 0.15s ease",
        })
        .add(knob);
    const render = () => {
        track.style({
            background: value ? "#00aaff" : "#00000026",
            justifyContent: value ? "flex-end" : "flex-start",
        });
    };
    render();
    const toggle = () => {
        value = !value;
        render();
        onChange(value);
    };
    track.on("click", (e) => {
        // 行本身也可点击；开关自己处理，避免冒泡后重复切换
        e.stopPropagation();
        toggle();
    });
    return {
        el: track,
        setValue: (next: boolean) => {
            if (next === value) return;
            value = next;
            render();
        },
        toggle,
    };
}

/** L2 设置行：左侧可选图标 + 标签，右侧开关等控件；整行可点击 */
export function uToggleRow(
    label: string,
    control: { el: ElType<HTMLElement>; toggle?: () => void },
    op?: { icon?: string },
) {
    const row = ui.barItem().style({
        height: px(sSize(1.5)),
        display: "flex",
        alignItems: "center",
        gap: px(sSize2.paddingx),
        padding: `0 ${px(sSize2.paddingx)}`,
        boxSizing: "border-box",
    });
    if (op?.icon) row.add(getIconXEl(op.icon, { size: 24, width: 28, height: 24 }));
    row.add([
        aLineText()
            .sv(label)
            .style({
                ...gTextStyle.body,
                color: gTextStyle.color.primary,
                flexGrow: "1",
            }),
        control.el,
    ]);
    const toggle = control.toggle;
    if (toggle) row.on("click", () => toggle());
    return row;
}

export type SelectMarkKind = "radio" | "checkbox" | "check";

/** 选择标记：圆 = 单选，方 = 多选，勾 = 选中 / 托盘开关 */
export function uSelectMark(kind: SelectMarkKind, selected = false, size = 16) {
    const box = view().style({
        position: "relative",
        width: px(size),
        height: px(size),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: "0",
    });
    let value = selected;
    const render = () => {
        box.clear();
        if (kind === "check") {
            if (value) box.add(getIconXEl("check", { size, padding: 1 }));
            return;
        }
        if (kind === "radio") {
            box.add(getIconXEl("circle", { size, padding: 1 }));
            if (value) {
                box.add(
                    view()
                        .style({
                            position: "absolute",
                            inset: "0",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                        })
                        .add(getIconXEl("circle.fill", { size: Math.round(size * 0.5) })),
                );
            }
            return;
        }
        box.add(getIconXEl("square", { size, padding: 1 }));
        if (value) {
            box.add(
                view()
                    .style({
                        position: "absolute",
                        inset: "0",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                    })
                    .add(getIconXEl("check", { size: Math.round(size * 0.7) })),
            );
        }
    };
    render();
    return {
        el: box,
        setSelected: (next: boolean) => {
            if (next === value) return;
            value = next;
            render();
        },
    };
}

/** 统一的列表行：左侧图标 / 文本，右侧详情 / 选择标记 */
export function uChoiceRow(op: {
    label: string;
    detail?: string;
    icon?: ElType<HTMLElement> | { el: HTMLElement };
    right?: ElType<HTMLElement> | { el: HTMLElement };
    mark?: SelectMarkKind;
    selected?: boolean;
    size?: 1 | 1.5;
    /** 选中时是否用 L3 实心白强调；tray 菜单用 false，只显示勾 */
    emphasize?: boolean;
    onClick?: () => void;
}) {
    let selected = op.selected ?? false;
    const emphasize = op.emphasize ?? true;
    const row = iItem({ type: "h", size: op.size ?? 1.5 }).style({
        display: "flex",
        alignItems: "center",
        padding: `0 ${px(sSize2.paddingx)}`,
        gap: px(sSize2.paddingx),
        boxSizing: "border-box",
        cursor: op.onClick ? "pointer" : "default",
    });
    if (op.icon) row.add(op.icon);
    const label = aLineText()
        .sv(op.label)
        .style({
            ...gTextStyle.body,
            color: gTextStyle.color.primary,
            flexGrow: "1",
            minWidth: "0",
        });
    row.add(label);
    const detail = aLineText()
        .sv(op.detail ?? "")
        .style({
            ...gTextStyle.caption,
            color: gTextStyle.color.secondary,
            width: "fit-content",
            maxWidth: "45%",
            flexShrink: "0",
        });
    detail.style({ display: op.detail ? "" : "none" });
    row.add(detail);
    const mark = op.mark ? uSelectMark(op.mark, selected) : undefined;
    if (op.right) row.add(op.right);
    else if (mark) row.add(mark.el);

    const renderSelected = () => {
        if (emphasize) {
            row.style({ background: selected ? gSurfaceStyle.solid.backgroundColor : "transparent" });
        }
        mark?.setSelected(selected);
    };
    renderSelected();

    if (op.onClick) row.on("click", () => op.onClick?.());

    return {
        el: row,
        setLabel: (text: string) => label.sv(text),
        setDetail: (text: string) => {
            detail.sv(text);
            detail.style({ display: text ? "" : "none" });
        },
        setSelected: (next: boolean) => {
            selected = next;
            renderSelected();
        },
    };
}

/** 电池信息行：电池图标 + 百分比 + 充电状态 */
export function uBatteryInfo(initial: { percentage: number; charging: boolean }) {
    const battery = getIconXEl("battery", { size: 24, width: 28, height: 24 });
    // 电量条动效从下方经过，图标和数字用背景模糊保持清晰
    const batteryBox = view().style({ backdropFilter: "blur(3px)", borderRadius: "6px" }).add(battery);
    const valueText = aNumberText({
        fontSize: 20,
        lineHeight: 26,
        color: gTextStyle.color.primary,
    });
    valueText.el.style({
        backdropFilter: "blur(3px)",
        borderRadius: "4px",
    });
    const statusText = aLineText().style({
        ...gTextStyle.caption,
        color: gTextStyle.color.secondary,
        width: "fit-content",
    });
    let percentage = initial.percentage;
    let charging = initial.charging;
    const render = () => {
        valueText.sv(`${percentage}%`);
        statusText.sv(charging ? "充电中" : "未充电");
        battery.sv("value", Math.max(0, Math.min(1, percentage / 100)));
    };
    render();
    return {
        el: view("x")
            .style({ alignItems: "center", gap: px(sSize2.padding) })
            .add([batteryBox, view("y").style({ gap: "1px", minWidth: "0" }).add([valueText.el, statusText])]),
        setValue: (nextPercentage: number, nextCharging: boolean) => {
            percentage = nextPercentage;
            charging = nextCharging;
            render();
        },
    };
}

/** 均匀三等分（或任意等分）的横向选择条 */
export function uSegmented<T extends string>(op: {
    items: { label: string; value: T }[];
    value?: T;
    onChange?: (value: T) => void;
}) {
    const row = view("x").style({
        width: "100%",
        height: px(sSize(1)),
        gap: "2px",
    });
    let items = op.items;
    let value = op.value;
    const render = () => {
        row.clear();
        for (const item of items) {
            const selected = item.value === value;
            const seg = iItem({ type: "h", size: 1 })
                .style({
                    flex: "1",
                    minWidth: "0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    overflow: "hidden",
                    background: selected ? gSurfaceStyle.solid.backgroundColor : "transparent",
                })
                .add(
                    aLineText()
                        .sv(item.label)
                        .style({
                            ...gTextStyle.body,
                            color: gTextStyle.color.primary,
                            width: "fit-content",
                            maxWidth: "100%",
                            textAlign: "center",
                        }),
                );
            seg.on("click", () => {
                if (value === item.value) return;
                value = item.value;
                render();
                op.onChange?.(value);
            });
            row.add(seg);
        }
    };
    render();
    return {
        el: row,
        setItems: (next: { label: string; value: T }[]) => {
            items = next;
            render();
        },
        setValue: (next: T) => {
            if (next === value) return;
            value = next;
            render();
        },
    };
}

/** 电池设备行：电池图标 + 名称 + 百分比 */
export function uBatteryRow(label: string, percentage: number) {
    const battery = getIconXEl("battery", { size: 18, width: 22, height: 18 });
    let value = percentage;
    const render = () => battery.sv("value", Math.max(0, Math.min(1, value / 100)));
    const valueText = aNumberText({
        fontSize: 12,
        lineHeight: 17,
        color: gTextStyle.color.secondary,
    });
    valueText.sv(`${value}%`);
    // 设备行的电池图标和百分比一起靠右
    const right = view("x").style({
        alignItems: "center",
        gap: px(6),
        flexShrink: "0",
    });
    right.add([battery, valueText.el]);
    const row = uChoiceRow({
        label,
        right,
    });
    render();
    return {
        el: row.el,
        setValue: (nextLabel: string, nextPercentage: number) => {
            value = nextPercentage;
            row.setLabel(nextLabel);
            valueText.sv(`${value}%`);
            render();
        },
    };
}

/** 系统菜单：锁屏 + 关机 / 重启 / 挂起 */
export function uSystemMenu(op: {
    onLock: () => void;
    onShutdown: () => void;
    onReboot: () => void;
    onSuspend: () => void;
}) {
    const action = (icon: string, label: string, onClick: () => void) =>
        iItem({ type: "h", size: 1 })
            .style({
                display: "flex",
                alignItems: "center",
                gap: px(sSize2.paddingx),
                padding: `0 ${px(sSize2.paddingx)}`,
                boxSizing: "border-box",
                cursor: "pointer",
            })
            .add([
                getIconXEl(icon, { size: 16 }),
                aLineText()
                    .sv(label)
                    .style({
                        ...gTextStyle.body,
                        color: gTextStyle.color.primary,
                    }),
            ])
            .on("click", onClick);
    const menu = ui.bar([
        ui
            .barItem()
            .style({ height: px(sSize(1)) })
            .add(action("lock", "锁屏", op.onLock)),
        ui
            .barItem()
            .style({ height: px(sSize(1) * 3) })
            .add([
                action("shutdown", "关机", op.onShutdown),
                action("reboot", "重启", op.onReboot),
                action("suspend", "挂起", op.onSuspend),
            ]),
    ]);
    menu.el.style({ width: px(sSize(3)) });
    return { el: menu.el };
}

export function xView(els: ElType<HTMLElement>[]) {
    const el = view("y").style({
        gap: `${sSize2.padding}px`,
        padding: `${sSize2.padding}px`,
        borderRadius: `${gRadius.container}px`,
        boxSizing: "content-box",
        ...gGlassStyle.bg,
    });
    el.add(els);
    return {
        el,
    };
}

export function bButton(txt: string, onClick: () => void) {
    return button()
        .style({ width: "100%", height: "100%" })
        .add(aLineText().sv(txt))
        .on("click", () => {
            onClick();
        });
}

/** 通知时间：当天只显示时分，更早的带上日期 */
function formatNotiTime(ts: number) {
    const d = new Date(ts);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.getFullYear() !== now.getFullYear())
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
    if (d.getMonth() !== now.getMonth() || d.getDate() !== now.getDate())
        return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
    return hm;
}

/** 通知条目的内容；下拉面板和临时提示共用同一套排版 */
export function nNotiContent(op: { title: string; content: string; time?: number; onClose?: () => void }) {
    const titleRow = view("x").style({ alignItems: "center" });
    titleRow.add(
        aLineText()
            .sv(op.title)
            .style({ ...fontStyle.title, flexGrow: 1, width: "auto" }),
    );
    if (op.time !== undefined) {
        titleRow.add(
            aLineText()
                .sv(formatNotiTime(op.time))
                .style({
                    width: "fit-content",
                    flexShrink: 0,
                    marginRight: px(4),
                    ...gTextStyle.caption,
                    color: gTextStyle.color.secondary,
                }),
        );
    }
    if (op.onClose) {
        titleRow.add(
            button(getIconXEl("cross")).on("click", () => {
                op.onClose?.();
            }),
        );
    }
    return view("y")
        .style({
            height: "100%",
            justifyContent: "center",
            gap: "2px",
        })
        .add([titleRow, aLineText().sv(op.content).style(fontStyle.low)]);
}

/** 顶栏临时提示里的通知卡片：L2 面板 + 与下拉列表相同的条目排版 */
export function nNotiToast(op: { title: string; content: string; width?: number }) {
    return ui
        .barItem()
        .style({
            width: px(op.width ?? sSize(6)),
            height: px(sSize(2)),
            padding: px(sSize2.padding),
            boxSizing: "border-box",
            overflow: "hidden",
            flexShrink: "0",
        })
        .add(nNotiContent(op));
}

export function nNotiList(op: {
    map: (k: string) => Promise<{ title: string; content: string; time: number; delete: () => void }>;
}) {
    let list: string[] = [];
    const nl = uScrollList<string>({
        itemSize: sSize(2),
        containerSize: sSize(2) * 4,
        direction: "down",
        crossSize: sSize(10),
        keyExtractor: (k) => k,
        renderItem: (id) => {
            const el = iItem({ type: "h", size: 2 }).style({ padding: px(sSize2.padding), alignItems: "center" });
            op.map(id).then((n) => {
                el.clear().add(
                    nNotiContent({
                        title: n.title,
                        content: n.content,
                        time: n.time,
                        onClose: n.delete,
                    }),
                );
            });
            return el;
        },
        empty: "没有通知",
    });

    const clearAll = view("x")
        .add(getIconXEl("cross"))
        .style({
            alignItems: "center",
            justifyContent: "center",
        })
        .on("click", async () => {
            for (const l of list) {
                (await op.map(l)).delete();
            }
        });

    return {
        el: ui.bar([
            // todo 勿扰模式
            ui
                .barItem()
                .style({ height: px(sSize(2) * 4) })
                .add(nl.el),
            ui
                .barItem()
                .style({ height: px(sSize(1)) })
                .add(
                    clearAll.style({
                        height: "100%",
                    }),
                ),
        ]).el,
        setList: (l: string[]) => {
            list = l;
            // 最新通知在最上面
            const desc = [...l].reverse();
            // 清空时直接收起列表，避免旧项退场动画和空提示重叠
            nl.setList(desc, desc.length === 0);
        },
    };
}

export function mMedia(op: {
    map: (k: string) => Promise<{
        data: BindingSource<{
            title: string;
            cover: string;
            artist: string[];
            duration: number;
        }>;
        play: BindingSource<boolean>;
        next: () => void;
        previous: () => void;
        currentTime: BindingSource<number>;
    }>;
}) {
    const CARD_WIDTH = sSize(5.5);
    const COVER_SIZE = sSize(2.5);

    function formatTime(seconds: number) {
        if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
        const total = Math.floor(seconds);
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
    }

    const TAB_WIDTH = sSize(2);
    const tabIds: string[] = [];
    const tabIndexById = new Map<string, number>();
    const tabEls = new Map<string, ElType<HTMLElement>>();
    let activeTabIndex = 0;

    function createTab(id: string) {
        const name = id.replace("org.mpris.MediaPlayer2.", "").split(".")[0];
        const tab = view("x").style({
            width: "100%",
            height: "100%",
            borderRadius: px(gRadius.item),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: `0 ${px(sSize2.paddingx)}`,
            boxSizing: "border-box",
            cursor: "pointer",
            overflow: "hidden",
            background: id === tabIds[activeTabIndex] ? gSurfaceStyle.solid.backgroundColor : "transparent",
        });
        tab.add(
            aLineText().sv(name).style({
                width: "fit-content",
                maxWidth: "100%",
                textAlign: "center",
            }),
        );
        tab.on("click", () => {
            const index = tabIndexById.get(id);
            if (index === undefined) return;
            s.scrollToPage(index);
            setActiveTab(index);
        });
        tabEls.set(id, tab);
        return tab;
    }

    const tabList = dynamicScrollList<string>({
        itemSize: TAB_WIDTH,
        containerSize: CARD_WIDTH,
        direction: "right",
        keyExtractor: (id) => id,
        dragByMouse: true,
        renderItem: (id) => createTab(id),
    });
    tabList.el.style({ width: px(CARD_WIDTH), height: px(sSize(1)) });

    const setActiveTab = (index: number) => {
        if (index === activeTabIndex) return;
        activeTabIndex = index;
        const activeId = tabIds[index];
        for (const [id, tab] of tabEls) {
            tab.style({
                background: id === activeId ? gSurfaceStyle.solid.backgroundColor : "transparent",
            });
        }
        tabList.scrollToPage(index, false);
    };

    const tabsBar = ui
        .barItem()
        .style({ height: px(sSize(1)), display: "none" })
        .add(tabList.el);

    const s = carousel<string>({
        itemSize: CARD_WIDTH,
        direction: "right",
        keyExtractor: (k) => k,
        onScroll: (index, progress) => setActiveTab(Math.round(index + progress)),
        renderItem: (k) => {
            const card = view("y").style({
                width: px(CARD_WIDTH),
                height: "100%",
                padding: px(sSize2.padding),
                boxSizing: "border-box",
                alignItems: "center",
                gap: "6px",
            });

            const cover = view()
                .style({
                    width: px(COVER_SIZE),
                    height: px(COVER_SIZE),
                    borderRadius: px(gRadius.item),
                    overflow: "hidden",
                    background: "#0000000a",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: "0",
                })
                .addInto(card);
            const title = aLineText()
                .style({
                    ...gTextStyle.title,
                    color: gTextStyle.color.primary,
                    width: "100%",
                    textAlign: "center",
                })
                .addInto(card);
            const artist = aLineText()
                .style({
                    ...gTextStyle.caption,
                    color: gTextStyle.color.secondary,
                    width: "100%",
                    textAlign: "center",
                })
                .addInto(card);

            card.add(spacer());

            const progress = view()
                .style({
                    width: "100%",
                    height: "6px",
                    background: "#00000012",
                    borderRadius: px(gRadius.item),
                    overflow: "hidden",
                    flexShrink: "0",
                })
                .addInto(card);
            const progressFill = view()
                .style({
                    width: "0%",
                    height: "100%",
                    background: gTextStyle.color.primary,
                })
                .addInto(progress);

            // 按钮严格居中，时间绝对定位在按钮两侧
            const controls = view("x")
                .style({
                    position: "relative",
                    width: "100%",
                    height: px(28),
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: "0",
                })
                .on("pointerdown", (e) => e.stopPropagation())
                .addInto(card);
            const currentText = aNumberText({
                fontSize: 10,
                lineHeight: 12,
                color: gTextStyle.color.secondary,
            });
            currentText.el
                .style({
                    position: "absolute",
                    left: "0",
                    top: "50%",
                    transform: "translateY(-50%)",
                })
                .addInto(controls);
            const durationText = aNumberText({
                fontSize: 10,
                lineHeight: 12,
                color: gTextStyle.color.secondary,
            });
            durationText.el
                .style({
                    position: "absolute",
                    right: "0",
                    top: "50%",
                    transform: "translateY(-50%)",
                })
                .addInto(controls);
            const buttonGroup = view("x")
                .style({ alignItems: "center", justifyContent: "center", gap: "4px" })
                .addInto(controls);

            let player: Awaited<ReturnType<typeof op.map>> | undefined;
            let duration = 0;
            let currentTimeValue = 0;
            let playing = false;
            const renderTime = () => {
                const ratio = duration > 0 ? Math.min(1, currentTimeValue / duration) : 0;
                progressFill.style({ width: `${ratio * 100}%` });
                currentText.sv(formatTime(currentTimeValue));
                durationText.sv(formatTime(duration));
            };

            const mediaButton = (icon: ElType<HTMLElement> | { el: HTMLElement }, onClick: () => void) => {
                const btn = button(
                    view().style({ display: "flex", alignItems: "center", justifyContent: "center" }).add(icon),
                )
                    .style({
                        width: "28px",
                        height: "28px",
                        padding: "0",
                        border: "none",
                        background: "transparent",
                        borderRadius: px(gRadius.item),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                        flexShrink: "0",
                    })
                    .on("click", onClick);
                btn.on("pointerenter", () => btn.style({ background: "#0000000a" }));
                btn.on("pointerleave", () => btn.style({ background: "transparent" }));
                return btn;
            };

            const playIcon = view()
                .style({ display: "flex", alignItems: "center", justifyContent: "center" })
                .add(getIconXEl("media.play.fill", { size: 16 }));
            const pauseIcon = view()
                .style({ display: "none", alignItems: "center", justifyContent: "center" })
                .add(getIconXEl("media.pause.fill", { size: 16 }));
            const playPauseBtn = mediaButton(
                view()
                    .style({ display: "flex", alignItems: "center", justifyContent: "center" })
                    .add([playIcon, pauseIcon]),
                () => player?.play.set?.(!playing),
            );

            buttonGroup.add([
                mediaButton(getIconXEl("media.backward.fill", { size: 16 }), () => player?.previous()),
                playPauseBtn,
                mediaButton(getIconXEl("media.forward.fill", { size: 16 }), () => player?.next()),
            ]);
            renderTime();

            op.map(k).then((x) => {
                player = x;
                x.data.getAndSubscribe((data) => {
                    duration = data.duration;
                    cover.clear();
                    if (data.cover) {
                        image(data.cover, "cover")
                            .style({ width: "100%", height: "100%", objectFit: "cover" })
                            .addInto(cover);
                    } else {
                        cover.add(getIconXEl("music", { size: 36, width: 36, height: 36 }));
                    }
                    title.sv(data.title);
                    artist.sv(data.artist.join(", ") || "未知艺术家");
                    renderTime();
                });
                x.play.getAndSubscribe((v) => {
                    playing = !!v;
                    playIcon.style({ display: playing ? "none" : "flex" });
                    pauseIcon.style({ display: playing ? "flex" : "none" });
                });
                x.currentTime.getAndSubscribe((v) => {
                    currentTimeValue = v;
                    renderTime();
                });
            });
            return card;
        },
    });
    const contentBar = ui
        .barItem()
        .style({ height: px(CARD_WIDTH), position: "relative" })
        .add(s.el);
    const emptyMask = view("x")
        .style({
            position: "absolute",
            inset: "0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            background: "rgba(245, 245, 245, 0.72)",
        })
        .add(
            aLineText()
                .sv("没有播放器")
                .style({
                    ...gTextStyle.body,
                    color: gTextStyle.color.secondary,
                    width: "fit-content",
                }),
        );
    contentBar.add(emptyMask);

    const nel = ui.bar([tabsBar, contentBar]);

    return {
        el: nel.el,
        setList: (l: string[]) => {
            tabIds.length = 0;
            tabIds.push(...l);
            tabIndexById.clear();
            l.forEach((id, index) => {
                tabIndexById.set(id, index);
            });
            for (const id of [...tabEls.keys()]) {
                if (!tabIndexById.has(id)) tabEls.delete(id);
            }
            activeTabIndex = -1;
            tabsBar.style({ display: l.length > 0 ? "" : "none" });
            emptyMask.style({ display: l.length > 0 ? "none" : "flex" });
            tabList.setList(l);
            tabList.scrollTo(0);
            s.setList(l);
            if (l.length > 0) {
                s.scrollToPage(0, false);
                setActiveTab(0);
            }
        },
    };
}

export function tTrayMenu(op: { click: () => void; clickItem: () => void }) {
    const titleEl = aLineText().style({
        ...gTextStyle.captionStrong,
        color: gTextStyle.color.secondary,
        textAlign: "center",
    });
    const mainClick = view("x")
        .style({ alignItems: "center", justifyContent: "center", height: px(sSize(1)) })
        .add(titleEl)
        .on("click", () => {
            op.click();
        });
    const backMenu = view("x")
        .style({ alignItems: "center", justifyContent: "center", height: px(sSize(1)) })
        .add(getIconXEl("chevron.left"));
    const data = new Map<number, MenuItem>();
    /** 子菜单返回栈：每层保存上一层的 id 列表 */
    const menuStack: number[][] = [];
    const list = dynamicScrollList<number>({
        itemSize: sSize(1),
        containerSize: sSize(1) * 8,
        direction: "down",
        keyExtractor: (k) => k.toString(),
        renderItem: (i, _, items) => {
            const item = data.get(i);
            if (!item) {
                console.error(`tray ui ${i} cannot find item`);
                return iItem({ type: "h", size: 1 });
            }
            const hasIcon = items.some((id) => data.get(id)?.iconUrl);
            const iconBox = hasIcon ? view().style({ width: "16px", height: "16px", flexShrink: "0" }) : undefined;
            if (iconBox && item.iconUrl) {
                item.iconUrl({ theme: "breeze" }).then((url) => {
                    image(url ?? "", "icon")
                        .style({ width: "16px", height: "16px", objectFit: "cover" })
                        .addInto(iconBox);
                });
            }
            const right = item.children?.length
                ? view().add(getIconXEl("chevron.right", { size: 14, width: 16, height: 16 }))
                : undefined;
            const mark = item.children?.length
                ? undefined
                : item.toggleType === "checkmark"
                  ? ("check" as const)
                  : item.toggleType === "radio"
                    ? ("radio" as const)
                    : undefined;
            const row = uChoiceRow({
                label: item.label,
                icon: iconBox,
                right,
                mark,
                selected: !!item.toggleState,
                size: 1,
                emphasize: false,
                onClick: () => {
                    if (item.children?.length) {
                        menuStack.push(items);
                        list.setList(
                            item.children
                                .filter((child) => child.visible)
                                .filter((child) => child.type === "standard")
                                .map((child) => child.id),
                        );
                        backMenu.style({ display: "flex" });
                        return;
                    }
                    item.click();
                    op.clickItem();
                },
            });
            return row.el;
        },
    });
    list.el.style({ width: px(sSize(6)) });
    backMenu.style({ display: "none" });
    backMenu.on("click", () => {
        const prev = menuStack.pop();
        if (!prev) return;
        list.setList(prev);
        backMenu.style({ display: menuStack.length > 0 ? "flex" : "none" });
    });
    const menuEl = ui.bar([ui.barItem().add(mainClick), ui.barItem().add([backMenu, list.el])]);

    function set(tree: MenuItem[]) {
        data.clear();
        function w(tree: MenuItem[]) {
            for (const i of tree) {
                data.set(i.id, i);
                if (i.children?.length) {
                    w(i.children);
                }
            }
        }
        w(tree);
    }

    return {
        // 全部更新而不是局部更新
        // 一方面，拖盘弹窗点击就关闭，对更新页面不敏感
        // 其次，软件实现也有不同，有更新局部的，有全部更新的
        setTree: (tree: MenuItem[]) => {
            set(tree);
            menuStack.length = 0;
            backMenu.style({ display: "none" });
            const ids = tree
                .filter((i) => i.visible)
                .filter((i) => i.type === "standard")
                .map((i) => i.id);
            // 完整重建，避免同 id 的行复用旧 label / icon
            list.setList([], true);
            list.setList(ids, true);
        },
        setTitle: (s: string) => titleEl.sv(s),
        el: menuEl.el,
    };
}

export function nNumber(n: string, op?: { fontSize?: number; lineHeight?: number; color?: string }) {
    const l = n.split("");
    const fontSize = op?.fontSize ?? 16;
    const lightHeight = op?.lineHeight ?? fontSize;
    const r = fontSize / 16;

    const t = view("x").style({ height: `${lightHeight}px` });
    const map: Record<string, { name: string; w: number }> = {};
    for (const i of Array(10)
        .fill(0)
        .map((_, i) => i)) {
        map[i] = { name: `number.${i}`, w: 12 };
    }

    map["."] = { name: "number.dot", w: 4 };
    map[":"] = { name: "number.:", w: 4 };
    map[","] = { name: "number.,", w: 4 };
    map["/"] = { name: "number.slash", w: 12 };
    map["\\"] = { name: "number.backslash", w: 12 };
    map["#"] = { name: "number.hash", w: 12 };
    map["%"] = { name: "number.percent", w: 12 };
    map["-"] = { name: "number.minus", w: 12 };
    map["+"] = { name: "number.plus", w: 12 };
    map["°"] = { name: "number.degree", w: 12 };
    map._ = { name: "font.underscore", w: 12 };
    map[" "] = { name: "font.space", w: 12 };
    for (const n of l) {
        if (!(n in map)) console.warn(`cannot conver "${n}"`);
        else {
            t.add(
                getIconXEl(map[n].name, {
                    size: fontSize,
                    width: map[n].w * r,
                    height: lightHeight,
                    color: op?.color,
                }),
            );
        }
    }
    return t;
}

/** 自绘等宽数字文本；`sv` 用新内容整体重排 */
export function aNumberText(op?: { fontSize?: number; lineHeight?: number; color?: string }) {
    const el = view("x").style({ width: "fit-content", flexShrink: "0" });
    return {
        el,
        sv: (text: string) => {
            el.clear().add(nNumber(text, op));
        },
    };
}

export function rRange(op?: {
    dir?: "right" | "left" | "up" | "down";
    mel?: HTMLElement;
    /** 拖动结束（用于补发节流后的最后一次值） */
    onEnd?: () => void;
}) {
    const pel = view().style({ width: "200px", height: "16px" });
    const t = (op?.mel ? pack(op.mel) : view().style({ background: "#000" })).addInto(pel);

    let v = 0; // 0-1
    // 拖动中忽略外部回传值，避免节流后的旧值把滑块拉回去
    let dragging = false;

    let onChange: ((v: number) => void) | null = null;

    function limitV(iv: number) {
        return Math.min(1, Math.max(0, iv));
    }
    function set(iv: number) {
        v = limitV(iv);
        switch (dir) {
            case "right":
                t.style({ width: `${v * 100}%` });
                break;
            case "left":
                t.style({ width: `${v * 100}%` });
                break;
            case "up":
                t.style({ height: `${v * 100}%` });
                break;
            case "down":
                t.style({ height: `${v * 100}%` });
                break;
            default:
                break;
        }
    }

    const dir = op?.dir ?? "right";

    if (dir === "right") {
        t.style({ height: "100%" });
    } else if (dir === "left") {
        t.style({ height: "100%", right: "0", position: "absolute" });
    } else if (dir === "down") {
        t.style({ width: "100%" });
    } else {
        t.style({ bottom: "0", width: "100%", position: "absolute" });
    }

    trackPoint(pel, {
        start: () => {
            dragging = true;
            return { x: 0, y: 0, data: v };
        },
        ing: ({ x, y }, _, { startData }) => {
            let vv = 0;
            switch (dir) {
                case "right":
                    vv = x / pel.el.offsetWidth + startData;
                    break;
                case "left":
                    vv = x / pel.el.offsetWidth - startData;
                    break;
                case "up":
                    vv = y / pel.el.offsetHeight - startData;
                    break;
                case "down":
                    vv = y / pel.el.offsetWidth + startData;
                    break;
                default:
                    break;
            }
            set(vv); // todo 考虑移除，或者用动画区分手势预期位置和实际反馈sv
            onChange?.(limitV(vv));
        },
        end: () => {
            dragging = false;
            op?.onEnd?.();
        },
    });

    set(0);

    return {
        el: pel,
        sv: (v: number) => {
            if (!dragging) set(v);
        },
        gv: () => v,
        onChange(f: (v: number) => void) {
            onChange = f;
        },
    };
}

/** 亮度滑块：白色轨道 + 半透明底 */
export function uBrightnessSlider(op?: { value?: number; onChange?: (v: number) => void; onEnd?: () => void }) {
    const track = view().style({ background: "white", borderRadius: px(gRadius.item) }).el;
    const range = rRange({ mel: track, onEnd: op?.onEnd });
    range.el.style({
        width: px(sSize(6)),
        height: px(sSize(1)),
        borderRadius: px(gRadius.item),
        overflow: "hidden",
        ...gGlassStyle.itemInBg,
    });
    if (op?.onChange) range.onChange(op.onChange);
    range.sv(op?.value ?? 0.5);
    return { el: range.el, sv: range.sv, onChange: range.onChange };
}

/** 亮度弹窗：滑块本身就是 L2，直接放进 L1 的网格，不再套一层 L2 */
export function uBrightnessList() {
    const grid = ui.bar([]);
    grid.el.style({
        display: "none",
        gridTemplateColumns: "1fr",
        gap: px(sSize2.padding),
        width: px(sSize(6)),
    });
    return {
        el: grid.el,
        setSliders: (sliders: ElType<HTMLElement>[]) => {
            grid.el.clear().add(sliders);
            grid.el.style({
                display: sliders.length > 0 ? "grid" : "none",
                height: px(sliders.length * sSize(1) + Math.max(0, sliders.length - 1) * sSize2.padding),
            });
        },
    };
}

export function vVolume(op?: {
    inputM: BindingSource<boolean>;
    outputM: BindingSource<boolean>;
    inputV: BindingSource<number>;
    outputV: BindingSource<number>;
}) {
    const d = 1;

    function muteB(icon: string) {
        let muted = false;
        const el = view()
            .style({
                width: px(sSize(d)),
                height: px(sSize(d)),
                borderRadius: px(gRadius.item),
                ...gGlassStyle.itemInBg,
            })
            .add(
                getIconXEl(icon, {
                    size: sSize(d) - 12,
                    width: sSize(d),
                    height: sSize(d),
                }),
            )
            .bindGet(() => muted)
            .bindSet((v: boolean) => {
                muted = v;
                if (v) {
                    el.style({ opacity: "0.5" });
                } else {
                    el.style({ opacity: "1" });
                }
            });
        el.sv(false);
        return el;
    }

    const bOutput = muteB("speaker").on("click", (_, el) => {
        op?.outputM.set?.(!el.gv);
        bOutput.sv(!el.gv); // todo 异步加载动画
    });
    const bInput = muteB("mic").on("click", (_, el) => {
        op?.inputM.set?.(!el.gv);
        bInput.sv(!el.gv);
    });

    // 拖动滑块产生的高频输入在桌面层节流，系统 API 不做频率限制
    const setOutputVolume = throttle((v: number) => void op?.outputV.set?.(v), 50);
    const setInputVolume = throttle((v: number) => void op?.inputV.set?.(v), 50);

    const rOutput = rRange({
        mel: view().style({ background: "white", borderRadius: px(gRadius.item) }).el,
        onEnd: () => setOutputVolume.flush(),
    });
    const rInput = rRange({
        mel: view().style({ background: "white", borderRadius: px(gRadius.item) }).el,
        onEnd: () => setInputVolume.flush(),
    });

    rOutput.el.style({
        width: "100%",
        height: px(sSize(d)),
        borderRadius: px(gRadius.item),
        overflow: "hidden",
        ...gGlassStyle.itemInBg,
    });
    rInput.el.style({
        width: "100%",
        height: px(sSize(d)),
        borderRadius: px(gRadius.item),
        overflow: "hidden",
        ...gGlassStyle.itemInBg,
    });

    // 按钮和条本身都是 L2；2 × 2 grid
    const p = ui.bar([bOutput, rOutput.el, bInput, rInput.el]);
    p.el.style({
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gridTemplateRows: "1fr 1fr",
        width: px(sSize(6)),
        height: px(sSize((d * 2) as 1)),
    });

    // todo 应用音量

    op?.outputM.getAndSubscribe((v) => {
        bOutput.sv(v);
    });
    op?.inputM.getAndSubscribe((v) => {
        bInput.sv(v);
    });
    op?.outputV.getAndSubscribe((v) => {
        rOutput.sv(v);
    });
    op?.inputV.getAndSubscribe((v) => {
        rInput.sv(v);
    });
    rOutput.onChange(setOutputVolume);
    rInput.onChange(setInputVolume);

    return {
        el: p.el,
    };
}

// ── 输入法界面 ────────────────────────────────────────────────────────────────────────────────
// 候选窗和托盘弹窗的视觉都集中在这里，方便统一调整圆角、高亮和间距。

export interface ImeCandidateAnchor {
    /** 视口坐标的光标矩形（x/y 为左上角） */
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface ImeCandidateHandlers {
    select(index: number): void;
    nextPage(): void;
    prevPage(): void;
}

/** 输入法候选窗：只负责显示和鼠标操作，不接收键盘焦点 */
export function imeCandidatePopup(op: ImeCandidateHandlers) {
    const body = view("y").style({ gap: px(sSize2.padding) });
    const el = view("y")
        .style({
            position: "absolute",
            display: "none",
            maxWidth: "min(560px, calc(90vw / var(--desktop-ui-scale, 1)))",
            padding: px(sSize2.padding),
            borderRadius: px(gRadius.container),
            boxSizing: "border-box",
            pointerEvents: "auto",
            color: "#111",
            fontFamily: "sans-serif",
            ...gGlassStyle.bg,
        })
        .add(body);

    let anchor: ImeCandidateAnchor | undefined;
    let wheelAt = 0;
    /** 桌面 UI 缩放；候选窗自身带 zoom，left/top 要写回局部坐标 */
    let scale = 1;

    el.on("wheel", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const now = performance.now();
        if (now - wheelAt < 80) return;
        wheelAt = now;
        if (e.deltaY > 0) op.nextPage();
        else if (e.deltaY < 0) op.prevPage();
    });

    const visible = () => el.el.style.display !== "none";

    function place() {
        // 元素自身带 zoom；用视觉尺寸计算，再除回局部坐标写 left/top
        const rect = el.el.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        if (!anchor) {
            el.style({
                left: `${Math.max(4, (window.innerWidth - w) / 2) / scale}px`,
                top: `${Math.max(4, window.innerHeight - h - 24) / scale}px`,
            });
            return;
        }
        const margin = 6;
        const pad = 4;
        let x = anchor.x;
        let y = anchor.y + anchor.h + margin;
        if (y + h > window.innerHeight - pad) y = anchor.y - margin - h;
        x = Math.min(Math.max(x, pad), Math.max(pad, window.innerWidth - w - pad));
        y = Math.min(Math.max(y, pad), Math.max(pad, window.innerHeight - h - pad));
        el.style({ left: `${x / scale}px`, top: `${y / scale}px` });
    }

    function pagerButton(arrow: "left" | "right", enabled: boolean, click: () => void) {
        return button(
            arrow === "left"
                ? getIconXEl("chevron.left", { size: 16, width: sSize(1) })
                : getIconXEl("chevron.right", { size: 16, width: sSize(1) }),
        )
            .style({
                width: px(sSize(1)),
                height: px(sSize(1)),
                borderRadius: px(gRadius.item),
                backgroundColor: gGlassStyle.itemInBg.backgroundColor,
                opacity: enabled ? "1" : "0.35",
                pointerEvents: enabled ? "auto" : "none",
                cursor: enabled ? "pointer" : "default",
            })
            .on("click", click);
    }

    return {
        el,
        setAnchor(a: ImeCandidateAnchor | undefined) {
            anchor = a;
            if (visible()) place();
        },
        setScale(value: number) {
            if (!Number.isFinite(value) || value <= 0) return;
            scale = value;
            el.style({ zoom: `${value}` });
            if (visible()) place();
        },
        hide() {
            el.style({ display: "none" });
        },
        update(state: ImComposeState) {
            const preeditText = state.preedit.trim();
            const auxiliaryText = state.auxiliary.trim();
            const hasContent = preeditText.length > 0 || state.candidates.length > 0 || auxiliaryText.length > 0;
            if (!hasContent) {
                el.style({ display: "none" });
                return;
            }

            const showPreedit = !!preeditText || !!auxiliaryText;
            const preedit = view("x").style({
                padding: px(sSize2.paddingx),
                alignItems: "center",
                height: px(sSize(1)),
            });
            if (preeditText) {
                preedit.add(txt(preeditText).style({ whiteSpace: "nowrap", fontSize: "12px", opacity: "0.9" }));
            }
            if (auxiliaryText) {
                preedit.add(txt(auxiliaryText).style({ whiteSpace: "nowrap", fontSize: "11px", opacity: "0.55" }));
            }

            const horizontal = state.candidateLayout >= 2;
            const list = ui.barItem();
            list.style({
                display: "flex",
                flexDirection: horizontal ? "row" : "column",
                alignItems: "stretch",
                maxWidth: horizontal ? "min(540px, calc(86vw / var(--desktop-ui-scale, 1)))" : "320px",
            });
            state.candidates.forEach((text, i) => {
                if (!text) return;
                const active = i === state.candidateCursor;
                const label = (state.candidateLabels[i] ?? "").trim() || `${i + 1}`;
                list.add(
                    view("x")
                        .style({
                            gap: "6px",
                            alignItems: "baseline",
                            padding: `5px ${px(sSize2.paddingx)}`,
                            borderRadius: px(gRadius.item),
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                            backgroundColor: active ? "#fff" : "transparent",
                            height: px(sSize(1)),
                        })
                        .add([
                            txt(label).style({ fontSize: "10px", opacity: active ? "0.85" : "0.5" }),
                            txt(text).style({ fontSize: "14px" }),
                        ])
                        .on("click", () => op.select(i)),
                );
            });
            list.add(
                view("x")
                    .style({
                        gap: "4px",
                        alignItems: "center",
                        fontSize: "11px",
                        opacity: "0.8",
                        width: "100%",
                        height: px(sSize(1)),
                    })
                    .add([
                        pagerButton("left", state.hasPrev, () => op.prevPage()),
                        pagerButton("right", state.hasNext, () => op.nextPage()),
                    ]),
            );

            const hasCandidates = state.candidates.length > 0;
            body.clear().add([...(showPreedit ? [ui.barItem().add(preedit)] : []), ...(hasCandidates ? [list] : [])]);
            body.style({
                width: "fit-content",
                minWidth: !horizontal && hasCandidates ? px(160) : "0px",
            });

            el.style({ display: "flex", visibility: "hidden" });
            place();
            el.style({ visibility: "visible" });
        },
    };
}

export interface ImeTrayStatus {
    available: boolean;
    currentUniqueName: string;
    /** `off` 的项是关闭输入法的键盘布局（默认 keyboard-us） */
    entries: { uniqueName: string; name: string; label: string; off?: boolean }[];
    hint?: string;
    error?: string;
}

export interface ImeTrayActions {
    select(uniqueName: string): void;
}

/** 输入法托盘弹窗：列表直接切换输入法，键盘布局项即关闭输入法。`initial` 用于静态预览 */
export function imeTrayPanel(op: ImeTrayActions, initial?: ImeTrayStatus) {
    const content = view("y");
    const list = ui.barItem();
    const wrapper = ui.bar([content, list]);
    wrapper.el.style({
        width: px(sSize(4)),
    });

    const setStatus = (status: ImeTrayStatus) => {
        content.style({ display: "flex" });
        content.clear();
        list.clear();
        list.style({ display: "none" });

        if (!status.available) {
            content.add(
                aLineText()
                    .sv("fcitx5 不可用")
                    .style({ padding: `4px ${px(sSize2.paddingx)}` }),
            );
            if (status.error) {
                content.add(
                    txt(status.error).style({
                        fontSize: "11px",
                        opacity: "0.6",
                        wordBreak: "break-all",
                        padding: `0 ${px(sSize2.paddingx)} 4px`,
                    }),
                );
            }
            return;
        }

        list.style({ display: status.entries.length > 0 ? "block" : "none" });
        if (status.entries.length > 0) {
            for (const entry of status.entries) {
                const active = status.currentUniqueName === entry.uniqueName;
                const off = !!entry.off;
                list.add(
                    view("x")
                        .style({
                            borderRadius: px(gRadius.item),
                            gap: px(sSize2.paddingx),
                            alignItems: "center",
                            cursor: "pointer",
                            height: px(sSize(1)),
                            backgroundColor: active ? "#fff" : "transparent",
                        })
                        .add([
                            view("x")
                                .style({
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: px(sSize(1)),
                                    height: px(sSize(1)),
                                })
                                .add(
                                    txt(off ? "关" : entry.label?.trim() || "·").style({
                                        fontSize: "10px",
                                        opacity: active ? "0.85" : "0.55",
                                    }),
                                ),
                            aLineText().sv(off ? "关闭输入法" : entry.name),
                            txt(off ? "" : entry.uniqueName).style({
                                fontSize: "10px",
                                opacity: "0.5",
                                flexShrink: "0",
                                maxWidth: "90px",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                            }),
                        ])
                        .on("click", () => op.select(entry.uniqueName)),
                );
            }
        }

        if (status.hint) {
        }
        if (status.error) {
            content.add(
                txt(status.error).style({
                    fontSize: "10px",
                    opacity: "0.55",
                    wordBreak: "break-all",
                    padding: `0 ${px(sSize2.paddingx)} 4px`,
                }),
            );
        }
        content.style({ display: content.el.children.length > 0 ? "flex" : "none" });
    };

    if (initial) setStatus(initial);
    else
        content.add(
            aLineText()
                .sv("正在初始化…")
                .style({ padding: `4px ${px(sSize2.paddingx)}` }),
        );

    return {
        el: wrapper.el,
        setStatus,
    };
}

export const ui = {
    passwd: () => {
        const x = uPasswdInput();
        x.el.style({
            height: px(sSize(1)),
            borderRadius: px(gRadius.item),
            padding: px(sSize2.paddingx),
            boxSizing: "border-box",
            ...gGlassStyle.justItem,
        });
        return x;
    },
    /** 在复杂背景下的容器 */
    bar: (els: ElType<HTMLElement>[]) => xView(els),
    /** 在复杂背景下的容器项目 */
    barItem: () => view().style({ borderRadius: `${gRadius.item}px`, ...gGlassStyle.itemInBg, overflow: "hidden" }),
};
