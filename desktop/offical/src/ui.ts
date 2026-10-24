import { button, type ElType, image, pack, spacer, trackPoint, txt, view } from "dkh-ui";
import { AnimationGear, timingFunction } from "myde-ui";
import type { ImComposeState, ImState } from "../../../src/sys_api/input_method";
import type { MenuItem } from "../../../src/sys_api/menu";
import { getIconXEl } from "./icon";
import type { BindingSource } from "./registry";
import { carousel, dynamicScrollList } from "./scroll-list";

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

        const kEl = view();
        const isFirst = pd.length === 0;
        uiAnimatePdSize++;
        const g = new AnimationGear({ v: 0 });
        g.addState("init", { v: 0 }, ["x"]);
        g.addState("x", { v: 1 }, ["init"]);
        g.setUpdateCallback((v) => {
            if (v.v === 0) {
                uiAnimatePdSize--;
                kEl.remove();
            } else if (0 < v.v && v.v <= 1) {
                if (kEl.el.innerText === "") {
                    contentEl.add(kEl);
                }
                kEl.style({ width: `${v.v}ch`, height: `${v.v}ch`, borderRadius: "8px", background: "#000" });
                if (!isFirst) kEl.style({ marginLeft: `${v.v * 4}px` });
                if (v.v === 1) {
                    updateAlignment();
                }
                uiAnimatePdSize++;
            }
        });
        g.moveTo("init", 0);
        g.moveTo("x", { duration: 200 });
        pd.push({ k: e.key, rm: () => g.moveTo("init", 100), el: kEl });
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
    let list: string[] = [];
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
                                button(getIconXEl("cross")).on("click", () => {
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
                .style({ position: "relative" })
                .add([
                    nl.el.style({ width: px(sSize(10)) }),
                    emptyMask.style({ position: "absolute", top: 0, left: 0 }),
                ]),
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
            if (l.length === 0) {
                showGear.moveTo({ s: 1 });
            } else {
                showGear.moveTo({ s: 0 });
            }
            nl.setList(l);
            list = l;
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
            const prevBtn = button(getIconXEl("media.backward.fill")).addInto(controls);
            const playBtn = button(getIconXEl("media.play.fill")).addInto(controls);
            const pauseBtn = button(getIconXEl("media.pause.fill")).addInto(controls);
            const nextBtn = button(getIconXEl("media.forward.fill")).addInto(controls);
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

export function tTrayMenu(op: { click: () => void; clickItem: () => void }) {
    const titleEl = aLineText();
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
    const list = dynamicScrollList<number>({
        itemSize: sSize(1),
        containerSize: sSize(1) * 8,
        direction: "down",
        keyExtractor: (k) => k.toString(),
        renderItem: (i, _, items) => {
            const item = data.get(i);
            const itemEl = view("x").style({
                padding: px(sSize2.paddingx),
                gap: px(sSize2.paddingx),
                alignItems: "center",
            });
            if (!item) {
                console.error(`tray ui ${i} cannot find item`);
                return itemEl;
            }
            const hasIcon = items.some((i) => data.get(i)?.iconUrl);
            if (hasIcon) {
                const iconEl = view().style({ width: "16px", height: "16px", flexShrink: 0 }).addInto(itemEl);
                if (item.iconUrl) {
                    item.iconUrl({ theme: "breeze" }).then((url) => {
                        image(url ?? "", "icon")
                            .style({ width: "16px", height: "16px", objectFit: "cover" })
                            .addInto(iconEl);
                    });
                }
            }
            aLineText().sv(item.label).addInto(itemEl).style({ flexGrow: 1 });
            // todo
            if (item.children?.length) {
                view().add(getIconXEl("chevron.right")).addInto(itemEl);
            } else if (item.toggleType === "checkmark") {
                if (item.toggleState) {
                    view().add("v").addInto(itemEl);
                } else {
                    view().add("☐").addInto(itemEl);
                }
            } else if (item.toggleType === "radio") {
                if (item.toggleState) {
                    view().add("v").addInto(itemEl);
                } else {
                    view().add("○").addInto(itemEl);
                }
            }
            itemEl.on("click", () => {
                if (item.children?.length) {
                    backMenu.on("click", () => {
                        list.setList(items);
                    });
                    list.setList(
                        item.children
                            .filter((i) => i.visible)
                            .filter((i) => i.type === "standard")
                            .map((i) => i.id),
                    );
                } else {
                    item.click();
                    op.clickItem();
                }
            });

            return itemEl;
        },
    });
    list.el.style({ width: px(sSize(6)) });
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
            list.setList(
                tree
                    .filter((i) => i.visible)
                    .filter((i) => i.type === "standard")
                    .map((i) => i.id),
                true,
            );
            if (tree.some((i) => i.children?.length)) {
                backMenu.style({ display: "flex" });
            } else {
                backMenu.style({ display: "none" });
            }
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
            t.add(getIconXEl(map[n].name, { size: fontSize, width: map[n].w * r, height: lightHeight }));
        }
    }
    return t;
}

