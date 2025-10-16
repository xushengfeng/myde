import { image, view } from "dkh-ui";

const { sysApi, rootDir } =
    // @ts-expect-error
    window.myde as typeof import("../../src/renderer/desktop-api").default;

const mainEl = view().style({ width: "100vw", height: "100vh" }).addInto();

image(`${rootDir}/assets/wallpaper/1.svg`, "wallpaper")
    .style({
        width: "100%",
        height: "100%",
        objectFit: "cover",
    })
    .addInto(mainEl);
