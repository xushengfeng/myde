import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbusIO } from "myde-dbus";

const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

export interface DBusTestEnvOptions {
    enablePcap?: boolean;
    pcapOutputDir?: string;
    socketPath?: string;
    daemonTimeout?: number;
}

export interface SpawnWithDBusOptions extends SpawnOptions {
    extraEnv?: Record<string, string>;
}

export class DBusTestEnv {
    private _socketPath: string;
    private _pcapOutputDir: string | undefined;
    private _enablePcap: boolean;
    private _daemonTimeout: number;

    private daemon: ChildProcess | null = null;
    private monitor: ChildProcess | null = null;
    private monitorOutput: number[] = [];
    private _started = false;

    constructor(options?: DBusTestEnvOptions) {
        this._enablePcap = options?.enablePcap ?? false;
        this._pcapOutputDir = options?.pcapOutputDir;
        this._daemonTimeout = options?.daemonTimeout ?? 5000;
        this._socketPath =
            options?.socketPath ?? path.join(os.tmpdir(), `myde-test-bus-${process.pid}-${Date.now()}.sock`);
    }

    get socketPath(): string {
        return this._socketPath;
    }

    get busAddress(): string {
        return `unix:path=${this._socketPath}`;
    }

    get dbusEnv(): Record<string, string> {
        return {
            ...process.env,
            DBUS_SESSION_BUS_ADDRESS: this.busAddress,
        };
    }

    get pcapBuffer(): Buffer | null {
        if (!this._enablePcap || this.monitorOutput.length === 0) return null;
        return Buffer.from(this.monitorOutput);
    }

    async start(): Promise<void> {
        if (this._started) throw new Error("DBusTestEnv already started");

        if (fs.existsSync(this._socketPath)) {
            fs.unlinkSync(this._socketPath);
        }

        this.daemon = spawn("dbus-daemon", ["--session", `--address=unix:path=${this._socketPath}`, "--print-address"]);

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("dbus-daemon start timeout")), this._daemonTimeout);
            if (!this.daemon) {
                reject();
                return;
            }
            this.daemon.stdout?.once("data", () => {
                clearTimeout(timer);
                resolve();
            });
            this.daemon.on("error", (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });

        if (this._enablePcap) {
            this.monitor = spawn("dbus-monitor", ["--address", this.busAddress, "--pcap"]);
            this.monitor.stdout?.on("data", (data: Buffer) => {
                this.monitorOutput.push(...new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            });
            this.monitor.stderr?.on("data", (data) => {
                console.error("[dbus-monitor]", data.toString());
            });
        }

        this._started = true;
    }

    async stop(): Promise<void> {
        if (!this._started) return;

        if (this._enablePcap && this.monitorOutput.length > 0) {
            const outputDir = this._pcapOutputDir ?? process.cwd();
            const pcapFile = path.join(outputDir, `dbus-monitor-${Date.now()}.pcap`);
            fs.writeFileSync(pcapFile, Buffer.from(this.monitorOutput));
        }

        this.monitor?.kill();
        this.daemon?.kill();

        if (fs.existsSync(this._socketPath)) {
            fs.unlinkSync(this._socketPath);
        }

        this.monitor = null;
        this.daemon = null;
        this._started = false;
    }

    async createConnection(): Promise<dbusIO> {
        const socket = new mus.USocket();
        await new Promise<void>((resolve, reject) => {
            socket.connect(this._socketPath, () => resolve());
            socket.on("error", reject);
            setTimeout(() => reject(new Error("socket connect timeout")), this._daemonTimeout);
        });
        const io = new dbusIO({ socket });
        await io.connect();
        return io;
    }

    spawn(command: string, args?: string[], options?: SpawnWithDBusOptions): ChildProcess {
        const { extraEnv, ...spawnOptions } = options ?? {};
        return spawn(command, args ?? [], {
            ...spawnOptions,
            env: {
                ...this.dbusEnv,
                ...extraEnv,
            },
        });
    }
}
