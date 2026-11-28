const fsp = require("node:fs/promises") as typeof import("node:fs/promises");

import { EventEmitter } from "../event-emitter/event-emitter";

const HWMON_DIR = "/sys/class/hwmon";
const THERMAL_DIR = "/sys/class/thermal";
const DEFAULT_INTERVAL = 5000;

export type TemperatureKind = "cpu" | "gpu" | "nvme" | "battery" | "wifi" | "acpi" | "other";

export type TemperatureSource = "hwmon" | "thermal";

export type TemperatureSensor = {
    /** 稳定标识，如 `hwmon:coretemp/temp1` 或 `thermal:thermal_zone0` */
    id: string;
    kind: TemperatureKind;
    /** 显示名，如 `coretemp: Package id 0`、`nvme: Composite` */
    name: string;
    /** 摄氏度 */
    value: number;
    /** 摄氏度；传感器不提供时省略 */
    max?: number;
    /** 摄氏度；传感器不提供时省略 */
    crit?: number;
    source: TemperatureSource;
};

export type TemperatureEvents = {
    /** 传感器列表或数值变化 */
    changed: [sensors: TemperatureSensor[]];
};

type ScannedSensor = TemperatureSensor & {
    /** 用于和 thermal_zone 去重的 hwmon/thermal 类型名 */
    sourceName: string;
};

/** 同一硬件同时出现在 hwmon 和 thermal_zone 时的别名 */
const THERMAL_ALIASES: Record<string, string> = {
    x86_pkg_temp: "coretemp",
    acpitz: "acpitz",
    iwlwifi_1: "iwlwifi",
};

function kindOf(name: string, label: string): TemperatureKind {
    const text = `${name} ${label}`.toLowerCase();
    if (/(coretemp|k10temp|zenpower|cpu_thermal|x86_pkg_temp|tcpu|soc_thermal|package)/.test(text)) return "cpu";
    if (/(amdgpu|nouveau|i915|\bxe\b|gpu|radeon)/.test(text)) return "gpu";
    if (/(nvme|drivetemp|ssd)/.test(text)) return "nvme";
    if (/(battery|bat0|bat1|batt)/.test(text)) return "battery";
    if (/(iwlwifi|ath|wlan|wifi|wlp)/.test(text)) return "wifi";
    if (/(acpitz|acpi|int3400|thermal)/.test(text)) return "acpi";
    return "other";
}

async function readText(path: string): Promise<string | undefined> {
    try {
        return await fsp.readFile(path, "utf8");
    } catch {
        return undefined;
    }
}

async function readTemperature(path: string): Promise<number | undefined> {
    const text = await readText(path);
    if (!text) return undefined;
    const value = Number(text.trim());
    if (!Number.isFinite(value)) return undefined;
    return value / 1000;
}

async function readOptionalTemperature(path: string): Promise<number | undefined> {
    const value = await readTemperature(path);
    return value !== undefined && value > 0 ? value : undefined;
}

async function scanHwmon(): Promise<ScannedSensor[]> {
    let dirs: string[];
    try {
        dirs = await fsp.readdir(HWMON_DIR);
    } catch {
        return [];
    }

    const sensors: ScannedSensor[] = [];
    const seen = new Set<string>();
    await Promise.all(
        dirs.map(async (dir) => {
            const base = `${HWMON_DIR}/${dir}`;
            const name = (await readText(`${base}/name`))?.trim() || dir;
            let entries: string[];
            try {
                entries = await fsp.readdir(base);
            } catch {
                return;
            }

            const temps = entries
                .map((entry) => /^temp(\d+)_input$/.exec(entry))
                .filter((match): match is RegExpExecArray => match !== null);

            await Promise.all(
                temps.map(async (match) => {
                    const index = match[1];
                    const value = await readTemperature(`${base}/temp${index}_input`);
                    if (value === undefined) return;
                    const label = (await readText(`${base}/temp${index}_label`))?.trim() ?? "";
                    const max = await readOptionalTemperature(`${base}/temp${index}_max`);
                    const crit = await readOptionalTemperature(`${base}/temp${index}_crit`);
                    let id = `hwmon:${name}/temp${index}`;
                    if (seen.has(id)) id = `hwmon:${name}/${dir}/temp${index}`;
                    seen.add(id);
                    sensors.push({
                        id,
                        kind: kindOf(name, label),
                        name: label ? `${name}: ${label}` : name,
                        value,
                        max,
                        crit,
                        source: "hwmon",
                        sourceName: name,
                    });
                }),
            );
        }),
    );
    return sensors;
}

