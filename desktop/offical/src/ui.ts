import { type ElType, view } from "dkh-ui";
import { AnimationGear } from "myde-ui";

export const sSize = {
    /* 一行 */
    oneLine: 32,
    /* 复杂信息一行 */
    item: 48,
    /* 小组件开关 */
    xItem: 64,
};

export const sSize2 = {
    paddingx: 6,
    radius1: 10,
    padding: 8,
    radius2: 18,
};

export const gGlassStyle = {
    bg: {
        backdropFilter: "blur(12px)",
        background: "rgba(245, 245, 245, 0.8)",
        boxShadow: "0 0 4px #00000011",
    },
    itemInBg: {
        backgroundColor: "#ffffff88",
    },
    justItem: {
        backdropFilter: "blur(12px)",
        backgroundColor: "rgb(250.88, 250.88, 250.88, 0.9066)",
        boxShadow: "0 0 4px #00000011",
    },
} as const;

function px(n: number) {
    return `${n}px`;
}
export function aLineText() {
    const textEl = view().style({
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        overflow: "hidden",
        width: "100%",
    });
    const wrapEl = view().style({
        overflow: "hidden",
        width: "100%",
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

export function uPasswdInput() {
    const pd: { rm: () => void; k: string; el: ReturnType<typeof view> }[] = [];
    let uiAnimatePdSize = 0;
    let placeholderText = "";
    const placeholderEl = view().style({ color: "#999", pointerEvents: "none" });
    const textEl = view("x")
        .style({
            whiteSpace: "nowrap",
            overflow: "hidden",
            width: "100%",
            cursor: "text",
            height: "100%",
            alignItems: "center",
            justifyContent: "center",
        })
        .attr({ tabIndex: 0 });

    const contentEl = view("x").style({
        alignItems: "center",
        flexShrink: 0,
    });
    textEl.add(contentEl);
    textEl.add(placeholderEl);

    const wrapEl = view().style({
        overflowX: "hidden",
    });
    wrapEl.add(textEl);

    function updatePlaceholder() {
        if (uiAnimatePdSize === 0 && placeholderText) {
            placeholderEl.el.style.display = "";
            placeholderEl.clear().add(placeholderText);
        } else {
            placeholderEl.el.style.display = "none";
        }
    }

    function updateAlignment() {
        requestAnimationFrame(() => {
            const containerWidth = textEl.el.clientWidth;
            const contentWidth = contentEl.el.scrollWidth;
            if (contentWidth > containerWidth) {
                textEl.style({ justifyContent: "flex-end" });
            } else {
                textEl.style({ justifyContent: "center" });
            }
        });
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
            if (pd.length > 0) {
                const lastPd = pd.pop();
                if (lastPd) {
                    lastPd.rm();
                }
                updateAlignment();
            }
            return;
        }

        if (e.key.length !== 1) return;

        const kEl = view().style({
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "monospace",
        });
        const isFirst = pd.length === 0;
        uiAnimatePdSize++;
        const g = new AnimationGear({ v: 0 });
        g.addState("init", { v: 0 }, ["x"]);
        g.addState("x", { v: 1 }, ["hideKey"]);
        g.addState("hideKey", { v: 2 }, ["rm"]);
        g.addState("rm", { v: 3 }, []);
        g.setUpdateCallback((v) => {
            if (v.v === 0) {
                if (kEl.el.innerText === "") {
                    contentEl.add(kEl);
                    kEl.add(e.key);
                }
                kEl.style({ width: 0, overflow: "hidden", height: "100%" });
            } else if (0 < v.v && v.v <= 1) {
                kEl.style({ width: `${v.v}ch` });
                if (!isFirst) kEl.style({ marginLeft: `${v.v * 4}px` });
                if (v.v === 1) {
                    g.moveTo("hideKey", 200);
                    updateAlignment();
                }
            } else if (1 < v.v && v.v <= 2) {
                if (v.v === 2) {
                    kEl.clear().style({ width: "8px", height: "8px", borderRadius: "8px", background: "#000" });
                    updateAlignment();
                }
            } else if (2 < v.v && v.v <= 3) {
                kEl.style({ width: `${8 * (3 - v.v)}px`, height: `${8 * (3 - v.v)}px` });
                updateAlignment();
                if (v.v === 3) {
                    kEl.remove();
                    uiAnimatePdSize--;
                    updateAlignment();
                    updatePlaceholder();
                }
            }
        });
        g.moveTo("init", 0);
        g.moveTo("x", { duration: 200 });
        pd.push({ k: e.key, rm: () => g.moveTo("rm", 100), el: kEl });
        updateAlignment();
        updatePlaceholder();
        wrapEl.el.dispatchEvent(new Event("input"));
    });

    updatePlaceholder();

    return {
        el: wrapEl.bindGet(() => pd.map((i) => i.k).join("")),
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
            placeholderText = t;
            updatePlaceholder();
        },
        clear: () => {
            for (const i of pd) {
                i.rm();
            }
            pd.length = 0;
            updateAlignment();
        },
        inputKey: (k: string) => {
            textEl.el.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
        },
    };
}

export function iItem(op: { type: "h" | "v" | "sq"; size: "oneLine" | "item" | "xItem" }) {
    const el = view().style({ borderRadius: `${sSize2.radius1}px` });
    const s = `${sSize[op.size]}px`;
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
    const el = view().style({});
}

export function xView(els: ElType<HTMLElement>[]) {
    const el = view("y").style({
        gap: `${sSize2.padding}px`,
        padding: `${sSize2.padding}px`,
        borderRadius: `${sSize2.radius2}px`,
        ...gGlassStyle.bg,
    });
    el.add(els);
    return {
        el,
    };
}

export const ui = {
    passwd: () => {
        const x = uPasswdInput();
        x.el.style({
            height: px(sSize.oneLine),
            borderRadius: px(sSize2.radius1),
            padding: px(sSize2.paddingx),
            boxSizing: "border-box",
            ...gGlassStyle.justItem,
        });
        return x;
    },
    /** 在复杂背景下的容器 */
    bar: (els: ElType<HTMLElement>[]) => xView(els),
    /** 在复杂背景下的容器项目 */
    barItem: () => view().style({ borderRadius: `${sSize2.radius1}px`, ...gGlassStyle.itemInBg, overflow: "hidden" }),
};
