import { dbusClient, dbusInterface, type dbusIO } from "myde-dbus";

export class power {
    private dbus: dbusIO;
    private client: dbusClient;
    private devices = new Map<string, powerDevice>();
    private onMap = new Map<string, Set<(...args: unknown[]) => unknown>>(); // todo 类型 提取为一个lib

    constructor(dbus: dbusIO) {
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

        infc.on<"o">("DeviceAdded", async (path) => {
            const device = new powerDevice(this.client, path);
            await device.init();
            this.devices.set(path, device);
            // todo emit
        });
        infc.on<"o">("DeviceRemoved", async (path) => {
            this.devices.delete(path);
        });
    }
    getDevices() {
        return Array.from(this.devices.values());
    }
}

export class powerDevice {
    private client: dbusClient;
    private path: string;
    // @ts-expect-error
    private infc: dbusInterface;
    constructor(client: dbusClient, path: string) {
        this.client = client;
        this.path = path;
    }
    async init() {
        const o = await (await this.client.getService("org.freedesktop.UPower")).getObject(this.path);
        this.infc = await o.getInterface("org.freedesktop.UPower.Device");
    }
    async getPercentage() {
        const per = await this.infc.get<"d">("Percentage");
        return per[0];
    }
    // todo on change
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
