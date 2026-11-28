const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
const { execFile } = require("node:child_process") as typeof import("node:child_process");
const os = require("node:os") as typeof import("node:os");

const PROC = "/proc";
const DEFAULT_PAGE_SIZE = 4096;
/** Linux 的 USER_HZ 在常见架构上都是 100，getconf 不可用时按它兜底 */
const DEFAULT_CLOCK_TICKS = 100;

export type Item = {
    pid: number;
    ppid: number;
    /** memory usage in bytes */
    memoryUsage: number;
    name: string;
    children: Item[];
};

export type ProcessState =
    | "running"
    | "sleeping"
    | "disk-sleep"
    | "stopped"
    | "tracing-stop"
    | "zombie"
    | "dead"
    | "idle"
    | "parked"
    | "unknown";

export type ProcessInfo = {
    pid: number;
    ppid: number;
    /** /proc/PID/stat 的 starttime，自启动以来的时钟 tick，用来识别 PID 复用 */
    startTime: number;
    uid: number;
    /** /proc/PID/stat 的 comm，可能被内核截断 */
    name: string;
    state: ProcessState;
    /** CPU 使用率；可能超过 100（多线程），首次采样为 null */
    cpu: number | null;
    /** 累计 CPU 时间，毫秒 */
    cpuTime: number;
    /** RSS，字节 */
    memory: number;
    /** nice 值 -20..19 */
    nice: number;
    /** 线程数 */
    threads: number;
};

export type CpuBreakdown = {
    user: number;
    nice: number;
    system: number;
    idle: number;
    iowait: number;
    irq: number;
    softirq: number;
    steal: number;
};

export type CpuInfo = {
    /** 总体使用率 0..100；第一次采样为 null */
    usage: number | null;
    /** 每个逻辑 CPU 的使用率；第一次采样为 null */
    perCpu: (number | null)[];
    /** 1/5/15 分钟平均负载 */
    load: [number, number, number];
    /** 两次采样之间的时间占比；第一次采样为 null */
    breakdown: CpuBreakdown | null;
};

export type CpuCoreType = "performance" | "efficiency" | "low-power-efficiency" | "unknown";

export type CpuCoreInfo = {
    /** 物理核 ID；无法读取时为 -1 */
    id: number;
    packageId: number;
    type: CpuCoreType;
    /** 调度器容量，0..1024 */
    capacity?: number;
    /** 最大频率，MHz */
    maxFreq?: number;
    /** 该物理核的逻辑 CPU（SMT 兄弟） */
    siblings: number[];
    /** 该核至少有一个逻辑 CPU 在线 */
    online: boolean;
};

export type CpuTopology = {
    /** CPU 型号名，如 Intel(R) Core(TM) Ultra X7 358H */
    model: string;
    /** 是否存在性能核/能效核的区分 */
    hybrid: boolean;
    /** 以下集合只包含在线逻辑 CPU，可直接用于亲和度 */
    performance: number[];
    efficiency: number[];
    lowPowerEfficiency: number[];
    unknown: number[];
    cores: CpuCoreInfo[];
};

export type MemoryInfo = {
    /** 字节 */
    total: number;
    free: number;
    available: number;
    /** MemTotal - MemAvailable，字节 */
    used: number;
    buffers: number;
    /** Cached + SReclaimable，字节 */
    cached: number;
    swapTotal: number;
    swapFree: number;
    swapUsed: number;
};

export type SystemSnapshot = {
    /** 毫秒时间戳 */
    time: number;
    /** 秒 */
    uptime: number;
    cpu: CpuInfo;
    memory: MemoryInfo;
    /** 所有进程的扁平列表，用 ppid 建树 */
    processes: ProcessInfo[];
};

export type ProcessIo = {
    readBytes: number;
    writeBytes: number;
    readChars: number;
    writeChars: number;
    readSyscalls: number;
    writeSyscalls: number;
};

