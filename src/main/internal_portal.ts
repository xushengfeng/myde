import { uniqueSocketPath } from "../socket-name";

const child_process = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const PORTAL_FILE = `[portal]
DBusName=org.freedesktop.impl.portal.desktop.myde
Interfaces=org.freedesktop.impl.portal.FileChooser;
UseIn=MyDE
`;

const PORTAL_CONF = `[preferred]
org.freedesktop.impl.portal.FileChooser=myde;
`;

export interface InternalPortalHandle {
    busAddress: string;
    stop(): void;
}

export interface InternalPortalOptions {
    /** MyDE 的 userData 目录；portal 配置写在这里，不碰系统配置 */
    userDataDir: string;
    /** 私有 dbus socket 所在目录，通常 XDG_RUNTIME_DIR */
    runtimeDir: string;
}

let current: InternalPortalHandle | undefined;

/**
 * 启动 MyDE 私有 session bus + xdg-desktop-portal。
 *
 * 只影响通过 MSysApi.server().runApp() 启动的应用：它们会拿到私有
 * DBUS_SESSION_BUS_ADDRESS，从而使用 MyDE 的 portal 后端；宿主的
 * org.freedesktop.portal.Desktop 和用户配置不会被修改。
 */
export async function startInternalPortal(opts: InternalPortalOptions): Promise<InternalPortalHandle> {
    stopInternalPortal();

    const socketPath = uniqueSocketPath(opts.runtimeDir, "myde-internal-bus");
    const busAddress = `unix:path=${socketPath}`;
    fs.rmSync(socketPath, { force: true });

    const portalDirs = writePortalConfig(opts.userDataDir);
    const bus = child_process.spawn(
        process.env.MYDE_DBUS_DAEMON || "dbus-daemon",
        ["--session", `--address=${busAddress}`, "--nofork", "--print-address=1"],
        {
            stdio: ["ignore", "pipe", "pipe"],
            // 让总线上被激活的 Documents/PermissionStore 也使用隔离的数据目录
            env: {
                ...process.env,
                XDG_CONFIG_HOME: portalDirs.configHome,
                XDG_DATA_HOME: portalDirs.dataHome,
                XDG_CACHE_HOME: portalDirs.cacheHome,
            },
        },
    );
    await waitForBus(bus, socketPath);
    bus.stderr?.on("data", (data) => console.warn("[portal] dbus-daemon:", data.toString().trim()));
    bus.once("exit", (code) => {
        if (code !== null && code !== 0) console.warn(`[portal] dbus-daemon 退出: ${code}`);
    });

    let portal: import("node:child_process").ChildProcess | undefined;
    try {
        portal = await startPortalFrontend({
            busAddress,
            runtimeDir: opts.runtimeDir,
            ...portalDirs,
        });
    } catch (e) {
        bus.kill();
        fs.rmSync(socketPath, { force: true });
        throw e;
    }
    if (!portal) {
        bus.kill();
        fs.rmSync(socketPath, { force: true });
        throw new Error("找不到可用的 xdg-desktop-portal；可用 MYDE_XDG_DESKTOP_PORTAL 指定路径");
    }

    process.env.MYDE_INTERNAL_BUS_ADDRESS = busAddress;

    const handle: InternalPortalHandle = {
        busAddress,
        stop() {
            portal?.kill();
            bus.kill();
            fs.rmSync(socketPath, { force: true });
        },
    };
    current = handle;
    return handle;
}

export function stopInternalPortal(): void {
    current?.stop();
    current = undefined;
    delete process.env.MYDE_INTERNAL_BUS_ADDRESS;
}

function waitForBus(child: import("node:child_process").ChildProcess, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            if (error) reject(error);
            else resolve();
        };
        timer = setTimeout(() => {
            child.kill();
            finish(new Error("dbus-daemon 启动超时"));
        }, 5000);

        child.stdout?.on("data", (data) => {
            if (String(data).includes("unix:path=")) finish();
        });
        child.once("error", (e) => finish(e));
        child.once("exit", (code) => {
            if (done) return;
            if (code === 0 && fs.existsSync(socketPath)) finish();
            else finish(new Error(`dbus-daemon 启动失败，退出码 ${code}`));
        });
    });
}

function writePortalConfig(userDataDir: string): {
    portalsDir: string;
    configHome: string;
    dataHome: string;
    cacheHome: string;
} {
    const root = path.join(userDataDir, "portal");
    const portalsDir = path.join(root, "portals");
    const configHome = path.join(root, "config");
    const configDir = path.join(configHome, "xdg-desktop-portal");
    const dataHome = path.join(root, "data");
    const cacheHome = path.join(root, "cache");
    fs.mkdirSync(portalsDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataHome, { recursive: true });
    fs.mkdirSync(cacheHome, { recursive: true });
    fs.writeFileSync(path.join(portalsDir, "myde.portal"), PORTAL_FILE);
    fs.writeFileSync(path.join(configDir, "myde-portals.conf"), PORTAL_CONF);
    // 桌面名匹配不到时也保证读到配置，避免退化为 .portal 的 UseIn
    fs.writeFileSync(path.join(configDir, "portals.conf"), PORTAL_CONF);
    return { portalsDir, configHome, dataHome, cacheHome };
}

function findPortalBinary(): string | undefined {
    const explicit = process.env.MYDE_XDG_DESKTOP_PORTAL;
    if (explicit) return explicit;
    const candidates = [
        "/usr/lib/xdg-desktop-portal",
        "/usr/libexec/xdg-desktop-portal",
        "/usr/bin/xdg-desktop-portal",
        "xdg-desktop-portal",
    ];
    for (const candidate of candidates) {
        if (!path.isAbsolute(candidate) || fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

function startPortalFrontend(op: {
    busAddress: string;
    runtimeDir: string;
    portalsDir: string;
    configHome: string;
    dataHome: string;
    cacheHome: string;
}): Promise<import("node:child_process").ChildProcess | undefined> {
    const bin = findPortalBinary();
    if (!bin) return Promise.resolve(undefined);

    return new Promise((resolve) => {
        const child = child_process.spawn(bin, [], {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                DBUS_SESSION_BUS_ADDRESS: op.busAddress,
                XDG_RUNTIME_DIR: op.runtimeDir,
                XDG_CURRENT_DESKTOP: "MyDE",
                XDG_SESSION_DESKTOP: "MyDE",
                // portal 只看到 MyDE 自己生成的配置，不读宿主的 portal 配置
                XDG_DESKTOP_PORTAL_DIR: op.portalsDir,
                XDG_CONFIG_HOME: op.configHome,
                XDG_DATA_HOME: op.dataHome,
                XDG_CACHE_HOME: op.cacheHome,
            },
        });
        let spawned = false;
        child.once("spawn", () => {
            spawned = true;
            console.log(`[portal] 内部 xdg-desktop-portal 已启动: ${bin}`);
            resolve(child);
        });
        child.once("error", (e) => {
            if (!spawned) {
                console.warn(`[portal] 无法启动 ${bin}:`, e);
                resolve(undefined);
            }
        });
        child.stderr?.on("data", (data) => console.warn("[portal] xdg-desktop-portal:", data.toString().trim()));
        child.stdout?.on("data", (data) => console.log("[portal] xdg-desktop-portal:", data.toString().trim()));
        child.once("exit", (code) => {
            if (code !== null && code !== 0) console.warn(`[portal] xdg-desktop-portal 退出: ${code}`);
        });
    });
}
