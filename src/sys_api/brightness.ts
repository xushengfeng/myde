const fs = require("node:fs") as typeof import("node:fs");
const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
const { execFile } = require("node:child_process") as typeof import("node:child_process");

import { dbusClient, type dbusInterface, type dbusIO, type dbusService } from "myde-dbus";
import { EventEmitter } from "../event-emitter/event-emitter";

const BACKLIGHT_DIR = "/sys/class/backlight";
const LOGIN_BUS = "org.freedesktop.login1";
const LOGIN_MANAGER_PATH = "/org/freedesktop/login1";
const LOGIN_MANAGER_IFACE = "org.freedesktop.login1.Manager";
const LOGIN_SESSION_IFACE = "org.freedesktop.login1.Session";
const LOGIN_USER_IFACE = "org.freedesktop.login1.User";
const LOGIN_SEAT_IFACE = "org.freedesktop.login1.Seat";
const LOGIN_AUTO_SESSION = "/org/freedesktop/login1/session/auto";

/** 内置屏走内核 backlight，外接屏走 DDC/CI */
export type BrightnessKind = "backlight" | "ddc";

export interface BrightnessDisplay {
    /** 稳定标识：`backlight:<设备名>` 或 `ddc:<DRM 连接器|i2c 总线>` */
    id: string;
    kind: BrightnessKind;
    /** 界面显示名：内置屏为 DRM 连接器名，外接屏为厂商 + 型号 */
    name: string;
    /** 0-100 百分比 */
    brightness: number;
    /** 当前是否能写入（内置屏需要 sysfs 权限或 logind；外接屏需要 DDC 可读） */
    writable: boolean;
}

export type BrightnessEvents = {
    /** 新屏幕可用（init/refresh 扫描到，外接屏热插拔后 refresh） */
    added: [display: BrightnessDisplay];
    removed: [id: string];
    /** 亮度变化，包括 Fn 键等外部修改（内置屏通过 sysfs 监听） */
    changed: [id: string, brightness: number];
};

/** `ddcutil detect --brief` 里一个可用的显示器 */
export interface DdcDetectEntry {
    /** /dev/i2c-N 的 N */
    bus: number;
    /** 如 card0-DP-1 */
    connector?: string;
    /** ddcutil 的 Monitor 字段，形如 MFR:MODEL:SERIAL */
    monitor: string;
}

interface VcpBrightness {
    current: number;
    max: number;
}

type DisplayRecord = {
    info: BrightnessDisplay;
    backlight?: { device: string; max: number; file: string };
    ddc?: { bus: number; max: number };
};

type CommandResult = { code: number; stdout: string; stderr: string };

/**
 * 执行外部命令。命令不存在等启动错误 reject；非零退出码作为结果返回，
 * 因为 ddcutil 探测不到显示器时也会给有用的 stdout/stderr。
 */
function runCommand(cmd: string, args: string[], timeout: number): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
            if (!error) {
                resolve({ code: 0, stdout, stderr });
                return;
            }
            if (error.killed) {
                reject(new Error(`${cmd} 超时（${timeout}ms）`));
                return;
            }
            if (typeof error.code === "string") {
                reject(error);
                return;
            }
            resolve({ code: typeof error.code === "number" ? error.code : 1, stdout, stderr });
        });
    });
}

/** 解析 `ddcutil detect --brief`，忽略 "Invalid display" 段 */
export function parseDdcDetectOutput(text: string): DdcDetectEntry[] {
    const entries: DdcDetectEntry[] = [];
    let current: Partial<DdcDetectEntry> | undefined;
    let valid = false;

    const flush = () => {
        if (valid && current?.bus !== undefined && current.monitor) {
            entries.push({
                bus: current.bus,
                connector: current.connector,
                monitor: current.monitor,
            });
        }
        current = undefined;
        valid = false;
    };

    for (const line of text.split(/\r?\n/)) {
        const header = line.match(/^\s*(Display|Invalid display)\b/i);
        if (header) {
            flush();
            current = {};
            valid = header[1].toLowerCase() === "display";
            continue;
        }
        if (!current) continue;

        const bus = line.match(/I2C bus:\s*\/dev\/i2c-(\d+)/i);
        if (bus) current.bus = Number(bus[1]);
        const connector = line.match(/DRM connector:\s*(\S+)/i);
        if (connector) current.connector = connector[1];
        const monitor = line.match(/Monitor:\s*(.+)/i);
        if (monitor) current.monitor = monitor[1].trim();
    }
    flush();

    return entries;
}