export type ProcessDetail = {
    pid: number;
    cmdline: string[];
    /** cgroup v2 路径，如 /user.slice/... */
    cgroup: string;
    /** 允许运行的 CPU 列表，来自 /proc/PID/status 的 Cpus_allowed_list */
    affinity: number[];
    /** /proc/PID/exe，无权限或已退出时为空 */
    exe?: string;
    /** PSS，字节；仅同 uid 且进程可读时有值 */
    pss?: number;
    /** 进程 IO；仅同 uid 且可读时有值 */
    io?: ProcessIo;
};

export type WatchSystemOptions = {
    /** 采样间隔，毫秒，默认 1000，最小 100 */
    interval?: number;
    signal?: AbortSignal;
};

type RawCpuTimes = {
    user: number;
    nice: number;
    system: number;
    idle: number;
    iowait: number;
    irq: number;
    softirq: number;
    steal: number;
};

type CpuStat = {
    total: RawCpuTimes;
    perCpu: RawCpuTimes[];
};

type RawProcess = {
    pid: number;
    ppid: number;
    uid: number;
    name: string;
    state: ProcessState;
    utime: number;
    stime: number;
    nice: number;
    threads: number;
    startTime: number;
    /** RSS，页数 */
    rssPages: number;
    /** RSS，字节 */
    memory: number;
};

type CpuSample = {
    time: number;
    cpu: CpuStat;
    processes: Map<number, { ticks: number; startTime: number }>;
};

let pageSizePromise: Promise<number> | undefined;
let clockTicksPromise: Promise<number> | undefined;
let lastSample: CpuSample | undefined;

function getconf(name: string, fallback: number): Promise<number> {
    return new Promise((resolve) => {
        execFile("getconf", [name], { encoding: "utf8", timeout: 1000 }, (error, stdout) => {
            const value = Number.parseInt(stdout ?? "", 10);
            resolve(!error && Number.isFinite(value) && value > 0 ? value : fallback);
        });
    });
}

function getPageSize() {
    pageSizePromise ??= getconf("PAGESIZE", DEFAULT_PAGE_SIZE);
    return pageSizePromise;
}

function getClockTicks() {
    clockTicksPromise ??= getconf("CLK_TCK", DEFAULT_CLOCK_TICKS);
    return clockTicksPromise;
}

function emptyCpuTimes(): RawCpuTimes {
    return { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0 };
}

function parseCpuTimes(parts: string[]): RawCpuTimes {
    const value = (index: number) => {
        const parsed = Number(parts[index]);
        return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
        user: value(1),
        nice: value(2),
        system: value(3),
        idle: value(4),
        iowait: value(5),
        irq: value(6),
        softirq: value(7),
        steal: value(8),
    };
}

function sumCpuTimes(times: RawCpuTimes) {
    return times.user + times.nice + times.system + times.idle + times.iowait + times.irq + times.softirq + times.steal;
}

async function readCpuStat(): Promise<CpuStat> {
    const text = await fsp.readFile(`${PROC}/stat`, "utf8");
    let total: RawCpuTimes | undefined;
    const perCpu: RawCpuTimes[] = [];
    for (const line of text.split("\n")) {
        if (!line.startsWith("cpu")) continue;
        const parts = line.trim().split(/\s+/);
        if (parts[0] === "cpu") total = parseCpuTimes(parts);
        else if (/^cpu\d+$/.test(parts[0])) perCpu.push(parseCpuTimes(parts));
    }
    return { total: total ?? emptyCpuTimes(), perCpu };
}

async function readMemInfo(): Promise<MemoryInfo> {
    const text = await fsp.readFile(`${PROC}/meminfo`, "utf8");
    const values = new Map<string, number>();
    for (const line of text.split("\n")) {
        const match = /^([A-Za-z0-9_()]+):\s+(\d+)/.exec(line);
        if (!match) continue;
        values.set(match[1], Number(match[2]) * 1024);
    }
    const total = values.get("MemTotal") ?? 0;
    const free = values.get("MemFree") ?? 0;
    const buffers = values.get("Buffers") ?? 0;
    const cached = (values.get("Cached") ?? 0) + (values.get("SReclaimable") ?? 0);
    const available =
        values.get("MemAvailable") ??
        Math.max(0, free + buffers + (values.get("Cached") ?? 0) + (values.get("SReclaimable") ?? 0));
    const swapTotal = values.get("SwapTotal") ?? 0;
    const swapFree = values.get("SwapFree") ?? 0;
    return {
        total,
        free,
        available,
        used: Math.max(0, total - available),
        buffers,
        cached,
        swapTotal,
        swapFree,
        swapUsed: Math.max(0, swapTotal - swapFree),
    };
}

