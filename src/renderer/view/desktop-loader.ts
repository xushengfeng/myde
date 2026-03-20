const fs = require("node:fs") as typeof import("node:fs");

import { addStyle, initDKH, pack } from "dkh-ui";
import { myde } from "../../desktop-api";
import type { nowConfig } from "../../setting/config";
import { setting } from "../../setting/setting";
import { vfs } from "../../sys_api/fs";

function loadDesktop(p: string) {
    const dirPath = p.replace(/\/$/, "");
    const packagePath = `${dirPath}/package.json`;
    if (!fs.existsSync(packagePath)) {
        console.error("Desktop package.json not found:", packagePath);
        return;
    }
    myde.MSysApi.fs = new vfs(dirPath);
    myde.MSetting = new setting<nowConfig>({
        version: "0.0.1",
        filePath: `${urlParams.get("userData")}/setting.json`,
        transform: (data, _versionA, _versionB) => {
            return data;
        },
        defaultSetting: { version: "0.0.1", "icon.theme": "breeze" },
    });
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

addStyle({
    "*": {
        cursor: "none !important",
    },
});

window.myde = myde;

const urlParams = new URLSearchParams(window.location.search);
const nodeModule = urlParams.get("nodeModule");
if (!nodeModule) {
    // @ts-expect-error
    delete window.require;
    // @ts-expect-error
    delete window.module;
    delete window.exports;
}
const desktopPath = urlParams.get("desktop");
if (desktopPath) {
    loadDesktop(desktopPath);
}
