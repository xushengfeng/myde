import type { InputDeviceType } from "../input";
import { EventEmitter } from "../../event-emitter/event-emitter";

export interface FsLike {
    readFileSync(path: string, options: { encoding: string } | string): string;
    existsSync(path: string): boolean;
    watch(path: string, listener: (eventType: string, filename: string | null) => void): { close(): void };
}

export interface DeviceEntry {
    path: string;
    name: string;
    type: InputDeviceType;
}

export type DeviceScannerEvents = {
    deviceAdded: [DeviceEntry];
    deviceRemoved: [DeviceEntry];
};

export class DeviceScanner extends EventEmitter<DeviceScannerEvents> {
    private devices = new Map<string, DeviceEntry>();
    private watcher: { close(): void } | null = null;
    private fs: FsLike;

    constructor(fs: FsLike) {
        super();
        this.fs = fs;
    }

    async scan(): Promise<DeviceEntry[]> {
        const devices = this.parseProcDevices();
        this.devices.clear();
        for (const device of devices) {
            this.devices.set(device.path, device);
        }
        this.startWatching();
        return devices;
    }

    private parseProcDevices(): DeviceEntry[] {
        let content: string;
        try {
            content = this.fs.readFileSync("/proc/bus/input/devices", "utf-8");
        } catch {
            return [];
        }

        const devices: DeviceEntry[] = [];
        let current: Partial<DeviceEntry> & { handlers?: string } = {};

        for (const line of content.split("\n")) {
            if (line === "" && current.path) {
                current.type = this.detectDeviceType(current.handlers ?? "");
                devices.push(current as DeviceEntry);
                current = {};
            } else if (line.startsWith("I:")) {
                // Bus, Vendor, Product 信息可用于更精确的设备识别
            } else if (line.startsWith("N:")) {
                current.name = line.match(/Name="?(.+?)"?$/)?.[1] ?? "";
            } else if (line.startsWith("H:")) {
                const eventMatch = line.match(/event(\d+)/);
                if (eventMatch) {
                    current.path = `/dev/input/event${eventMatch[1]}`;
                }
                current.handlers = line;
            }
        }

        if (current.path) {
            current.type = this.detectDeviceType(current.handlers ?? "");
            devices.push(current as DeviceEntry);
        }

        return devices;
    }

    private detectDeviceType(handlers: string): InputDeviceType {
        if (handlers.includes("kbd")) return "keyboard";
        if (handlers.includes("mouse")) return "mouse";
        if (handlers.includes("touchpad")) return "touchpad";
        if (handlers.includes("touchscreen")) return "touchscreen";
        if (handlers.includes("tablet")) return "tablet";
        if (handlers.includes("js")) return "gamepad";
        return "unknown";
    }

    private startWatching(): void {
        if (this.watcher) return;

        try {
            this.watcher = this.fs.watch("/dev/input", (_eventType, filename) => {
                if (!filename?.startsWith("event")) return;

                const path = `/dev/input/${filename}`;
                const exists = this.fs.existsSync(path);

                if (exists && !this.devices.has(path)) {
                    const device = this.findDeviceInProc(path);
                    if (device) {
                        this.devices.set(path, device);
                        this.emit("deviceAdded", device);
                    }
                } else if (!exists && this.devices.has(path)) {
                    const device = this.devices.get(path);
                    if (device) {
                        this.devices.delete(path);
                        this.emit("deviceRemoved", device);
                    }
                }
            });
        } catch {
            // 无法监视目录，忽略
        }
    }

    private findDeviceInProc(path: string): DeviceEntry | null {
        const devices = this.parseProcDevices();
        return devices.find((d) => d.path === path) ?? null;
    }

    destroy(): void {
        this.watcher?.close();
        this.watcher = null;
    }
}