async function readLoad(): Promise<[number, number, number]> {
    const text = await fsp.readFile(`${PROC}/loadavg`, "utf8");
    const parts = text.trim().split(/\s+/);
    const value = (index: number) => {
        const parsed = Number(parts[index]);
        return Number.isFinite(parsed) ? parsed : 0;
    };
    return [value(0), value(1), value(2)];
}

async function readUptime(): Promise<number> {
    const text = await fsp.readFile(`${PROC}/uptime`, "utf8");
    const parsed = Number(text.trim().split(/\s+/)[0]);
    return Number.isFinite(parsed) ? parsed : 0;
}

function mapState(state: string): ProcessState {
    switch (state) {
        case "R":
            return "running";
        case "S":
            return "sleeping";
        case "D":
            return "disk-sleep";
        case "T":
            return "stopped";
        case "t":
            return "tracing-stop";
        case "Z":
            return "zombie";
        case "X":
        case "x":
            return "dead";
        case "I":
            return "idle";
        case "P":
            return "parked";
        default:
            return "unknown";
    }
}

function parseProcStat(pid: number, text: string): Omit<RawProcess, "uid" | "memory"> | undefined {
    const open = text.indexOf("(");
    const close = text.lastIndexOf(")");
    if (open === -1 || close <= open) return undefined;
    const name = text.slice(open + 1, close);
    const fields = text
        .slice(close + 2)
        .trim()
        .split(/\s+/);
    if (fields.length < 22) return undefined;
    const number = (index: number) => {
        const parsed = Number(fields[index]);
        return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
        pid,
        ppid: number(1),
        name,
        state: mapState(fields[0]),
        utime: number(11),
        stime: number(12),
        nice: number(16),
        threads: number(17),
        startTime: number(19),
        rssPages: Math.max(0, number(21)),
    };
}

