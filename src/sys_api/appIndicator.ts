// Status Notifier Item also Tray

import { type DBusTypes, dbusClient, type dbusInterface, type dbusIO, dbusServer, MessageType } from "myde-dbus";
import { EventEmitter } from "../event-emitter/event-emitter";
import { getDesktopIcon } from "./application";
import { dbusMenu } from "./menu";

const WATCHER_NAME = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH = "/StatusNotifierWatcher";
const WATCHER_IFACE = "org.kde.StatusNotifierWatcher";
const ITEM_PATH = "/StatusNotifierItem";

const WATCHER_XML = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem"><arg name="service" type="s" direction="in"/></method>
    <method name="RegisterStatusNotifierHost"><arg name="service" type="s" direction="in"/></method>
    <signal name="StatusNotifierItemRegistered"><arg name="service" type="s"/></signal>
    <signal name="StatusNotifierItemUnregistered"><arg name="service" type="s"/></signal>
    <signal name="StatusNotifierHostRegistered"/>
    <signal name="StatusNotifierHostUnregistered"/>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
  </interface>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get"><arg name="interface" type="s" direction="in"/><arg name="property" type="s" direction="in"/><arg name="value" type="v" direction="out"/></method>
    <method name="GetAll"><arg name="interface" type="s" direction="in"/><arg name="props" type="a{sv}" direction="out"/></method>
    <signal name="PropertiesChanged"><arg name="interface" type="s"/><arg name="changed" type="a{sv}"/><arg name="invalidated" type="as"/></signal>
  </interface>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg name="xml" type="s" direction="out"/></method>
  </interface>
