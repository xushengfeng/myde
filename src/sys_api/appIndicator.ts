// Status Notifier Item also Tray

import { dbusClient, dbusInterface, DBusTypes, type dbusIO } from "myde-dbus";
import { getDesktopIcon } from "./application";
import { dbusMenu } from "./menu";

export class tray {
    // private sniHost: dbusServer; // todo 实现watcher
    private dbus: dbusIO;
    private sniWatcher: dbusClient;
    tarysService = new Map<string, trayItem>();
    private onMap = new Map<string, Set<(...args: unknown[]) => unknown>>(); // todo 类型 提取为一个lib

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
        }
        infc.on<"s">("StatusNotifierItemRegistered", async (name) => {
            const item = new trayItem(name, this.dbus);
            await item.init();
            this.tarysService.set(name, item);
            // todo emit
        });
        infc.on<"s">("StatusNotifierItemUnregistered", async (name) => {
            console.log("remove tray", name);
            this.tarysService.delete(name);
        });
    }
}

export class trayItem {
    private client: dbusClient;
    private path: string;
    private menuPath: dbusMenu | undefined;
    // @ts-expect-error
    private mainInterface: dbusInterface;
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
        const menuPath = (await infc.get<"o">("Menu"))[0];
        this.menuPath = new dbusMenu(this.client, { serverName: service, objectPath: menuPath });
        await this.menuPath.init();
    }
    async title() {
        return (await this.mainInterface.get<"s">("Title"))[0];
    }
    /** true 可视化程序应优先显示菜单或发送 ContextMenu() 而不是 Activate() */
    async itemIsMenu() {
        return (await this.mainInterface.get<"b">("ItemIsMenu"))[0];
    }
    async getIcon(op?: { size?: number; scale?: number; theme?: string }) {
        const iconName = (await this.mainInterface.get<"s">("IconName"))[0];
        const iconThemePath = (await this.mainInterface.get<"s">("IconThemePath"))[0];
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
}
