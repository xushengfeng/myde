import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notification } from "../notification";
import { dbusIO } from "myde-dbus";
import type { USocket } from "myde-unix-socket";
const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");
const SOCKET_PATH = path.join(__dirname, "test-bus.sock");

describe("notification", () => {
    let socket: USocket;
    let io: dbusIO;
    let daemon: ChildProcess;
    let monitor: ChildProcess;
    const monitorOutput: number[] = [];
    beforeAll(async () => {
        if (fs.existsSync(SOCKET_PATH)) {
            fs.unlinkSync(SOCKET_PATH);
        }

        daemon = spawn("dbus-daemon", ["--session", `--address=unix:path=${SOCKET_PATH}`, "--print-address"]);

        await new Promise<void>((resolve, reject) => {
            daemon.stdout?.on("data", (data) => {
                resolve();
            });
            daemon.on("error", reject);
            setTimeout(() => reject(new Error("Daemon start timeout")), 5000);
        });

        monitor = spawn("dbus-monitor", ["--address", `unix:path=${SOCKET_PATH}`, "--pcap"]);
        monitor.stdout?.on("data", (data: Buffer) => {
            monitorOutput.push(...new Uint8Array(data.buffer));
        });
        monitor.stderr?.on("data", (data) => {
            console.error("dbus-monitor error:", data.toString());
        });

        socket = new mus.USocket();
        await new Promise<void>((resolve, reject) => {
            socket.connect(SOCKET_PATH, () => resolve());
            socket.on("error", reject);
            setTimeout(() => reject(new Error("Connection timeout")), 5000);
        });

        io = new dbusIO({ socket });
        await io.connect();
    });
    afterAll(async () => {
        fs.writeFileSync(path.join(__dirname, `monitor_output_${Date.now()}.pcap`), Uint8Array.from(monitorOutput));
        monitor.kill();
        daemon.kill();
    });
    it("should initialize notification server", async () => {
        const notif = new notification(io);
        await notif.init();
    });
    it("should receive notifications", async () => {
        const notif = new notification(io);
        await notif.init();

        // Simulate sending a notification using dbus-send
        const sendProcess = spawn("notify-send", ["--app-name=TestApp", "Test Summary", "Test Body"], {
            env: {
                ...process.env,
                DBUS_SESSION_BUS_ADDRESS: `unix:path=${SOCKET_PATH}`,
            },
        });

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
