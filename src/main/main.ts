/// <reference types="vite/client" />
import { app, globalShortcut, nativeTheme, BrowserWindow, sharedTexture, ipcMain } from "electron";
import * as path from "node:path";
const run_path = path.join(path.resolve(__dirname, ""), "../../");
import url from "node:url";

const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

let /** 是否开启开发模式 */ dev: boolean;

dev = true;

let the_icon = path.join(run_path, "assets/logo/1024x1024.png");
if (process.platform === "win32") {
    the_icon = path.join(run_path, "assets/logo/icon.ico");
}

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
        show: !isTestMode,
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        frame: !runAsDesktop,
        hasShadow: !runAsDesktop,
        roundedCorners: !runAsDesktop,
    });
    mainWin = main_window;

    if (process.env.desktop === ":test") {
        rendererPath(main_window.webContents, "test.html", {
            query: { userData: app.getPath("userData"), env: JSON.stringify(process.env) },
        });
    } else {
        let desktop_path = process.env.desktop ?? "desktop/offical";
        if (!path.isAbsolute(desktop_path)) {
            desktop_path = path.join(run_path, desktop_path);
        }
        log("加载桌面", desktop_path);
        rendererPath(main_window.webContents, "main.html", {
            query: {
                userData: app.getPath("userData"),
                env: JSON.stringify(process.env),
                desktop: desktop_path,
                ...(process.env.nodeModule ? { nodeModule: "on" } : {}),
            },
        });
    }

    if (dev) main_window.webContents.openDevTools();
}

let mainWin: BrowserWindow | null = null;

// 自动开启开发者模式
if (process.argv.includes("-d") || import.meta.env.DEV) {
    dev = true;
} else {
    dev = false;
}

dev = true;

const isTestMode = process.env.testMode === "on";

if (isTestMode) {
    dev = false;
}

const runAsDesktop = Boolean(process.env.runAsDesktop);

app.commandLine.appendSwitch("enable-experimental-web-platform-features", "enable");

app.whenReady().then(() => {
    createWin();
});

app.on("will-quit", () => {
    // Unregister all shortcuts.
    globalShortcut.unregisterAll();
});

const ipcPath = path.join("/tmp", "myde.sock");

const server = new mus.UServer();
server.listen(ipcPath);
server.on("connection", (socket) => {
    socket.on("data", (data, fd) => {
        const message = data.toString();
        const j = JSON.parse(message) as {
            id: number;
            options: Parameters<typeof sharedTexture.importSharedTexture>[0];
        };
        for (const [pidx, p] of (j.options.textureInfo.handle.nativePixmap?.planes ?? []).entries()) {
            p.fd = fd[pidx];
        }
        if (mainWin) {
            const texture = sharedTexture.importSharedTexture(j.options);
            sharedTexture.sendSharedTexture(
                { importedSharedTexture: texture, frame: mainWin.webContents.mainFrame },
                j.id,
            );
        }
    });
});

ipcMain.on("test", (_, data) => {
    if (data.type === "kill") {
        app.quit();
    } else if (data.type === "data") {
        console.log(JSON.stringify(data.data));
    } else if (data.type === "applog") {
        console.log(JSON.stringify({ applog: data.data }));
    }
});
