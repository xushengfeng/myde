import { button, type ElType, image, spacer, view } from "dkh-ui";
import { AnimationGear, timingFunction } from "myde-ui";
import { carousel, dynamicScrollList } from "./scroll-list";
import type { BindingSource } from "./registry";

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

const fontStyle = {
    title: {
        fontSize: "1.2em",
    },
    low: {
        opacity: 0.7,
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

export function iItem(op: { type: "h" | "v" | "sq"; size: 1 | 1.5 | 2 }) {
    const el = view().style({ borderRadius: `${sSize2.radius1}px` });
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

export function xView(els: ElType<HTMLElement>[]) {
    const el = view("y").style({
        gap: `${sSize2.padding}px`,
        padding: `${sSize2.padding}px`,
        borderRadius: `${sSize2.radius2}px`,
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

export function nNotiList(op: { map: (k: string) => Promise<{ title: string; content: string; delete: () => void }> }) {
    const nl = dynamicScrollList<string>({
        itemSize: sSize(2),
        containerSize: sSize(2) * 4,
        direction: "down",
        keyExtractor: (k) => k,
        renderItem: (id) => {
            const el = iItem({ type: "h", size: 2 }).style({ padding: px(sSize2.padding), alignItems: "center" });
            op.map(id).then((n) => {
                el.clear().add([
                    view("y")
                        .add([
                            view("x").add([
                                aLineText().sv(n.title).style(fontStyle.title),
                                spacer(),
                                button("×").on("click", () => {
                                    n.delete();
                                }),
                            ]),
                            aLineText().sv(n.content).style(fontStyle.low),
                        ])
                        .style({
                            height: "100%",
                            justifyContent: "center",
                        }),
                ]);
            });
            return el;
        },
    });
    const emptyMask = view("x")
        .style({
            width: px(sSize(10)),
            height: px(sSize(2) * 4),
            justifyContent: "center",
            alignItems: "center",
            pointerEvents: "none",
        })
        .add(
            aLineText()
                .sv("没有通知")
                .style({ ...fontStyle.low }),
        );
    const showGear = new AnimationGear({ s: 0 }, { transition: { duration: 400, map: timingFunction.easeOut } });
    showGear.setUpdateCallback((v) => {
        emptyMask.style({ opacity: v.s });
    });
    showGear.moveTo({ s: 1 }, 0);

    return {
        el: ui.bar([
            ui
                .barItem()
                .style({ position: "relative" })
                .add([
                    nl.el.style({ width: px(sSize(10)) }),
                    emptyMask.style({ position: "absolute", top: 0, left: 0 }),
                ]),
        ]).el,
        setList: (l: string[]) => {
            if (l.length === 0) {
                showGear.moveTo({ s: 1 });
            } else {
                showGear.moveTo({ s: 0 });
            }
            nl.setList(l);
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
    const main = view();
    const list = view("x")
        .style({ gap: px(sSize2.padding) })
        .addInto(main);

    const s = carousel<string>({
        itemSize: 200,
        direction: "right",
        keyExtractor: (k) => k,
        renderItem: (k) => {
            const ditial = view("y").addInto(main);

            const cover = view().addInto(ditial);
            const title = aLineText().addInto(ditial);
            const artist = aLineText().addInto(ditial);

            const controls = view("x")
                .on("pointerdown", (e) => {
                    // carousel可以用鼠标拖拽，这里交互式元素屏蔽拖拽
                    e.stopPropagation();
                })
                .addInto(ditial);
            const prevBtn = button("⏮️").addInto(controls);
            const playBtn = button("▶️").addInto(controls);
            const pauseBtn = button("⏸️").addInto(controls);
            const nextBtn = button("⏭️").addInto(controls);
            const time = view()
                .style({
                    width: "160px",
                    height: "10px",
                    background: "rgba(0,0,0,0.1)",
                    borderRadius: "5px",
                    overflow: "hidden",
                })
                .addInto(controls);
            const timex = view()
                .style({
                    width: "0%",
                    height: "100%",
                    background: "rgba(0,0,0,0.5)",
                })
                .addInto(time);
            op.map(k).then(async (x) => {
                let duration = 0;
                x.data.getAndSubscribe((data) => {
                    const artCover = data.cover;
                    if (artCover) {
                        cover.clear();
                        image(artCover, "cover")
                            .style({ width: "100px", height: "100px", objectFit: "cover" })
                            .addInto(cover);
                    } else {
                        cover.clear();
                    }
                    title.sv(data.title);
                    artist.sv(data.artist.join(", "));
                    duration = data.duration;
                });

                // const play=await x.play.get()
                playBtn.on("click", () => {
                    x.play.set?.(true);
                });
                pauseBtn.on("click", () => {
                    x.play.set?.(false);
                });
                nextBtn.on("click", () => {
                    x.next();
                });
                prevBtn.on("click", () => {
                    x.previous();
                });

                x.currentTime.getAndSubscribe((v) => {
                    timex.style({ width: `${(v / duration) * 100}%` });
                });
            });
            return ditial;
        },
    });

    main.style({ padding: px(sSize2.padding) }).add(s.el);

    const nel = ui.bar([ui.barItem().add(main)]);

    return {
        el: nel.el,
        setList: (l: string[]) => {
            list.clear().add(
                l.map((i, index) =>
                    view()
                        .add(i.replace("org.mpris.MediaPlayer2.", "").split(".")[0])
                        .on("click", () => {
                            s.scrollToPage(index);
                        }),
                ),
            );
            s.setList(l);
        },
    };
}

export const ui = {
    passwd: () => {
        const x = uPasswdInput();
        x.el.style({
            height: px(sSize(1)),
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