/** 限制并发的异步映射，避免一次性打开过多 /proc 文件 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await fn(items[index]);
        }
    });
    await Promise.all(workers);
    return results;
}

async function readProcessTable(pageSize: number): Promise<RawProcess[]> {
    const entries = await fsp.readdir(PROC);
    const pids = entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number)
        .sort((a, b) => a - b);
    const results = await mapLimit(pids, 64, async (pid) => {
        const dir = `${PROC}/${pid}`;
        try {
            const [dirStat, text] = await Promise.all([fsp.stat(dir), fsp.readFile(`${dir}/stat`, "utf8")]);
            const parsed = parseProcStat(pid, text);
            if (!parsed) return undefined;
            return { ...parsed, uid: dirStat.uid, memory: parsed.rssPages * pageSize };
        } catch {
            return undefined;
        }
    });
    return results.filter((process): process is RawProcess => process !== undefined);
}

function clampPercent(value: number) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(100, Math.max(0, value));
}

function buildCpuInfo(cpu: CpuStat, previous?: CpuStat, load: [number, number, number] = [0, 0, 0]): CpuInfo {
    const deltaTotal = previous ? sumCpuTimes(cpu.total) - sumCpuTimes(previous.total) : 0;
    let breakdown: CpuBreakdown | null = null;
    let usage: number | null = null;
    if (previous && deltaTotal > 0) {
        const percent = (current: number, before: number) => ((current - before) / deltaTotal) * 100;
        breakdown = {
            user: percent(cpu.total.user, previous.total.user),
            nice: percent(cpu.total.nice, previous.total.nice),
            system: percent(cpu.total.system, previous.total.system),
            idle: percent(cpu.total.idle, previous.total.idle),
            iowait: percent(cpu.total.iowait, previous.total.iowait),
            irq: percent(cpu.total.irq, previous.total.irq),
            softirq: percent(cpu.total.softirq, previous.total.softirq),
            steal: percent(cpu.total.steal, previous.total.steal),
        };
        usage = clampPercent(100 - breakdown.idle - breakdown.iowait);
    }
    const perCpu = cpu.perCpu.map((current, index) => {
        const before = previous?.perCpu[index];
        if (!before) return null;
        const delta = sumCpuTimes(current) - sumCpuTimes(before);
        if (delta <= 0) return null;
        return clampPercent(((delta - (current.idle - before.idle) - (current.iowait - before.iowait)) / delta) * 100);
    });
    return { usage, perCpu, load, breakdown };
}

function lastCpuTotal(sample: CpuSample) {
    return sumCpuTimes(sample.cpu.total);
}

async function readSystemSnapshot(previous?: CpuSample): Promise<{ snapshot: SystemSnapshot; sample: CpuSample }> {
    const [pageSize, clockTicks] = await Promise.all([getPageSize(), getClockTicks()]);
    const [cpu, memory, load, uptime, rawProcesses] = await Promise.all([
        readCpuStat(),
        readMemInfo(),
        readLoad(),
        readUptime(),
        readProcessTable(pageSize),
    ]);
    const sample: CpuSample = {
        time: Date.now(),
        cpu,
        processes: new Map(
            rawProcesses.map((process) => [
                process.pid,
                { ticks: process.utime + process.stime, startTime: process.startTime },
            ]),
        ),
    };
    const previousTotal = previous ? lastCpuTotal(previous) : undefined;
    const deltaTotal = previousTotal === undefined ? 0 : lastCpuTotal(sample) - previousTotal;
    const cpuInfo = buildCpuInfo(cpu, previous?.cpu, load);
    const cpuCount = Math.max(1, cpu.perCpu.length || 1);
    const processes = rawProcesses.map((process): ProcessInfo => {
        const before = previous?.processes.get(process.pid);
        const ticks = process.utime + process.stime;
        const cpuPercent =
            before && before.startTime === process.startTime && deltaTotal > 0
                ? Math.max(0, ((ticks - before.ticks) / deltaTotal) * cpuCount * 100)
                : null;
        return {
            pid: process.pid,
            ppid: process.ppid,
            startTime: process.startTime,
            uid: process.uid,
            name: process.name,
            state: process.state,
            cpu: cpuPercent,
            cpuTime: (ticks * 1000) / clockTicks,
            memory: process.memory,
            nice: process.nice,
            threads: process.threads,
        };
    });
    return {
        snapshot: { time: sample.time, uptime, cpu: cpuInfo, memory, processes },
        sample,
    };
}

/**
 * 读取一次整机快照。
 *
 * CPU 使用率需要两次采样：第一次 `cpu.usage` / `perCpu` / `breakdown` 和每个进程的
 * `cpu` 都是 null，第二次才有值。进程列表是扁平的，用 `ppid` 建树。
 */
export async function getSystemSnapshot(): Promise<SystemSnapshot> {
    const { snapshot, sample } = await readSystemSnapshot(lastSample);
    lastSample = sample;
    return snapshot;
}

/**
 * 周期性采样整机快照。每个 watcher 有自己的采样基线，互不影响。
 * 返回停止函数；也可以通过 `signal` 停止。
 */
export function watchSystem(
    callback: (snapshot: SystemSnapshot) => void,
    options: WatchSystemOptions = {},
): () => void {
    const interval = Math.max(100, options.interval ?? 1000);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous: CpuSample | undefined;

    const stop = () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", stop);
    };

    const tick = async () => {
        if (stopped) return;
        try {
            const { snapshot, sample } = await readSystemSnapshot(previous);
            previous = sample;
            if (!stopped) callback(snapshot);
        } catch (error) {
            console.error("[systemMonitor] snapshot failed:", error);
        }
        if (!stopped) timer = setTimeout(tick, interval);
    };

    if (options.signal?.aborted) return stop;
    options.signal?.addEventListener("abort", stop, { once: true });
    void tick();
    return stop;
}

/**
 * 读取单个进程的补充信息：命令行、cgroup、exe；同 uid 且进程可读时还有 PSS 和 IO。
 * 进程不存在时返回 null，单项读取失败只省略对应字段。
 */
