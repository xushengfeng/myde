import * as fs from "node:fs";
import * as path from "node:path";

export function findExecutable(name: string): string | undefined {
    for (const dir of (process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(":")) {
        if (!dir) continue;
        const full = path.join(dir, name);
        if (fs.existsSync(full)) return full;
    }
    return undefined;
}

/** 同步等待，不推进事件循环：同步 API 里等外部进程只能用这个。 */
export function sleepSync(ms: number) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