async function scanThermal(): Promise<ScannedSensor[]> {
    let dirs: string[];
    try {
        dirs = await fsp.readdir(THERMAL_DIR);
    } catch {
        return [];
    }

    const sensors: ScannedSensor[] = [];
    await Promise.all(
        dirs
            .filter((dir) => dir.startsWith("thermal_zone"))
            .map(async (dir) => {
                const base = `${THERMAL_DIR}/${dir}`;
                const type = (await readText(`${base}/type`))?.trim() || dir;
                const value = await readTemperature(`${base}/temp`);
                if (value === undefined) return;

                let max: number | undefined;
                let crit: number | undefined;
                let entries: string[];
                try {
                    entries = await fsp.readdir(base);
                } catch {
                    entries = [];
                }
                for (const entry of entries) {
                    const match = /^trip_point_(\d+)_type$/.exec(entry);
                    if (!match) continue;
                    const tripType = (await readText(`${base}/${entry}`))?.trim();
                    const trip = await readOptionalTemperature(`${base}/trip_point_${match[1]}_temp`);
                    if (trip === undefined) continue;
                    if (tripType === "critical") crit = trip;
                    else if (tripType === "hot" && max === undefined) max = trip;
                }

                sensors.push({
                    id: `thermal:${dir}`,
                    kind: kindOf(type, ""),
                    name: type,
                    value,
                    max,
                    crit,
                    source: "thermal",
                    sourceName: type,
                });
            }),
    );
    return sensors;
}

async function scanSensors(): Promise<TemperatureSensor[]> {
    const [hwmon, thermal] = await Promise.all([scanHwmon(), scanThermal()]);
    const hwmonNames = new Set(hwmon.map((sensor) => sensor.sourceName));
    const seen = new Set(hwmon.map((sensor) => sensor.id));
    const result: TemperatureSensor[] = hwmon.map(({ sourceName: _sourceName, ...sensor }) => sensor);

    for (const sensor of thermal) {
        const alias = THERMAL_ALIASES[sensor.sourceName];
        if (alias && hwmonNames.has(alias)) continue;
        if (seen.has(sensor.id)) continue;
        seen.add(sensor.id);
        const { sourceName: _sourceName, ...publicSensor } = sensor;
        result.push(publicSensor);
    }

    result.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return result;
}

/**
 * 温度传感器。
 *
 * 读取 `/sys/class/hwmon` 和 `/sys/class/thermal`，不做 root 操作；传感器不可读时自动跳过。
 * 温度没有内核事件，`init()` 后按 `interval`（默认 5 秒）轮询，列表或数值变化时发出 `changed`。
 */
export class temperature extends EventEmitter<TemperatureEvents> {
    private sensors: TemperatureSensor[] = [];
    private signature = "";
    private timer: ReturnType<typeof setTimeout> | undefined;
    private interval: number;
    private started = false;
    private refreshing = false;
    private destroyed = false;

    constructor(options: { interval?: number } = {}) {
        super();
        this.interval = Math.max(1000, options.interval ?? DEFAULT_INTERVAL);
    }

    /** 扫描一次并开始轮询；重复调用无副作用 */
    async init(): Promise<void> {
        if (this.started || this.destroyed) return;
        this.started = true;
        await this.refresh();
        this.schedule();
    }

    /** 立即重新扫描；并发调用时返回当前缓存 */
    async refresh(): Promise<TemperatureSensor[]> {
        if (this.refreshing || this.destroyed) return this.getSensors();
        this.refreshing = true;
        try {
            const sensors = await scanSensors();
            const signature = JSON.stringify(sensors);
            this.sensors = sensors;
            if (signature !== this.signature) {
                this.signature = signature;
                this.emit("changed", this.getSensors());
            }
            return this.getSensors();
        } finally {
            this.refreshing = false;
        }
    }

    getSensors(): TemperatureSensor[] {
        return this.sensors.slice();
    }

    /** 修改轮询间隔；已经在轮询时立即生效 */
    start(interval?: number): void {
        if (this.destroyed) return;
        if (interval !== undefined) this.interval = Math.max(1000, interval);
        this.started = true;
        if (!this.timer) this.schedule();
    }

    stop(): void {
        this.started = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    destroy(): void {
        this.destroyed = true;
        this.stop();
        this.removeAllListeners("changed");
        this.sensors = [];
    }

    private schedule(): void {
        if (!this.started || this.destroyed) return;
        this.timer = setTimeout(async () => {
            this.timer = undefined;
            await this.refresh();
            this.schedule();
        }, this.interval);
    }
}
