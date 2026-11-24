import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { getAppLogPath } from "../../utils/log";
import { spawnSessionApp } from "../session_apps";

let previousStateHome: string | undefined;

afterEach(() => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    previousStateHome = undefined;
});

/** helper 代启动：进程真的跑起来，输出照旧进应用日志 */
it("spawns an app and writes its output to the app log", async () => {
    previousStateHome = process.env.XDG_STATE_HOME;
    const stateHome = mkdtempSync(path.join(os.tmpdir(), "myde-session-app-"));
    process.env.XDG_STATE_HOME = stateHome;

    let pid: number | undefined;
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        spawnSessionApp(
            {
                exec: "/bin/sh",
                args: ["-c", "echo hello; echo oops >&2; exit 3"],
                env: { PATH: "/usr/bin:/bin", HOME: stateHome },
                cwd: stateHome,
            },
            {
                started: (value) => {
                    pid = value;
                },
                exit: (code, signal) => resolve({ code, signal }),
            },
        );
    });

    await expect(exit).resolves.toEqual({ code: 3, signal: null });
    expect(pid).toBeGreaterThan(0);

    // 日志是追加写，等 flush 落地
    await new Promise((resolve) => setTimeout(resolve, 100));
    const log = readFileSync(getAppLogPath("/bin/sh", pid ?? 0), "utf8");
    expect(log).toContain("started: /bin/sh -c echo hello");
    expect(log).toContain("[out] hello");
    expect(log).toContain("[err] oops");
    expect(log).toContain("exited: code=3");
});
