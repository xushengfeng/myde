const fs = require("node:fs") as typeof import("node:fs");
const { dbusIO } = require("myde-dbus") as typeof import("myde-dbus");
const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

import { addStyle, initDKH, pack } from "dkh-ui";
import { _myde } from "../../desktop-api";
import type { nowConfig } from "../../setting/config";
import { setting } from "../../setting/setting";
import { vfs } from "../../sys_api/fs";
import { SConnect } from "../../remote_connect/sconnect";
import { PeerjsAdapter } from "../../remote_connect/peerjs_adapter";
import { mpris } from "../../sys_api/mpris";
import { notification } from "../../sys_api/notification";
import { getEnv } from "../../sys_api/env";
import { tray } from "../../sys_api/appIndicator";

const {
    default: { loginService },
} = require("myde-pam-client") as typeof import("myde-pam-client");

async function loadDesktop(p: string) {
    const dirPath = p.replace(/\/$/, "");
    const packagePath = `${dirPath}/package.json`;
    if (!fs.existsSync(packagePath)) {
        console.error("Desktop package.json not found:", packagePath);
        return;
    }
    myde.MSysApi.fs = new vfs(dirPath);
    myde.MSysApi.verifyUserPassword = async (password: string) => {
        return new Promise<boolean>((resolve) => {
            loginService.authenticate(getEnv().USER, password, (e) => {
                if (e) {
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    };
    myde.MSetting = new setting<nowConfig>({
        version: "0.0.1",
        filePath: `${urlParams.get("userData")}/setting.json`,
        transform: (data, _versionA, _versionB) => {
            return data;
        },
        defaultSetting: { version: "0.0.1", "icon.theme": "breeze" },
    });
    myde.MConnect = new SConnect(new PeerjsAdapter());
    myde.MSysApi.media = new mpris(await newDBusIO());
    myde.MSysApi.notification = new notification(await newDBusIO());
    myde.MSysApi.tray = new tray(await newDBusIO());
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

async function newDBusIO() {
    const socket = new mus.USocket();
    socket.connect("/run/user/1000/bus");
    const io = new dbusIO({ socket });
    await io.connect();
    return io;
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

global.myde = _myde;

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
    await loadDesktop(desktopPath);
}
