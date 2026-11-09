import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { type DBusType, type DBusTypes, dbusClient } from "myde-dbus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testRunnerApp } from "../../test_runner/test_runner";
import { DBusTestEnv } from "../test/utils/dbus_env/dbus-env";

/**
 * 真 Electron 集成测试：
 * - 桌面进程（Electron renderer）里初始化 xdgDesktopPortal 后端；
 * - 测试进程通过私有 session bus 调 org.freedesktop.impl.portal.FileChooser.OpenFile；
 * - 桌面脚本监听 fileChooser.request，模拟用户选择文件并 accept；
 * - 断言后端返回的 uris / choices / current_filter。
 *
 * 不启动系统 xdg-desktop-portal，也不改宿主配置；私有 bus 由 DBusTestEnv 创建。
 */

const READY_FILE = "/tmp/myde-portal-test-ready";
const SELECTED_FILE = "/tmp/myde-portal-test-selected.txt";
const REQUEST_HANDLE = "/org/freedesktop/portal/desktop/request/test/1";
const BUS_NAME = "org.freedesktop.impl.portal.desktop.myde";

type CallOptions = DBusTypes<"a{sv}">[0];

function dictValue<T extends string>(dict: CallOptions, key: string, signature: T): DBusType<T> {
    const entry = dict.find(([k]) => k === key);
    expect(entry, `结果里缺少 ${key}`).toBeDefined();
    if (!entry) throw new Error(`结果里缺少 ${key}`);
    expect(entry[1].signature).toBe(signature);
    return (entry[1].value as unknown[])[0] as DBusType<T>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("xdg desktop portal file chooser", () => {
    let env: DBusTestEnv;
    let oldBusAddress: string | undefined;

    beforeAll(async () => {
        fs.rmSync(READY_FILE, { force: true });
        fs.rmSync(SELECTED_FILE, { force: true });
        env = new DBusTestEnv();
        await env.start();
        oldBusAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
        process.env.DBUS_SESSION_BUS_ADDRESS = env.busAddress;
    });

    afterAll(async () => {
        if (oldBusAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
        else process.env.DBUS_SESSION_BUS_ADDRESS = oldBusAddress;
        fs.rmSync(READY_FILE, { force: true });
        fs.rmSync(SELECTED_FILE, { force: true });
        await env.stop();
    });

    it("OpenFile 经过 Electron 桌面 accept 后返回 uris", { timeout: 30000 }, async () => {
        const io = await env.createConnection();
        const client = new dbusClient({ io });

        // 桌面脚本里注册监听，然后写 ready 文件；外层等 ready 再发起请求，避免抢跑。
        const runner = testRunnerApp("/bin/true", ({ runner }) => {
            const fs = require("node:fs") as typeof import("node:fs");
            const portal = myde.MSysApi.portal;
            if (!portal) {
                fs.writeFileSync("/tmp/myde-portal-test-ready", "missing");
                runner.sendData({ type: "error", error: "MSysApi.portal 未初始化" });
                return;
            }

            portal.on("fileChooser.request", (req) => {
                runner.sendData({
                    type: "request",
                    id: req.id,
                    mode: req.mode,
                    appId: req.appId,
                    title: req.title,
                    modal: req.modal,
                    multiple: req.multiple,
                    filters: req.filters,
                    choices: req.choices,
                    currentFolder: req.currentFolder,
                });
                fs.writeFileSync("/tmp/myde-portal-test-selected.txt", "selected by electron");
                setTimeout(async () => {
                    const result = await req.accept({
                        paths: ["/tmp/myde-portal-test-selected.txt"],
                        choices: { encoding: "utf8" },
                        currentFilter: req.filters[0],
                    });
                    runner.sendData({ type: "accept", ...result });
                }, 50);
            });
            fs.writeFileSync("/tmp/myde-portal-test-ready", "ok");
        });

        try {
            const meta = await client.getMetaInterface();
            let owned = false;
            for (let i = 0; i < 150; i++) {
                const [has] = await meta.NameHasOwner(BUS_NAME);
                if (has) {
                    owned = true;
                    break;
                }
                await sleep(100);
            }
            expect(owned, "桌面里的 portal 后端没有注册 DBus 名字").toBe(true);

            let ready = "";
            for (let i = 0; i < 100; i++) {
                if (fs.existsSync(READY_FILE)) {
                    ready = fs.readFileSync(READY_FILE, "utf8");
                    if (ready) break;
                }
                await sleep(50);
            }
            expect(ready, "桌面脚本没有注册 fileChooser.request 监听").toBe("ok");

            const service = await client.getService(BUS_NAME);
            const obj = await service.getObject("/org/freedesktop/portal/desktop");
            const ifc = await obj.getInterface("org.freedesktop.impl.portal.FileChooser");

            const options = [
                ["modal", { signature: "b", value: [true] }],
                ["multiple", { signature: "b", value: [false] }],
                ["filters", { signature: "a(sa(us))", value: [[["Text", [[0, "*.txt"]]]]] }],
                [
                    "choices",
                    {
                        signature: "a(ssa(ss)s)",
                        value: [
                            [
                                [
                                    "encoding",
                                    "Encoding",
                                    [
                                        ["utf8", "UTF-8"],
                                        ["latin1", "Latin-1"],
                                    ],
                                    "utf8",
                                ],
                            ],
                        ],
                    },
                ],
                ["current_folder", { signature: "ay", value: [Array.from(Buffer.from("/tmp\0"))] }],
            ] as unknown as CallOptions;

            const result = await ifc
                .call("OpenFile", "osssa{sv}", REQUEST_HANDLE, "org.example.Test", "", "Open test", options)
                .as<"ua{sv}">();
            const [response, results] = result;

            expect(response).toBe(0);
            expect(dictValue(results, "uris", "as")).toEqual([pathToFileURL(SELECTED_FILE).href]);
            expect(dictValue(results, "choices", "a(ss)")).toEqual([["encoding", "utf8"]]);
            expect(dictValue(results, "current_filter", "(sa(us))")).toEqual(["Text", [[0, "*.txt"]]]);

            // 给 runner 一点时间把 accept 日志 flush 到 stdout
            await sleep(300);
        } finally {
            runner.kill();
        }

        const raw = (await runner.waitExit()) as Record<string, unknown>[];
        const requestLog = raw.find((r) => r.type === "request") as
            | {
                  id: string;
                  mode: string;
                  appId: string;
                  title: string;
                  modal: boolean;
                  multiple: boolean;
                  filters: unknown;
                  choices: unknown;
                  currentFolder?: string;
              }
            | undefined;
        expect(requestLog, `桌面没有收到 fileChooser.request: ${JSON.stringify(raw).slice(0, 800)}`).toBeDefined();
        if (!requestLog) throw new Error("桌面没有收到 fileChooser.request");
        expect(requestLog.id).toBe(REQUEST_HANDLE);
        expect(requestLog.mode).toBe("open");
        expect(requestLog.appId).toBe("org.example.Test");
        expect(requestLog.title).toBe("Open test");
        expect(requestLog.modal).toBe(true);
        expect(requestLog.filters).toEqual([{ name: "Text", rules: [{ kind: "glob", pattern: "*.txt" }] }]);
        expect(requestLog.currentFolder).toBe("/tmp");
        expect(raw.find((r) => r.type === "accept")?.ok).toBe(true);
    });
});
