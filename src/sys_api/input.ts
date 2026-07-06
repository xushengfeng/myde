import { type DeviceEntry, DeviceScanner, type FsLike as ScannerFs } from "./input/device_scanner";
import { EvdevReader, type FsLike as ReaderFs } from "./input/evdev_reader";
import { EventEmitter } from "./input/event_emitter";

export type InputDeviceType = "keyboard" | "mouse" | "touchpad" | "touchscreen" | "tablet" | "gamepad" | "unknown";

export interface InputEvent {
    device: InputDevice;
    type: number;
    code: number;
    value: number;
    timestamp: number;
}

export interface InputDeviceEvents {
    event: [InputEvent];
    key: [InputEvent];
    keyDown: [InputEvent];
    keyUp: [InputEvent];
    keyRepeat: [InputEvent];
    relative: [InputEvent];
    absolute: [InputEvent];
    sync: [InputEvent];
    error: [Error];
}

export interface InputManagerEvents {
    event: [InputEvent];
    key: [InputEvent];
    keyDown: [InputEvent];
    keyUp: [InputEvent];
    keyRepeat: [InputEvent];
    relative: [InputEvent];
    absolute: [InputEvent];
    sync: [InputEvent];
    error: [Error];
    deviceAdded: [InputDevice];
    deviceRemoved: [InputDevice];
}

export type FsLike = ScannerFs & ReaderFs;

export class InputDevice extends EventEmitter<InputDeviceEvents> {
    readonly path: string;
    readonly name: string;
    readonly type: InputDeviceType;
    private reader: EvdevReader | null = null;
    private fs: FsLike;

    constructor(path: string, name: string, type: InputDeviceType, fs: FsLike) {
        super();
        this.path = path;
        this.name = name;
        this.type = type;
        this.fs = fs;
    }

    open(): void {
        this.reader = new EvdevReader(this, this.fs);

        this.reader.on("event", (event: InputEvent) => {
            this.emit("event", event);

            switch (event.type) {
                case 1: // EV_KEY
                    this.emit("key", event);
                    if (event.value === 1) this.emit("keyDown", event);
                    else if (event.value === 0) this.emit("keyUp", event);
                    else if (event.value === 2) this.emit("keyRepeat", event);
                    break;
                case 2: // EV_REL
                    this.emit("relative", event);
                    break;
                case 3: // EV_ABS
                    this.emit("absolute", event);
                    break;
                case 0: // EV_SYN
                    if (event.code === 0) {
                        // SYN_REPORT
                        this.emit("sync", event);
                    }
                    break;
            }
        });

        this.reader.on("error", (err: Error) => {
            this.emit("error", err);
        });

        this.reader.open();
    }

    close(): void {
        this.reader?.close();
        this.reader = null;
    }
}

export class InputManager extends EventEmitter<InputManagerEvents> {
    private scanner: DeviceScanner;
    private devices = new Map<string, InputDevice>();
    private fs: FsLike;

    constructor(fs: FsLike) {
        super();
        this.fs = fs;
        this.scanner = new DeviceScanner(fs);
    }

    async init(): Promise<void> {
        const deviceInfos = await this.scanner.scan();

        for (const info of deviceInfos) {
            this.addDevice(info.path, info.name, info.type);
        }

        this.scanner.on("deviceAdded", (info: DeviceEntry) => {
            const device = this.addDevice(info.path, info.name, info.type);
            this.emit("deviceAdded", device);
        });

        this.scanner.on("deviceRemoved", (info: DeviceEntry) => {
            this.removeDevice(info.path);
        });
    }

    private addDevice(path: string, name: string, type: InputDeviceType): InputDevice {
        const device = new InputDevice(path, name, type, this.fs);

        device.on("event", (event) => this.emit("event", event));
        device.on("key", (event) => this.emit("key", event));
        device.on("keyDown", (event) => this.emit("keyDown", event));
        device.on("keyUp", (event) => this.emit("keyUp", event));
        device.on("keyRepeat", (event) => this.emit("keyRepeat", event));
        device.on("relative", (event) => this.emit("relative", event));
        device.on("absolute", (event) => this.emit("absolute", event));
        device.on("sync", (event) => this.emit("sync", event));

        device.on("error", (err) => {
            console.warn(`[Input] 设备 ${name} 读取失败:`, err.message);
            this.emit("error", err);
            this.removeDevice(path);
        });

        device.open();
        this.devices.set(path, device);
        return device;
    }

    private removeDevice(path: string): void {
        const device = this.devices.get(path);
        if (device) {
            device.close();
            this.devices.delete(path);
            this.emit("deviceRemoved", device);
        }
    }

    getDevices(): InputDevice[] {
        return Array.from(this.devices.values());
    }

    getDevice(path: string): InputDevice | undefined {
        return this.devices.get(path);
    }

    destroy(): void {
        for (const device of this.devices.values()) {
            device.close();
        }
        this.devices.clear();
        this.scanner.destroy();
    }
}
