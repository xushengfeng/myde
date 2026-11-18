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

export interface NotificationInitOptions {
    /** expire_timeout = -1 时使用；0 表示不自动过期 */
    defaultTimeout?: number;
}

const NOTIFICATION_PATH = "/org/freedesktop/Notifications";
const NOTIFICATION_IFACE = "org.freedesktop.Notifications";

export class notification extends EventEmitter<NotificationEvents> {
    private dbusServer: dbusServer;
    private nidCounter = 1;
    private notifications = new Map<number, NotificationData>();
    private timers = new Map<number, ReturnType<typeof setTimeout>>();
    /** expire_timeout = -1 时的默认值（毫秒），0 表示不自动过期 */
    private defaultTimeout = 5000;

    constructor(dbus: dbusIO) {
        super();
        this.dbusServer = new dbusServer(dbus, "org.freedesktop.Notifications");
    }

    async init(opts?: NotificationInitOptions) {
        if (opts?.defaultTimeout !== undefined) this.setDefaultTimeout(opts.defaultTimeout);
        await this.dbusServer.init();
        this.dbusServer.addObject(NOTIFICATION_PATH, NOTIFICATION_IFACE, {
            GetCapabilities: async () => {
                return { signature: "as", value: [["body", "actions", "persistence"]] };
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
                // replaces_id 指向不存在的通知时按新通知处理，避免复用外部 id
                const thisId =
                    replaces_id !== 0 && this.notifications.has(replaces_id) ? replaces_id : this.nidCounter++;
                this.clearTimer(thisId);
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
                this.scheduleExpiry(thisId, expire_timeout);
                this.emit("new", data);
                return { signature: "u", value: [thisId] };
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

    /** 设置 expire_timeout = -1 时的默认超时；0 表示不自动过期 */
    setDefaultTimeout(ms: number) {
        if (!Number.isFinite(ms) || ms < 0) throw new Error(`无效的通知超时: ${ms}`);
        this.defaultTimeout = ms;
    }

    getNotification(id: number) {
        return this.notifications.get(id);
    }

    getNotifications() {
        return Array.from(this.notifications.values());
    }

    private scheduleExpiry(id: number, expireTimeout: number) {
        const timeout = expireTimeout === -1 ? this.defaultTimeout : expireTimeout;
        if (!(timeout > 0)) return;
        this.timers.set(
            id,
            setTimeout(() => {
                this.timers.delete(id);
                void this.close(id, 1);
            }, timeout),
        );
    }

    private clearTimer(id: number) {
        const timer = this.timers.get(id);
        if (timer === undefined) return;
        clearTimeout(timer);
        this.timers.delete(id);
    }

    async close(id: number, reason = 3) {
        this.clearTimer(id);
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
