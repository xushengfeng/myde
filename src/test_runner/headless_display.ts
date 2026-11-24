import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findExecutable, sleepSync } from "./process_utils";

export type HeadlessDisplay = {
    /** 形如 `:3`，只给 Electron 主进程用；测试应用仍连虚拟 Wayland server */
    display: string;
    stop: () => void;
};

/** 进程退出时也要兜底清理：测试失败/worker 被回收时不一定走 runner 的 cleanup。 */
const activeStops = new Set<() => void>();
process.once("exit", () => {
    for (const stop of [...activeStops]) stop();
});

let fallbackWarned = false;

function warnFallback(reason: string) {
    if (fallbackWarned) return;
    fallbackWarned = true;
    console.warn(`[test] ${reason}，退回 Electron headless ozone；dmabuf/shared texture 测试需要 GPU，可能失败`);
}

/**
 * 启一个私有的无头显示：weston headless 后端 + 它内部的 Xwayland。
 *
 * - 输出没有窗口，不会出现在宿主桌面上；不读宿主 DISPLAY/WAYLAND_DISPLAY，
 *   所以同时开几个桌面实现也不会接错。
 * - 走 X11 是为了拿到 GPU：headless ozone 在当前 Electron 上无法初始化 GPU
 *   （dmabuf/shared texture 相关测试会整帧丢失），而 Xwayland 的 GL 直通渲染节点。
 * - 装不了 weston/Xwayland 时返回 undefined，调用方退回 headless ozone。
 */
export function startHeadlessDisplay(): HeadlessDisplay | undefined {
    if (process.platform !== "linux") return undefined;
    const weston = findExecutable("weston");
    const xwayland = findExecutable("Xwayland");
    if (!weston || !xwayland) {
        warnFallback("未找到 weston/Xwayland");
        return undefined;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myde-test-display-"));
    fs.chmodSync(dir, 0o700);
    const configPath = path.join(dir, "weston.ini");
    fs.writeFileSync(
        configPath,
        `[core]
backend=headless-backend.so
renderer=gl
xwayland=true
[output]
name=headless
mode=1920x1080
`,
    );
    const logPath = path.join(dir, "weston.log");
    const logFd = fs.openSync(logPath, "w");
    const proc = child_process.spawn(
        weston,
        [`--config=${configPath}`, "--socket=myde-test-headless", "--width=1920", "--height=1080"],
        {
            stdio: ["ignore", "ignore", logFd],
            env: { ...process.env, XDG_RUNTIME_DIR: dir, DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
        },
    );
    fs.closeSync(logFd);

    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        activeStops.delete(stop);
        try {
            proc.kill("SIGTERM");
        } catch {}
        // weston 正常收到 SIGTERM 会自己清理 Xwayland socket。这里必须同步等：
        // vitest worker 可能在 cleanup 之后立刻退出，unref 的定时器不会执行，
        // weston 就会以 PPID 1 残留。
        sleepSync(120);
        try {
            proc.kill("SIGKILL");
        } catch {}
        fs.rmSync(dir, { recursive: true, force: true });
    };
    activeStops.add(stop);
    proc.on("exit", () => {
        activeStops.delete(stop);
        if (!stopped) {
            stopped = true;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    // weston 把 Xwayland 实际占用的编号打进日志；等它出现再让 Electron 连接
    const deadline = Date.now() + 10000;
    let display: string | undefined;
    while (Date.now() < deadline) {
        try {
            display = /xserver listening on display (:\d+)/.exec(fs.readFileSync(logPath, "utf8"))?.[1];
        } catch {}
        if (display) break;
        // 事件循环被同步等待占住，看不到 exit 事件；用 /proc 判断 weston 是否已经失败
        if (!fs.existsSync(`/proc/${proc.pid}`)) break;
        sleepSync(50);
    }
    if (!display) {
        stop();
        warnFallback("weston headless 启动失败");
        return undefined;
    }
    const socketPath = `/tmp/.X11-unix/X${display.slice(1)}`;
    for (let i = 0; i < 100 && !fs.existsSync(socketPath); i++) sleepSync(50);
    if (!fs.existsSync(socketPath)) {
        stop();
        warnFallback(`Xwayland socket ${socketPath} 没有出现`);
        return undefined;
    }
    return { display, stop };
}
