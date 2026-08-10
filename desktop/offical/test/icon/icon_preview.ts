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
    "notification",
    "number.0",
    "number.1",
    "number.2",
    "number.3",
    "number.4",
    "number.5",
    "number.6",
    "number.7",
    "number.8",
    "number.9",
    "number.dot",
    "number.:",
    "number.,",
    "number.hash",
    "number.slash",
    "number.backslash",
    "number.percent",
    "number.minus",
    "number.plus",
    "number.degree",
    "font.underscore",
    "font.space",
];

if ("document" in globalThis) {
    const pel = view("x", "wrap").style({ gap: "16px" }).addInto();
    for (const i of l) {
        const el = getIconXEl(i, { size: 64 }).el;
        view("y")
            .style({ alignItems: "center", gap: "8px", width: `${64}px` })
            .add([el, txt(i).style({ fontFamily: "monospace", wordBreak: "break-all" })])
            .addInto(pel)
            .on("click", () => {
                const url = new URL(window.location.href);
                url.searchParams.set("icon", i);
                window.history.replaceState({}, "", url.toString());
                showIcon(i);
            });
    }
    const dialog = ele("dialog").attr({ popover: "auto" }).addInto();
    function showIcon(name: string) {
        // dialog
        // 32 64 512
        dialog.el.showPopover();
        const pel = view();
        const sm = view("x").addInto(pel);
        for (const size of [16, 24, 32]) {
            const el = getIconXEl(name, { size }).el;
            el.style.border = "1px solid blue";
            sm.add(el);
        }
        const bel = view("x").addInto(pel);
        for (const b of [0, 2, 4, 6, 8, 10, 12, 14]) {
            const el = getIconXEl(name, { size: 64 }).el;
            el.style.filter = `blur(${b}px)`;
            bel.add(
                view().style({ width: "64px", height: "64px", border: "1px solid blue", overflow: "hidden" }).add(el),
            );
        }

        const xel = view().style({ position: "relative" });
        const el = getIconXEl(name, { size: 512 }).el;
        el.style.border = "1px solid blue";
        xel.add(el);
        pel.add(xel);
        const cEl = view().style({ position: "absolute", top: 0, width: "512px" });
        const x = getIconComment(name);
        if (x) cEl.el.innerHTML = x;
        xel.add(cEl);

        dialog.clear().add(pel);
    }
    const icon = new URLSearchParams(location.search).get("icon");
    if (icon) {
        showIcon(icon);
    }
}
