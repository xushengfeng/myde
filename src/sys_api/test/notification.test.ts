import type { dbusIO } from "myde-dbus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notification } from "../notification";
import { DBusTestEnv } from "./utils/dbus_env/dbus-env";

describe("notification", () => {
    let env: DBusTestEnv;
    let io: dbusIO;
    let notif: notification;
    beforeAll(async () => {
        env = new DBusTestEnv({ enablePcap: true, pcapOutputDir: __dirname });
        await env.start();
        io = await env.createConnection();
        notif = new notification(io);
        await notif.init();
    });
    afterAll(async () => {
        await env.stop();
    });
    it("should receive notifications", async () => {
        const sendProcess = env.spawn("notify-send", ["--app-name=TestApp", "Test Summary", "Test Body"]);

        sendProcess.stdout?.on("data", (data) => {
            console.log("notify-send output:", data.toString());
        });
        sendProcess.stderr?.on("data", (data) => {
            console.log("notify-send error:", data.toString());
        });

        await new Promise<void>((resolve, reject) => {
            notif.on("new", (data) => {
                try {
                    expect(data.app_name).toBe("TestApp");
                    expect(data.summary).toBe("Test Summary");
                    expect(data.body).toBe("Test Body");
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        });
    });
});
