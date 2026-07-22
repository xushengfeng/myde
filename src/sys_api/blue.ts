import { dbusClient, dbusInterface, type dbusIO } from "myde-dbus";

export class blue {
    private dbus: dbusIO;
    private client: dbusClient;
    private devices = new Map<string, blueDevice>();

    constructor(dbus: dbusIO) {
        this.dbus = dbus;
        this.client = new dbusClient({ io: dbus });
    }

    async init() {
        await this.dbus.connect();
        const s = await this.client.getService("org.bluez");
        const adapter = await s.getObject("/org/bluez/hci0");
        const infc = await adapter.getInterface("org.bluez.Adapter1");

        const objects = await (await this.client.getService("org.bluez")).getObject("/");
        const introspectable = await objects.getInterface("org.freedesktop.DBus.ObjectManager");
        const [managedObjects] = await introspectable.call("GetManagedObjects").as<"a{oa{sa{sv}}}">();

        for (const [path, interfaces] of managedObjects) {
            for (const [interfaceName] of interfaces) {
                if (interfaceName === "org.bluez.Device1") {
                    const device = new blueDevice(this.client, path);
                    await device.init();
                    this.devices.set(path, device);
                }
            }
        }

        const objectManager = await (await this.client.getService("org.bluez")).getObject("/");
        const objManagerIface = await objectManager.getInterface("org.freedesktop.DBus.ObjectManager");

        objManagerIface.on<"oa{sa{sv}}">("InterfacesAdded", async (path, interfaces) => {
            if (interfaces["org.bluez.Device1"]) {
                const device = new blueDevice(this.client, path);
                await device.init();
                this.devices.set(path, device);
            }
        });

        objManagerIface.on<"oas">("InterfacesRemoved", async (path, interfaces) => {
            if (interfaces.includes("org.bluez.Device1")) {
                this.devices.delete(path);
            }
        });
    }

    getDevices() {
        return Array.from(this.devices.values());
    }

    async getAdapterName() {
        const s = await this.client.getService("org.bluez");
        const adapter = await s.getObject("/org/bluez/hci0");
        const infc = await adapter.getInterface("org.bluez.Adapter1");
        const [name] = await infc.get<"s">("Name");
        return name;
    }

    async isPowered() {
        const s = await this.client.getService("org.bluez");
        const adapter = await s.getObject("/org/bluez/hci0");
        const infc = await adapter.getInterface("org.bluez.Adapter1");
        const [powered] = await infc.get<"b">("Powered");
        return powered;
    }

    async setPowered(powered: boolean) {
        const s = await this.client.getService("org.bluez");
        const adapter = await s.getObject("/org/bluez/hci0");
        const infc = await adapter.getInterface("org.bluez.Adapter1");
        await infc.set<"b">("Powered", [powered], "b");
    }

    async startDiscovery() {
        const s = await this.client.getService("org.bluez");
        const adapter = await s.getObject("/org/bluez/hci0");
        const infc = await adapter.getInterface("org.bluez.Adapter1");
        await infc.call("StartDiscovery").await();
    }

    async stopDiscovery() {
        const s = await this.client.getService("org.bluez");
        const adapter = await s.getObject("/org/bluez/hci0");
        const infc = await adapter.getInterface("org.bluez.Adapter1");
        await infc.call("StopDiscovery").await();
    }
}

export class blueDevice {
    private client: dbusClient;
    private path: string;
    // @ts-expect-error
    private infc: dbusInterface;

    constructor(client: dbusClient, path: string) {
        this.client = client;
        this.path = path;
    }

    async init() {
        const o = await (await this.client.getService("org.bluez")).getObject(this.path);
        this.infc = await o.getInterface("org.bluez.Device1");
    }

    async getName() {
        const [name] = await this.infc.get<"s">("Name");
        return name;
    }

    async getAddress() {
        const [address] = await this.infc.get<"s">("Address");
        return address;
    }

    async isConnected() {
        const [connected] = await this.infc.get<"b">("Connected");
        return connected;
    }

    async isTrusted() {
        const [trusted] = await this.infc.get<"b">("Trusted");
        return trusted;
    }

    async connect() {
        await this.infc.call("Connect").await();
    }

    async disconnect() {
        await this.infc.call("Disconnect").await();
    }

    async pair() {
        await this.infc.call("Pair").await();
    }

    async remove() {
        const s = await this.client.getService("org.bluez");
        const adapter = await s.getObject("/org/bluez/hci0");
        const infc = await adapter.getInterface("org.bluez.Adapter1");
        await infc.call("RemoveDevice", "o", this.path).await();
    }

    getPath() {
        return this.path;
    }
}
