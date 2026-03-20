import { dbusIO } from "./dbus";
import { dbusMessage } from "./message";

type dbusClientOp = {
    io: dbusIO;
    destination: string;
    path: string;
    interface: string;
};

export class dbusClient {
    op: Omit<dbusClientOp, "destination" | "path" | "interface">;
    constructor(op: typeof dbusClient.prototype.op) {
        this.op = { ...op };
    }
    async getService(name: string) {
        return new dbusService({ ...this.op, destination: name });
    }
}

export class dbusService {
    op: Omit<dbusClientOp, "path" | "interface">;
    constructor(op: typeof dbusService.prototype.op) {
        this.op = { ...op };
    }
    async getObject(path: string) {
        return new dbusObject({ ...this.op, path });
    }
}

export class dbusObject {
    op: Omit<dbusClientOp, "interface">;
    constructor(op: typeof dbusObject.prototype.op) {
        this.op = { ...op };
    }
    async getInterface(name: string) {
        return new dbusInterface({ ...this.op, interface: name });
    }
}

export class dbusInterface {
    op: dbusClientOp;
    io: dbusIO;
    constructor(op: dbusClientOp) {
        this.op = { ...op };
        this.io = op.io;
    }
    async get(method: string, x: string) {
        this.io.call(new dbusMessage());
    }
    async set(method: string, x: string, value: unknown) {
        this.io.call(new dbusMessage());
    }
    on(signal: string, callback: (...args: unknown[]) => void) {}
}
