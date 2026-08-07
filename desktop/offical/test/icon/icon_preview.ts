import { getIconX, getIconXEl } from "../../src/icon";

const l = ["line", "zline", "dot", "rect", "rect.r", "rect.fill", "blue"];
for (const i of ["rect"]) {
    const svg = getIconX(i);
    console.log(`Icon "${i}":`);
    console.log(svg);
    console.log("");
}

if ("document" in globalThis) {
    for (const i of l) {
        const el = getIconXEl(i, { size: 128 });
        document.body.append(el);
        el.onclick = () => showIcon(i);
    }
    const dialog = document.createElement("dialog");
    dialog.popover = "auto";
    document.body.append(dialog);
    function showIcon(name: string) {
        // dialog
        // 32 64 512
        dialog.showPopover();
        const pel = document.createElement("div");
        for (const size of [32, 64, 512]) {
            const el = getIconXEl(name, { size });
            pel.append(el);
        }
        dialog.innerHTML = "";
        dialog.append(pel);
    }
    const icon = new URLSearchParams(location.search).get("icon");
    if (icon) {
        showIcon(icon);
    }
}
