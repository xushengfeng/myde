import { button, type ElType, spacer, txt, view } from "dkh-ui";
import type { ImComposeState } from "../../../../src/sys_api/input_method";
import { gGlassStyle, px, sSize2 } from "../ui";

export interface CandidateAnchor {
    /** 视口坐标的光标矩形（x/y 为左上角） */
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface CandidateHooks {
    select(index: number): void;
    nextPage(): void;
    prevPage(): void;
}

/**
 * 输入法候选窗。
 *
 * 只负责显示和鼠标操作；键盘选择/翻页仍由 fcitx 在 ProcessKeyEvent 里处理，
 * 避免两套键位不一致。窗口本身不接收焦点，点击不改变 Wayland 窗口焦点。
 */
export class CandidateWindow {
    readonly el: ElType<HTMLElement>;
    private readonly body: ElType<HTMLElement>;
    private readonly hooks: CandidateHooks;
    private anchor: CandidateAnchor | undefined;
    private wheelAt = 0;

    constructor(hooks: CandidateHooks) {
        this.hooks = hooks;
        this.body = view("y").style({ gap: "6px" });
        this.el = view("y")
            .style({
                position: "absolute",
                display: "none",
                maxWidth: "min(560px, 90vw)",
                padding: `${sSize2.padding}px`,
                borderRadius: `${sSize2.radius2}px`,
                boxSizing: "border-box",
                pointerEvents: "auto",
                color: "#111",
                fontFamily: "sans-serif",
                ...gGlassStyle.bg,
            })
            .add(this.body)
            .on("wheel", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const now = performance.now();
                if (now - this.wheelAt < 80) return;
                this.wheelAt = now;
                if (e.deltaY > 0) this.hooks.nextPage();
                else if (e.deltaY < 0) this.hooks.prevPage();
            });
    }

    setAnchor(anchor: CandidateAnchor | undefined) {
        this.anchor = anchor;
        if (this.visible) this.place();
    }

    get visible() {
        return this.el.el.style.display !== "none";
    }

    update(state: ImComposeState) {
        const hasContent = state.preedit.length > 0 || state.candidates.length > 0 || state.auxiliary.length > 0;
        if (!hasContent) {
            this.hide();
            return;
        }

        const preedit = view("x").style({ gap: "8px", alignItems: "baseline", minHeight: "20px" });
        if (state.preedit) {
            preedit.add(txt(state.preedit).style({ whiteSpace: "nowrap", fontSize: "13px" }));
        }
        if (state.auxiliary) {
            preedit.add(txt(state.auxiliary).style({ whiteSpace: "nowrap", fontSize: "12px", opacity: "0.7" }));
        }
        preedit.add(spacer());
        if (state.hasPrev || state.hasNext) {
            preedit.add(
                view("x")
                    .style({ gap: "6px", alignItems: "center", fontSize: "12px", opacity: "0.75" })
                    .add([
                        this.pagerButton("◀", state.hasPrev, () => this.hooks.prevPage()),
                        txt("翻页"),
                        this.pagerButton("▶", state.hasNext, () => this.hooks.nextPage()),
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
            const item = view("x")
                .style({
                    gap: "6px",
                    alignItems: "baseline",
                    padding: "4px 9px",
                    borderRadius: "8px",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    background: active ? "#3b82f6" : "rgba(255,255,255,0.55)",
                    color: active ? "#fff" : "inherit",
                })
                .add([
                    txt(label).style({ fontSize: "10px", opacity: active ? "0.85" : "0.55" }),
                    txt(text).style({ fontSize: "15px" }),
                ])
                .on("click", () => this.hooks.select(i));
            list.add(item);
        });

        this.body.clear().add([preedit, ...(state.candidates.length > 0 ? [list] : [])]);
        if (horizontal) this.body.style({ width: "fit-content" });
        else this.body.style({ width: "fit-content", minWidth: px(150) });
        this.show();
    }

    hide() {
        this.el.style({ display: "none" });
    }

    private pagerButton(text: string, enabled: boolean, click: () => void) {
        return button(txt(text))
            .style({
                padding: "0 4px",
                opacity: enabled ? "1" : "0.3",
                pointerEvents: enabled ? "auto" : "none",
                cursor: enabled ? "pointer" : "default",
            })
            .on("click", click);
    }

    private show() {
        this.el.style({ display: "flex", visibility: "hidden" });
        this.place();
        this.el.style({ visibility: "visible" });
    }

    private place() {
        if (!this.anchor) {
            // 没有光标信息时放在视口下缘中间，至少别挡住正在输入的行
            const w = this.el.el.offsetWidth;
            const h = this.el.el.offsetHeight;
            this.el.style({
                left: `${Math.max(4, (window.innerWidth - w) / 2)}px`,
                top: `${Math.max(4, window.innerHeight - h - 24)}px`,
            });
            return;
        }
        const margin = 6;
        const pad = 4;
        const w = this.el.el.offsetWidth;
        const h = this.el.el.offsetHeight;
        let x = this.anchor.x;
        let y = this.anchor.y + this.anchor.h + margin;
        if (y + h > window.innerHeight - pad) y = this.anchor.y - margin - h;
        x = Math.min(Math.max(x, pad), Math.max(pad, window.innerWidth - w - pad));
        y = Math.min(Math.max(y, pad), Math.max(pad, window.innerHeight - h - pad));
        this.el.style({ left: `${x}px`, top: `${y}px` });
    }
}
