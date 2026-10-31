const { exec, spawn } = require("node:child_process") as typeof import("node:child_process");

import { EventEmitter } from "../event-emitter/event-emitter";

export interface AudioDevice {
    id: number;
    name: string;
    type: "sink" | "source" | "device";
    isDefault: boolean;
    volume?: number;
    isMuted?: boolean;
    description?: string;
}

export interface AudioStream {
    id: number;
    name: string;
    pid?: number;
    type: "input" | "output";
    applicationName?: string;
    mediaClass?: string;
    volume?: number;
    isMuted?: boolean;
}

interface PactlChannel {
    value: number;
}

type PactlVolume = Record<string, PactlChannel> | null | undefined;

interface PactlProperties {
    [key: string]: string | undefined;
}

interface PactlDevice {
    index: number;
    name: string;
    description?: string;
    mute: boolean;
    volume?: PactlVolume;
    properties?: PactlProperties;
}

interface PactlStream {
    index: number;
    mute: boolean;
    volume?: PactlVolume;
    properties?: PactlProperties;
}

interface PactlList {
    sinks: PactlDevice[];
    sources: PactlDevice[];
    sink_inputs: PactlStream[];
    source_outputs: PactlStream[];
}

interface PactlInfo {
    default_sink_name?: string;
    default_source_name?: string;
}

const VOLUME_SCALE = 65536;
const VOLUME_EPSILON = 1 / VOLUME_SCALE / 2;

/**
 * pactl 的 sink/source、sink-input/source-output 索引各自独立，会重号
 * （例如 sink #51 和它的 monitor source #51）。
 * 对外仍只暴露一个 number id：sink / sink-input 直接用 pactl index（>= 0），
 * source / source-output 用 -(index + 1)（< 0）。
 */
function encodeId(index: number, reverse: boolean) {
    return reverse ? -index - 1 : index;
}

function decodeId(id: number) {
    return id < 0 ? -id - 1 : id;
}

