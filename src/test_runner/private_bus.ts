import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findExecutable, sleepSync } from "./process_utils";

export type PrivateBus = {
    address: string;
    stop: () => void;
};

/** 进程退出时兜底清理，避免 worker 直接退出留下 dbus-daemon。 */
const activeStops = new Set<() => void>();
process.once("exit", () => {
    for (const stop of [...activeStops]) stop();
});

/**
 * 每个测试实例一条私有 session bus。
 *
 * 桌面实现会在 init 时注册通知/托盘 watcher 等名字；跑在宿主 session bus 上
 * 会影响正在使用的桌面。私有 bus 里这些服务只存在于测试进程，应用和桌面的
 * 会话服务也相互隔离。
 *
 * 测试自己创建了总线（DBusTestEnv / 内部 portal）时不使用它，见 createTestEnv。
 * 没有 dbus-daemon 时返回 undefined，调用方沿用现有环境。
 */
let warned = false;

export function startPrivateBus(): PrivateBus | undefined {
    const dbusDaemon = findExecutable("dbus-daemon");
    if (!dbusDaemon) {
        if (!warned) {
            warned = true;
            console.warn("[test] 未找到 dbus-daemon，桌面测试沿用宿主 session bus");
        }
        return undefined;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myde-test-bus-"));
    fs.chmodSync(dir, 0o700);
    const socketPath = path.join(dir, "bus");
    const address = `unix:path=${socketPath}`;
    const proc = child_process.spawn(dbusDaemon, ["--session", `--address=${address}`, "--nofork", "--nopidfile"], {
        stdio: "ignore",
        env: { ...process.env, XDG_RUNTIME_DIR: dir },
    });

    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        activeStops.delete(stop);
        try {
            proc.kill("SIGTERM");
        } catch {}
        // 同步收尾：worker 退出时 unref 定时器不会执行
        sleepSync(60);
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

    for (let i = 0; i < 100 && !fs.existsSync(socketPath); i++) {
        if (!fs.existsSync(`/proc/${proc.pid}`)) break;
        sleepSync(20);
    }
    if (!fs.existsSync(socketPath)) {
        stop();
        return undefined;
    }
    return { address, stop };
}
