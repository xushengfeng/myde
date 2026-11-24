/// <reference types="vite/client" />

import { closeSync, existsSync, mkdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { format } from "node:util";
import { app, BrowserWindow, globalShortcut, ipcMain, nativeTheme, sharedTexture } from "electron";
import { uniqueSocketPath } from "../socket-name";
import { formatLogTime, getLogDir, RotatingLogFile } from "../utils/log";
import { startInternalPortal, stopInternalPortal } from "./internal_portal";
import type { SessionAppEvent, SessionHelperCommand, SessionHelperEvent } from "./session_ipc";

const run_path = path.join(path.resolve(__dirname, ""), "../../");

import url from "node:url";

const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");
const childProcess = require("node:child_process") as typeof import("node:child_process");

let /** 是否开启开发模式 */ dev: boolean;

dev = true;

/** 主进程日志文件；原生模式 stdout 在被 DRM 占用的 TTY 上，必须落盘 */
const mainLogFile = new RotatingLogFile(path.join(getLogDir(), "myde.log"));

function mainLog(level: string, message: string) {
    mainLogFile.write(`${formatLogTime()} [${level}] ${message}\n`);
}

/** 让主进程 console 同时写日志文件，行为保持不变 */
function captureConsole() {
    const methods = ["debug", "info", "log", "warn", "error"] as const;
    for (const method of methods) {
        const original = console[method];
        console[method] = (...args: unknown[]) => {
            original(...args);
            let message: string;
            try {
                message = format(...args);
            } catch {
                message = args.map((arg) => String(arg)).join(" ");
            }
            if (message.length > 16 * 1024) message = `${message.slice(0, 16 * 1024)}…`;
            mainLog(method, message);
        };
    }
}

captureConsole();
mainLog(
    "info",
    `start: version=${app.getVersion()} electron=${process.versions.electron} node=${process.versions.node} pid=${process.pid} argv=${JSON.stringify(process.argv)}`,
);
mainLog("info", `log file: ${mainLogFile.filePath}`);

/**
 * wrap 控制通道：socket 路径和一次性认证 token 只交给桌面进程本身。
 * token 由 wrap 经继承的文件描述符传来，读一次即关闭；这些变量随后从
 * process.env 删除，避免渲染进程、helper 和之后启动的应用继承。
 */
const wrapControl = (() => {
    const socketPath = process.env.MYDE_WRAP_SOCKET;
    let token: string | undefined;
    const fdText = process.env.MYDE_WRAP_AUTH_FD;
    const authFd = fdText ? Number(fdText) : Number.NaN;
    if (Number.isInteger(authFd) && authFd > 2) {
        try {
            const buffer = Buffer.alloc(128);
            const length = readSync(authFd, buffer, 0, buffer.length, null);
            token = buffer.subarray(0, length).toString("utf8").trim() || undefined;
        } catch (error) {
            mainLog("warn", `读取 wrap 认证 token 失败: ${String(error)}`);
        } finally {
            try {
                closeSync(authFd);
            } catch {}
        }
    }
    delete process.env.MYDE_WRAP_SOCKET;
    delete process.env.MYDE_WRAP_AUTH_FD;
    // 调试开关只在开发时显式设置，不留给桌面启动的应用
    delete process.env.MYDE_REMOTE_DEBUGGING_PORT;
    delete process.env.MYDE_INSPECT_PORT;
    delete process.env.MYDE_REMOTE_ALLOW_ORIGINS;
    return { socketPath, token };
})();

// 会话内的 helper 必须在 Chromium 把主进程搬进 app-*.scope 之前启动：它继承当前
// cgroup，会留在登录会话里。它负责两件事：
// - 注册 polkit 会话级 agent，接住会话内进程的认证；
// - 代桌面启动应用，让应用（以及终端里再派生的 systemctl 等）也留在同一个会话。
// 放到 app.whenReady 里就太晚了。
const sessionHelperPath = path.join(__dirname, "session_helper.js");
let sessionHelper: import("node:child_process").ChildProcess | undefined;
let polkitBridgeReady = false;
const polkitPending: SessionHelperEvent[] = [];

/** helper 的应用事件转成 renderer 的消息 */
function toAppEvent(event: SessionHelperEvent): SessionAppEvent | undefined {
    switch (event.type) {
        case "app-started":
            return { type: "started", id: event.id, pid: event.pid };
        case "app-error":
            return { type: "error", id: event.id, message: event.message };
        case "app-exit":
            return { type: "exit", id: event.id, code: event.code, signal: event.signal };
        default:
            return undefined;
    }
}

function startSessionHelper() {
    // 窗口模式下认证由宿主桌面处理，注册我们自己的 agent 反而会把宿主的弹窗抢过来
    if (!process.env.runAsDesktop) return;
    if (process.env.testMode === "on") return;
    if (process.env.MYDE_SESSION_HELPER === "0") return;
    if (!existsSync(sessionHelperPath)) {
        mainLog("warn", `[session-helper] 找不到 ${sessionHelperPath}，跳过`);
        return;
    }
    try {
        sessionHelper = childProcess.spawn(process.execPath, [sessionHelperPath], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
    } catch (error) {
        mainLog("warn", `[session-helper] 启动失败: ${String(error)}`);
        return;
    }
    sessionHelper.stdout?.on("data", (data: Buffer) =>
        mainLog("info", `[session-helper] ${data.toString().trimEnd()}`),
    );
    sessionHelper.stderr?.on("data", (data: Buffer) =>
        mainLog("warn", `[session-helper] ${data.toString().trimEnd()}`),
    );
    sessionHelper.on("message", (message: SessionHelperEvent) => {
        const appEvent = toAppEvent(message);
        if (appEvent) {
            if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:event", appEvent);
            return;
        }
        if (polkitBridgeReady && mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send("polkit:event", message);
        } else {
            polkitPending.push(message);
        }
    });
    sessionHelper.on("error", (error) => mainLog("warn", `[session-helper] 错误: ${String(error)}`));
    sessionHelper.once("exit", (code, signal) => {
        mainLog("warn", `[session-helper] 退出 code=${code} signal=${signal}`);
        sessionHelper = undefined;
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:helper-exit");
    });
}
startSessionHelper();

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
    main_window.webContents.once("did-finish-load", () => {
        polkitBridgeReady = true;
        if (!mainWin || mainWin.isDestroyed()) return;
        for (const message of polkitPending.splice(0)) {
            mainWin.webContents.send("polkit:event", message);
        }
    });
    main_window.on("closed", () => {
        sharedLog("main window closed");
        mainLog("info", "main window closed");
    });
    main_window.on("unresponsive", () => {
        sharedLog("main window unresponsive");
        mainLog("warn", "main window unresponsive");
    });
    main_window.webContents.on("render-process-gone", (_e, details) => {
        const line = `render-process-gone ${JSON.stringify(details)}`;
        sharedLog(line);
        mainLog("error", line);
    });
    main_window.webContents.on("destroyed", () => {
        sharedLog("webContents destroyed");
        mainLog("warn", "webContents destroyed");
    });
    if (process.env.desktop === ":test") {
        rendererPath(main_window.webContents, "test.html", {
            query: {
                userData: app.getPath("userData"),
                env: JSON.stringify(process.env),
                wrapSocket: wrapControl.socketPath ?? "",
                ...(wrapControl.token ? { wrapToken: wrapControl.token } : {}),
            },
        });
    } else {
        let desktop_path = process.env.desktop ?? "desktop/official";
        if (!path.isAbsolute(desktop_path)) {
            desktop_path = path.join(run_path, desktop_path);
        }
        log("加载桌面", desktop_path);
        rendererPath(main_window.webContents, "main.html", {
            query: {
                userData: app.getPath("userData"),
                env: JSON.stringify(process.env),
                desktop: desktop_path,
                wrapSocket: wrapControl.socketPath ?? "",
                ...(wrapControl.token ? { wrapToken: wrapControl.token } : {}),
                ...(process.env.nodeModule ? { nodeModule: "on" } : {}),
                displayType: runAsDesktop ? "desktop" : "window",
            },
        });
    }

    if (dev) main_window.webContents.openDevTools();
    main_window.webContents.on("console-message", (event) => {
        const { level, message, sourceId, lineNumber } = event;
        mainLog(`renderer:${level}`, `${message} (${sourceId}:${lineNumber})`);
        // 保留原有的 stdout 输出，方便原生模式外接重定向或 SSH 时查看
        if (runAsDesktop) {
            try {
                process.stdout.write(`console-message: lineNumber=${lineNumber}, message=${JSON.stringify(message)}\n`);
            } catch {
                /* stdout 已关闭 */
            }
        }
    });
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

// 总线模式控制应用和桌面系统服务的总线归属：
// internal 全部走私有总线；mixed 除输入法外走私有总线；external 全部走宿主会话总线。
// --bus-mode=<mode> 或 MYDE_BUS_MODE 指定，默认 mixed。
const requestedBusMode = (() => {
    const arg = process.argv.find((item) => item.startsWith("--bus-mode="))?.slice("--bus-mode=".length);
    const value = arg ?? process.env.MYDE_BUS_MODE;
    return value === "internal" || value === "external" ? value : "mixed";
})();

// 私有 dbus + xdg-desktop-portal 供应用和桌面服务使用；external 模式不启动。
// --no-internal-portal / MYDE_INTERNAL_PORTAL=0 可关闭，--internal-portal / MYDE_INTERNAL_PORTAL=1 可强制开启。
// 测试实例默认关闭，显式开启时仍会启动。
const internalPortalForced = process.env.MYDE_INTERNAL_PORTAL === "1" || process.argv.includes("--internal-portal");
const internalPortalDisabled =
    process.env.MYDE_INTERNAL_PORTAL === "0" || process.argv.includes("--no-internal-portal");
const useInternalPortal = internalPortalDisabled
    ? false
    : internalPortalForced
      ? true
      : isTestMode
        ? false
        : requestedBusMode !== "external";

// 没有私有总线时只能按 external 工作；强制开启私有总线时 external 退化为 mixed。
const busMode = !useInternalPortal ? "external" : requestedBusMode === "external" ? "mixed" : requestedBusMode;
process.env.MYDE_BUS_MODE = busMode;
mainLog("info", `bus mode: ${busMode}`);
mainLog("info", `internal portal: ${useInternalPortal ? "on" : "off"}`);

if (isTestMode) {
    dev = false;
    // 测试实例与正在运行的 myde 隔离；ozone 平台由 test_runner 在启动前用环境变量选择。
    // runner 会传自己的 userData 目录，方便异常退出后由测试清理。
    const testUserData = process.env.MYDE_TEST_USER_DATA_DIR || path.join(os.tmpdir(), `myde-test-${process.pid}`);
    delete process.env.MYDE_TEST_USER_DATA_DIR;
    app.setPath("userData", testUserData);
    app.commandLine.appendSwitch("allow-file-access-from-files");
    let cleanupScheduled = false;
    const scheduleUserDataCleanup = () => {
        if (cleanupScheduled) return;
        cleanupScheduled = true;
        // Chromium 在 will-quit 之后还会写 Cache/Local State。用 detached 的
        // Node 进程等主进程退出后再删，避免刚删掉又被子进程重建。
        const script = `setTimeout(() => { try { require("node:fs").rmSync(${JSON.stringify(testUserData)}, { recursive: true, force: true }); } catch {} }, 600);`;
        try {
            const child = childProcess.spawn(process.execPath, ["-e", script], {
                detached: true,
                stdio: "ignore",
                env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            });
            child.unref();
        } catch {}
    };
    app.on("will-quit", scheduleUserDataCleanup);
}

const runAsDesktop = Boolean(process.env.runAsDesktop);

app.commandLine.appendSwitch("enable-experimental-web-platform-features", "enable");

app.whenReady().then(async () => {
    if (useInternalPortal) {
        try {
            const handle = await startInternalPortal({
                userDataDir: app.getPath("userData"),
                runtimeDir: process.env.XDG_RUNTIME_DIR || app.getPath("temp"),
            });
            console.log(`[portal] 内部 portal 已启动: ${handle.busAddress}`);
        } catch (e) {
            console.warn("[portal] 内部 portal 启动失败，回退到宿主 session bus:", e);
        }
    }
    createWin();
});

app.on("will-quit", () => {
    stopInternalPortal();
    sessionHelper?.kill();
    sessionHelper = undefined;
    // Unregister all shortcuts.
    globalShortcut.unregisterAll();
});

// 每个实例独立的共享纹理通道：固定名字会让第二个实例的渲染进程连到第一个
// 实例的主进程，纹理被送进错误的窗口。路径通过环境变量传给渲染进程。
const ipcPath = uniqueSocketPath(process.env.XDG_RUNTIME_DIR || os.tmpdir(), "myde-shared", ".sock");
process.env.MYDE_SHARED_TEXTURE_SOCKET = ipcPath;

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
// 在模块顶层（普通 async context）创建定时器，所有连接的解析都从这里驱动。
// 不能在 native TSFN 回调里 setImmediate/setInterval：拿到的 async context
// 可能为空，CheckImmediate 里 v8::Function::Call 会以 null context 崩溃。
const sharedDrains = new Set<() => void>();
const sharedTimer = setInterval(() => {
    for (const drain of sharedDrains) {
        try {
            drain();
        } catch (e) {
            sharedLog(`drain error ${String(e)}`);
        }
    }
}, 4);
sharedTimer.unref?.();

process.on("uncaughtException", (e: Error) => {
    const line = `uncaughtException ${String(e.stack ?? e)}`;
    sharedLog(line);
    mainLog("error", line);
});
process.on("unhandledRejection", (e) => {
    const line = `unhandledRejection ${String(e)}`;
    sharedLog(line);
    mainLog("error", line);
});
app.on("before-quit", () => {
    sharedLog("before-quit");
    mainLog("info", "before-quit");
});
app.on("will-quit", () => {
    sharedLog("will-quit");
    mainLog("info", "will-quit");
});
app.on("window-all-closed", () => {
    sharedLog("window-all-closed");
    mainLog("info", "window-all-closed");
});
app.on("child-process-gone", (_e, details) => {
    const line = `child-process-gone ${JSON.stringify(details)}`;
    sharedLog(line);
    mainLog("error", line);
});

const server = new mus.UServer();
server.listen(ipcPath);
app.on("will-quit", () => {
    try {
        rmSync(ipcPath, { force: true });
    } catch {}
    mainLog("info", "quit");
    mainLogFile.close();
});
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

    const handleMessage = (j: { id: number; options: Parameters<typeof sharedTexture.importSharedTexture>[0] }) => {
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
                    .sendSharedTexture({ importedSharedTexture: texture, frame: mainWin.webContents.mainFrame }, j.id)
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
                sharedLog(
                    `frame id=${j.id} planes=${j.options?.textureInfo?.handle?.nativePixmap?.planes?.length ?? 0} pending=${pendingFds.length}`,
                );
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
            sharedLog(`data len=${data?.length ?? -1} fdvalues=${(fds ?? []).join(",")} pending=${pendingFds.length}`);
        dataCount++;
        if (fds?.length) pendingFds.push(...fds);
        buffered = buffered.length === 0 ? data : Buffer.concat([buffered, data]);
    });
    sharedDrains.add(drain);
    socket.on("close", () => {
        sharedDrains.delete(drain);
        closeFds();
    });
    socket.on("end", closeFds);
});

