// Status Notifier Item also Tray

import { type DBusTypes, dbusClient, type dbusInterface, type dbusIO } from "myde-dbus";
import { EventEmitter } from "../event-emitter/event-emitter";
import { getDesktopIcon } from "./application";
import { dbusMenu } from "./menu";

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
    // private sniHost: dbusServer; // todo 实现watcher
    private dbus: dbusIO;
    private sniWatcher: dbusClient;
    ev = new EventEmitter<TrayEvents>();
    tarysService = new Map<string, trayItem>();

    constructor(dbus: dbusIO) {
        this.dbus = dbus;
        this.sniWatcher = new dbusClient({ io: dbus });
    }

    async init() {
        await this.dbus.connect();
        const watcher = await this.sniWatcher.getService("org.kde.StatusNotifierWatcher");
        const infc = await (await watcher.getObject("/StatusNotifierWatcher")).getInterface(
            "org.kde.StatusNotifierWatcher",
        );
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
