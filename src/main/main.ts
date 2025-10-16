/// <reference types="vite/client" />
import { app, globalShortcut, nativeTheme, BrowserWindow } from "electron";
import * as path from "node:path";
const run_path = path.join(path.resolve(__dirname, ""), "../../");
import url from "node:url";

let /** 是否开启开发模式 */ dev: boolean;

dev = true;

let the_icon = path.join(run_path, "assets/logo/1024x1024.png");
if (process.platform === "win32") {
    the_icon = path.join(run_path, "assets/logo/icon.ico");
}

const isMac = process.platform === "darwin";

function log(...params: unknown[]) {
    if (dev) console.log(...params);
}

function renderer_url(
    file_name: string,
    q: Electron.LoadFileOptions = {
        query: { config_path: app.getPath("userData") },
    },
) {
    if (!q.query) {
        q.query = { config_path: app.getPath("userData") };
    } else {
        q.query.config_path = app.getPath("userData");
    }
    let x: url.URL;
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
        const main_url = `${process.env.ELECTRON_RENDERER_URL}/${file_name}`;
        x = new url.URL(main_url);
    } else {
        x = new url.URL(`file://${path.join(__dirname, "../renderer", file_name)}`);
    }
    if (q) {
        if (q.search) x.search = q.search;
        if (q.query) {
            for (const i in q.query) {
                x.searchParams.set(i, q.query[i]);
            }
        }
        if (q.hash) x.hash = q.hash;
    }
    return x.toString();
}

/** 加载网页 */
function rendererPath(window: Electron.WebContents, file_name: string, q?: Electron.LoadFileOptions) {
    window.loadURL(renderer_url(file_name, q));
}

// 窗口
async function createWin() {
    const main_window = new BrowserWindow({
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f0f0f" : "#ffffff",
        icon: the_icon,
        show: true,
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    if (process.env.desktop) {
        let desktop_path = process.env.desktop;
        if (!path.isAbsolute(desktop_path)) {
            desktop_path = path.join(run_path, desktop_path);
        }
        log("加载桌面", desktop_path);
        rendererPath(main_window.webContents, "main.html", {
            query: { userData: app.getPath("userData"), env: JSON.stringify(process.env), desktop: desktop_path },
        });
    } else
        rendererPath(main_window.webContents, "test.html", {
            query: { userData: app.getPath("userData"), env: JSON.stringify(process.env) },
        });
    if (dev) main_window.webContents.openDevTools();
}

// 自动开启开发者模式
if (process.argv.includes("-d") || import.meta.env.DEV) {
    dev = true;
} else {
    dev = false;
}

dev = true;

app.commandLine.appendSwitch("enable-experimental-web-platform-features", "enable");

app.whenReady().then(() => {
    createWin();
});

app.on("will-quit", () => {
    // Unregister all shortcuts.
    globalShortcut.unregisterAll();
});
