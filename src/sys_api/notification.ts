import { type dbusIO, dbusServer } from "myde-dbus";
import { EventEmitter } from "../event-emitter/event-emitter";

export interface NotificationData {
    app_name: string;
    replaces_id: number;
    app_icon: string;
    summary: string;
    body: string;
    actions: string[];
    hints: Record<string, unknown>;
    expire_timeout: number;
    id: number;
}

export type NotificationEvents = {
    new: [NotificationData];
    closed: [id: number, reason: number];
    action: [id: number, actionKey: string];
};

const NOTIFICATION_PATH = "/org/freedesktop/Notifications";
const NOTIFICATION_IFACE = "org.freedesktop.Notifications";

export class notification extends EventEmitter<NotificationEvents> {
    private dbusServer: dbusServer;
    private nidCounter = 1;
    private notifications = new Map<number, NotificationData>();

    constructor(dbus: dbusIO) {
        super();
        this.dbusServer = new dbusServer(dbus, "org.freedesktop.Notifications");
    }

    async init() {
        await this.dbusServer.init();
        this.dbusServer.addObject(NOTIFICATION_PATH, NOTIFICATION_IFACE, {
            GetCapabilities: async () => {
                return { signature: "as", value: ["body", "actions", "persistence"] };
            },
            Notify: async (
                app_name: string,
                replaces_id: number,
                app_icon: string,
                summary: string,
                body: string,
                actions: string[],
                hints: Record<string, unknown>,
                expire_timeout: number,
            ) => {
                const thisId = replaces_id === 0 ? this.nidCounter : replaces_id;
                if (replaces_id === 0) this.nidCounter++;
                const data: NotificationData = {
                    app_name,
                    replaces_id,
                    app_icon,
                    summary,
                    body,
                    actions,
                    hints,
                    expire_timeout,
                    id: thisId,
                };
                this.notifications.set(thisId, data);
                this.emit("new", data);
                return { signature: "u", value: thisId };
            },
            CloseNotification: async (id: number) => {
                await this.close(id, 3);
            },
            GetServerInformation: async () => {
                return { signature: "ssss", value: ["MyDE Notification Server", "MyDE", "1.0", "1.2"] };
            },
            // todo 其他能力
        });
    }

    getNotification(id: number) {
        return this.notifications.get(id);
    }

    getNotifications() {
        return Array.from(this.notifications.values());
    }

    async close(id: number, reason = 3) {
        if (!this.notifications.delete(id)) return false;
        this.emit("closed", id, reason);
        await this.dbusServer.emitSignal(NOTIFICATION_PATH, NOTIFICATION_IFACE, "NotificationClosed", "uu", [
            id,
            reason,
        ]);
        return true;
    }

    async invokeAction(id: number, actionKey: string) {
        if (!this.notifications.has(id)) return false;
        this.emit("action", id, actionKey);
        await this.dbusServer.emitSignal(NOTIFICATION_PATH, NOTIFICATION_IFACE, "ActionInvoked", "us", [id, actionKey]);
        return true;
    }
}