export async function getProcessDetail(pid: number): Promise<ProcessDetail | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const dir = `${PROC}/${pid}`;
    try {
        await fsp.access(`${dir}/stat`);
    } catch {
        return null;
    }

    const [cmdlineText, cgroupText, statusText, exe, pssText, ioText] = await Promise.all([
        readText(`${dir}/cmdline`),
        readText(`${dir}/cgroup`),
        readText(`${dir}/status`),
        readLink(`${dir}/exe`),
        readText(`${dir}/smaps_rollup`),
        readText(`${dir}/io`),
    ]);

    return {
        pid,
        cmdline: cmdlineText ? cmdlineText.split("\0").filter(Boolean) : [],
        cgroup: parseCgroup(cgroupText),
        affinity: parseAffinity(statusText),
        exe,
        pss: parsePss(pssText),
        io: parseIo(ioText),
    };
}

async function readText(path: string): Promise<string | undefined> {
    try {
        return await fsp.readFile(path, "utf8");
    } catch {
        return undefined;
    }
}

async function readLink(path: string): Promise<string | undefined> {
    try {
        return await fsp.readlink(path);
    } catch {
        return undefined;
    }
}

function parseCgroup(text: string | undefined): string {
    if (!text) return "";
    for (const line of text.split("\n")) {
        const index = line.indexOf("::");
        if (index >= 0) return line.slice(index + 2).trim();
    }
    return "";
}

function parseCpuList(text: string): number[] {
    const cpus: number[] = [];
    for (const part of text.trim().split(",")) {
        if (!part) continue;
        const [startText, endText] = part.split("-");
        const start = Number(startText);
        if (!Number.isInteger(start) || start < 0) continue;
        const end = endText === undefined ? start : Number(endText);
        if (!Number.isInteger(end) || end < start) continue;
        for (let cpu = start; cpu <= end; cpu++) cpus.push(cpu);
    }
    return cpus;
}

function parseAffinity(text: string | undefined): number[] {
    if (!text) return [];
    const match = /^Cpus_allowed_list:\s*(.+)$/m.exec(text);
    return match ? parseCpuList(match[1]) : [];
}

function parsePss(text: string | undefined): number | undefined {
    if (!text) return undefined;
    const match = /^Pss:\s+(\d+)\s+kB/m.exec(text);
    if (!match) return undefined;
    return Number(match[1]) * 1024;
}

function parseIo(text: string | undefined): ProcessIo | undefined {
    if (!text) return undefined;
    const values = new Map<string, number>();
    for (const line of text.split("\n")) {
        const [key, value] = line.split(":");
        if (!key || value === undefined) continue;
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) values.set(key.trim(), parsed);
    }
    return {
        readBytes: values.get("read_bytes") ?? 0,
        writeBytes: values.get("write_bytes") ?? 0,
        readChars: values.get("rchar") ?? 0,
        writeChars: values.get("wchar") ?? 0,
        readSyscalls: values.get("syscr") ?? 0,
        writeSyscalls: values.get("syscw") ?? 0,
    };
}

/** 获取进程树；pid 为 0 时从 pid 0 的根进程开始。 */
export async function getPidTree(pid = 0): Promise<Item> {
    const pageSize = await getPageSize();
    const processes = await readProcessTable(pageSize);
    const byPid = new Map(processes.map((process) => [process.pid, process]));
    const children = new Map<number, RawProcess[]>();
    for (const process of processes) {
        const list = children.get(process.ppid);
        if (list) list.push(process);
        else children.set(process.ppid, [process]);
    }
    for (const list of children.values()) list.sort((a, b) => a.pid - b.pid);

    const build = (process: RawProcess): Item => {
        return {
            pid: process.pid,
            ppid: process.ppid,
            name: process.name,
            memoryUsage: process.memory,
            children: (children.get(process.pid) ?? []).map(build),
        };
    };

    if (pid === 0) {
        return {
            pid: 0,
            ppid: 0,
            name: "root",
            memoryUsage: 0,
            children: (children.get(0) ?? []).map(build),
        };
    }
    const root = byPid.get(pid);
    if (!root) {
        return { pid, ppid: 0, name: "unknown", memoryUsage: 0, children: [] };
    }
    return build(root);
}

