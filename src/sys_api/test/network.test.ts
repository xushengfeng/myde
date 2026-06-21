import { dbusIO } from "myde-dbus";
import { describe, it, expect } from "vitest";
import { network } from "../network";
const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

function newSocket() {
    const socket = new mus.USocket();
    socket.connect("/var/run/dbus/system_bus_socket");
    return socket;
}

describe("network", () => {
    it("init", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const networkInstance = new network(dbus);
        await networkInstance.init();
    });
    it("getWifiDevices", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const networkInstance = new network(dbus);
        await networkInstance.init();
        const devices = networkInstance.getWifiDevices();
        console.log("Found WiFi devices:", devices.length);
        for (const device of devices) {
            const iface = await device.getInterface();
            console.log("WiFi Device:", iface);
        }
    });
    it("getAccessPoints", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const networkInstance = new network(dbus);
        await networkInstance.init();
        const devices = networkInstance.getWifiDevices();
        const wifiNames: string[] = [];
        for (const device of devices) {
            await device.requestScan();
            const accessPoints = await device.getAccessPoints();
            for (const ap of accessPoints) {
                const ssid = await ap.getSsid();
                console.log("WiFi Name:", ssid);
                wifiNames.push(ssid);
            }
        }
        expect(wifiNames.length).toBeGreaterThan(0);
        expect(wifiNames).toContain("CMCC-J37C");
    });
    it("getActiveWifiConnection", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const networkInstance = new network(dbus);
        await networkInstance.init();
        const activeConnection = await networkInstance.getActiveWifiConnection();
        console.log("Active WiFi Connection:", activeConnection);
        expect(activeConnection).not.toBeNull();
        if (activeConnection) {
            expect(activeConnection.type).toBe("802-11-wireless");
            expect(activeConnection.state).toBe(2);
            console.log("Connected to WiFi:", activeConnection.id);
        }
    });
    it("checkActiveAccessPoint", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const networkInstance = new network(dbus);
        await networkInstance.init();
        const devices = networkInstance.getWifiDevices();
        for (const device of devices) {
            const activeAp = await device.getActiveAccessPoint();
            if (activeAp) {
                const ssid = await activeAp.getSsid();
                const isActive = await activeAp.isActive();
                console.log("Active Access Point:", ssid, "isActive:", isActive);
                expect(isActive).toBe(true);
            }
        }
    });
    it("getSavedConnections", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const networkInstance = new network(dbus);
        await networkInstance.init();
        const devices = networkInstance.getWifiDevices();
        for (const device of devices) {
            const savedConnections = await device.getSavedConnections();
            console.log("Saved connections:", savedConnections.length);
            for (const conn of savedConnections) {
                console.log("  -", conn.id, "(", conn.ssid, ")");
            }
            expect(savedConnections.length).toBeGreaterThan(0);
        }
    });
});
