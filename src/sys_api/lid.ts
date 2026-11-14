import { dbusClient, type dbusInterface, type dbusIO } from "myde-dbus";
import { EventEmitter } from "../event-emitter/event-emitter";

const LOGIN_BUS = "org.freedesktop.login1";
const LOGIN_MANAGER_PATH = "/org/freedesktop/login1";
const LOGIN_MANAGER_IFACE = "org.freedesktop.login1.Manager";

export type LidEvents = {
    /** 合盖状态变化，closed 为 true 表示已合盖 */
    changed: [closed: boolean];
};

/**
 * 笔记本合盖状态。
 *
 * 通过 logind 的 `org.freedesktop.login1.Manager.LidClosed` 属性读取和监听，
 * 无合盖开关（台式机）时始终为 false。
 */
export class lid extends EventEmitter<LidEvents> {
    private dbus: dbusIO;
    private client: dbusClient;
    // @ts-expect-error
    private infc: dbusInterface;
    private closed = false;
    private ready = false;
    private changedUnsub?: () => void;

    constructor(dbus: dbusIO) {
        super();
        this.dbus = dbus;
        this.client = new dbusClient({ io: dbus });
    }

    async init() {
        if (this.ready) return;
        await this.dbus.connect();
        const service = await this.client.getService(LOGIN_BUS);
        const object = await service.getObject(LOGIN_MANAGER_PATH);
        this.infc = await object.getInterface(LOGIN_MANAGER_IFACE);
        const [closed] = await this.infc.get<"b">("LidClosed");
        this.closed = closed;
        this.changedUnsub = await this.infc.propertiesChanged((changedProperties) => {
            if (!("LidClosed" in changedProperties)) return;
            // myde-dbus 的 PropertiesChanged 值仍是变体内容数组（如 [true]），
            // 兼容直接给标量的实现
            const raw = changedProperties.LidClosed;
            const closed = (Array.isArray(raw) ? raw[0] : raw) === true;
            if (closed === this.closed) return;
            this.closed = closed;
            this.emit("changed", closed);
        });
        this.ready = true;
    }

    /** 当前是否合盖；init 后由 logind 的属性变化保持更新 */
    isClosed() {
        return this.closed;
    }

    isReady() {
        return this.ready;
    }

    destroy() {
        this.changedUnsub?.();
        this.changedUnsub = undefined;
        this.ready = false;
        this.closed = false;
        this.removeAllListeners("changed");
    }
}