/** 读取进程主线程允许运行的 CPU 列表。 */
export async function getAffinity(pid: number): Promise<number[]> {
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`无效的 pid: ${pid}`);
    }
    const text = await fsp.readFile(`${PROC}/${pid}/status`, "utf8");
    const affinity = parseAffinity(text);
    if (affinity.length === 0) {
        throw new Error(`进程 ${pid} 没有 Cpus_allowed_list`);
    }
    return affinity;
}

function formatCpuList(cpus: number[]): string {
    if (!Array.isArray(cpus) || cpus.length === 0) {
        throw new Error("CPU 列表不能为空");
    }
    const sorted = [...new Set(cpus)].sort((a, b) => a - b);
    for (const cpu of sorted) {
        if (!Number.isInteger(cpu) || cpu < 0) {
            throw new Error(`无效的 CPU: ${cpu}`);
        }
    }
    const parts: string[] = [];
    let start: number | undefined;
    let previous: number | undefined;
    for (const cpu of sorted) {
        if (start === undefined || previous === undefined) {
            start = cpu;
            previous = cpu;
        } else if (cpu === previous + 1) {
            previous = cpu;
        } else {
            parts.push(start === previous ? `${start}` : `${start}-${previous}`);
            start = cpu;
            previous = cpu;
        }
    }
    if (start !== undefined && previous !== undefined) {
        parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    }
    return parts.join(",");
}

/**
 * 设置进程所有线程的 CPU 亲和度。同 uid 的进程无需特权；
 * 依赖 util-linux 的 `taskset -apc`，失败时抛出带 stderr 的错误。
 */
export async function setAffinity(pid: number, cpus: number[]): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`无效的 pid: ${pid}`);
    }
    const list = formatCpuList(cpus);
    await new Promise<void>((resolve, reject) => {
        execFile(
            "taskset",
            ["-apc", list, String(pid)],
            { encoding: "utf8", timeout: 5000 },
            (error, _stdout, stderr) => {
                if (!error) {
                    resolve();
                    return;
                }
                const code = (error as NodeJS.ErrnoException).code;
                const message =
                    code === "ENOENT" ? "找不到 taskset（util-linux）" : (stderr || "").trim() || error.message;
                reject(new Error(`设置 CPU 亲和度失败: ${message}`));
            },
        );
    });
}

type CpuRecord = {
    cpu: number;
    online: boolean;
    coreId: number;
    packageId: number;
    siblings: number[];
    capacity?: number;
    maxFreq?: number;
    cppc?: number;
};

const PMU_ROOTS = ["/sys/devices", "/sys/bus/event_source/devices"];

async function readOptionalNumber(path: string): Promise<number | undefined> {
    const text = await readText(path);
    if (!text) return undefined;
    const value = Number(text.trim());
    return Number.isFinite(value) ? value : undefined;
}

async function readCpuModel(): Promise<string> {
    const text = await readText(`${PROC}/cpuinfo`);
    if (text) {
        const values = new Map<string, string>();
        for (const line of text.split("\n")) {
            const match = /^([^:]+):\s*(.*)$/.exec(line);
            if (!match) continue;
            const key = match[1].trim().toLowerCase();
            if (key === "model name" || key === "cpu model" || key === "hardware" || key === "processor") {
                const value = match[2].trim();
                // x86 的 processor 字段是编号，不是型号
                if (value && !/^\d+$/.test(value)) values.set(key, value);
            }
        }
        for (const key of ["model name", "cpu model", "hardware", "processor"]) {
            const value = values.get(key);
            if (value) return value;
        }
    }
    return os.cpus()[0]?.model?.trim() ?? "";
}

async function readPmuCpus(name: string): Promise<number[]> {
    for (const root of PMU_ROOTS) {
        const text = await readText(`${root}/${name}/cpus`);
        if (!text) continue;
        const cpus = parseCpuList(text);
        if (cpus.length > 0) return cpus;
    }
    return [];
}

