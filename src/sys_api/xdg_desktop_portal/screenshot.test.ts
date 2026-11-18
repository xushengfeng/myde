import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testRunnerApp } from "../../test_runner/test_runner";
import { DBusTestEnv } from "../test/utils/dbus_env/dbus-env";

/**
 * 真 Electron 集成测试：
 * - 桌面进程里初始化 xdgDesktopPortal 后端；
 * - 测试进程用 gdbus 调 org.freedesktop.impl.portal.Screenshot / Access
 *   （myde-dbus 的客户端编码对部分 header 长度有 bug，这里不用它）；
 * - 桌面脚本监听 screenshot.request / screenshot.pickColor / access.request 并接受请求；
 * - 断言返回的 uri、保存下来的 PNG、颜色和权限响应。
 *
 * 不启动系统 xdg-desktop-portal，也不改宿主配置；私有 bus 由 DBusTestEnv 创建。
 */

const READY_FILE = "/tmp/myde-portal-screenshot-ready";
const REPORT_FILE = "/tmp/myde-portal-screenshot-report.jsonl";
const SHOT_DIR = "/tmp/myde-portal-screenshot";
const SHOT_FILE = `${SHOT_DIR}/portal.png`;
const SCREENSHOT_HANDLE = "/org/freedesktop/portal/desktop/request/test/screenshot";
const PICK_HANDLE = "/org/freedesktop/portal/desktop/request/test/pick";
const ACCESS_HANDLE = "/org/freedesktop/portal/desktop/request/test/access";
const DENY_HANDLE = "/org/freedesktop/portal/desktop/request/test/deny";
const BUS_NAME = "org.freedesktop.impl.portal.desktop.myde";
const OBJECT_PATH = "/org/freedesktop/portal/desktop";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl6sAAAAASUVORK5CYII=";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("xdg desktop portal screenshot", () => {
    let env: DBusTestEnv;
    let oldBusAddress: string | undefined;

    function gdbus(method: string, ...args: string[]): string {
        return execFileSync(
            "gdbus",
            [
                "call",
                "--address",
                env.busAddress,
                "--dest",
                BUS_NAME,
                "--object-path",
                OBJECT_PATH,
                "--method",
                method,
                ...args,
            ],
            { encoding: "utf8", timeout: 30000 },
        );
    }

    beforeAll(async () => {
        fs.rmSync(READY_FILE, { force: true });
        fs.rmSync(REPORT_FILE, { force: true });
        fs.rmSync(SHOT_DIR, { recursive: true, force: true });
        env = new DBusTestEnv();
        await env.start();
        oldBusAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
        process.env.DBUS_SESSION_BUS_ADDRESS = env.busAddress;
    });

    afterAll(async () => {
        if (oldBusAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
        else process.env.DBUS_SESSION_BUS_ADDRESS = oldBusAddress;
        fs.rmSync(READY_FILE, { force: true });
        fs.rmSync(REPORT_FILE, { force: true });
        fs.rmSync(SHOT_DIR, { recursive: true, force: true });
        await env.stop();
    });

    it("Screenshot/PickColor/Access 经过 Electron 桌面处理", { timeout: 60000 }, async () => {
        const runner = testRunnerApp("/bin/true", ({ runner }) => {
            const fs = require("node:fs") as typeof import("node:fs");
            const portal = myde.MSysApi.portal;
            const reportFile = "/tmp/myde-portal-screenshot-report.jsonl";
            const report = (data: unknown) => fs.appendFileSync(reportFile, `${JSON.stringify(data)}\n`);
            if (!portal) {
                fs.writeFileSync("/tmp/myde-portal-screenshot-ready", "missing");
                runner.sendData({ type: "error", error: "MSysApi.portal 未初始化" });
                return;
            }
            const png = Uint8Array.from(
                Buffer.from(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl6sAAAAASUVORK5CYII=",
                    "base64",
                ),
            );

            portal.on("screenshot.request", async (req) => {
                report({
                    type: "screenshot-request",
                    id: req.id,
                    appId: req.appId,
                    interactive: req.interactive,
                    target: req.target,
                    permissionStoreChecked: req.permissionStoreChecked,
                });
                const result = await req.accept(
                    { png, width: 1, height: 1 },
                    { directory: "/tmp/myde-portal-screenshot", name: "portal.png" },
                );
                report({ type: "screenshot-accept", ...result });
            });

            portal.on("screenshot.pickColor", async (req) => {
                report({ type: "pick-request", id: req.id, appId: req.appId });
                const result = await req.accept([0.25, 0.5, 0.75]);
                report({ type: "pick-accept", ...result });
            });

            portal.on("access.request", async (req) => {
                report({
                    type: "access-request",
                    id: req.id,
                    appId: req.appId,
                    title: req.title,
                    subtitle: req.subtitle,
                    body: req.body,
                    denyLabel: req.denyLabel,
                    grantLabel: req.grantLabel,
                    icon: req.icon,
                    choices: req.choices,
                });
                if (req.title.includes("Deny")) {
                    await req.deny();
                    report({ type: "access-denied", id: req.id });
                } else {
                    const result = await req.accept({ remember: "true" });
                    report({ type: "access-accept", ...result });
                }
            });

            fs.writeFileSync("/tmp/myde-portal-screenshot-ready", "ok");
        });

        try {
            let ready = "";
            for (let i = 0; i < 160; i++) {
                if (fs.existsSync(READY_FILE)) {
                    ready = fs.readFileSync(READY_FILE, "utf8");
                    if (ready) break;
                }
                await sleep(100);
            }
            expect(ready, `桌面脚本没有注册 portal 监听: ${ready}`).toBe("ok");

            // Properties：Screenshot 接口广告 version 与可用 target
            const props = gdbus("org.freedesktop.DBus.Properties.GetAll", "org.freedesktop.impl.portal.Screenshot");
            expect(props).toContain("'version': <uint32 3>");
            expect(props).toContain("'AvailableTargets': <uint32 1>");

            const screenshotOptions = [
                "@a{sv} {",
                "'modal': <false>,",
                "'interactive': <true>,",
                "'target': <uint32 1>,",
                "'permission_store_checked': <true>",
                "}",
            ].join(" ");
            const screenshotReply = gdbus(
                "org.freedesktop.impl.portal.Screenshot.Screenshot",
                SCREENSHOT_HANDLE,
                "org.example.Test",
                "",
                screenshotOptions,
            );
            expect(screenshotReply).toContain("uint32 0");
            expect(/uri': <'(.*?)'>/.exec(screenshotReply)?.[1]).toBe(pathToFileURL(SHOT_FILE).href);
            expect(fs.readFileSync(SHOT_FILE)).toEqual(Buffer.from(PNG_BASE64, "base64"));

            const pickReply = gdbus(
                "org.freedesktop.impl.portal.Screenshot.PickColor",
                PICK_HANDLE,
                "org.example.Test",
                "",
                "@a{sv} {}",
            );
            expect(pickReply).toContain("uint32 0");
            const color = /color': <\(([^)]*)\)>/
                .exec(pickReply)?.[1]
                .split(",")
                .map((value) => Number(value.trim()));
            expect(color).toEqual([0.25, 0.5, 0.75]);

            const accessOptions = [
                "@a{sv} {",
                "'modal': <true>,",
                "'deny_label': <'Deny'>,",
                "'grant_label': <'Allow'>,",
                "'icon': <'dialog-password'>,",
                "'choices': <[('remember', 'Remember', @a(ss) [], 'false')]>",
                "}",
            ].join(" ");
            const accessReply = gdbus(
                "org.freedesktop.impl.portal.Access.AccessDialog",
                ACCESS_HANDLE,
                "org.example.Test",
                "",
                "Allow test",
                "subtitle",
                "body",
                accessOptions,
            );
            expect(accessReply).toContain("uint32 0");
            expect(accessReply).toContain("('remember', 'true')");

            const denyReply = gdbus(
                "org.freedesktop.impl.portal.Access.AccessDialog",
                DENY_HANDLE,
                "org.example.Test",
                "",
                "Deny test",
                "",
                "",
                accessOptions,
            );
            expect(denyReply).toContain("uint32 1");

            await sleep(300);
        } finally {
            runner.kill();
        }

        await runner.waitExit();
        const raw = fs.existsSync(REPORT_FILE)
            ? fs
                  .readFileSync(REPORT_FILE, "utf8")
                  .split("\n")
                  .filter((line) => line.length > 0)
                  .map((line) => JSON.parse(line) as Record<string, unknown>)
            : [];
        const screenshotRequest = raw.find((r) => r.type === "screenshot-request") as
            | {
                  id: string;
                  appId: string;
                  interactive: boolean;
                  target: string;
                  permissionStoreChecked: boolean;
              }
            | undefined;
        expect(
            screenshotRequest,
            `桌面没有收到 screenshot.request: ${JSON.stringify(raw).slice(0, 800)}`,
        ).toBeDefined();
        if (!screenshotRequest) throw new Error("桌面没有收到 screenshot.request");
        expect(screenshotRequest.id).toBe(SCREENSHOT_HANDLE);
        expect(screenshotRequest.appId).toBe("org.example.Test");
        expect(screenshotRequest.interactive).toBe(true);
        expect(screenshotRequest.target).toBe("screen");
        expect(screenshotRequest.permissionStoreChecked).toBe(true);
        expect(raw.find((r) => r.type === "screenshot-accept")?.ok).toBe(true);

        const accessRequest = raw.find((r) => r.type === "access-request") as
            | {
                  title: string;
                  subtitle: string;
                  body: string;
                  denyLabel: string;
                  grantLabel: string;
                  icon: string;
                  choices: { id: string; options: unknown[] }[];
              }
            | undefined;
        expect(accessRequest).toBeDefined();
        if (!accessRequest) throw new Error("桌面没有收到 access.request");
        expect(accessRequest.title).toBe("Allow test");
        expect(accessRequest.subtitle).toBe("subtitle");
        expect(accessRequest.body).toBe("body");
        expect(accessRequest.denyLabel).toBe("Deny");
        expect(accessRequest.grantLabel).toBe("Allow");
        expect(accessRequest.icon).toBe("dialog-password");
        expect(accessRequest.choices).toEqual([{ id: "remember", label: "Remember", options: [], initial: "false" }]);
        expect(raw.find((r) => r.type === "access-accept")?.ok).toBe(true);
        expect(raw.find((r) => r.type === "access-denied")?.id).toBe(DENY_HANDLE);
        expect(raw.find((r) => r.type === "pick-accept")?.ok).toBe(true);
    });
});
