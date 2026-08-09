import { ele, txt, view } from "dkh-ui";
import { getIconXEl } from "../../src/icon";

const l = [
    "line",
    "zline",
    "dot",
    "rect",
    "rect.r",
    "rect.fill",
    "blue",
    "battery",
    "wifi",
    "shutdown",
    "lock",
    "reboot",
    "suspend",
    "chevron.left",
    "chevron.right",
    "music",
    "media.forward.fill",
    "media.backward.fill",
    "media.play.fill",
    "media.pause.fill",
    "cross",
    "mutiWinView",
    "number.1",
];

if ("document" in globalThis) {
    const pel = view("x", "wrap").style({ gap: "16px" }).addInto();
    for (const i of l) {
        const el = getIconXEl(i, { size: 64 }).el;
        view("y")
            .style({ alignItems: "center", gap: "8px", width: `${64}px` })
            .add([el, txt(i).style({ fontFamily: "monospace", wordBreak: "break-all" })])
            .addInto(pel)
            .on("click", () => showIcon(i));
    }
    const dialog = ele("dialog").attr({ popover: "auto" }).addInto();
    function showIcon(name: string) {
        // dialog
        // 32 64 512
        dialog.el.showPopover();
        const pel = view();
        for (const size of [32, 64, 512]) {
            const el = getIconXEl(name, { size }).el;
            el.style.border = "1px solid blue";
            pel.add(el);
        }
        dialog.clear().add(pel);
    }
    const icon = new URLSearchParams(location.search).get("icon");
    if (icon) {
        showIcon(icon);
    }
}