</node>`;

/** D-Bus variant：value 是签名解析出的值数组 */
type Variant = { signature: string; value: unknown[] };

export type TrayEvents = {
    new: [name: string];
    remove: [name: string];
    menuUpdate: [];
    changed: [name: string];
};

export type TrayItemEvents = {
    menuUpdate: [];
    changed: [];
};

export class tray {
    private dbus: dbusIO;
    private sniWatcher: dbusClient;
    private sniWatcherServer: dbusServer;
    /** dbusServer 的 handler 只有 body；记录当前 MethodCall 的 sender，供只传对象路径的注册使用 */
    private currentSender: string | undefined;
    /** item id（service + path）→ 注册它的 bus name */
    private items = new Map<string, string>();
    private hosts = new Set<string>();
    private hostRegistered = false;
    ev = new EventEmitter<TrayEvents>();
    tarysService = new Map<string, trayItem>();

    constructor(dbus: dbusIO) {
        this.dbus = dbus;
        this.sniWatcher = new dbusClient({ io: dbus });
        this.sniWatcherServer = new dbusServer(dbus, WATCHER_NAME);
        this.dbus.addMessageHandler((message) => {
            if (message.getType() === MessageType.MethodCall) this.currentSender = message.getSender();
        });
    }

    async init() {
        await this.dbus.connect();
        await this.#initWatcher();

        const watcher = await this.sniWatcher.getService(WATCHER_NAME);
        const infc = await (await watcher.getObject(WATCHER_PATH)).getInterface(WATCHER_IFACE);
        const [servicesNames] = await infc.get<"as">("RegisteredStatusNotifierItems");
        for (const name of servicesNames) {
            const item = new trayItem(name, this.dbus);
            await item.init();
            this.tarysService.set(name, item);
            this.bindItem(name, item);
        }
        await infc.on<"s">("StatusNotifierItemRegistered", async (name) => {
            if (this.tarysService.has(name)) return;
            const item = new trayItem(name, this.dbus);
            await item.init();
            this.tarysService.set(name, item);
            this.bindItem(name, item);
            this.ev.emit("new", name);
        });
        await infc.on<"s">("StatusNotifierItemUnregistered", (name) => {
            const item = this.tarysService.get(name);
            if (!item) return;
            item.destroy();
            this.tarysService.delete(name);
            this.ev.emit("remove", name);
        });
    }

    /** 成为 watcher；外部总线上已有 watcher 时会排队，仍然使用已有的那个 */
    async #initWatcher() {
        await this.sniWatcherServer.init();
        this.sniWatcherServer.addObject(WATCHER_PATH, WATCHER_IFACE, {
            RegisterStatusNotifierItem: (service: string) => this.#registerItem(service),
            RegisterStatusNotifierHost: (service: string) => this.#registerHost(service),
        });
        this.sniWatcherServer.addObject(WATCHER_PATH, "org.freedesktop.DBus.Properties", {
            Get: (iface: string, prop: string) => this.#getProperty(iface, prop),
            GetAll: (iface: string) => this.#getAllProperties(iface),
        });
        this.sniWatcherServer.addObject(WATCHER_PATH, "org.freedesktop.DBus.Introspectable", {
            Introspect: () => ({ signature: "s", value: [WATCHER_XML] }),
        });
        this.hostRegistered = true;
        await this.sniWatcherServer.emitSignal(WATCHER_PATH, WATCHER_IFACE, "StatusNotifierHostRegistered");

        const meta = await new dbusClient({ io: this.dbus }).getMetaInterface();
        await meta.onNameOwnerChanged((name, _oldOwner, newOwner) => {
            if (newOwner) return;
            this.hosts.delete(name);
            void this.#removeItemsByService(name);
        });
    }

    async #registerItem(serviceArg: string): Promise<undefined> {
        if (!serviceArg) return undefined;
        // 规范允许只传对象路径，此时用调用方唯一名补全
        const service = serviceArg.startsWith("/") ? this.currentSender : serviceArg;
        const path = serviceArg.startsWith("/") ? serviceArg : ITEM_PATH;
        if (!service || !path) return undefined;
        const item = `${service}${path}`;
        if (this.items.has(item)) return undefined;
        this.items.set(item, service);
        await this.sniWatcherServer.emitSignal(WATCHER_PATH, WATCHER_IFACE, "StatusNotifierItemRegistered", "s", [
            item,
        ]);
        return undefined;
    }

    async #registerHost(service: string): Promise<undefined> {
        if (!service || this.hosts.has(service)) return undefined;
        this.hosts.add(service);
        await this.sniWatcherServer.emitSignal(WATCHER_PATH, WATCHER_IFACE, "StatusNotifierHostRegistered");
        return undefined;
    }

    async #removeItemsByService(service: string) {
        for (const [item, itemService] of [...this.items]) {
            if (itemService !== service) continue;
            this.items.delete(item);
            await this.sniWatcherServer.emitSignal(WATCHER_PATH, WATCHER_IFACE, "StatusNotifierItemUnregistered", "s", [
                item,
            ]);
        }
    }

    #properties(): [string, Variant][] {
        return [
            ["RegisteredStatusNotifierItems", { signature: "as", value: [Array.from(this.items.keys())] }],
            ["IsStatusNotifierHostRegistered", { signature: "b", value: [this.hostRegistered || this.hosts.size > 0] }],
            ["ProtocolVersion", { signature: "i", value: [0] }],
        ];
    }

    #getProperty(iface: string, prop: string) {
        if (iface !== WATCHER_IFACE) throw new Error(`未知接口 ${iface}`);
        const entry = this.#properties().find(([name]) => name === prop);
        if (!entry) throw new Error(`未知属性 ${prop}`);
        return { signature: "v", value: [entry[1]] };
    }

    #getAllProperties(iface: string) {
        if (iface !== WATCHER_IFACE) return { signature: "a{sv}", value: [[]] };
        return { signature: "a{sv}", value: [this.#properties()] };
    }

    private bindItem(name: string, item: trayItem) {
        item.ev.on("menuUpdate", () => this.ev.emit("menuUpdate"));
        item.ev.on("changed", () => this.ev.emit("changed", name));
    }
}

export class trayItem {
    private client: dbusClient;
    private path: string;
    private menuPath: dbusMenu | undefined;
    // @ts-expect-error
    private mainInterface: dbusInterface;
    private unsubs: (() => void)[] = [];
    ev = new EventEmitter<TrayItemEvents>();
    constructor(path: string, io: dbusIO) {
        this.client = new dbusClient({ io });
        this.path = path;
    }
    async init() {
        const b = this.path.indexOf("/");
        const service = this.path.slice(0, b);
        const objPath = this.path.slice(b);
        const serviceClient = await this.client.getService(service);
        const trayItemObj = await serviceClient.getObject(objPath);
        const infc = await trayItemObj.getInterface("org.kde.StatusNotifierItem");
        this.mainInterface = infc;

        const changed = () => this.ev.emit("changed");
        this.unsubs.push(await infc.propertiesChanged(changed));
        for (const signal of ["NewIcon", "NewTitle", "NewToolTip", "NewAttentionIcon"]) {
            this.unsubs.push(await infc.on(signal, changed));
        }
        this.unsubs.push(await infc.on<"s">("NewStatus", changed));

        try {
            const menuPath = (await infc.get<"o">("Menu"))[0];
            if (menuPath) {
                this.menuPath = new dbusMenu(this.client, { serverName: service, objectPath: menuPath });
                await this.menuPath.init();
                this.menuPath.ev.on("update", () => {
                    this.ev.emit("menuUpdate");
                });
            }
        } catch (error) {
            console.warn("tray Menu property not available:", error);
        }
    }
    destroy() {
        for (const unsub of this.unsubs) unsub();
        this.unsubs = [];
        this.menuPath?.destroy();
        this.menuPath = undefined;
        this.ev.removeAllListeners("menuUpdate");
        this.ev.removeAllListeners("changed");
    }
    async title() {
        return (await this.mainInterface.get<"s">("Title"))[0];
    }
    /** true 可视化程序应优先显示菜单或发送 ContextMenu() 而不是 Activate() */
    async itemIsMenu() {
        try {
            return (await this.mainInterface.get<"b">("ItemIsMenu"))[0];
        } catch (error) {
            console.error("tray ItemIsMenu error", error);
            return true;
        }
    }
    async getIcon(op?: { size?: number; scale?: number; theme?: string }) {
        let iconName: string | undefined;
        try {
            iconName = (await this.mainInterface.get<"s">("IconName"))[0];
        } catch {}
        let iconThemePath: string | undefined;
        try {
            iconThemePath = (await this.mainInterface.get<"s">("IconThemePath"))[0];
        } catch {}

        if (iconName) {
            const blobUrl = await getDesktopIcon(iconName, {
                themeBasePath: iconThemePath,
                theme: op?.theme,
                size: op?.size,
                scale: op?.scale,
            });
            return blobUrl;
        } else {
            const _iconDatas = await this.mainInterface.get<"a(iiay)">("IconPixmap");
            if (!_iconDatas) return undefined;
            if (typeof document === "undefined") {
                return undefined;
            }
            const iconDatas = _iconDatas[0];
            const firstIconData = iconDatas[0];
            if (!firstIconData) return undefined;
            let iconData: DBusTypes<"iiay"> = firstIconData;
            for (const data of iconDatas) {
                const [w, h] = data;
                if (w >= (op?.size ?? 24) && h >= (op?.size ?? 24)) {
                    iconData = data;
                    break;
                }
            }

            const [w, h, data] = iconData;
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            if (!ctx) return undefined;

            const imageData = ctx.createImageData(w, h);
            const argbdata = data;
            const rgbaData = new Uint8ClampedArray(argbdata.length);
            for (let i = 0; i < argbdata.length; i += 4) {
                const a = argbdata[i];
                const r = argbdata[i + 1];
                const g = argbdata[i + 2];
                const b = argbdata[i + 3];
                rgbaData[i] = r;
                rgbaData[i + 1] = g;
                rgbaData[i + 2] = b;
                rgbaData[i + 3] = a;
            }
            imageData.data.set(rgbaData);
            ctx.putImageData(imageData, 0, 0);
            return canvas.toDataURL();
        }
    }
    async getMenu() {
        return (await this.menuPath?.getAllLayout()) ?? [];
    }
    async activate() {
        this.mainInterface.call<"ii">("Activate", "ii", 0, 0);
    }
}
