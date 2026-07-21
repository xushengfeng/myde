import { view } from "dkh-ui";
import { uPasswdInput } from "../../src/ui";

const i = uPasswdInput();
i.placeholder("input your p");
const p = i.el.style({
    width: "100px",
    height: "24px",
    background: "#eee",
});
const r = view();
view().add(["passwd", p, r]).addInto();
p.on("change", () => {
    r.clear().add(p.gv);
});
