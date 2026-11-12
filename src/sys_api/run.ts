const child_process = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

import type { renderTools } from "../wayland";
import { createServer } from "../wayland";
import { getEnv } from "./env";

function findExecutable(name: string, pathEnv: string | undefined): string | undefined {
    if (name.includes("/")) return fs.existsSync(name) ? name : undefined;
    const searchPath = pathEnv || "/usr/local/bin:/usr/bin:/bin";
    for (const dir of searchPath.split(":")) {
        if (!dir) continue;
        const full = path.join(dir, name);
        if (fs.existsSync(full)) return full;
    }
    return undefined;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 只有真正拿到合法 display 时才向应用传 DISPLAY。 */
function hasDisplayNumber(n: number | undefined): n is number {
    return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/** LANGUAGE 缺省时从 LANG 推导（zh_CN.UTF-8@variant → zh_CN）；C/POSIX 等没有语言信息时返回 undefined。 */
function languageFromLang(lang: string | undefined): string | undefined {
    return lang?.match(/^([a-zA-Z]{2,3}(?:_[a-zA-Z0-9]+)?)(?:[.@]|$)/)?.[1];
}

async function waitForXSocket(display: number, child: import("node:child_process").ChildProcess, timeout: number) {
    const socketPath = `/tmp/.X11-unix/X${display}`;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (fs.existsSync(socketPath)) return true;
        if (child.exitCode !== null) return false;
        await sleep(50);
    }
    return fs.existsSync(socketPath);
}

export function server(op: { dev?: boolean; render: renderTools }) {
    const env = getEnv();
    const server = createServer({ render: op.render, socketDir: env.XDG_RUNTIME_DIR || "/tmp" });
    const user = env.USER || "root";
    const uid = child_process.execSync(`id -u ${user}`).toString().trim();
    const gid = child_process.execSync(`id -g ${user}`).toString().trim();

    let xwaylandDisplay: number | undefined;
    let xwaylandChild: import("node:child_process").ChildProcess | undefined;
    let xwaylandTask: Promise<number | undefined> | undefined;
    let xwaylandWarned = false;

    const deEnv = {
        HOME: env.HOME,
        LANG: env.LANG,
        LANGUAGE: env.LANGUAGE,
        PATH: env.PATH,
        DBUS_SESSION_BUS_ADDRESS: env.MYDE_INTERNAL_BUS_ADDRESS || env.DBUS_SESSION_BUS_ADDRESS,
        XDG_CURRENT_DESKTOP: env.XDG_CURRENT_DESKTOP || "MyDE",
        ...(op?.dev ? { WAYLAND_DEBUG: "1" } : {}),
    };

    const spawnAppParts = (
        execPath: string,
        args: string[],
        xServerNum?: number,
        deEnvOverride: typeof deEnv = deEnv,
    ) => {
        return runApp(execPath, {
            args,
            deEnv: deEnvOverride,
            server: { socketDir: server.socketDir, socketName: server.socketName },
            xServerNum,
            user: {
                uid: Number.isNaN(Number(uid)) ? undefined : Number(uid),
                gid: Number.isNaN(Number(gid)) ? undefined : Number(gid),
            },
        });
    };

    const spawnApp = (exec: string, xServerNum?: number) => {
        const execParts = exec.trim().split(" ");
        return spawnAppParts(execParts[0], execParts.slice(1), xServerNum);
    };

    const startXwayland = () => {
        if (xwaylandDisplay !== undefined) return Promise.resolve(xwaylandDisplay);
        if (xwaylandTask) return xwaylandTask;

        xwaylandTask = (async () => {
            try {
                const satelliteName = env.MYDE_XWAYLAND_SATELLITE || "xwayland-satellite";
                const satellite = findExecutable(satelliteName, env.PATH);
                if (!satellite) {
                    if (!xwaylandWarned) {
                        xwaylandWarned = true;
                        console.warn(`[xwayland] 未找到 ${satelliteName}；X11 应用将不可用`);
                    }
                    return undefined;
                }
                if (!findExecutable("Xwayland", env.PATH)) {
                    console.warn("[xwayland] PATH 中未找到 Xwayland，仍尝试启动 xwayland-satellite");
                }

                // 连续失败通常不是 display 被占用，而是 satellite/Xwayland 本身起不来，试几个就停。
                for (let attempt = 0; attempt < 3; attempt++) {
                    let display = -1;
                    for (let i = 0; i < 100; i++) {
                        if (!fs.existsSync(`/tmp/.X11-unix/X${i}`) && !fs.existsSync(`/tmp/.X${i}-lock`)) {
                            display = i;
                            break;
                        }
                    }
                    if (display === -1) break;

                    const child = spawnAppParts(satellite, [`:${display}`], undefined, { ...deEnv, WAYLAND_DEBUG: "" });
                    xwaylandChild = child;
                    child.stdout?.on("data", (data) => console.log("[xwayland-satellite]", data.toString().trim()));
                    child.stderr?.on("data", (data) => console.warn("[xwayland-satellite]", data.toString().trim()));
                    child.once("exit", (code) => {
                        if (xwaylandChild === child) {
                            xwaylandChild = undefined;
                            xwaylandDisplay = undefined;
                            xwaylandTask = undefined;
                        }
                        if (code !== null && code !== 0) console.warn(`[xwayland] xwayland-satellite 退出: ${code}`);
                    });

                    const ok = await waitForXSocket(display, child, 5000);
                    if (ok && child.exitCode === null) {
                        xwaylandDisplay = display;
                        console.log(`[xwayland] 已启动，DISPLAY=:${display}`);
                        return display;
                    }
                    child.kill();
                    if (xwaylandChild === child) xwaylandChild = undefined;
                }
                console.warn("[xwayland] 启动失败，X11 应用将不可用");
                return undefined;
            } catch (e) {
                console.warn("[xwayland] 启动异常:", e);
                return undefined;
            } finally {
                if (xwaylandDisplay === undefined) xwaylandTask = undefined;
            }
        })();
        return xwaylandTask;
    };

    const stopXwayland = () => {
        xwaylandChild?.kill();
        xwaylandChild = undefined;
        xwaylandDisplay = undefined;
        xwaylandTask = undefined;
    };

    return {
        runApp: (exec: string, xServerNum?: number) =>
            spawnApp(exec, hasDisplayNumber(xServerNum) ? xServerNum : xwaylandDisplay),
        startXwayland,
        stopXwayland,
        server,
    };
}

export function runApp(
    execPath: string,
    op: {
        args: string[];
        deEnv: {
            HOME: string;
            LANG?: string;
            LANGUAGE?: string;
            WAYLAND_DEBUG?: string;
            PATH?: string;
            DBUS_SESSION_BUS_ADDRESS?: string;
            XDG_CURRENT_DESKTOP?: string;
        };
        server: {
            socketDir: string;
            socketName: string;
        };
        xServerNum?: number;
        user?: { uid?: number; gid?: number };
    },
) {
    console.log(`Running application: ${execPath}`);

    const lang = op.deEnv.LANG || "en_US.UTF-8";
    const language = op.deEnv.LANGUAGE || languageFromLang(lang);

    const subprocess = child_process.spawn(execPath, op.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            HOME: op.deEnv.HOME,
            PATH: op.deEnv.PATH || "/usr/local/bin:/usr/bin:/bin",
            LANG: lang,
            ...(language ? { LANGUAGE: language } : {}),
            XDG_SESSION_TYPE: "wayland",
            XDG_RUNTIME_DIR: op.server.socketDir,
            XDG_CURRENT_DESKTOP: op.deEnv.XDG_CURRENT_DESKTOP || "MyDE",
            XDG_SESSION_DESKTOP: "MyDE",
            DBUS_SESSION_BUS_ADDRESS: op.deEnv.DBUS_SESSION_BUS_ADDRESS || `unix:path=${op.server.socketDir}/bus`,
            WAYLAND_DISPLAY: op.server.socketName,
            WAYLAND_DEBUG: op.deEnv.WAYLAND_DEBUG || "",
            ...(hasDisplayNumber(op.xServerNum) ? { DISPLAY: `:${op.xServerNum}` } : {}),
        },
        cwd: op.deEnv.HOME,
        uid: op.user?.uid,
        gid: op.user?.gid,
    });

    return subprocess;
}
