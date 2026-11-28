import { dbusClient, type dbusInterface, type dbusIO } from "myde-dbus";
import { EventEmitter } from "../event-emitter/event-emitter";

export type PowerEvents = {
    "device-added": [device: powerDevice];
    "device-removed": [path: string];
};

export type PowerDeviceEvents = {
    changed: [changedProperties: Record<string, unknown>];
    /** UPower `EnergyRate` 变化，单位 W */
    "energy-rate-changed": [rate: number];
};

export type PowerProfile = {
    name: string;
    cpuDriver?: string[];
    platformDriver?: string[];
    driver?: string;
};

export type PowerProfilesEvents = {
    changed: [activeProfile: string];
};

export class power extends EventEmitter<PowerEvents> {
    private dbus: dbusIO;
    private client: dbusClient;
    private devices = new Map<string, powerDevice>();

    constructor(dbus: dbusIO) {
        super();
        this.dbus = dbus;
        this.client = new dbusClient({ io: dbus });
    }

    async init() {
        await this.dbus.connect();
        const s = await this.client.getService("org.freedesktop.UPower");
        const x = await s.getObject("/org/freedesktop/UPower");
        const infc = await x.getInterface("org.freedesktop.UPower");
        const [devices] = await infc.call("EnumerateDevices").as<"ao">();

        for (const path of devices) {
            const device = new powerDevice(this.client, path);
            await device.init();
            this.devices.set(path, device);
        }

        await infc.on<"o">("DeviceAdded", async (path) => {
            if (this.devices.has(path)) return;
            const device = new powerDevice(this.client, path);
            await device.init();
            this.devices.set(path, device);
            this.emit("device-added", device);
        });
        await infc.on<"o">("DeviceRemoved", (path) => {
            const device = this.devices.get(path);
            if (!device) return;
            device.destroy();
            this.devices.delete(path);
            this.emit("device-removed", path);
        });
    }
    getDevices() {
        return Array.from(this.devices.values());
    }
}

export class powerDevice extends EventEmitter<PowerDeviceEvents> {
    private client: dbusClient;
    path: string;
    // @ts-expect-error
    private infc: dbusInterface;
    private ready = false;
    private changedUnsub?: () => void;
    constructor(client: dbusClient, path: string) {
        super();
        this.client = client;
        this.path = path;
    }
    async init() {
        if (this.ready) return;
        const o = await (await this.client.getService("org.freedesktop.UPower")).getObject(this.path);
        this.infc = await o.getInterface("org.freedesktop.UPower.Device");
        this.changedUnsub = await this.infc.propertiesChanged((changedProperties) => {
            this.emit("changed", changedProperties);
            const raw = changedProperties.EnergyRate;
            const rate = Array.isArray(raw) ? raw[0] : raw;
            if (typeof rate === "number" && Number.isFinite(rate)) {
                this.emit("energy-rate-changed", rate);
            }
        });
        this.ready = true;
    }
    destroy() {
        this.changedUnsub?.();
        this.changedUnsub = undefined;
        this.ready = false;
        this.removeAllListeners("changed");
        this.removeAllListeners("energy-rate-changed");
    }
    /** 当前功率，单位 W；插电或设备不报告时可能为 0 */
    async getEnergyRate() {
        const [rate] = await this.infc.get<"d">("EnergyRate");
        return rate;
    }
    /** 当前能量，单位 Wh */
    async getEnergy() {
        const [energy] = await this.infc.get<"d">("Energy");
        return energy;
    }
    async getPercentage() {
        const per = await this.infc.get<"d">("Percentage");
        return per[0];
    }
    async getState() {
        const state = await this.infc.get<"u">("State");
        switch (state[0]) {
            case 0:
                return "Unknown";
            case 1:
                return "Charging";
            case 2:
                return "Discharging";
            case 3:
                return "Empty";
            case 4:
                return "Fully charged";
            case 5:
                return "Pending charge";
            case 6:
                return "Pending discharge";
        }
        return "Unknown";
    }
    async isCharging() {
        return (await this.getState()) === "Charging";
    }
    async getPowerSupply() {
        const powerSupply = await this.infc.get<"b">("PowerSupply");
        return powerSupply[0];
    }
    async getType() {
        const type = await this.infc.get<"u">("Type");
        switch (type[0]) {
            case 0:
                return "Unknown";
            case 1:
                return "Line Power";
            case 2:
                return "Battery";
            case 3:
                return "Ups";
            case 4:
                return "Monitor";
            case 5:
                return "Mouse";
            case 6:
                return "Keyboard";
            case 7:
                return "Pda";
            case 8:
                return "Phone";
            case 9:
                return "Media Player";
            case 10:
                return "Tablet";
            case 11:
                return "Computer";
            case 12:
                return "Gaming Input";
            case 13:
                return "Pen";
            case 14:
                return "Touchpad";
            case 15:
                return "Modem";
            case 16:
                return "Network";
            case 17:
                return "Headset";
            case 18:
                return "Speakers";
            case 19:
                return "Headphones";
            case 20:
                return "Video";
            case 21:
                return "Other Audio";
            case 22:
                return "Remote Control";
            case 23:
                return "Printer";
            case 24:
                return "Scanner";
            case 25:
                return "Camera";
            case 26:
                return "Wearable";
            case 27:
                return "Toy";
            case 28:
                return "Bluetooth Generic";
        }
        return "Unknown";
    }
    async getModel() {
        const model = await this.infc.get<"s">("Model");
        return model[0];
    }
}