function quote(x: string) {
    return `'${x.replaceAll("'", `'\\''`)}'`;
}

function readVolume(volume: PactlVolume): number | undefined {
    if (!volume) return undefined;
    const first = Object.values(volume)[0];
    return first ? first.value / VOLUME_SCALE : undefined;
}

function run(x: string): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    exec(x, { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 }, (err, stdo, _stde) => {
        if (err) {
            reject(err);
        } else {
            resolve(stdo);
        }
    });
    return promise;
}

// pactl subscribe 只给出对象类别和索引，不带具体数值，收到事件后再整体刷新一次
const SUBSCRIBE_EVENT = /^Event '\w+' on ([\w-]+)(?:\s|$)/;
const SUBSCRIBE_RELEVANT_KINDS = new Set(["sink", "source", "sink-input", "source-output", "server", "card"]);

export class volumeControl {
    ev = new EventEmitter<{
        deviceAdd: [device: AudioDevice];
        deviceRemove: [deviceId: number];
        deviceVolumeChange: [deviceId: number, volume: number];
        deviceMuteChange: [deviceId: number, muted: boolean];
        streamAdd: [stream: AudioStream];
        streamRemove: [streamId: number];
        streamVolumeChange: [streamId: number, volume: number];
        streamMuteChange: [streamId: number, muted: boolean];
    }>();

    private devices = new Map<number, AudioDevice>();
    private streams = new Map<number, AudioStream>();

    private subscribeProc?: ReturnType<typeof spawn>;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private restartTimer?: ReturnType<typeof setTimeout>;
    private refreshing = false;
    private needsRefresh = false;
    private warned = false;
    private started = false;
    private destroyed = false;

    async init() {
        if (this.started || this.destroyed) return;
        this.started = true;
        // 桌面退出时杀掉订阅进程，避免留下孤儿 pactl
        process.once("exit", this.killSubscribe);
        await this.refresh();
        this.startSubscribe();
    }

    private startSubscribe() {
        if (this.destroyed) return;

        const proc = spawn("pactl", ["subscribe"], { stdio: ["ignore", "pipe", "ignore"] });
        this.subscribeProc = proc;
        let spawned = false;

        proc.on("spawn", () => {
            spawned = true;
        });

        proc.on("error", (error) => {
            console.warn("[volume] pactl subscribe 启动失败:", error);
        });

        proc.on("close", () => {
            this.subscribeProc = undefined;
            // 进程启动过又退出（例如音频服务重启）时重连；pactl 不存在则不反复重试
            if (this.destroyed || !spawned) return;
            this.restartTimer = setTimeout(() => {
                this.restartTimer = undefined;
                this.startSubscribe();
            }, 1000);
        });

        let buffer = "";
        proc.stdout?.setEncoding("utf-8");
        proc.stdout?.on("data", (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                const kind = line.match(SUBSCRIBE_EVENT)?.[1];
                if (kind && SUBSCRIBE_RELEVANT_KINDS.has(kind)) {
                    this.scheduleRefresh();
                }
            }
        });
    }

    // 事件会成串到达（改一次音量可能触发好几条），合并成一次刷新
    private scheduleRefresh() {
        if (this.refreshTimer) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh();
        }, 50);
    }

    private async refresh() {
        if (this.destroyed) return;
        if (this.refreshing) {
            this.needsRefresh = true;
            return;
        }

        this.refreshing = true;
        try {
            const [listText, infoText] = await Promise.all([
                run("pactl --format=json list"),
                run("pactl --format=json info"),
            ]);
            const list = JSON.parse(listText) as PactlList;
            const info = JSON.parse(infoText) as PactlInfo;

            if (this.destroyed) return;
            this.applyDevices(list, info);
            this.applyStreams(list);
        } catch (error) {
            if (!this.warned) {
                this.warned = true;
                console.warn("[volume] 读取音频状态失败（pactl 是否可用？）:", error);
            }
        } finally {
            this.refreshing = false;
            if (this.needsRefresh) {
                this.needsRefresh = false;
                this.scheduleRefresh();
            }
        }
    }

    private applyDevices(list: PactlList, info: PactlInfo) {
        const old = this.devices;
        const next = new Map<number, AudioDevice>();

        for (const sink of list.sinks) {
            const device = this.toDevice(sink, "sink", sink.name === info.default_sink_name);
            next.set(device.id, device);
        }
        for (const source of list.sources) {
            // monitor source 只是 sink 的环回，不是真实输入设备
            if (source.name.endsWith(".monitor")) continue;
            const device = this.toDevice(source, "source", source.name === info.default_source_name);
            next.set(device.id, device);
        }

        this.devices = next;

        for (const [id, device] of next) {
            const prev = old.get(id);
            if (!prev) {
                this.ev.emit("deviceAdd", device);
                continue;
            }
            if (
                device.volume !== undefined &&
                prev.volume !== undefined &&
                Math.abs(device.volume - prev.volume) > VOLUME_EPSILON
            ) {
                this.ev.emit("deviceVolumeChange", id, device.volume);
            }
            if (device.isMuted !== undefined && prev.isMuted !== device.isMuted) {
                this.ev.emit("deviceMuteChange", id, device.isMuted);
            }
        }

        for (const id of old.keys()) {
            if (!next.has(id)) this.ev.emit("deviceRemove", id);
        }
    }

    private applyStreams(list: PactlList) {
        const old = this.streams;
        const next = new Map<number, AudioStream>();

        for (const input of list.sink_inputs) {
            const stream = this.toStream(input, "output");
            next.set(stream.id, stream);
        }
        for (const output of list.source_outputs) {
            const stream = this.toStream(output, "input");
            next.set(stream.id, stream);
        }

        this.streams = next;

        for (const [id, stream] of next) {
            const prev = old.get(id);
            if (!prev) {
                this.ev.emit("streamAdd", stream);
                continue;
            }
            if (
                stream.volume !== undefined &&
                prev.volume !== undefined &&
                Math.abs(stream.volume - prev.volume) > VOLUME_EPSILON
            ) {
                this.ev.emit("streamVolumeChange", id, stream.volume);
            }
            if (stream.isMuted !== undefined && prev.isMuted !== stream.isMuted) {
                this.ev.emit("streamMuteChange", id, stream.isMuted);
            }
        }

        for (const id of old.keys()) {
            if (!next.has(id)) this.ev.emit("streamRemove", id);
        }
    }

    private toDevice(raw: PactlDevice, type: "sink" | "source", isDefault: boolean): AudioDevice {
        return {
            id: encodeId(raw.index, type === "source"),
            name: raw.name,
            type,
            isDefault,
            volume: readVolume(raw.volume),
            isMuted: raw.mute,
            description: raw.description,
        };
    }

    private toStream(raw: PactlStream, type: "input" | "output"): AudioStream {
        const properties = raw.properties ?? {};
        const pid = properties["application.process.id"];
        return {
            id: encodeId(raw.index, type === "input"),
            name: properties["node.name"] ?? properties["application.name"] ?? String(raw.index),
            pid: pid ? Number.parseInt(pid, 10) : undefined,
            type,
            applicationName: properties["application.name"],
            mediaClass: properties["media.class"],
            volume: readVolume(raw.volume),
            isMuted: raw.mute,
        };
    }

    // Public API methods
    getDevices(): AudioDevice[] {
        return Array.from(this.devices.values());
    }

    getSinks(): AudioDevice[] {
        return Array.from(this.devices.values()).filter((d) => d.type === "sink");
    }

    getSources(): AudioDevice[] {
        return Array.from(this.devices.values()).filter((d) => d.type === "source");
    }

    getStreams(): AudioStream[] {
        return Array.from(this.streams.values());
    }

    getDevice(id: number): AudioDevice | undefined {
        return this.devices.get(id);
    }

    getStream(id: number): AudioStream | undefined {
        return this.streams.get(id);
    }

    // 缓存里没有时按 id 的符号推断类型，保证按 id 直接调用也能工作
    private deviceKind(id: number): "sink" | "source" {
        const device = this.devices.get(id);
        if (device) return device.type === "source" ? "source" : "sink";
        return id < 0 ? "source" : "sink";
    }

    private streamKind(streamId: number): "sink-input" | "source-output" {
        const stream = this.streams.get(streamId);
        if (stream) return stream.type === "input" ? "source-output" : "sink-input";
        return streamId < 0 ? "source-output" : "sink-input";
    }

    async getDeviceVolume(id: number): Promise<number | null> {
        const kind = this.deviceKind(id);
        try {
            const output = await run(`pactl --format=json get-${kind}-volume ${decodeId(id)}`);
            const volume = readVolume((JSON.parse(output) as { volume?: PactlVolume }).volume);
            return volume ?? null;
        } catch (_error) {
            return null;
        }
    }

    async setDeviceVolume(id: number, volume: number): Promise<boolean> {
        const kind = this.deviceKind(id);
        const clamped = clampVolume(volume);
        try {
            await run(`pactl set-${kind}-volume ${decodeId(id)} ${scaledVolume(clamped)}`);
            const device = this.devices.get(id);
            if (device) device.volume = quantizeVolume(clamped);
            return true;
        } catch (_error) {
            return false;
        }
    }

    async getDeviceMute(id: number): Promise<boolean | null> {
        const kind = this.deviceKind(id);
        try {
            const output = await run(`pactl --format=json get-${kind}-mute ${decodeId(id)}`);
            return (JSON.parse(output) as { mute?: boolean }).mute ?? null;
        } catch (_error) {
            return null;
        }
    }

    async setDeviceMute(id: number, mute: boolean | "toggle"): Promise<boolean> {
        const kind = this.deviceKind(id);
        try {
            await run(`pactl set-${kind}-mute ${decodeId(id)} ${muteValue(mute)}`);
            const device = this.devices.get(id);
            if (device) device.isMuted = mute === "toggle" ? !device.isMuted : mute;
            return true;
        } catch (_error) {
            return false;
        }
    }

    async setDefaultDevice(id: number): Promise<boolean> {
        // 默认设备要按名字设置，必须有缓存
        const device = this.devices.get(id);
        if (!device) return false;
        const kind = device.type === "source" ? "source" : "sink";
        try {
            await run(`pactl set-default-${kind} ${quote(device.name)}`);
            for (const [deviceId, item] of this.devices) {
                if (item.type === device.type) item.isDefault = deviceId === id;
            }
            return true;
        } catch (_error) {
            return false;
        }
    }

    // Stream control methods
    async getStreamVolume(streamId: number): Promise<number | null> {
        try {
            const raw = await this.findStream(this.streamKind(streamId), streamId);
            return readVolume(raw?.volume) ?? null;
        } catch (_error) {
            return null;
        }
    }

    async setStreamVolume(streamId: number, volume: number): Promise<boolean> {
        const kind = this.streamKind(streamId);
        const clamped = clampVolume(volume);
        try {
            await run(`pactl set-${kind}-volume ${decodeId(streamId)} ${scaledVolume(clamped)}`);
            const stream = this.streams.get(streamId);
            if (stream) stream.volume = quantizeVolume(clamped);
            return true;
        } catch (_error) {
            return false;
        }
    }

    async getStreamMute(streamId: number): Promise<boolean | null> {
        try {
            const raw = await this.findStream(this.streamKind(streamId), streamId);
            return raw?.mute ?? null;
        } catch (_error) {
            return null;
        }
    }

    async setStreamMute(streamId: number, mute: boolean | "toggle"): Promise<boolean> {
        const kind = this.streamKind(streamId);
        try {
            await run(`pactl set-${kind}-mute ${decodeId(streamId)} ${muteValue(mute)}`);
            const stream = this.streams.get(streamId);
            if (stream) stream.isMuted = mute === "toggle" ? !stream.isMuted : mute;
            return true;
        } catch (_error) {
            return false;
        }
    }

    private async findStream(kind: "sink-input" | "source-output", streamId: number): Promise<PactlStream | undefined> {
        const output = await run(`pactl --format=json list ${kind}s`);
        const index = decodeId(streamId);
        return (JSON.parse(output) as PactlStream[]).find((s) => s.index === index);
    }

    // Cleanup
    destroy() {
        this.destroyed = true;
        process.off("exit", this.killSubscribe);
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = undefined;
        }
        this.killSubscribe();
    }

    private killSubscribe = () => {
        if (!this.subscribeProc) return;
        this.subscribeProc.removeAllListeners();
        this.subscribeProc.kill();
        this.subscribeProc = undefined;
    };
}

function clampVolume(volume: number) {
    return Math.max(0, Math.min(1.5, volume));
}

// pactl 的裸整数音量以 65536 为 100%
function scaledVolume(volume: number) {
    return Math.round(volume * VOLUME_SCALE);
}

// 和服务器回读的精度保持一致，避免自己的修改又触发一次 change 事件
function quantizeVolume(volume: number) {
    return Math.round(volume * VOLUME_SCALE) / VOLUME_SCALE;
}

function muteValue(mute: boolean | "toggle") {
    return mute === "toggle" ? "toggle" : mute ? "1" : "0";
}
