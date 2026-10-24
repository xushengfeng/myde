import { type ElType, txt, view } from "dkh-ui";
import { type ImeTrayStatus, imeTrayPanel } from "../ui";
import type { ImeController, ImeStatus } from "./ime";
import { formatBindings } from "./shortcut";

type ShowTip = (op?: { state?: "show" | "hide" | "toggle"; anchorEl?: HTMLElement }) => void;

/**
 * 顶栏输入法托盘：按钮只显示标签和负责弹出，弹窗内容在 ui.ts 的 `imeTrayPanel`。
 */
export function createImeTool(op: {
    ime: () => ImeController | undefined;
    tipEl: HTMLElement;
    showTip: ShowTip;
}): ElType<HTMLElement> {
    const label = txt("—").style({
        fontSize: "14px",
        fontWeight: "600",
        minWidth: "20px",
        textAlign: "center",
        whiteSpace: "nowrap",
        userSelect: "none",
    });
    const el = view("x").style({ alignItems: "center", justifyContent: "center", minWidth: "24px" }).add(label);

    const panel = imeTrayPanel({
        toggle: () => {
            void op.ime()?.toggle();
        },
        setEnabled: (enabled) => {
            void op.ime()?.setEnabled(enabled);
        },
        select: (uniqueName) => {
            void op.ime()?.setCurrentIM(uniqueName);
        },
    });
    panel.el.addInto(op.tipEl);

    el.on("click", () => {
        void op.ime()?.sync();
        op.showTip({ state: "show", anchorEl: el.el });
    });

    op.ime()?.onStatus((status) => {
        label.sv(status.label);
        const bindings = op.ime()?.getBindings();
        panel.setStatus(
            toTrayStatus(
                status,
                bindings
                    ? `激活 ${formatBindings(bindings.toggle)} · 切换 ${formatBindings(bindings.nextIM)} / ${formatBindings(bindings.prevIM)}`
                    : undefined,
            ),
        );
    });

    return el;
}

function toTrayStatus(status: ImeStatus, hint?: string): ImeTrayStatus {
    return {
        available: status.available,
        enabled: status.enabled,
        state: status.state,
        currentName: status.current?.name || "未命名输入法",
        currentUniqueName: status.current?.uniqueName ?? "",
        entries: (status.group?.inputMethods ?? []).map((entry) => ({
            uniqueName: entry.uniqueName,
            name: entry.name,
            label: entry.label,
        })),
        hint,
        error: status.error,
    };
}
