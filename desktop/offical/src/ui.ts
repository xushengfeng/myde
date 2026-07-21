import { view } from "dkh-ui";

export function aLineText() {
    const textEl = view().style({
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        overflow: "hidden",
        width: "100%",
    });
    const wrapEl = view().style({
        overflow: "hidden",
        width: "100%",
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
