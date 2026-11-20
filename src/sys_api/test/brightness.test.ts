import { dbusIO } from "myde-dbus";
import { describe, expect, it } from "vitest";
import { brightness, parseDdcDetectOutput, parseVcpBrightness } from "../brightness";

const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

describe("brightness parsers", () => {
    it("parses ddcutil detect --brief", () => {
        const entries = parseDdcDetectOutput(`Invalid display
   I2C bus:          /dev/i2c-11
   DRM connector:    card0-eDP-1
   Monitor:          CSW:MNE007ZA3-5:

Display 1
   I2C bus:          /dev/i2c-10
   DRM connector:    card0-DP-1
   Monitor:          DEL:U2720Q:ABC123
   Serial number:    ABC123

Invalid display
   I2C bus:          /dev/i2c-8
`);
        expect(entries).toEqual([{ bus: 10, connector: "card0-DP-1", monitor: "DEL:U2720Q:ABC123" }]);
    });

    it("parses ddcutil getvcp 10", () => {
        expect(
            parseVcpBrightness(
                "VCP code 0x10 (Brightness                    ): current value =    50, max value =   100",
            ),
        ).toEqual({ current: 50, max: 100 });
        expect(parseVcpBrightness("VCP code 0x10 (Brightness): Unsupported feature code")).toBeUndefined();
        expect(parseVcpBrightness("VCP code 0x10 (Brightness): current value = 10, max value = 0")).toBeUndefined();
    });
});

describe("brightness", () => {
    function createApi() {
        const socket = new mus.USocket();
        socket.connect("/var/run/dbus/system_bus_socket");
        return new brightness(new dbusIO({ socket }));
    }

    it("init and read displays", async () => {
        const api = createApi();
        await api.init();
        const displays = api.getDisplays();
        console.log("Brightness displays:", displays);
        expect(Array.isArray(displays)).toBe(true);
        for (const display of displays) {
            expect(display.brightness).toBeGreaterThanOrEqual(0);
            expect(display.brightness).toBeLessThanOrEqual(100);
            expect(display.id).not.toBe("");
        }
        api.destroy();
    }, 60000);

    it("set brightness and restore", async () => {
        const api = createApi();
        await api.init();
        const display = api.getDisplays().find((item) => item.writable);
        if (!display) {
            console.warn("没有可写的屏幕，跳过写入测试");
            api.destroy();
            return;
        }

        const before = display.brightness;
        const changed = await api.setBrightness(display.id, before === 100 ? 80 : before + 20);
        console.log(`Brightness ${display.id}: ${before} -> ${changed}`);
        expect(changed).toBeGreaterThanOrEqual(0);
        expect(changed).toBeLessThanOrEqual(100);

        await api.setBrightness(display.id, before);
        expect(api.getDisplay(display.id)?.brightness).toBe(before);
        api.destroy();
    }, 60000);
});
