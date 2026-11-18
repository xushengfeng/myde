import fs from "node:fs";
import { dbusClient, dbusIO, dbusServer } from "myde-dbus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testRunnerApp } from "../../test_runner/test_runner";

const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

const LOG_FILE = "/tmp/myde-tray-watcher-log";
const STOP_FILE = "/tmp/myde-tray-watcher-stop";
const ITEM_NAME = "org.myde.TrayWatcherTest";
const ITEM_PATH = "/StatusNotifierItem";
const WATCHER_NAME = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH = "/StatusNotifierWatcher";
const WATCHER_IFACE = "org.kde.StatusNotifierWatcher";

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

async function connect(address: string) {
    const socket = new mus.USocket();
    socket.connect(socketPathFromAddress(address));
    const io = new dbusIO({ socket });
    await io.connect();
    return { socket, io, client: new dbusClient({ io }) };
}

describe("tray watcher（内部总线）", () => {
    let oldPortal: string | undefined;
    let oldMode: string | undefined;
    let runner: ReturnType<typeof testRunnerApp> | undefined;
    let itemSocket: InstanceType<typeof mus.USocket> | undefined;
    let querySocket: InstanceType<typeof mus.USocket> | undefined;

    beforeAll(() => {
        fs.rmSync(LOG_FILE, { force: true });
        fs.rmSync(STOP_FILE, { force: true });
        oldPortal = process.env.MYDE_INTERNAL_PORTAL;
        oldMode = process.env.MYDE_BUS_MODE;
        // 测试实例默认关内部 portal；这里显式打开，验证非 external 模式。
        process.env.MYDE_INTERNAL_PORTAL = "1";
        process.env.MYDE_BUS_MODE = "mixed";
    });

    afterAll(() => {
        if (oldPortal === undefined) delete process.env.MYDE_INTERNAL_PORTAL;
        else process.env.MYDE_INTERNAL_PORTAL = oldPortal;
        if (oldMode === undefined) delete process.env.MYDE_BUS_MODE;
        else process.env.MYDE_BUS_MODE = oldMode;
        itemSocket?.destroy();
        querySocket?.destroy();
        fs.rmSync(LOG_FILE, { force: true });
    });

    it("注册、上报属性、断开后移除", { timeout: 40000 }, async () => {
        runner = testRunnerApp("/bin/true", ({ runner: appRunner }) => {
            const fs = require("node:fs") as typeof import("node:fs");
            const env = JSON.parse(new URLSearchParams(location.search).get("env") ?? "{}") as Record<string, string>;
            const log = (line: unknown) => fs.appendFileSync("/tmp/myde-tray-watcher-log", `${JSON.stringify(line)}\n`);

            log({
                type: "env",
                bus: env.MYDE_INTERNAL_BUS_ADDRESS,
                host: env.DBUS_SESSION_BUS_ADDRESS,
                mode: env.MYDE_BUS_MODE,
            });

            const tray = myde.MSysApi.tray;
            if (!tray) {
                log({ type: "error", error: "MSysApi.tray 未初始化" });
                appRunner.sendData({ type: "error", error: "MSysApi.tray 未初始化" });
                return;
            }
            tray.ev.on("new", (name) => log({ type: "new", name }));
            tray.ev.on("remove", (name) => log({ type: "remove", name }));
            tray.init()
                .then(() => {
                    log({ type: "ready", items: Array.from(tray.tarysService.keys()) });
                })
                .catch((error) => log({ type: "error", error: String(error) }));

            // 外层 runner.kill() 只杀 npx，Electron 会留下来；用文件通知它自己 app.quit()
            const stopTimer = setInterval(() => {
                if (!fs.existsSync("/tmp/myde-tray-watcher-stop")) return;
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
            expect(envLine.mode).toBe("mixed");
            await waitForLog((line) => line.type === "ready");

            const item = await connect(busAddress);
            itemSocket = item.socket;
            const itemServer = new dbusServer(item.io, ITEM_NAME);
            await itemServer.init();
            itemServer.addObject(ITEM_PATH, "org.kde.StatusNotifierItem", {});

            const watcher = await item.client.getService(WATCHER_NAME);
            const watcherIfc = await (await watcher.getObject(WATCHER_PATH)).getInterface(WATCHER_IFACE);
            const [uniqueName] = await (await item.client.getMetaInterface()).GetNameOwner(ITEM_NAME);

            // 1) 传 bus name（常规形式）
            await watcherIfc.call("RegisterStatusNotifierItem", "s", ITEM_NAME).await();
            const byName = `${ITEM_NAME}${ITEM_PATH}`;
            await waitForLog((line) => line.type === "new" && line.name === byName);

            // 2) 只传对象路径（需要用 sender 补全）
            await watcherIfc.call("RegisterStatusNotifierItem", "s", ITEM_PATH).await();
            const byPath = `${uniqueName}${ITEM_PATH}`;
            await waitForLog((line) => line.type === "new" && line.name === byPath);

            const query = await connect(busAddress);
            querySocket = query.socket;
            const queryWatcher = await query.client.getService(WATCHER_NAME);
            const queryIfc = await (await queryWatcher.getObject(WATCHER_PATH)).getInterface(WATCHER_IFACE);

            const [registered] = await queryIfc.get<"as">("RegisteredStatusNotifierItems");
            expect(registered).toEqual(expect.arrayContaining([byName, byPath]));

            // 断开 item 连接 → watcher 通过 NameOwnerChanged 移除
            itemSocket.destroy();
            itemSocket = undefined;
            await waitForLog((line) => line.type === "remove" && line.name === byName);
            await waitForLog((line) => line.type === "remove" && line.name === byPath);

            const [afterClose] = await queryIfc.get<"as">("RegisteredStatusNotifierItems");
            expect(afterClose).toEqual([]);

            expect(readLog().filter((line) => line.type === "error")).toEqual([]);
        } finally {
            // 让 Electron 自己 app.quit()（会走 will-quit，停掉内部 portal）
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
            // 不等待 waitExit：npx/electron-vite 的 stdout 可能被 Electron 子进程持有，
            // 结束时 stdout 不关闭会把测试拖到超时；应用已经通过 STOP_FILE 退出。
        }
    });
});