/** 解析 `ddcutil --brief getvcp 10`（亮度 VCP 0x10） */
export function parseVcpBrightness(text: string): VcpBrightness | undefined {
    const match = text.match(/VCP code\s+0x10\b[^\n]*?current value\s*=\s*(-?\d+)\s*,\s*max value\s*=\s*(-?\d+)/i);
    if (!match) return undefined;
    const current = Number(match[1]);
    const max = Number(match[2]);
    if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return undefined;
    return { current, max };
}

function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(100, Math.max(0, Math.round(value)));
}

function toPercent(value: number, max: number): number {
    if (max <= 0) return 0;
    return clampPercent((value / max) * 100);
}

function toRaw(percent: number, max: number): number {
    return Math.min(max, Math.max(0, Math.round((clampPercent(percent) / 100) * max)));
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 读 logind 的 `(so)` 复合属性（如 `Session.Seat`、`Seat.ActiveSession`、
 * `User.Display`），返回 `[id, 对象路径]`。myde-dbus 的 `get` 读到单个复合值时
 * 会再包一层数组，这里两种形状都接受。
 */
async function getPair(iface: dbusInterface, property: string): Promise<[string, string] | undefined> {
    const value = (await iface.get<"so">(property)) as unknown;
    const pair = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") return undefined;
    return [pair[0], pair[1]];
}

/** 内置 backlight 对应的 DRM 连接器名（如 eDP-1），取不到时返回 undefined */
function backlightConnector(dir: string): string | undefined {
    try {
        const target = fs.readlinkSync(`${dir}/device`);
        const base = target.split("/").filter(Boolean).pop();
        if (!base) return undefined;
        return base.match(/^card\d+-(.+)$/)?.[1] ?? base;
    } catch {
        return undefined;
    }
}

/** ddcutil 的 Monitor 字段 MFR:MODEL:SERIAL -> 显示名 */
function ddcMonitorName(entry: DdcDetectEntry): string {
    const [manufacturer, model] = entry.monitor.split(":");
    const base = [manufacturer, model].filter(Boolean).join(" ").trim() || entry.monitor.trim();
    const connector = entry.connector?.replace(/^card\d+-/, "");
    return connector ? `${base} (${connector})` : base;
}

/**
 * 屏幕亮度。
 *
 * - 内置屏：读 `/sys/class/backlight/<dev>/{brightness,max_brightness}`，写入优先
 *   直接写 sysfs，没有权限时走 logind `Session.SetBrightness`（写席位当前的前台会话，
 *   切 VT 后自动跟随）。
 *   用 `fs.watch` 监听 sysfs，Fn 键或其他程序改亮度也会发出 `changed`。
 * - 外接屏：调用 `ddcutil`（DDC/CI，VCP 0x10）枚举和读写；需要 i2c 权限
 *   （udev `uaccess` 规则或 i2c 组），不可用时只记录告警，不影响内置屏。
 */
export class brightness extends EventEmitter<BrightnessEvents> {
    private dbus?: dbusIO;
    private client?: dbusClient;
    private service?: dbusService;
    private manager?: dbusInterface;
    /** 当前席位（logind Seat 对象路径），和会话不同，VT 切换不会变 */
    private seatPath?: string;
    private sessionError?: string;
    private logindAvailable = false;

    private displays = new Map<string, DisplayRecord>();
    private watchers = new Map<string, ReturnType<typeof fs.watch>>();
    /** 每个屏幕同一时刻只跑一个写入，连续调用合并成最新值 */
    private pending = new Map<string, number>();
    private drains = new Map<string, Promise<void>>();
    private watchTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private ddcMissing = false;
    private ddcWarned = new Set<string>();

    private started = false;
    private refreshing = false;
    private destroyed = false;

    /** dbus 用于内置屏的 logind 写入；没有时只能直接写 sysfs */
    constructor(dbus?: dbusIO) {
        super();
        this.dbus = dbus;
    }

    async init(): Promise<void> {
        if (this.started || this.destroyed) return;
        this.started = true;
        if (this.dbus) {
            try {
                await this.dbus.connect();
            } catch (error) {
                this.sessionError = errorText(error);
                console.warn("[brightness] 系统总线连接失败，内置屏只能直接写 sysfs:", error);
            }
            if (!this.sessionError) {
                try {
                    // 只确认 logind 可用；具体写到哪个会话在每次写入时按席位前台会话重新取
                    await this.getManager();
                    this.logindAvailable = true;
                } catch (error) {
                    console.warn("[brightness] logind 不可用，内置屏只能直接写 sysfs:", error);
                }
            }
        }
        await this.refresh();
    }

    /** 当前扫描到的屏幕（按内置屏、外接屏顺序） */
    getDisplays(): BrightnessDisplay[] {
        return Array.from(this.displays.values(), (record) => ({ ...record.info }));
    }

    getDisplay(id: string): BrightnessDisplay | undefined {
        const record = this.displays.get(id);
        return record ? { ...record.info } : undefined;
    }

    /** 重新扫描（外接屏热插拔后调用），返回最新列表 */
    async refresh(): Promise<BrightnessDisplay[]> {
        if (this.destroyed) return [];
        if (this.refreshing) return this.getDisplays();
        this.refreshing = true;
        try {
            const previous = this.displays;
            const next = new Map<string, DisplayRecord>();

            for (const record of this.scanBacklights()) {
                next.set(record.info.id, record);
            }
            for (const record of await this.scanDdc()) {
                if (!next.has(record.info.id)) next.set(record.info.id, record);
            }
            if (this.destroyed) return [];

            this.displays = next;
            for (const [id, record] of next) {
                const prev = previous.get(id);
                this.ensureWatcher(record);
                if (!prev) {
                    this.emit("added", { ...record.info });
                } else if (prev.info.brightness !== record.info.brightness) {
                    this.emit("changed", id, record.info.brightness);
                }
            }
            for (const id of previous.keys()) {
                if (next.has(id)) continue;
                this.closeWatcher(id);
                this.emit("removed", id);
            }
            return this.getDisplays();
        } finally {
            this.refreshing = false;
        }
    }

    /**
     * 设置亮度，百分比 0-100，返回实际生效值。
     * 同一屏幕的连续调用会合并，拖动滑块时只会写入最新值。
     */
    async setBrightness(id: string, percent: number): Promise<number> {
        const display = this.displays.get(id);
        if (!display) throw new Error(`未知的显示设备: ${id}`);
        if (!display.info.writable) throw new Error(`显示设备不可写: ${display.info.name}`);
        const target = clampPercent(percent);
        this.pending.set(id, target);

        for (;;) {
            const running = this.drains.get(id);
            if (running) {
                await running;
            } else {
                const drain = this.drain(id);
                this.drains.set(id, drain);
                try {
                    await drain;
                } finally {
                    if (this.drains.get(id) === drain) this.drains.delete(id);
                }
            }
            // 期间有新目标时再跑一轮，保证返回时列表里的值就是最后一次写入的结果
            if (!this.pending.has(id)) break;
        }
        return this.displays.get(id)?.info.brightness ?? target;
    }

    private async drain(id: string): Promise<void> {
        while (this.pending.has(id)) {
            const value = this.pending.get(id) ?? 0;
            this.pending.delete(id);
            const record = this.displays.get(id);
            if (!record) throw new Error(`显示设备已移除: ${id}`);
            await this.apply(record, value);
        }
    }

    destroy(): void {
        this.destroyed = true;
        for (const id of this.watchers.keys()) this.closeWatcher(id);
        for (const timer of this.watchTimers.values()) clearTimeout(timer);
        this.watchTimers.clear();
        this.pending.clear();
        this.drains.clear();
        this.displays.clear();
        for (const event of ["added", "removed", "changed"] as const) this.removeAllListeners(event);
    }

    private scanBacklights(): DisplayRecord[] {
        let names: string[];
        try {
            names = fs.readdirSync(BACKLIGHT_DIR);
        } catch {
            return [];
        }

        const records: DisplayRecord[] = [];
        for (const device of names) {
            const dir = `${BACKLIGHT_DIR}/${device}`;
            try {
                const max = Number(fs.readFileSync(`${dir}/max_brightness`, "utf8").trim());
                if (!Number.isFinite(max) || max <= 0) continue;
                const file = `${dir}/brightness`;
                const value = Number(fs.readFileSync(file, "utf8").trim());
                const writable = this.sysfsWritable(file);
                records.push({
                    info: {
                        id: `backlight:${device}`,
                        kind: "backlight",
                        name: backlightConnector(dir) ?? device,
                        brightness: toPercent(value, max),
                        writable: writable || this.logindAvailable,
                    },
                    backlight: { device, max, file },
                });
            } catch (error) {
                console.warn(`[brightness] 读取 ${dir} 失败:`, errorText(error));
            }
        }
        return records;
    }

    private sysfsWritable(file: string): boolean {
        try {
            fs.accessSync(file, fs.constants.W_OK);
            return true;
        } catch {
            return false;
        }
    }

    private async scanDdc(): Promise<DisplayRecord[]> {
        if (this.ddcMissing) return [];

        let detected: CommandResult;
        try {
            detected = await runCommand("ddcutil", ["detect", "--brief"], 30000);
        } catch (error) {
            // 只有命令不存在才永久放弃，其他错误（超时、权限）下次 refresh 再试
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                this.ddcMissing = true;
                console.warn("[brightness] 未找到 ddcutil，外接屏幕亮度不可用");
            } else {
                console.warn("[brightness] ddcutil detect 失败:", errorText(error));
            }
            return [];
        }

        const entries = parseDdcDetectOutput(detected.stdout);
        const records: DisplayRecord[] = [];
        const seen = new Set<string>();
        for (const entry of entries) {
            const id = `ddc:${entry.connector ?? `i2c-${entry.bus}`}`;
            if (seen.has(id)) continue;
            seen.add(id);

            const vcp = await this.readVcp(entry.bus);
            if (!vcp) {
                if (!this.ddcWarned.has(id)) {
                    this.ddcWarned.add(id);
                    console.warn(
                        `[brightness] 无法读取 ${entry.monitor} 的亮度（VCP 0x10 不支持或 /dev/i2c-${entry.bus} 无权限）`,
                    );
                }
                continue;
            }
            records.push({
                info: {
                    id,
                    kind: "ddc",
                    name: ddcMonitorName(entry),
                    brightness: toPercent(vcp.current, vcp.max),
                    writable: true,
                },
                ddc: { bus: entry.bus, max: vcp.max },
            });
        }
        return records;
    }

    private async readVcp(bus: number): Promise<VcpBrightness | undefined> {
        try {
            const result = await runCommand("ddcutil", ["--bus", String(bus), "--brief", "getvcp", "10"], 15000);
            if (result.code !== 0 && !result.stdout) return undefined;
            return parseVcpBrightness(result.stdout);
        } catch {
            return undefined;
        }
    }

    private async apply(record: DisplayRecord, percent: number): Promise<void> {
        if (record.backlight) {
            const raw = toRaw(percent, record.backlight.max);
            await this.writeBacklight(record.backlight, raw);
            const value = this.readBacklight(record.backlight);
            this.updateBrightness(record, value ?? toPercent(raw, record.backlight.max));
        } else if (record.ddc) {
            const raw = toRaw(percent, record.ddc.max);
            await this.writeDdc(record.ddc.bus, raw);
            this.updateBrightness(record, toPercent(raw, record.ddc.max));
        }
    }

    private updateBrightness(record: DisplayRecord, percent: number): void {
        const value = clampPercent(percent);
        const target = this.displays.get(record.info.id) ?? record;
        if (target.info.brightness === value) return;
        target.info.brightness = value;
        this.emit("changed", target.info.id, value);
    }

    private readBacklight(backlight: NonNullable<DisplayRecord["backlight"]>): number | undefined {
        try {
            const raw = Number(fs.readFileSync(backlight.file, "utf8").trim());
            if (!Number.isFinite(raw)) return undefined;
            return toPercent(raw, backlight.max);
        } catch {
            return undefined;
        }
    }

    private async writeBacklight(backlight: NonNullable<DisplayRecord["backlight"]>, raw: number): Promise<void> {
        try {
            await fsp.writeFile(backlight.file, `${raw}\n`, "utf8");
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // 只有权限问题才回退 logind；越界、设备消失等错误直接抛出
            if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") {
                throw new Error(`写入 ${backlight.file} 失败: ${errorText(error)}`);
            }
        }

        if (!this.dbus) {
            throw new Error(`没有权限写入 ${backlight.file}，且系统总线不可用（logind 回退不可用）`);
        }
        try {
            await this.setLogindBrightness(backlight, raw);
        } catch (error) {
            throw new Error(`logind SetBrightness 失败: ${errorText(error)}`);
        }
    }

    private async writeDdc(bus: number, raw: number): Promise<void> {
        const result = await runCommand(
            "ddcutil",
            ["--bus", String(bus), "--brief", "setvcp", "10", String(raw)],
            20000,
        );
        if (result.code !== 0) {
            const reason = result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code}`;
            throw new Error(`ddcutil setvcp 失败: ${reason}`);
        }
    }

    /** 系统总线上的 logind 服务（进程内复用） */
    private async getService(): Promise<dbusService> {
        if (!this.dbus) throw new Error("系统总线不可用");
        if (this.sessionError) throw new Error(this.sessionError);
        this.client ??= new dbusClient({ io: this.dbus });
        this.service ??= await this.client.getService(LOGIN_BUS);
        return this.service;
    }

    /** 取 logind Manager 接口（进程内复用） */
    private async getManager(): Promise<dbusInterface> {
        if (this.manager) return this.manager;
        const service = await this.getService();
        this.manager = await (await service.getObject(LOGIN_MANAGER_PATH)).getInterface(LOGIN_MANAGER_IFACE);
        return this.manager;
    }

    /**
     * 找当前席位（seat）：优先环境里的 XDG_SEAT，其次从登录会话的 Seat 属性取，
     * 都拿不到时退回唯一的席位。席位在运行期间不变，取到后缓存。
     */
    private async getSeatPath(): Promise<string | undefined> {
        if (this.seatPath) return this.seatPath;
        const manager = await this.getManager();
        const service = await this.getService();
        const seats: string[] = [];
        const addSeat = (path: string | undefined) => {
            if (path && path !== "/" && !seats.includes(path)) seats.push(path);
        };

        if (process.env.XDG_SEAT) {
            try {
                const [path] = await manager.call("GetSeat", "s", process.env.XDG_SEAT).as<"o">();
                addSeat(path);
            } catch {
                // 环境里的席位名已失效
            }
        }
        for (const path of await this.sessionCandidates(manager, service)) {
            try {
                const iface = await (await service.getObject(path)).getInterface(LOGIN_SESSION_IFACE);
                const seat = await getPair(iface, "Seat");
                addSeat(seat?.[1]);
            } catch {
                // 会话不存在或已结束
            }
        }
        if (seats.length === 0) {
            try {
                const [paths] = await manager.call("ListSeats").as<"a(so)">();
                for (const [, path] of paths) addSeat(path);
            } catch {
                // 没有席位信息
            }
        }

        this.seatPath = seats[0];
        return this.seatPath;
    }

    /** 可能属于当前用户的会话路径，按可信程度排序 */
    private async sessionCandidates(manager: dbusInterface, service: dbusService): Promise<string[]> {
        const candidates: string[] = [];
        const add = (path: string | undefined) => {
            if (path && path !== "/" && !candidates.includes(path)) candidates.push(path);
        };

        try {
            const [path] = await manager.call("GetSessionByPID", "u", process.pid).as<"o">();
            add(path);
        } catch {
            // 进程可能不在会话 scope 里（如 app-*.scope）
        }
        try {
            const [userPath] = await manager.call("GetUser", "u", process.getuid?.() ?? 0).as<"o">();
            const user = await (await service.getObject(userPath)).getInterface(LOGIN_USER_IFACE);
            const display = await getPair(user, "Display");
            add(display?.[1]);
        } catch {
            // 没有图形会话
        }
        if (process.env.XDG_SESSION_ID) {
            add(`/org/freedesktop/login1/session/${process.env.XDG_SESSION_ID}`);
        }
        add(LOGIN_AUTO_SESSION);
        return candidates;
    }

    /**
     * 取能设置亮度的 logind 会话：席位当前的前台会话（`Seat.ActiveSession`）。
     *
     * logind 只接受席位前台会话的 SetBrightness，其他会话一律
     * `NotYourDevice: Session is not in foreground`。所以每次写入都重新读前台会话，
     * 不缓存会话本身：切 VT 后旧会话立刻变成非前台。
     */
    private async getSession(): Promise<{ iface: dbusInterface; id: string }> {
        const manager = await this.getManager();
        const service = await this.getService();

        const seatPath = await this.getSeatPath();
        if (seatPath) {
            try {
                const seat = await (await service.getObject(seatPath)).getInterface(LOGIN_SEAT_IFACE);
                const active = await getPair(seat, "ActiveSession");
                const activePath = active?.[1];
                if (activePath && activePath !== "/") {
                    const iface = await (await service.getObject(activePath)).getInterface(LOGIN_SESSION_IFACE);
                    const [id] = await iface.get<"s">("Id");
                    return { iface, id };
                }
            } catch {
                // 前台会话刚结束，继续用下面的候选会话
            }
        }

        // 没有席位/前台会话时，退回找任意活动会话
        const candidates = await this.sessionCandidates(manager, service);
        let fallback: { iface: dbusInterface; id: string } | undefined;
        let lastError: unknown;
        for (const path of candidates) {
            try {
                const iface = await (await service.getObject(path)).getInterface(LOGIN_SESSION_IFACE);
                const [id] = await iface.get<"s">("Id");
                const [active] = await iface.get<"b">("Active");
                if (active) return { iface, id };
                fallback ??= { iface, id };
            } catch (error) {
                lastError = error;
            }
        }
        if (fallback) return fallback;
        throw lastError instanceof Error ? lastError : new Error("找不到 logind 会话");
    }

    /**
     * 经 logind 写 backlight。正好切过 VT 时前台会话和查询结果可能错开，
     * logind 会拒绝并重新查一次。
     */
    private async setLogindBrightness(backlight: NonNullable<DisplayRecord["backlight"]>, raw: number): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            const session = await this.getSession();
            try {
                await session.iface.call("SetBrightness", "ssu", "backlight", backlight.device, raw).await();
                return;
            } catch (error) {
                if (attempt > 0 || !String(error).includes("NotYourDevice")) throw error;
                console.warn(`[brightness] 会话 ${session.id} 不是前台会话，重新查找后重试`);
            }
        }
    }

    private ensureWatcher(record: DisplayRecord): void {
        if (!record.backlight || this.watchers.has(record.info.id)) return;
        try {
            const watcher = fs.watch(record.backlight.file, () => this.scheduleBacklightSync(record.info.id));
            watcher.on("error", () => {
                watcher.close();
                this.watchers.delete(record.info.id);
            });
            this.watchers.set(record.info.id, watcher);
        } catch (error) {
            console.warn(`[brightness] 监听 ${record.backlight.file} 失败:`, errorText(error));
        }
    }

    private closeWatcher(id: string): void {
        const watcher = this.watchers.get(id);
        if (watcher) {
            watcher.close();
            this.watchers.delete(id);
        }
        const timer = this.watchTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.watchTimers.delete(id);
        }
    }

    private scheduleBacklightSync(id: string): void {
        if (this.watchTimers.has(id)) return;
        // sysfs 一次写入可能触发多个事件，合并后再读
        this.watchTimers.set(
            id,
            setTimeout(() => {
                this.watchTimers.delete(id);
                const record = this.displays.get(id);
                if (!record?.backlight) return;
                const value = this.readBacklight(record.backlight);
                if (value !== undefined) this.updateBrightness(record, value);
            }, 30),
        );
    }
}
