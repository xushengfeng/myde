import { dbusClient, type dbusInterface, type dbusIO } from "myde-dbus";
import { EventEmitter } from "../event-emitter/event-emitter";

export type NetworkEvents = {
    changed: [changedProperties: Record<string, unknown>];
    "device-added": [device: wifiDevice];
    "device-removed": [path: string];
};

export type WifiDeviceEvents = {
    changed: [changedProperties: Record<string, unknown>];
    "access-point-added": [accessPoint: accessPoint];
    "access-point-removed": [path: string];
    "access-point-changed": [accessPoint: accessPoint];
};

export type AccessPointEvents = {
    changed: [changedProperties: Record<string, unknown>];
};

export class network extends EventEmitter<NetworkEvents> {
    private dbus: dbusIO;
    private client: dbusClient;
    private wifiDevices = new Map<string, wifiDevice>();

    constructor(dbus: dbusIO) {
        super();
        this.dbus = dbus;
        this.client = new dbusClient({ io: dbus });
    }

    async init() {
        await this.dbus.connect();
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const obj = await s.getObject("/org/freedesktop/NetworkManager");
        const infc = await obj.getInterface("org.freedesktop.NetworkManager");

        await infc.propertiesChanged((changedProperties) => {
            this.emit("changed", changedProperties);
        });

        const [devicePaths] = await infc.call("GetDevices").as<"ao">();

        for (const path of devicePaths) {
            try {
                const devObj = await s.getObject(path);
                const devIface = await devObj.getInterface("org.freedesktop.NetworkManager.Device");
                const [deviceType] = await devIface.get<"u">("DeviceType");

                if (deviceType === 2) {
                    const wifiDev = new wifiDevice(this.client, path);
                    await wifiDev.init();
                    this.wifiDevices.set(path, wifiDev);
                }
            } catch {
                // Skip devices that can't be accessed
            }
        }

        await infc.on<"oo">("DeviceAdded", async (path) => {
            if (this.wifiDevices.has(path)) return;
            try {
                const devObj = await s.getObject(path);
                const devIface = await devObj.getInterface("org.freedesktop.NetworkManager.Device");
                const [deviceType] = await devIface.get<"u">("DeviceType");

                if (deviceType === 2) {
                    const device = new wifiDevice(this.client, path);
                    await device.init();
                    this.wifiDevices.set(path, device);
                    this.emit("device-added", device);
                }
            } catch {
                // Skip devices that can't be accessed
            }
        });

        await infc.on<"oo">("DeviceRemoved", (path) => {
            const device = this.wifiDevices.get(path);
            if (!device) return;
            device.destroy();
            this.wifiDevices.delete(path);
            this.emit("device-removed", path);
        });
    }

    getWifiDevices() {
        return Array.from(this.wifiDevices.values());
    }

    async getActiveWifiConnection() {
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const obj = await s.getObject("/org/freedesktop/NetworkManager");
        const infc = await obj.getInterface("org.freedesktop.NetworkManager");
        const [activeConnections] = await infc.get<"ao">("ActiveConnections");

        for (const connPath of activeConnections) {
            try {
                const connObj = await s.getObject(connPath);
                const connIface = await connObj.getInterface("org.freedesktop.NetworkManager.Connection.Active");
                const [type] = await connIface.get<"s">("Type");
                const [state] = await connIface.get<"u">("State");

                if (type === "802-11-wireless" && state === 2) {
                    const [id] = await connIface.get<"s">("Id");
                    const [specificObject] = await connIface.get<"o">("SpecificObject");
                    const [devices] = await connIface.get<"ao">("Devices");

                    return {
                        path: connPath,
                        id,
                        type,
                        state,
                        specificObject,
                        devicePath: devices[0] || null,
                    };
                }
            } catch {
                // Skip connections that can't be accessed
            }
        }

        return null;
    }

    async getState() {
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const obj = await s.getObject("/org/freedesktop/NetworkManager");
        const infc = await obj.getInterface("org.freedesktop.NetworkManager");
        const [state] = await infc.get<"u">("State");
        return state;
    }

    async isNetworkingEnabled() {
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const obj = await s.getObject("/org/freedesktop/NetworkManager");
        const infc = await obj.getInterface("org.freedesktop.NetworkManager");
        const [enabled] = await infc.get<"b">("NetworkingEnabled");
        return enabled;
    }

    async isWirelessEnabled() {
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const obj = await s.getObject("/org/freedesktop/NetworkManager");
        const infc = await obj.getInterface("org.freedesktop.NetworkManager");
        const [enabled] = await infc.get<"b">("WirelessEnabled");
        return enabled;
    }

    async setWirelessEnabled(enabled: boolean) {
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const obj = await s.getObject("/org/freedesktop/NetworkManager");
        const infc = await obj.getInterface("org.freedesktop.NetworkManager");
        await infc.set<"b">("WirelessEnabled", [enabled], "b");
    }
}