ipcMain.on("polkit:action", (_event, action: SessionHelperCommand) => {
    try {
        sessionHelper?.send(action);
    } catch {
        // helper 正在退出，IPC 通道已关闭
    }
});

/** 应用启动/结束都交给 session helper，进程留在登录会话里 */
ipcMain.on("app:spawn-available", (event) => {
    event.returnValue = Boolean(sessionHelper);
});

ipcMain.on("app:spawn", (_event, command: Extract<SessionHelperCommand, { type: "spawn" }>) => {
    try {
        sessionHelper?.send(command);
    } catch {
        // helper 正在退出，IPC 通道已关闭
    }
});

ipcMain.on("app:kill", (_event, command: Extract<SessionHelperCommand, { type: "kill" }>) => {
    try {
        sessionHelper?.send(command);
    } catch {
        // helper 正在退出，IPC 通道已关闭
    }
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

interface ScreenshotRectRequest {
    x: number;
    y: number;
    width: number;
    height: number;
}

function screenshotRect(rect: ScreenshotRectRequest): Electron.Rectangle {
    const values = [rect.x, rect.y, rect.width, rect.height];
    if (!values.every((value) => Number.isFinite(value))) {
        throw new Error("截屏区域无效");
    }
    const normalized = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
    };
    if (normalized.width <= 0 || normalized.height <= 0) {
        throw new Error("截屏区域为空");
    }
    return normalized;
}

function screenshotFileName(now = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `Screenshot_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
}

function screenshotName(name: string | undefined): string | undefined {
    if (!name) return undefined;
    const base = path
        .basename(name)
        .replace(/[\p{Cc}<>:"/\\|?*]/gu, "_")
        .replace(/^\.+/, "")
        .trim();
    if (!base) return undefined;
    return base.toLowerCase().endsWith(".png") ? base : `${base}.png`;
}

function uniqueScreenshotPath(dir: string, name: string): string {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let file = path.join(dir, name);
    for (let i = 2; existsSync(file); i++) {
        file = path.join(dir, `${stem} (${i})${ext}`);
    }
    return file;
}

function isPng(data: Uint8Array): boolean {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return data.length >= signature.length && signature.every((value, index) => data[index] === value);
}

// 截屏：rect 用渲染页面的 CSS 像素，返回 PNG（HiDPI 下是物理像素尺寸）
ipcMain.handle("screenshot:capture", async (event, request?: { rect?: ScreenshotRectRequest }) => {
    const contents = event.sender;
    if (contents.isDestroyed()) throw new Error("页面已销毁");
    const rect = request?.rect ? screenshotRect(request.rect) : undefined;
    const image = await contents.capturePage(rect);
    if (image.isEmpty()) throw new Error("截屏结果为空");
    const size = image.getSize();
    return { png: image.toPNG(), width: size.width, height: size.height };
});

ipcMain.handle("screenshot:save", async (_event, request: { png: Uint8Array; name?: string; directory?: string }) => {
    const png = Buffer.from(request.png);
    if (!isPng(png)) throw new Error("截屏数据不是 PNG");
    const dir = path.resolve(request.directory ?? path.join(app.getPath("pictures"), "Screenshots"));
    mkdirSync(dir, { recursive: true });
    const file = uniqueScreenshotPath(dir, screenshotName(request.name) ?? screenshotFileName());
    writeFileSync(file, png);
    return { path: file, uri: url.pathToFileURL(file).href };
});

if (runAsDesktop) {
    dev = false;
}
