import { dbusIO } from "myde-dbus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tray } from "../appIndicator";
const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

function newSocket() {
    const socket = new mus.USocket();
    socket.connect("/run/user/1000/bus");
    return socket;
}

describe("tray", () => {
    it("init", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const trayInstance = new tray(dbus);
        await trayInstance.init();
        for (const [s, item] of trayInstance.tarysService) {
            console.log(s, await item.title());
        }
    });
    it("menu", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const trayInstance = new tray(dbus);
        await trayInstance.init();
        for (const item of trayInstance.tarysService.values()) {
            console.log(await item.getMenu());
        }
    });
});
