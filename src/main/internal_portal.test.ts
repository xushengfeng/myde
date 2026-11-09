import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbusClient, dbusIO } from "myde-dbus";
import { afterAll, describe, expect, it } from "vitest";
import { startInternalPortal, stopInternalPortal } from "./internal_portal";

const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

const hasPortalBinary = [
    process.env.MYDE_XDG_DESKTOP_PORTAL,
    "/usr/lib/xdg-desktop-portal",
    "/usr/libexec/xdg-desktop-portal",
    "/usr/bin/xdg-desktop-portal",
].some((p) => p && (path.isAbsolute(p) ? fs.existsSync(p) : true));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("internal portal", () => {
    const oldAppBus = process.env.MYDE_INTERNAL_BUS_ADDRESS;
    const oldSessionBus = process.env.DBUS_SESSION_BUS_ADDRESS;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myde-internal-portal-"));
    let busAddress: string | undefined;

    afterAll(() => {
        stopInternalPortal();
        if (oldAppBus === undefined) delete process.env.MYDE_INTERNAL_BUS_ADDRESS;
        else process.env.MYDE_INTERNAL_BUS_ADDRESS = oldAppBus;
        if (oldSessionBus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
        else process.env.DBUS_SESSION_BUS_ADDRESS = oldSessionBus;
        fs.rmSync(userDataDir, { recursive: true, force: true });
    });

    it.skipIf(!hasPortalBinary)(
        "启动私有 bus 和 xdg-desktop-portal，不改变宿主 session bus",
        { timeout: 20000 },
        async () => {
            const handle = await startInternalPortal({ userDataDir, runtimeDir: os.tmpdir() });
            busAddress = handle.busAddress;
            try {
                expect(process.env.MYDE_INTERNAL_BUS_ADDRESS).toBe(handle.busAddress);
                expect(process.env.DBUS_SESSION_BUS_ADDRESS).toBe(oldSessionBus);

                const socketPath = /unix:path=([^;]+)/.exec(handle.busAddress)?.[1];
                expect(socketPath, `bus 地址不对: ${handle.busAddress}`).toBeDefined();
                if (!socketPath) return;

                const socket = new mus.USocket();
                socket.connect(socketPath);
                const io = new dbusIO({ socket });
                await io.connect();
                const client = new dbusClient({ io });
                const meta = await client.getMetaInterface();

                let owned = false;
                for (let i = 0; i < 80; i++) {
                    const [has] = await meta.NameHasOwner("org.freedesktop.portal.Desktop");
                    if (has) {
                        owned = true;
                        break;
                    }
                    await sleep(100);
                }
                expect(owned, "私有 bus 上没有 xdg-desktop-portal").toBe(true);
                expect(fs.existsSync(path.join(userDataDir, "portal/portals/myde.portal"))).toBe(true);
                expect(fs.existsSync(path.join(userDataDir, "portal/config/xdg-desktop-portal/portals.conf"))).toBe(
                    true,
                );
            } finally {
                stopInternalPortal();
            }

            if (busAddress) {
                const socketPath = /unix:path=([^;]+)/.exec(busAddress)?.[1];
                if (socketPath) expect(fs.existsSync(socketPath)).toBe(false);
            }
        },
    );
});
