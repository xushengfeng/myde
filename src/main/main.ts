/// <reference types="vite/client" />

import { closeSync } from "node:fs";
import * as path from "node:path";
import { app, BrowserWindow, globalShortcut, ipcMain, nativeTheme, sharedTexture } from "electron";

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
    main_window.on("closed", () => sharedLog("main window closed"));
    main_window.on("unresponsive", () => sharedLog("main window unresponsive"));
    main_window.webContents.on("render-process-gone", (_e, details) =>
        sharedLog(`render-process-gone ${JSON.stringify(details)}`),
    );
    main_window.webContents.on("destroyed", () => sharedLog("webContents destroyed"));
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
                displayType: runAsDesktop ? "desktop" : "window",
            },
        });
    }

    if (dev) main_window.webContents.openDevTools();
    if (runAsDesktop) {
        mainWin.webContents.on("console-message", ({ message, level: _level, lineNumber }) => {
            // if (level === "error")
            console.log(`console-message: lineNumber=${lineNumber}, message=${JSON.stringify(message)}`);
        });
    }
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

// 临时诊断日志：主进程 shared texture 回调链路。崩溃后文件保留，便于定位。
const sharedLogPath = "/tmp/myde-shared.log";
try {
    require("node:fs").writeFileSync(sharedLogPath, `${new Date().toISOString()} start\n`);
} catch {}
const sharedLog = (msg: string) => {
    try {
        require("node:fs").appendFileSync(sharedLogPath, `${new Date().toISOString()} ${msg}\n`);
    } catch {}
};
process.on("uncaughtException", (e: Error) => sharedLog(`uncaughtException ${String(e.stack ?? e)}`));
process.on("unhandledRejection", (e) => sharedLog(`unhandledRejection ${String(e)}`));
app.on("before-quit", () => sharedLog("before-quit"));
app.on("will-quit", () => sharedLog("will-quit"));
app.on("window-all-closed", () => sharedLog("window-all-closed"));
app.on("child-process-gone", (_e, details) => sharedLog(`child-process-gone ${JSON.stringify(details)}`));

const server = new mus.UServer();
server.listen(ipcPath);
server.on("connection", (socket) => {
    sharedLog("connection");
    // 消息格式：[4字节大端长度][JSON]，fd 走 SCM_RIGHTS。Unix stream 会把多次
    // write 合并进一次 read，所以必须按长度分帧，不能把每个 data 事件当一条消息。
    let buffered: Buffer = Buffer.alloc(0);
    const pendingFds: number[] = [];
    const MAX_FRAME = 16 * 1024 * 1024;

    const closeFds = () => {
        for (const fd of pendingFds.splice(0)) {
            try {
                closeSync(fd);
            } catch {
                /* ignore */
            }
        }
    };

    const handleMessage = (j: {
        id: number;
        options: Parameters<typeof sharedTexture.importSharedTexture>[0];
    }) => {
        const planes = j.options.textureInfo.handle.nativePixmap?.planes ?? [];
        if (planes.length > 0 && pendingFds.length < planes.length) {
            console.error(`[shared-texture] 消息 id=${j.id} 缺少 fd（需要 ${planes.length}，有 ${pendingFds.length}）`);
            return;
        }
        const fds = pendingFds.splice(0, planes.length);
        try {
            for (const [pidx, p] of planes.entries()) p.fd = fds[pidx];
            sharedLog(
                `import start id=${j.id} size=${j.options.textureInfo.codedSize.width}x${j.options.textureInfo.codedSize.height} fmt=${j.options.textureInfo.pixelFormat} stride=${planes[0]?.stride ?? 0} fds=${fds.join(",")}`,
            );
            const texture = sharedTexture.importSharedTexture(j.options);
            sharedLog(`imported id=${j.id}`);
            if (mainWin && !mainWin.isDestroyed()) {
                // sendSharedTexture 有 1000ms 超时；必须处理 rejection，
                // 否则会变成主进程的 unhandledRejection
                sharedTexture
                    .sendSharedTexture(
                        { importedSharedTexture: texture, frame: mainWin.webContents.mainFrame },
                        j.id,
                    )
                    .then(() => sharedLog(`sent id=${j.id}`))
                    .catch((e: unknown) => {
                        sharedLog(`send error id=${j.id}: ${String((e as Error)?.stack ?? e)}`);
                        try {
                            texture.release?.();
                        } catch {}
                    });
            } else {
                sharedLog(`no mainWin/destroyed id=${j.id}`);
            }
        } catch (e) {
            sharedLog(`import error id=${j.id}: ${String((e as Error)?.stack ?? e)}`);
            console.error(`[shared-texture] 导入失败 id=${j.id}:`, e);
        } finally {
            // importSharedTexture 会复制 fd，收到的那份用完要关掉，否则
            // Chrome/Blender 持续提交 dmabuf 会把 fd 耗尽
            for (const fd of fds) {
                try {
                    closeSync(fd);
                } catch {
                    /* ignore */
                }
            }
        }
    };

    const drain = () => {
        while (buffered.length >= 4) {
            const len = buffered.readUInt32BE(0);
            if (len > MAX_FRAME) {
                console.error(`[shared-texture] 帧过大（${len}），丢弃缓冲`);
                buffered = Buffer.alloc(0);
                closeFds();
                break;
            }
            if (buffered.length < 4 + len) break;
            const payload = buffered.subarray(4, 4 + len);
            buffered = buffered.subarray(4 + len);
            try {
                const j = JSON.parse(payload.toString());
                sharedLog(`frame id=${j.id} planes=${j.options?.textureInfo?.handle?.nativePixmap?.planes?.length ?? 0} pending=${pendingFds.length}`);
                handleMessage(j);
            } catch (e) {
                // 不能把异常抛回 native 回调（会直接崩掉进程）
                console.error("[shared-texture] 无效消息:", e);
            }
        }
    };
    let dataCount = 0;
    socket.on("data", (data, fds) => {
        if (dataCount < 100)
            sharedLog(
                `data len=${data?.length ?? -1} fdvalues=${(fds ?? []).join(",")} pending=${pendingFds.length}`,
            );
        dataCount++;
        if (fds?.length) pendingFds.push(...fds);
        buffered = buffered.length === 0 ? data : Buffer.concat([buffered, data]);
    });
    // 从 TSFN 回调里 setImmediate 会继承一个空 async context（CheckImmediate 里
    // V8 context 为 null 直接崩）。用普通上下文里创建的定时器轮询队列。
    const timer = setInterval(() => {
        if (buffered.length >= 4) drain();
    }, 4);
    timer.unref?.();
    socket.on("close", () => {
        clearInterval(timer);
        closeFds();
    });
    socket.on("end", closeFds);
});

ipcMain.on("test", (_, data) => {
    // 测试数据必须同步写到 fd 1：console.log 对管道是异步写入，
    // 紧接着 app.quit() 会让这行 JSON 还没落进管道就丢失，父进程收不到任何数据
    const writeLine = (line: string) => {
        try {
            require("node:fs").writeSync(1, `${line}\n`);
        } catch {
            console.log(line);
        }
    };
    if (data.type === "kill") {
        setTimeout(() => app.quit(), 100);
    } else if (data.type === "data") {
        writeLine(JSON.stringify(data.data));
    } else if (data.type === "applog") {
        writeLine(JSON.stringify({ applog: data.data }));
    }
});

ipcMain.on("SetWindowSize", (_, x: { width: number; height: number }) => {
    mainWin?.setContentSize(x.width, x.height);
});

if (runAsDesktop) {
    dev = false;
}