// todo 有线设备
export class wifiDevice extends EventEmitter<WifiDeviceEvents> {
    private client: dbusClient;
    private path: string;
    // @ts-expect-error
    private infc: dbusInterface;
    // @ts-expect-error
    private wirelessIface: dbusInterface;
    private accessPoints = new Map<string, accessPoint>();
    private ready = false;
    private unsubs: (() => void)[] = [];
    private refreshing: Promise<accessPoint[]> | undefined;

    constructor(client: dbusClient, path: string) {
        super();
        this.client = client;
        this.path = path;
    }

    async init() {
        if (this.ready) return;
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const o = await s.getObject(this.path);
        this.infc = await o.getInterface("org.freedesktop.NetworkManager.Device");
        this.wirelessIface = await o.getInterface("org.freedesktop.NetworkManager.Device.Wireless");

        this.unsubs.push(
            await this.infc.propertiesChanged((changedProperties) => {
                this.emit("changed", changedProperties);
            }),
        );
        this.unsubs.push(
            await this.wirelessIface.propertiesChanged((changedProperties) => {
                this.emit("changed", changedProperties);
                if (
                    "AccessPoints" in changedProperties ||
                    "LastScan" in changedProperties ||
                    "ActiveAccessPoint" in changedProperties
                ) {
                    void this.refreshAccessPoints().catch((error) => {
                        console.warn("network: refresh access points error", error);
                    });
                }
            }),
        );

        this.ready = true;
        await this.refreshAccessPoints().catch((error) => {
            console.warn("network: get access points error", error);
        });
    }

    destroy() {
        for (const unsub of this.unsubs) unsub();
        this.unsubs = [];
        for (const ap of this.accessPoints.values()) ap.destroy();
        this.accessPoints.clear();
        this.ready = false;
        this.removeAllListeners("changed");
        this.removeAllListeners("access-point-added");
        this.removeAllListeners("access-point-removed");
        this.removeAllListeners("access-point-changed");
    }

    async getInterface() {
        const [iface] = await this.infc.get<"s">("Interface");
        return iface;
    }

    async getState() {
        const [state] = await this.infc.get<"u">("State");
        return state;
    }

    async getDeviceType() {
        const [deviceType] = await this.infc.get<"u">("DeviceType");
        return deviceType;
    }

    async getAccessPoints() {
        return await this.refreshAccessPoints();
    }

    private async refreshAccessPoints() {
        if (this.refreshing) return await this.refreshing;
        let task: Promise<accessPoint[]>;
        task = this.doRefreshAccessPoints().finally(() => {
            if (this.refreshing === task) this.refreshing = undefined;
        });
        this.refreshing = task;
        return await task;
    }

    private async doRefreshAccessPoints() {
        const [apPaths] = await this.wirelessIface.call("GetAccessPoints").as<"ao">();
        const nextPaths = new Set(apPaths);

        for (const [path, ap] of this.accessPoints) {
            if (nextPaths.has(path)) continue;
            ap.destroy();
            this.accessPoints.delete(path);
            this.emit("access-point-removed", path);
        }

        const result: accessPoint[] = [];
        for (const path of apPaths) {
            let ap = this.accessPoints.get(path);
            if (!ap) {
                const created = new accessPoint(this.client, path);
                this.accessPoints.set(path, created);
                try {
                    await created.init();
                } catch {
                    this.accessPoints.delete(path);
                    continue;
                }
                created.on("changed", () => this.emit("access-point-changed", created));
                this.emit("access-point-added", created);
                ap = created;
            }
            result.push(ap);
        }

        return result;
    }

    async requestScan() {
        await this.wirelessIface.call("RequestScan", "a{sv}", []).await();
    }

    async getActiveAccessPoint() {
        try {
            const [apPath] = await this.wirelessIface.get<"o">("ActiveAccessPoint");
            if (apPath && apPath !== "/") {
                const cached = this.accessPoints.get(apPath);
                if (cached) return cached;
                const ap = new accessPoint(this.client, apPath);
                await ap.init();
                return ap;
            }
        } catch {
            // No active access point
        }
        return null;
    }

