import { dbusIO } from "myde-dbus";
import { describe, expect, it } from "vitest";
import { lid } from "../lid";

const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

function newSocket() {
    const socket = new mus.USocket();
    socket.connect("/var/run/dbus/system_bus_socket");
    return socket;
}

describe("lid", () => {
    it("init", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const lidInstance = new lid(dbus);
        await lidInstance.init();
        expect(lidInstance.isReady()).toBe(true);
        expect(typeof lidInstance.isClosed()).toBe("boolean");
        console.log("Lid closed:", lidInstance.isClosed());

        // 订阅不应抛错；当前状态由 logind 在合盖/开盖时推送
        lidInstance.on("changed", (closed) => {
            console.log("Lid changed:", closed);
        });
        lidInstance.destroy();
    });
});
