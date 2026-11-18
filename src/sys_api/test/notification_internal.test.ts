import fs from "node:fs";
import { type DBusTypes, dbusClient, dbusIO } from "myde-dbus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testRunnerApp } from "../../test_runner/test_runner";

const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

const LOG_FILE = "/tmp/myde-notification-internal-log";
const STOP_FILE = "/tmp/myde-notification-internal-stop";
const NOTIFICATIONS_NAME = "org.freedesktop.Notifications";

type LogLine = { type: string; [key: string]: unknown };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readLog(): LogLine[] {
    try {
        return fs
            .readFileSync(LOG_FILE, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as LogLine);
    } catch {
        return [];
    }
}

async function waitFor<T>(fn: () => T | undefined, timeout = 10000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = fn();
        if (value !== undefined) return value;
        await sleep(100);
    }
    throw new Error(`等待超时，最后日志：${JSON.stringify(readLog().slice(-10))}`);
}

async function waitForLog(predicate: (line: LogLine) => boolean, timeout = 10000) {
    return waitFor(() => readLog().find(predicate), timeout);
}

function socketPathFromAddress(address: string) {
    const match = /unix:path=([^;]+)/.exec(address);
    if (!match) throw new Error(`不是 unix path 地址: ${address}`);
    return decodeURIComponent(match[1]);
}

describe("notification（内部总线）", () => {
    let oldPortal: string | undefined;
    let oldMode: string | undefined;
    let runner: ReturnType<typeof testRunnerApp> | undefined;
    let socket: InstanceType<typeof mus.USocket> | undefined;

    beforeAll(() => {
        fs.rmSync(LOG_FILE, { force: true });
        fs.rmSync(STOP_FILE, { force: true });
        oldPortal = process.env.MYDE_INTERNAL_PORTAL;
        oldMode = process.env.MYDE_BUS_MODE;
        process.env.MYDE_INTERNAL_PORTAL = "1";
        process.env.MYDE_BUS_MODE = "mixed";
    });

    afterAll(() => {
        if (oldPortal === undefined) delete process.env.MYDE_INTERNAL_PORTAL;
        else process.env.MYDE_INTERNAL_PORTAL = oldPortal;
        if (oldMode === undefined) delete process.env.MYDE_BUS_MODE;
        else process.env.MYDE_BUS_MODE = oldMode;
        socket?.destroy();
        fs.rmSync(LOG_FILE, { force: true });
        fs.rmSync(STOP_FILE, { force: true });
    });

    it("注册名字、Notify 回复并推送到桌面", { timeout: 40000 }, async () => {
        runner = testRunnerApp("/bin/true", ({ runner: appRunner }) => {
            const fs = require("node:fs") as typeof import("node:fs");
            const env = JSON.parse(new URLSearchParams(location.search).get("env") ?? "{}") as Record<string, string>;
            const log = (line: unknown) =>
                fs.appendFileSync("/tmp/myde-notification-internal-log", `${JSON.stringify(line)}\n`);

            log({
                type: "env",
                bus: env.MYDE_INTERNAL_BUS_ADDRESS,
                host: env.DBUS_SESSION_BUS_ADDRESS,
                mode: env.MYDE_BUS_MODE,
            });

            const notification = myde.MSysApi.notification;
            if (!notification) {
                log({ type: "error", error: "MSysApi.notification 未初始化" });
                appRunner.sendData({ type: "error", error: "MSysApi.notification 未初始化" });
                return;
            }
            notification.on("new", (data) => log({ type: "new", id: data.id, summary: data.summary, body: data.body }));
            notification.on("closed", (id, reason) => log({ type: "closed", id, reason }));
            notification
                .init()
                .then(() => log({ type: "ready" }))
                .catch((error) => log({ type: "error", error: String(error) }));

            const stopTimer = setInterval(() => {
                if (!fs.existsSync("/tmp/myde-notification-internal-stop")) return;
                clearInterval(stopTimer);
                appRunner.kill();
            }, 200);
        });

        let mainPid = 0;
        try {
            const envLine = await waitForLog((line) => line.type === "env");
            const busAddress = String(envLine.bus ?? "");
            mainPid = Number(/myde-internal-bus-(\d+)-/.exec(busAddress)?.[1] ?? 0);
            expect(busAddress, "桌面没有拿到内部总线地址").toContain("myde-internal-bus");
            await waitForLog((line) => line.type === "ready");

            socket = new mus.USocket();
            socket.connect(socketPathFromAddress(busAddress));
            const io = new dbusIO({ socket });
            await io.connect();
            const client = new dbusClient({ io });
            const meta = await client.getMetaInterface();
            const [owned] = await meta.NameHasOwner(NOTIFICATIONS_NAME);
            expect(owned, "桌面没有注册 org.freedesktop.Notifications").toBe(true);

            const service = await client.getService(NOTIFICATIONS_NAME);
            const ifc = await (await service.getObject("/org/freedesktop/Notifications")).getInterface(
                "org.freedesktop.Notifications",
            );

            const [capabilities] = await ifc.call("GetCapabilities").as<"as">();
            expect(capabilities).toContain("body");

            const hints = [] as DBusTypes<"a{sv}">[0];
            const [id] = await ifc
                .call("Notify", "susssasa{sv}i", "TestApp", 0, "", "Test Summary", "Test Body", [], hints, 5000)
                .as<"u">();
            expect(id).toBeGreaterThan(0);
            await waitForLog((line) => line.type === "new" && line.id === id && line.summary === "Test Summary");

            const [sameId] = await ifc
                .call("Notify", "susssasa{sv}i", "TestApp", id, "", "Test Summary", "Updated Body", [], hints, 5000)
                .as<"u">();
            expect(sameId).toBe(id);
            await waitForLog((line) => line.type === "new" && line.id === id && line.body === "Updated Body");

            await ifc.call("CloseNotification", "u", id).await();
            await waitForLog((line) => line.type === "closed" && line.id === id);

            expect(readLog().filter((line) => line.type === "error")).toEqual([]);
        } finally {
            fs.writeFileSync(STOP_FILE, "stop");
            const deadline = Date.now() + 5000;
            while (mainPid && Date.now() < deadline) {
                try {
                    process.kill(mainPid, 0);
                } catch {
                    break;
                }
                await sleep(100);
            }
            if (mainPid) {
                try {
                    process.kill(mainPid, "SIGKILL");
                } catch {
                    /* 已退出 */
                }
            }
            fs.rmSync(STOP_FILE, { force: true });
            runner?.kill();
        }
    });
});
