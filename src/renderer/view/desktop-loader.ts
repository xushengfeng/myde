const fs = require("node:fs") as typeof import("node:fs");
const { dbusIO } = require("myde-dbus") as typeof import("myde-dbus");
const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

import { addStyle, initDKH, pack } from "dkh-ui";
import { _myde } from "../../desktop-api";
import { PeerjsAdapter } from "../../remote_connect/peerjs_adapter";
import { SConnect } from "../../remote_connect/sconnect";
import type { nowConfig } from "../../setting/config";
import { setting } from "../../setting/setting";
import { tray } from "../../sys_api/appIndicator";
import { blue } from "../../sys_api/blue";
import { display } from "../../sys_api/display";
import { getEnv } from "../../sys_api/env";
import { vfs } from "../../sys_api/fs";
import { mpris } from "../../sys_api/mpris";
import { network } from "../../sys_api/network";
import { notification } from "../../sys_api/notification";
import { power } from "../../sys_api/power";

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
    myde.MSysApi.display = new display();
    myde.MSysApi.display.setType(urlParams.get("displayType") === "desktop" ? "desktop" : "window");
    if (myde.MSysApi.display.getType() === "desktop") {
        await myde.MSysApi.display.connect({ socketPath: getEnv().MYDE_WRAP_SOCKET, mus });
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
    myde.MSysApi.power = new power(await newDBusIO(true));
    myde.MSysApi.blue = new blue(await newDBusIO(true));
    myde.MSysApi.network = new network(await newDBusIO(true));
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

async function newDBusIO(system = false) {
    const socket = new mus.USocket();
    if (system) {
        socket.connect("/run/dbus/system_bus_socket");
    } else {
        socket.connect("/run/user/1000/bus");
    }
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
