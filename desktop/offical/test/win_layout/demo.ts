import { button, textarea, view } from "dkh-ui";
import { freeLayout } from "../../src/win_layout";

const layout = new freeLayout(800, 600);

const main = view().style({ width: "800px", height: "600px", background: "#eee", position: "relative" }).addInto();

button("add")
    .on("click", () => {
        layout.addWindow();
        render();
    })
    .addInto();

function render() {
    main.clear();
    for (const win of layout.getAllWindows()) {
        view()
            .style({
                position: "absolute",
                left: `${win.x}px`,
                top: `${win.y}px`,
                width: `${win.width}px`,
                height: `${win.height}px`,
                border: "1px solid #999",
                pointerEvents: "none",
            })
            .add(win.id.toString())
            .add(
                button("x")
                    .style({ pointerEvents: "all" })
                    .on("click", () => {
                        layout.removeWindow(win.id);
                        render();
                    }),
            )
            .addInto(main);
    }
}

main.on("pointerdown", (e) => {
    const posi = { x: e.offsetX, y: e.offsetY };
    layout.moveStart(posi, 4);
});

main.on("pointermove", (e) => {
    const posi = { x: e.offsetX, y: e.offsetY };
    layout.move(posi);
    render();
});

main.on("pointerup", () => {
    layout.moveEnd();
});

main.on("dblclick", (e) => {
    const posi = { x: e.offsetX, y: e.offsetY };
    layout.addWindow(posi);
    render();
});

render();

textarea()
    .addInto()
    .on("change", (_, el) => {
        // biome-ignore lint/security/noGlobalEval: 用于测试的
        const state = eval(`let y=${el.gv}; y`);
        layout.loadState(state);
        render();
    });