async function readOnlineCpus(): Promise<Set<number> | undefined> {
    const text = await readText("/sys/devices/system/cpu/online");
    if (!text) return undefined;
    const cpus = parseCpuList(text);
    return cpus.length > 0 ? new Set(cpus) : undefined;
}

async function readCpuRecord(cpu: number, onlineSet: Set<number> | undefined): Promise<CpuRecord> {
    const base = `/sys/devices/system/cpu/cpu${cpu}`;
    const [onlineText, coreId, packageId, siblingsText, capacity, maxFreqKHz, cppcNominal, cppcHighest] =
        await Promise.all([
            readText(`${base}/online`),
            readOptionalNumber(`${base}/topology/core_id`),
            readOptionalNumber(`${base}/topology/physical_package_id`),
            readText(`${base}/topology/thread_siblings_list`),
            readOptionalNumber(`${base}/cpu_capacity`),
            readOptionalNumber(`${base}/cpufreq/cpuinfo_max_freq`),
            readOptionalNumber(`${base}/acpi_cppc/nominal_perf`),
            readOptionalNumber(`${base}/acpi_cppc/highest_perf`),
        ]);
    const siblings = siblingsText ? parseCpuList(siblingsText) : [];
    if (siblings.length === 0) siblings.push(cpu);
    return {
        cpu,
        online: onlineSet ? onlineSet.has(cpu) : onlineText?.trim() !== "0",
        coreId: coreId ?? -1,
        packageId: packageId ?? -1,
        siblings: [...new Set(siblings)].sort((a, b) => a - b),
        capacity,
        maxFreq: maxFreqKHz === undefined ? undefined : maxFreqKHz / 1000,
        cppc: cppcNominal ?? cppcHighest,
    };
}

function classifyCpuRecords(
    records: CpuRecord[],
    metric: (record: CpuRecord) => number | undefined,
): { performance: Set<number>; efficiency: Set<number> } | undefined {
    const online = records.filter((record) => record.online);
    const values = online
        .map(metric)
        .filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
    if (values.length < 2) return undefined;
    const max = Math.max(...values);
    const min = Math.min(...values);
    // 1005/1024 这种小差异不当作 P/E 分类
    if (max <= 0 || max / min <= 1.1) return undefined;

    const performance = new Set<number>();
    const efficiency = new Set<number>();
    for (const record of online) {
        const value = metric(record);
        if (value === undefined || value <= 0) continue;
        if (value >= max * 0.9) performance.add(record.cpu);
        else efficiency.add(record.cpu);
    }
    if (performance.size === 0 || efficiency.size === 0) return undefined;
    return { performance, efficiency };
}

function classifyCpuFallback(records: CpuRecord[]) {
    for (const metric of [
        (record: CpuRecord) => record.cppc,
        (record: CpuRecord) => record.capacity,
        (record: CpuRecord) => record.maxFreq,
    ]) {
        const result = classifyCpuRecords(records, metric);
        if (result) return result;
    }
    return undefined;
}

/**
 * CPU 拓扑和 P/E/LPE 核分类。
 *
 * 优先读 Intel 混合架构的 perf PMU：`/sys/devices/cpu_core/cpus`（P）、
 * `cpu_atom/cpus`（E）、`cpu_lowpower/cpus`（LPE）。没有时依次用
 * `acpi_cppc`、`cpu_capacity`、`cpuinfo_max_freq` 分组回退；仍无法区分时全部 `unknown`。
 * 返回的性能/能效 CPU 集合只包含在线逻辑 CPU，可直接用于 `setAffinity()`。
 */
