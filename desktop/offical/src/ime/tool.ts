import { button, type ElType, txt, view } from "dkh-ui";
import { aLineText, px, sSize, sSize2, ui } from "../ui";
import type { ImeController, ImeStatus } from "./ime";
import { formatBindings } from "./shortcut";

type ShowTip = (op?: { state?: "show" | "hide" | "toggle"; anchorEl?: HTMLElement }) => void;

/**
 * 顶栏输入法托盘：显示当前输入法标签，弹层里做激活、开关和组内切换。
 * 结构与其他托盘工具一致（`selfBackground` + `ui.bar`）。
 */
export function createImeTool(op: {
    ime: () => ImeController | undefined;
    tipEl: HTMLElement;
    showTip: ShowTip;
}): ElType<HTMLElement> {
    const label = txt("—").style({
        fontSize: "13px",
        fontWeight: "600",
        minWidth: "20px",
        textAlign: "center",
        whiteSpace: "nowrap",
        userSelect: "none",
    });
    const el = view("x").style({ alignItems: "center", justifyContent: "center", minWidth: "24px" }).add(label);

    const content = view("y").style({
        width: px(sSize(7)),
        padding: `${sSize2.padding}px`,
        gap: `${sSize2.padding}px`,
        boxSizing: "border-box",
    });
    ui.bar([ui.barItem().add(content)]).el.addInto(op.tipEl);

    let status: ImeStatus | undefined;

    const render = () => {
        label.sv(status?.label ?? "—");
        content.clear();

        if (!status) {
            content.add(aLineText().sv("正在初始化…"));
            return;
        }
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

        const current = status.current;
        content.add(
            view("x")
                .style({ alignItems: "baseline", gap: "6px" })
                .add([
                    aLineText()
                        .sv(current?.name || "未命名输入法")
                        .style({ fontWeight: "600" }),
                    txt(stateText(status.state)).style({ fontSize: "11px", opacity: "0.6", flexShrink: "0" }),
                ]),
        );

        const actions = view("x").style({ gap: "4px" });
        actions.add([
            actionButton(stateText(status.state) === "组合中" ? "停用" : "激活", () => {
                void op.ime()?.toggle();
            }),
            actionButton(status.enabled ? "关闭输入法" : "开启输入法", () => {
                void op.ime()?.setEnabled(!status?.enabled);
            }),
        ]);
        content.add(actions);

        const list = status.group?.inputMethods;
        if (list && list.length > 0) {
            const box = view("y").style({ gap: "2px" });
            for (const entry of list) {
                const active = current?.uniqueName === entry.uniqueName;
                const item = view("x")
                    .style({
                        padding: "4px 8px",
                        borderRadius: "8px",
                        gap: "6px",
                        alignItems: "baseline",
                        cursor: "pointer",
                        background: active ? "#3b82f6" : "rgba(255,255,255,0.5)",
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
                    .on("click", () => {
                        void op.ime()?.setCurrentIM(entry.uniqueName);
                    });
                box.add(item);
            }
            content.add(box);
        }

        const b = op.ime()?.getBindings();
        if (b) {
            content.add(
                txt(
                    `激活 ${formatBindings(b.toggle)} · 切换 ${formatBindings(b.nextIM)} / ${formatBindings(b.prevIM)}`,
                ).style({ fontSize: "10px", opacity: "0.55", lineHeight: "1.5" }),
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

    el.on("click", () => {
        void op.ime()?.sync();
        op.showTip({ state: "show", anchorEl: el.el });
    });

    op.ime()?.onStatus((s) => {
        status = s;
        render();
    });
    render();
    return el;
}

function actionButton(text: string, click: () => void) {
    return button(txt(text))
        .style({
            flex: "1",
            padding: "5px 8px",
            borderRadius: "8px",
            background: "rgba(255,255,255,0.6)",
            cursor: "pointer",
            fontSize: "12px",
            whiteSpace: "nowrap",
        })
        .on("click", click);
}

function stateText(state: ImeStatus["state"]): string {
    if (state === 2) return "组合中";
    if (state === 1) return "英文";
    return "关闭";
}
