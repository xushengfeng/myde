const fs = require("node:fs") as typeof import("node:fs");

import { initDKH, pack } from "dkh-ui";
import { getDesktopEntries, getDesktopIcon } from "../sys_api/application";

function loadDesktop(p: string) {
    const dirPath = p;
    const packagePath = `${dirPath}/package.json`;
    if (!fs.existsSync(packagePath)) {
        console.error("Desktop package.json not found:", packagePath);
        return;
    }
    const packageData = fs.readFileSync(packagePath, "utf-8");
    const packageJson = JSON.parse(packageData);
    const mainPath = `${dirPath}/${packageJson.main || "index.js"}`;
    const indexData = fs.readFileSync(mainPath, "utf-8");
    // todo 隔离
    const script = document.createElement("script");
    script.type = "module";
    script.text = indexData;
    document.body.appendChild(script);
}

initDKH({ pureStyle: true });
pack(document.body).style({
    width: "100vw",
    height: "100vh",
    overflow: "hidden",
    background: "black",
});

const sys_api = {
    getDesktopEntries,
    getDesktopIcon,
};

// @ts-ignore
window.myde = { sys_api };

const urlParams = new URLSearchParams(window.location.search);
const desktopPath = urlParams.get("desktop");
if (desktopPath) {
    loadDesktop(desktopPath);
}
