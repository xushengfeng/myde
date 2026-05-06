import { dbusVariant, type dbusClient, type dbusInterface, type DBusType, type DBusTypes } from "myde-dbus";
import { getDesktopIcon } from "./application";

export type MenuItem = {
    id: number;
    type: "standard" | "separator";
    label: string;
    enabled?: boolean;
    visible?: boolean;
    iconUrl?: (op?: { size?: number; theme?: string; scale?: number }) => Promise<string | undefined>;
    shortcut?: string[][];
    toggleType?: "checkmark" | "radio" | "none";
    toggleState?: boolean;
    children?: MenuItem[];
    click: () => void;
};

export class dbusMenu {
    private client: dbusClient;
    private serverName: string;
    private objectPath: string;
    private mainInterface: dbusInterface | undefined;
    private onMap = new Map<string, Set<(...args: unknown[]) => unknown>>(); // todo 类型 提取为一个lib

    constructor(dbus: dbusClient, op: { serverName: string; objectPath: string }) {
        this.serverName = op.serverName;
        this.objectPath = op.objectPath;
        this.client = dbus;
    }

    async init() {
        const service = await this.client.getService(this.serverName);
        const menuObj = await service.getObject(this.objectPath);

        this.mainInterface = await menuObj.getInterface("com.canonical.dbusmenu");
    }
    private infc() {
        if (!this.mainInterface) throw new Error("init first");
        return this.mainInterface;
    }
    async getAllLayout() {
        const infc = this.infc();
        const x = await infc.call("GetLayout", "iias", 0, -1, []).as<"u(ia{sv}av)">();

        const layout = await buildMenuList(x[1][2]);

        async function buildMenuList(oneLayout: DBusType<"av">) {
            const list: MenuItem[] = [];
            for (const _item of oneLayout) {
                const [item] = _item.value as DBusTypes<"(ia{sv}av)">;
                const itemObj: MenuItem = {
                    id: item[0],
                    type: "standard",
                    label: "",
                    click: async () => {
                        await infc.call("Event", "isvu", item[0], "clicked", dbusVariant<"s">("s", ""), 0).as<"v">();
                    },
                };
                const v = item[1];
                for (const [k, _v] of v) {
                    if (k === "label") itemObj.label = (_v.value as DBusType<"s">)[0];
                    else if (k === "enabled") itemObj.enabled = (_v.value as DBusType<"b">)[0];
                    else if (k === "visible") itemObj.visible = (_v.value as DBusType<"b">)[0];
                    else if (k === "icon-name") {
                        itemObj.iconUrl = async (op) => await getDesktopIcon((_v.value as DBusType<"s">)[0], op);
                    } else if (k === "icon-data") {
                        if (itemObj.iconUrl) continue;
                        const pngData = new Uint8Array((_v.value as DBusType<"ay">)[0]);
                        const blob = new Blob([pngData], { type: "image/png" });
                        const blobUrl = URL.createObjectURL(blob);
                        itemObj.iconUrl = () => Promise.resolve(blobUrl);
                    } else if (k === "shortcut") itemObj.shortcut = (_v.value as DBusType<"a(as)">)[0];
                    else if (k === "toggle-type")
                        itemObj.toggleType = (_v.value as DBusType<"s">)[0] as MenuItem["toggleType"];
                    else if (k === "children-display" && (_v.value as DBusType<"s">)[0] === "submenu") {
                        itemObj.children = await buildMenuList(item[2]);
                    }
                }
                list.push(itemObj);
            }
            return list;
        }
        return layout;
    }
}
