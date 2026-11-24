/**
 * myde 日志文件。
 *
 * 原生模式（myde-wrap 全屏）下 stdout 落在被 DRM 占用的 TTY 上，屏幕上看不到；
 * 因此主进程日志和桌面启动的应用输出都同时写文件，便于事后排查。
 *
 * 目录：`$XDG_STATE_HOME/myde/logs`（默认 `~/.local/state/myde/logs`）
 * - `myde.log`：主进程日志（含渲染进程 console 转发）
 * - `apps/<可执行名>-<pid>.log`：桌面启动的应用输出（stdout/stderr，带时间与来源）
 */
const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");

export function getLogDir() {
    const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
    return path.join(base, "myde", "logs");
}

export function getAppLogDir() {
    return path.join(getLogDir(), "apps");
}

/** 本地时间 `YYYY-MM-DD HH:mm:ss.SSS`，便于和终端/应用日志对齐 */
export function formatLogTime(date = new Date()) {
    const p = (n: number, length = 2) => String(n).padStart(length, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`;
}

/** 应用日志文件名；可执行路径里的非法字符替换掉 */
export function getAppLogPath(execPath: string, pid: number) {
    const name = path.basename(execPath).replace(/[^\w.-]+/g, "_") || "app";
    return path.join(getAppLogDir(), `${name}-${pid}.log`);
}

/** 只保留最近的若干份应用日志，避免长期运行后堆积 */
export function pruneAppLogs(keep = 50) {
    try {
        const dir = getAppLogDir();
        const entries = fs
            .readdirSync(dir)
            .map((name) => {
                const filePath = path.join(dir, name);
                try {
                    return { filePath, mtime: fs.statSync(filePath).mtimeMs };
                } catch {
                    return undefined;
                }
            })
            .filter((entry): entry is { filePath: string; mtime: number } => entry !== undefined)
            .sort((a, b) => b.mtime - a.mtime);
        for (const entry of entries.slice(keep)) {
            try {
                fs.unlinkSync(entry.filePath);
            } catch {
                /* 正在被删除或被占用，忽略 */
            }
        }
    } catch {
        /* 没有目录/无权限时不影响桌面 */
    }
}

/** 把应用输出按行加时间戳和来源写入日志；分不清 stdout/stderr 时很难定位问题 */
export class AppOutputLog {
    private pending = "";
    constructor(
        private readonly file: RotatingLogFile,
        private readonly tag: "out" | "err",
    ) {}

    push(chunk: Buffer) {
        const text = this.pending + chunk.toString("utf8");
        const lines = text.split("\n");
        this.pending = lines.pop() ?? "";
        for (const line of lines) this.writeLine(line);
        // 没有换行的超长输出（如进度条）不能无限攒在内存里
        if (this.pending.length > 64 * 1024) {
            this.writeLine(this.pending);
            this.pending = "";
        }
    }

    flush() {
        if (this.pending) this.writeLine(this.pending);
        this.pending = "";
    }

    private writeLine(line: string) {
        this.file.write(`${formatLogTime()} [${this.tag}] ${line.replace(/\r$/, "")}\n`);
    }
}

/**
 * 追加写日志文件，超过上限就轮转：`name` → `name.1` → `name.2` …
 * 所有失败都吞掉：日志问题不能反过来影响桌面。
 */
export class RotatingLogFile {
    private stream: import("node:fs").WriteStream | undefined;
    private size = 0;

    constructor(
        readonly filePath: string,
        private readonly maxBytes = 10 * 1024 * 1024,
        private readonly keep = 3,
    ) {}

    write(chunk: string | Buffer) {
        try {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            this.stream ??= this.open();
            if (this.size + data.length > this.maxBytes) this.rotate();
            this.stream.write(data);
            this.size += data.length;
        } catch {
            /* 忽略日志写入失败 */
        }
    }

    close() {
        this.stream?.end();
        this.stream = undefined;
    }

    private open() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        // fd 必须同步打开：轮转紧接着就 rename，异步打开会让同步连续写入时
        // 文件还没创建，rename 落空（批量输出时尤其明显）
        const fd = fs.openSync(this.filePath, "a");
        this.size = fs.fstatSync(fd).size;
        const stream = fs.createWriteStream(this.filePath, { fd });
        // 磁盘满/权限变化会触发 error；未监听会变成未捕获异常
        stream.on("error", () => {
            if (this.stream === stream) this.stream = undefined;
        });
        return stream;
    }

    private rotate() {
        const old = this.stream;
        old?.end();
        for (let i = this.keep; i >= 1; i--) {
            const from = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
            try {
                fs.renameSync(from, `${this.filePath}.${i}`);
            } catch {
                /* 上一份不存在 */
            }
        }
        this.size = 0;
        this.stream = this.open();
    }
}