    async getSavedConnections() {
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const settingsObj = await s.getObject("/org/freedesktop/NetworkManager/Settings");
        const settingsIface = await settingsObj.getInterface("org.freedesktop.NetworkManager.Settings");
        const [connPaths] = await settingsIface.call("ListConnections").as<"ao">();

        const savedConnections: { path: string; id: string; ssid: string }[] = [];

        for (const connPath of connPaths) {
            try {
                const connObj = await s.getObject(connPath);
                const connIface = await connObj.getInterface("org.freedesktop.NetworkManager.Settings.Connection");
                const [settings] = await connIface.call("GetSettings").as<"a{sa{sv}}">();

                // The settings are returned as an array of key-value pairs
                // where each key is a section name and value is a dict of key-value pairs
                for (const [section, sectionSettings] of settings) {
                    if (section === "connection") {
                        const connectionSettings = sectionSettings as [string, { value: unknown }][];
                        let id = "";
                        let type = "";

                        for (const [key, valueObj] of connectionSettings) {
                            if (key === "id") {
                                // value is an array with one element
                                id = (valueObj.value as string[])[0];
                            } else if (key === "type") {
                                type = (valueObj.value as string[])[0];
                            }
                        }

                        if (type === "802-11-wireless") {
                            // Find the wireless section
                            for (const [wirelessSection, wirelessSettings] of settings) {
                                if (wirelessSection === "802-11-wireless") {
                                    const wirelessDict = wirelessSettings as [string, { value: unknown }][];
                                    for (const [key, valueObj] of wirelessDict) {
                                        if (key === "ssid") {
                                            const ssidBytes = (valueObj.value as number[][])[0];
                                            const ssid = Buffer.from(ssidBytes).toString("utf-8");
                                            savedConnections.push({
                                                path: connPath,
                                                id,
                                                ssid,
                                            });
                                            break;
                                        }
                                    }
                                    break;
                                }
                            }
                        }
                        break;
                    }
                }
            } catch {
                // Skip connections that can't be accessed
            }
        }

        return savedConnections;
    }

    async connect(ssid: string) {
        const savedConnections = await this.getSavedConnections();
        const targetConn = savedConnections.find((conn) => conn.ssid === ssid);

        if (!targetConn) {
            throw new Error(`No saved connection found for SSID: ${ssid}`);
        }

        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const nmObj = await s.getObject("/org/freedesktop/NetworkManager");
        const nmIface = await nmObj.getInterface("org.freedesktop.NetworkManager");

        const accessPoints = await this.getAccessPoints();
        const targetAp = accessPoints.find(async (ap) => (await ap.getSsid()) === ssid);

        if (!targetAp) {
            throw new Error(`Access point not found for SSID: ${ssid}`);
        }

        const apPath = targetAp.getPath();

        await nmIface.call("ActivateConnection", "ooo", targetConn.path, this.path, apPath).as<"o">();
    }

    async disconnect() {
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const nmObj = await s.getObject("/org/freedesktop/NetworkManager");
        const nmIface = await nmObj.getInterface("org.freedesktop.NetworkManager");
        const [activeConnections] = await nmIface.get<"ao">("ActiveConnections");

        for (const connPath of activeConnections) {
            try {
                const connObj = await s.getObject(connPath);
                const connIface = await connObj.getInterface("org.freedesktop.NetworkManager.Connection.Active");
                const [devices] = await connIface.get<"ao">("Devices");

                if (devices.includes(this.path)) {
                    await nmIface.call("DeactivateConnection", "o", connPath).await();
                    return;
                }
            } catch {
                // Skip connections that can't be accessed
            }
        }

        throw new Error("No active connection found for this device");
    }

    getPath() {
        return this.path;
    }
}

export class accessPoint extends EventEmitter<AccessPointEvents> {
    private client: dbusClient;
    private path: string;
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
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const o = await s.getObject(this.path);
        this.infc = await o.getInterface("org.freedesktop.NetworkManager.AccessPoint");
        this.changedUnsub = await this.infc.propertiesChanged((changedProperties) => {
            this.emit("changed", changedProperties);
        });
        this.ready = true;
    }

    destroy() {
        this.changedUnsub?.();
        this.changedUnsub = undefined;
        this.ready = false;
        this.removeAllListeners("changed");
    }

    async getSsid() {
        const [ssid] = await this.infc.get<"ay">("Ssid");
        return Buffer.from(ssid).toString("utf-8");
    }

    async getStrength() {
        const [strength] = await this.infc.get<"y">("Strength");
        return strength;
    }

    async getFrequency() {
        const [frequency] = await this.infc.get<"u">("Frequency");
        return frequency;
    }

    async getHwAddress() {
        const [address] = await this.infc.get<"s">("HwAddress");
        return address;
    }

    async getMaxBitrate() {
        const [bitrate] = await this.infc.get<"u">("MaxBitrate");
        return bitrate;
    }

    async isActive() {
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const nmObj = await s.getObject("/org/freedesktop/NetworkManager");
        const nmIface = await nmObj.getInterface("org.freedesktop.NetworkManager");
        const [activeConnections] = await nmIface.get<"ao">("ActiveConnections");

        for (const connPath of activeConnections) {
            try {
                const connObj = await s.getObject(connPath);
                const connIface = await connObj.getInterface("org.freedesktop.NetworkManager.Connection.Active");
                const [specificObject] = await connIface.get<"o">("SpecificObject");

                if (specificObject === this.path) {
                    return true;
                }
            } catch {
                // Skip connections that can't be accessed
            }
        }

        return false;
    }

    getPath() {
        return this.path;
    }
}
