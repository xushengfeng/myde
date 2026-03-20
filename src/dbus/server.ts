import { dbusClient } from "./client";
import { dbusIO } from "./dbus";

export class dbusServer {
    io: dbusIO;
    name: string;
    objs: Record<string, unknown>;
    constructor(io: dbusIO, name: string, objs: Record<string, unknown>) {
        this.io = io;
        this.name = name;
        this.objs = objs;
    }
    async init() {
        const service = await new dbusClient({ io: new dbusIO() }).getService("org.freedesktop.DBus");
        const obj = await service.getObject("/org/freedesktop/DBus");
        const iface = await obj.getInterface("org.freedesktop.DBus");
        await iface.set("RequestName", this.name, 0);
    }
}

export class dbusInterface {}
