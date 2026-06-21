import { dbusIO } from "myde-dbus";
import { describe, it } from "vitest";
import { blue } from "../blue";
const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

function newSocket() {
    const socket = new mus.USocket();
    socket.connect("/var/run/dbus/system_bus_socket");
    return socket;
}

describe("blue", () => {
    it("init", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const blueInstance = new blue(dbus);
        await blueInstance.init();
    });
    it("getDevices", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const blueInstance = new blue(dbus);
        await blueInstance.init();
        const devices = blueInstance.getDevices();
        for (const device of devices) {
            console.log(await device.getName(), await device.getAddress(), await device.isConnected());
        }
    });
});
