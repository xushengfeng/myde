import { getIconX } from "../../src/icon";

const l = ["line", "zline", "dot"];
for (const i of l) {
    const svg = getIconX(i);
    console.log(`Icon "${i}":`);
    console.log(svg);
    console.log("");
}

if ("document" in globalThis) {
    for (const i of l) {
        const svg = getIconX(i);
        const el = document.createElement("div");
        el.style.width = "256px";
        if (svg) el.innerHTML = svg;
        document.body.append(el);
    }
}
