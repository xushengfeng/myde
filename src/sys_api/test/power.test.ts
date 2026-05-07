import { dbusIO } from "myde-dbus";
import { describe, it } from "vitest";
import { power } from "../power";
const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

function newSocket() {
    const socket = new mus.USocket();
    socket.connect("/var/run/dbus/system_bus_socket");
    return socket;
}

describe("power", () => {
    it("init", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const powerInstance = new power(dbus);
        await powerInstance.init();
    });
    it("getDevices", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const powerInstance = new power(dbus);
        await powerInstance.init();
        const devices = powerInstance.getDevices();
        for (const device of devices) {
            console.log(
                await device.getModel(),
                await device.getPowerSupply(),
                await device.getType(),
                await device.getState(),
                await device.getPercentage(),
            );
        }
    });
});
