import { ele, txt, view } from "dkh-ui";
import { getIconComment, getIconXEl } from "../../src/icon";

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
            const xel = view().style({ position: "relative" });
            const el = getIconXEl(name, { size }).el;
            xel.add(el).style({ border: "1px solid blue" });
            pel.add(xel);
            if (size === 512) {
                const cEl = view().style({ position: "absolute", top: 0, width: "512px" });
                const x = getIconComment(name);
                if (x) cEl.el.innerHTML = x;
                console.log(x);

                xel.add(cEl);
            }
        }
        dialog.clear().add(pel);
    }
    const icon = new URLSearchParams(location.search).get("icon");
    if (icon) {
        showIcon(icon);
    }
}
