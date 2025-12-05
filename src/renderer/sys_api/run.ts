const child_process = require("node:child_process") as typeof import("node:child_process");

import { WaylandServer } from "../view/view";
import { getEnv } from "./env";

export function server(op?: { dev?: boolean }) {
    const env = getEnv();
    const server = new WaylandServer({ socketDir: env.XDG_RUNTIME_DIR || "/tmp" });
    return {
        runApp: (exec: string, xServerNum?: number) => {
            const execParts = exec.trim().split(" ");
            return runApp(execParts[0], {
                args: execParts.slice(1),
                deEnv: {
                    HOME: env.HOME,
                    LANG: env.LANG,
                    LANGUAGE: env.LANGUAGE,
                    ...(op?.dev ? { WAYLAND_DEBUG: "1" } : {}),
                },
                server: { socketDir: server.socketDir, socketName: server.socketName },
                xServerNum,
            });
        },
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
        };
        server: {
            socketDir: string;
            socketName: string;
        };
        xServerNum?: number;
    },
) {
    console.log(`Running application: ${execPath}`);

    const subprocess = child_process.spawn(execPath, op.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            HOME: op.deEnv.HOME,
            LANG: op.deEnv.LANG || "en_US.UTF-8",
            LANGUAGE: op.deEnv.LANGUAGE || "en_US:en",
            XDG_SESSION_TYPE: "wayland",
            XDG_RUNTIME_DIR: op.server.socketDir,
            WAYLAND_DISPLAY: op.server.socketName,
            WAYLAND_DEBUG: op.deEnv.WAYLAND_DEBUG || "",
            ...(Number.isNaN(op.xServerNum) ? {} : { DISPLAY: `:${op.xServerNum}` }),
        },
        cwd: op.deEnv.HOME,
    });

    return subprocess;
}
