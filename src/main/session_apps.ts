import { type ChildProcess, spawn } from "node:child_process";
import { AppOutputLog, formatLogTime, getAppLogPath, pruneAppLogs, RotatingLogFile } from "../utils/log";
import type { SpawnAppRequest } from "./session_ipc";

export type SessionAppHooks = {
    started?: (pid: number | undefined) => void;
    error?: (message: string) => void;
    exit?: (code: number | null, signal: string | null) => void;
};

/**
 * 在 session helper 里启动应用。
 *
 * 应用继承 helper 的 cgroup：helper 留在登录会话里，应用和它派生的子进程（终端里
 * 敲的 systemctl 等）因此属于该会话，polkit 的会话级 agent 才能接住它们的认证。
 * stdout/stderr 仍然照旧写入应用日志。
 */
export function spawnSessionApp(req: SpawnAppRequest, hooks: SessionAppHooks): ChildProcess {
    const startedAt = Date.now();
    const subprocess = spawn(req.exec, req.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: req.env,
        cwd: req.cwd,
        uid: req.uid,
        gid: req.gid,
    });

    pruneAppLogs();
    const appLog = new RotatingLogFile(getAppLogPath(req.exec, subprocess.pid ?? 0), 10 * 1024 * 1024, 2);
    appLog.write(`${formatLogTime()} [myde] started: ${req.exec}${req.args.length ? ` ${req.args.join(" ")}` : ""}\n`);

    const outLog = new AppOutputLog(appLog, "out");
    const errLog = new AppOutputLog(appLog, "err");
    subprocess.stdout?.on("data", (data: Buffer) => outLog.push(data));
    subprocess.stderr?.on("data", (data: Buffer) => errLog.push(data));

    let finished = false;
    const finish = (summary: string) => {
        if (finished) return;
        finished = true;
        outLog.flush();
        errLog.flush();
        appLog.write(`${formatLogTime()} [myde] ${summary}\n`);
        appLog.close();
    };
    let exited = false;
    subprocess.on("exit", (code, signal) => {
        exited = true;
        hooks.exit?.(code, signal);
    });
    subprocess.on("close", (code, signal) => {
        finish(`exited: code=${code} signal=${signal} duration=${Date.now() - startedAt}ms`);
        // 启动失败时没有 exit 事件，用 close 兜底
        if (!exited) hooks.exit?.(code, signal);
    });
    subprocess.on("error", (error) => {
        finish(`spawn error: ${String((error as Error)?.stack ?? error)}`);
        hooks.error?.(String((error as Error)?.message ?? error));
    });

    console.log(`Running application: ${req.exec} (pid ${subprocess.pid}, logs: ${appLog.filePath})`);
    hooks.started?.(subprocess.pid);

    return subprocess;
}
