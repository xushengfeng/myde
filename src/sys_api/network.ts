import { dbusClient, dbusInterface, type dbusIO } from "myde-dbus";

export class network {
    private dbus: dbusIO;
    private client: dbusClient;
    private wifiDevices = new Map<string, wifiDevice>();
    private onMap = new Map<string, Set<(...args: unknown[]) => unknown>>();

    constructor(dbus: dbusIO) {
        this.dbus = dbus;
        this.client = new dbusClient({ io: dbus });
    }

    async init() {
        await this.dbus.connect();
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const obj = await s.getObject("/org/freedesktop/NetworkManager");
        const infc = await obj.getInterface("org.freedesktop.NetworkManager");

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

        infc.on<"oo">("DeviceAdded", async (path) => {
            try {
                const devObj = await s.getObject(path);
                const devIface = await devObj.getInterface("org.freedesktop.NetworkManager.Device");
                const [deviceType] = await devIface.get<"u">("DeviceType");

                if (deviceType === 2) {
                    const device = new wifiDevice(this.client, path);
                    await device.init();
                    this.wifiDevices.set(path, device);
                }
            } catch {
                // Skip devices that can't be accessed
            }
        });

        infc.on<"oo">("DeviceRemoved", async (path) => {
            this.wifiDevices.delete(path);
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
export class wifiDevice {
    private client: dbusClient;
    private path: string;
    // @ts-expect-error
    private infc: dbusInterface;
    // @ts-expect-error
    private wirelessIface: dbusInterface;

    constructor(client: dbusClient, path: string) {
        this.client = client;
        this.path = path;
    }

    async init() {
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const o = await s.getObject(this.path);
        this.infc = await o.getInterface("org.freedesktop.NetworkManager.Device");
        this.wirelessIface = await o.getInterface("org.freedesktop.NetworkManager.Device.Wireless");
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
        const [apPaths] = await this.wirelessIface.call("GetAccessPoints").as<"ao">();
        const accessPoints: accessPoint[] = [];

        for (const apPath of apPaths) {
            try {
                const ap = new accessPoint(this.client, apPath);
                await ap.init();
                accessPoints.push(ap);
            } catch {
                // Skip access points that can't be accessed
            }
        }

        return accessPoints;
    }

    async requestScan() {
        await this.wirelessIface.call("RequestScan", "a{sv}", []).await();
    }

    async getActiveAccessPoint() {
        try {
            const [apPath] = await this.wirelessIface.get<"o">("ActiveAccessPoint");
            if (apPath && apPath !== "/") {
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

export class accessPoint {
    private client: dbusClient;
    private path: string;
    // @ts-expect-error
    private infc: dbusInterface;

    constructor(client: dbusClient, path: string) {
        this.client = client;
        this.path = path;
    }

    async init() {
        const s = await this.client.getService("org.freedesktop.NetworkManager");
        const o = await s.getObject(this.path);
        this.infc = await o.getInterface("org.freedesktop.NetworkManager.AccessPoint");
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