export function rRange(op?: { dir?: "right" | "left" | "up" | "down"; mel?: HTMLElement }) {
    const pel = view().style({ width: "200px", height: "16px" });
    const t = (op?.mel ? pack(op.mel) : view().style({ background: "#000" })).addInto(pel);

    let v = 0; // 0-1

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
    });

    set(0);

    return {
        el: pel,
        sv: (v: number) => set(v),
        gv: () => v,
        onChange(f: (v: number) => void) {
            onChange = f;
        },
    };
}

export function vVolume(op?: {
    inputM: BindingSource<boolean>;
    outputM: BindingSource<boolean>;
    inputV: BindingSource<number>;
    outputV: BindingSource<number>;
}) {
    const output = view("x").style({ gap: px(sSize2.padding) });
    const input = view("x").style({ gap: px(sSize2.padding) });
    const p = ui.bar([output, input]);

    const d = 1;

    function muteB(icon: string) {
        let muted = false;
        const el = view()
            .style({
                width: px(sSize(d)),
                height: px(sSize(d)),
                borderRadius: px(sSize2.radius1),
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

    const rOutput = rRange({ mel: view().style({ background: "white", borderRadius: px(sSize2.radius1) }).el });
    const rInput = rRange({ mel: view().style({ background: "white", borderRadius: px(sSize2.radius1) }).el });

    rOutput.el.style({
        height: px(sSize(d)),
        flexGrow: 1,
        borderRadius: px(sSize2.radius1),
        overflow: "hidden",
        ...gGlassStyle.itemInBg,
    });
    rInput.el.style({
        height: px(sSize(d)),
        flexGrow: 1,
        borderRadius: px(sSize2.radius1),
        overflow: "hidden",
        ...gGlassStyle.itemInBg,
    });

    output.add([bOutput, rOutput.el]);
    input.add([bInput, rInput.el]);

    p.el.style({
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
    rOutput.onChange((v) => op?.outputV.set?.(v));
    rInput.onChange((v) => op?.inputV.set?.(v));

    return {
        el: p.el,
    };
}

// ── 输入法界面 ────────────────────────────────────────────────────────────────────────────────
// 候选窗和托盘弹窗的视觉都集中在这里，方便统一调整圆角、高亮和间距。

/** 输入法选中项/强调色 */
const imeHighlight = "#00aaff";

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
            maxWidth: "min(560px, 90vw)",
            padding: px(sSize2.padding),
            borderRadius: px(sSize2.radius2),
            boxSizing: "border-box",
            pointerEvents: "auto",
            color: "#111",
            fontFamily: "sans-serif",
            ...gGlassStyle.bg,
        })
        .add(body);

    let anchor: ImeCandidateAnchor | undefined;
    let wheelAt = 0;

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
        if (!anchor) {
            const w = el.el.offsetWidth;
            const h = el.el.offsetHeight;
            el.style({
                left: `${Math.max(4, (window.innerWidth - w) / 2)}px`,
                top: `${Math.max(4, window.innerHeight - h - 24)}px`,
            });
            return;
        }
        const margin = 6;
        const pad = 4;
        const w = el.el.offsetWidth;
        const h = el.el.offsetHeight;
        let x = anchor.x;
        let y = anchor.y + anchor.h + margin;
        if (y + h > window.innerHeight - pad) y = anchor.y - margin - h;
        x = Math.min(Math.max(x, pad), Math.max(pad, window.innerWidth - w - pad));
        y = Math.min(Math.max(y, pad), Math.max(pad, window.innerHeight - h - pad));
        el.style({ left: `${x}px`, top: `${y}px` });
    }

    function pagerButton(text: string, enabled: boolean, click: () => void) {
        return button(txt(text))
            .style({
                height: "18px",
                padding: "0 6px",
                borderRadius: px(sSize2.radius1),
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
        hide() {
            el.style({ display: "none" });
        },
        update(state: ImComposeState) {
            const hasContent = state.preedit.length > 0 || state.candidates.length > 0 || state.auxiliary.length > 0;
            if (!hasContent) {
                el.style({ display: "none" });
                return;
            }

            const showPreedit = !!state.preedit || !!state.auxiliary || state.hasPrev || state.hasNext;
            const preedit = view("x").style({
                gap: px(sSize2.paddingx),
                alignItems: "baseline",
                minHeight: "20px",
            });
            if (state.preedit) {
                preedit.add(txt(state.preedit).style({ whiteSpace: "nowrap", fontSize: "12px", opacity: "0.9" }));
            }
            if (state.auxiliary) {
                preedit.add(txt(state.auxiliary).style({ whiteSpace: "nowrap", fontSize: "11px", opacity: "0.55" }));
            }
            preedit.add(spacer());
            if (state.hasPrev || state.hasNext) {
                preedit.add(
                    view("x")
                        .style({ gap: "4px", alignItems: "center", fontSize: "11px", opacity: "0.8" })
                        .add([
                            pagerButton("◀", state.hasPrev, () => op.prevPage()),
                            pagerButton("▶", state.hasNext, () => op.nextPage()),
                        ]),
                );
            }

            const horizontal = state.candidateLayout >= 2;
            const list = view(horizontal ? "x" : "y", horizontal ? "wrap" : undefined).style({
                gap: "4px",
                alignItems: "stretch",
                maxWidth: horizontal ? "min(540px, 86vw)" : "320px",
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
                            borderRadius: px(sSize2.radius1),
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                            backgroundColor: active ? imeHighlight : gGlassStyle.itemInBg.backgroundColor,
                            color: active ? "#fff" : "inherit",
                        })
                        .add([
                            txt(label).style({ fontSize: "10px", opacity: active ? "0.85" : "0.5" }),
                            txt(text).style({ fontSize: "14px" }),
                        ])
                        .on("click", () => op.select(i)),
                );
            });

            const hasCandidates = state.candidates.length > 0;
            body.clear().add([...(showPreedit ? [preedit] : []), ...(hasCandidates ? [list] : [])]);
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
    enabled: boolean;
    state: ImState;
    currentName: string;
    currentUniqueName: string;
    entries: { uniqueName: string; name: string; label: string }[];
    hint?: string;
    error?: string;
}

export interface ImeTrayActions {
    toggle(): void;
    setEnabled(enabled: boolean): void;
    select(uniqueName: string): void;
}

/** 输入法托盘弹窗：当前输入法、激活/开关和组内切换 */
export function imeTrayPanel(op: ImeTrayActions) {
    const content = view("y").style({
        width: px(sSize(7)),
        padding: px(sSize2.padding),
        gap: px(sSize2.padding),
        boxSizing: "border-box",
    });
    const wrapper = xView([
        view()
            .style({
                borderRadius: px(sSize2.radius1),
                overflow: "hidden",
                ...gGlassStyle.itemInBg,
            })
            .add(content),
    ]);
    content.add(aLineText().sv("正在初始化…"));

    const stateText = (state: ImState) => (state === 2 ? "组合中" : state === 1 ? "英文" : "关闭");

    const actionButton = (text: string, click: () => void) =>
        button(txt(text))
            .style({
                flex: "1",
                padding: `5px ${px(sSize2.paddingx)}`,
                borderRadius: px(sSize2.radius1),
                backgroundColor: gGlassStyle.itemInBg.backgroundColor,
                cursor: "pointer",
                fontSize: "12px",
                whiteSpace: "nowrap",
            })
            .on("click", click);

    const setStatus = (status: ImeTrayStatus) => {
        content.clear();

        if (!status.available) {
            content.add(aLineText().sv("fcitx5 不可用"));
            if (status.error) {
                content.add(
                    txt(status.error).style({
                        fontSize: "11px",
                        opacity: "0.6",
                        wordBreak: "break-all",
                    }),
                );
            }
            return;
        }

        content.add(
            view("x")
                .style({ alignItems: "baseline", gap: "6px" })
                .add([
                    aLineText().sv(status.currentName).style({ fontWeight: "600", flexGrow: "1" }),
                    txt(stateText(status.state)).style({ fontSize: "11px", opacity: "0.6", flexShrink: "0" }),
                ]),
        );

        content.add(
            view("x")
                .style({ gap: "4px" })
                .add([
                    actionButton(stateText(status.state) === "组合中" ? "停用" : "激活", () => op.toggle()),
                    actionButton(status.enabled ? "关闭输入法" : "开启输入法", () => op.setEnabled(!status.enabled)),
                ]),
        );

        if (status.entries.length > 0) {
            const list = view("y").style({ gap: "2px" });
            for (const entry of status.entries) {
                const active = status.currentUniqueName === entry.uniqueName;
                list.add(
                    view("x")
                        .style({
                            padding: `5px ${px(sSize2.paddingx)}`,
                            borderRadius: px(sSize2.radius1),
                            gap: "6px",
                            alignItems: "baseline",
                            cursor: "pointer",
                            backgroundColor: active ? imeHighlight : gGlassStyle.itemInBg.backgroundColor,
                            color: active ? "#fff" : "inherit",
                        })
                        .add([
                            txt(entry.label?.trim() || "·").style({
                                fontSize: "10px",
                                width: "14px",
                                flexShrink: "0",
                                opacity: active ? "0.85" : "0.55",
                            }),
                            aLineText().sv(entry.name),
                            txt(entry.uniqueName).style({
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
            content.add(list);
        }

        if (status.hint) {
            content.add(
                txt(status.hint).style({
                    fontSize: "10px",
                    opacity: "0.55",
                    lineHeight: "1.5",
                }),
            );
        }
        if (status.error) {
            content.add(
                txt(status.error).style({
                    fontSize: "10px",
                    opacity: "0.55",
                    wordBreak: "break-all",
                }),
            );
        }
    };

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