export async function getCpuTopology(): Promise<CpuTopology> {
    const [model, onlineSet, entries, performancePmu, efficiencyPmu, lowPowerPmu] = await Promise.all([
        readCpuModel(),
        readOnlineCpus(),
        fsp.readdir("/sys/devices/system/cpu").catch(() => [] as string[]),
        readPmuCpus("cpu_core"),
        readPmuCpus("cpu_atom"),
        readPmuCpus("cpu_lowpower"),
    ]);
    const cpuIds = entries
        .map((entry) => /^cpu(\d+)$/.exec(entry)?.[1])
        .filter((cpu): cpu is string => cpu !== undefined)
        .map(Number)
        .sort((a, b) => a - b);
    const records = await Promise.all(cpuIds.map((cpu) => readCpuRecord(cpu, onlineSet)));

    const typeByCpu = new Map<number, CpuCoreType>();
    for (const cpu of performancePmu) typeByCpu.set(cpu, "performance");
    for (const cpu of efficiencyPmu) typeByCpu.set(cpu, "efficiency");
    for (const cpu of lowPowerPmu) typeByCpu.set(cpu, "low-power-efficiency");

    let hybrid = performancePmu.length > 0 && (efficiencyPmu.length > 0 || lowPowerPmu.length > 0);
    if (typeByCpu.size === 0) {
        const fallback = classifyCpuFallback(records);
        if (fallback) {
            for (const cpu of fallback.performance) typeByCpu.set(cpu, "performance");
            for (const cpu of fallback.efficiency) typeByCpu.set(cpu, "efficiency");
            hybrid = true;
        }
    }

    const performance: number[] = [];
    const efficiency: number[] = [];
    const lowPowerEfficiency: number[] = [];
    const unknown: number[] = [];
    for (const record of records) {
        if (!record.online) continue;
        switch (typeByCpu.get(record.cpu) ?? "unknown") {
            case "performance":
                performance.push(record.cpu);
                break;
            case "efficiency":
                efficiency.push(record.cpu);
                break;
            case "low-power-efficiency":
                lowPowerEfficiency.push(record.cpu);
                break;
            default:
                unknown.push(record.cpu);
        }
    }

    const groups = new Map<string, CpuRecord[]>();
    for (const record of records) {
        const key =
            record.siblings.length > 1
                ? `siblings:${record.siblings.join(",")}`
                : record.coreId >= 0
                  ? `core:${record.packageId}:${record.coreId}`
                  : `cpu:${record.cpu}`;
        const group = groups.get(key);
        if (group) group.push(record);
        else groups.set(key, [record]);
    }

    const cores: CpuCoreInfo[] = [...groups.values()].map((group) => {
        const first = group[0];
        const types = new Set(group.map((record) => typeByCpu.get(record.cpu) ?? "unknown"));
        const type: CpuCoreType = types.size === 1 ? ([...types][0] ?? "unknown") : "unknown";
        const capacity = group.find((record) => record.capacity !== undefined)?.capacity;
        const maxFreq = group.find((record) => record.maxFreq !== undefined)?.maxFreq;
        const id = group.find((record) => record.coreId >= 0)?.coreId ?? Math.min(...group.map((record) => record.cpu));
        return {
            id,
            packageId: first.packageId,
            type,
            capacity,
            maxFreq,
            siblings: [...new Set(group.flatMap((record) => record.siblings))].sort((a, b) => a - b),
            online: group.some((record) => record.online),
        };
    });
    cores.sort((a, b) => a.packageId - b.packageId || a.id - b.id);

    return {
        model,
        hybrid,
        performance: performance.sort((a, b) => a - b),
        efficiency: efficiency.sort((a, b) => a - b),
        lowPowerEfficiency: lowPowerEfficiency.sort((a, b) => a - b),
        unknown: unknown.sort((a, b) => a - b),
        cores,
    };
}

export function getPid(pid: number) {
    return {
        getPidTree() {
            return getPidTree(pid);
        },
        getAffinity() {
            return getAffinity(pid);
        },
        setAffinity(cpus: number[]) {
            return setAffinity(pid, cpus);
        },
        setPriority(priority: number): void {
            try {
                os.setPriority(pid, priority);
            } catch (error) {
                console.error(`Failed to set priority for PID ${pid}:`, error);
            }
        },
        getPriority(): number | null {
            try {
                return os.getPriority(pid);
            } catch (error) {
                console.error(`Failed to get priority for PID ${pid}:`, error);
                return null;
            }
        },
        suspend() {
            process.kill(pid, "SIGSTOP");
        },
        resume() {
            process.kill(pid, "SIGCONT");
        },
        kill() {
            process.kill(pid, "SIGKILL");
        },
    };
}