/** 性能模式，来自 power-profiles-daemon 的 D-Bus 接口 */
export class powerProfiles extends EventEmitter<PowerProfilesEvents> {
    private dbus: dbusIO;
    private client: dbusClient;
    private infc?: dbusInterface;

    constructor(dbus: dbusIO) {
        super();
        this.dbus = dbus;
        this.client = new dbusClient({ io: dbus });
    }

    /** 找到 power-profiles-daemon 并监听 ActiveProfile，没有时返回 false */
    async init() {
        await this.dbus.connect();
        // 新版使用 org.freedesktop.UPower.PowerProfiles，旧版只有 net.hadess.PowerProfiles
        const candidates = [
            {
                service: "org.freedesktop.UPower.PowerProfiles",
                path: "/org/freedesktop/UPower/PowerProfiles",
                interface: "org.freedesktop.UPower.PowerProfiles",
            },
            {
                service: "net.hadess.PowerProfiles",
                path: "/net/hadess/PowerProfiles",
                interface: "net.hadess.PowerProfiles",
            },
        ];
        for (const candidate of candidates) {
            try {
                const service = await this.client.getService(candidate.service);
                const object = await service.getObject(candidate.path);
                const infc = await object.getInterface(candidate.interface);
                // getInterface 不检查对象是否存在，读一次属性确认服务可用
                await infc.get<"s">("ActiveProfile");
                this.infc = infc;
                await infc.propertiesChanged((changedProperties) => {
                    const active = changedProperties.ActiveProfile;
                    if (typeof active === "string") {
                        this.emit("changed", active);
                    } else if (Array.isArray(active) && typeof active[0] === "string") {
                        this.emit("changed", active[0]);
                    }
                });
                return true;
            } catch {
                // 尝试下一个服务名
            }
        }
        return false;
    }

    private iface() {
        if (!this.infc) throw new Error("powerProfiles 未初始化或 power-profiles-daemon 不可用");
        return this.infc;
    }

    async getProfiles(): Promise<PowerProfile[]> {
        const [profiles] = await this.iface().get<"aa{sv}">("Profiles");
        return profiles
            .map((entries) => {
                const data = Object.fromEntries(entries.map(([key, value]) => [key, value.value]));
                return {
                    name: String(data.Profile ?? ""),
                    cpuDriver: data.CpuDriver as string[] | undefined,
                    platformDriver: data.PlatformDriver as string[] | undefined,
                    driver: data.Driver as string | undefined,
                };
            })
            .filter((profile) => profile.name !== "");
    }

    async getActiveProfile() {
        const [profile] = await this.iface().get<"s">("ActiveProfile");
        return profile;
    }

    async setActiveProfile(profile: string) {
        await this.iface().set<"s">("ActiveProfile", [profile], "s");
    }
}
