import { type dbusIO, dbusServer } from "myde-dbus";
import { EventEmitter } from "../event-emitter/event-emitter";

export interface NotificationData {
    app_name: string;
    replaces_id: number;
    app_icon: string;
    summary: string;
    body: string;
    actions: unknown[]; // todo
    hints: Record<string, unknown>;
    expire_timeout: number;
    id: number;
}

export type NotificationEvents = {
    new: [NotificationData];
};

export class notification extends EventEmitter<NotificationEvents> {
    private dbusServer: dbusServer;
    private nidCounter = 1;

    constructor(dbus: dbusIO) {
        super();
        this.dbusServer = new dbusServer(dbus, "org.freedesktop.Notifications");
    }

    async init() {
        await this.dbusServer.init();
        this.dbusServer.addObject("/org/freedesktop/Notifications", "org.freedesktop.Notifications", {
            GetCapabilities: async () => {
                return { signature: "sss", value: ["body", "actions", "persistence"] };
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
                this.emit("new", {
                    app_name,
                    replaces_id,
                    app_icon,
                    summary,
                    body,
                    actions,
                    hints,
                    expire_timeout,
                    id: thisId,
                });
                return { signature: "u", value: thisId };
            },
            GetServerInformation: async () => {
                return { signature: "ssss", value: ["MyDE Notification Server", "MyDE", "1.0", "1.2"] };
            },
            // todo 其他能力
        });
    }
}