import { type dbusIO, dbusServer } from "myde-dbus";

export class notification {
    private dbusServer: dbusServer;
    private nidCounter = 1;
    private onMap = new Map<string, Set<(...args: unknown[]) => unknown>>(); // todo 类型 提取为一个lib

    constructor(dbus: dbusIO) {
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
                for (const callback of Array.from(this.onMap.get("new") ?? [])) {
                    callback({
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
                }
                return { signature: "u", value: thisId };
            },
            GetServerInformation: async () => {
                return { signature: "ssss", value: ["MyDE Notification Server", "MyDE", "1.0", "1.2"] };
            },
            // todo 其他能力
        });
    }
    on(
        event: "new",
        f: (arg: {
            app_name: string;
            replaces_id: number;
            app_icon: string;
            summary: string;
            body: string;
            actions: unknown[]; // todo
            hints: unknown[];
            expire_timeout: number;
            id: number;
        }) => void,
    );
    on(event: string, f: (...args: any[]) => void) {
        if (!this.onMap.has(event)) {
            this.onMap.set(event, new Set());
        }
        this.onMap.get(event)?.add(f);
    }
}
