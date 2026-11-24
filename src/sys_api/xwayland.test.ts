import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testRunnerApp } from "../test_runner/test_runner";

const binDir = "/tmp/myde-xwayland-test-bin";
const appPath = "/tmp/myde-xwayland-test-app.js";
const satellitePath = path.join(binDir, "xwayland-satellite");
const xwaylandPath = path.join(binDir, "Xwayland");
const oldPath = process.env.PATH;
// 通过文件回传：全量测试时子进程 stdout 事件偶尔会在 renderer 忙时丢，
// 文件落盘 + 轮询不受事件时序影响。
const fakeApp = `#!/usr/bin/env node
const fs = require("node:fs");
const payload = JSON.stringify({ display: process.env.DISPLAY ?? null });
const out = process.argv[2];
if (out) fs.writeFileSync(out, payload + "\\n");
else console.log(payload);
`;

function writeExecutable(file: string, content: string) {
    fs.writeFileSync(file, content);
    fs.chmodSync(file, 0o755);
}

/** 读 fake app 落盘的结果；外层读取，不依赖 renderer 的 stdout/IPC 时序。 */
function readXwaylandOut(label: string): { display: string | null } | undefined {
    const file = `/tmp/myde-xwayland-test-out-${label}`;
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8").trim()) as { display: string | null };
}

describe("xwayland", () => {
    it("startXwayland 分配 display，runApp 自动带 DISPLAY", { timeout: 20000 }, async () => {
        fs.rmSync(binDir, { recursive: true, force: true });
        fs.rmSync(appPath, { force: true });
        fs.mkdirSync(binDir, { recursive: true });
        writeExecutable(
            satellitePath,
            `#!/usr/bin/env node
const net = require("node:net");
const fs = require("node:fs");
const display = process.argv[2];
const n = display.slice(1);
fs.mkdirSync("/tmp/.X11-unix", { recursive: true });
const socketPath = "/tmp/.X11-unix/X" + n;
try { fs.rmSync(socketPath, { force: true }); } catch {}
const server = net.createServer((socket) => socket.end());
server.listen(socketPath);
process.on("SIGTERM", () => {
    try { server.close(); fs.rmSync(socketPath, { force: true }); } finally { process.exit(0); }
});
setInterval(() => {}, 1000);
`,
        );
        writeExecutable(xwaylandPath, "#!/bin/sh\nexit 0\n");
        writeExecutable(appPath, fakeApp);
        process.env.PATH = `${binDir}:${oldPath ?? "/usr/bin:/bin"}`;
        fs.rmSync("/tmp/myde-xwayland-test-out-before", { force: true });
        fs.rmSync("/tmp/myde-xwayland-test-out-after", { force: true });

        try {
            const { waitExit } = testRunnerApp("/bin/true", async ({ serverX, runner }) => {
                const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
                const runFakeApp = async (label: string) => {
                    serverX.runApp(`/tmp/myde-xwayland-test-app.js /tmp/myde-xwayland-test-out-${label}`);
                    // 让应用把 DISPLAY 写进结果文件；外层在 waitExit 后读取。
                    await sleep(1000);
                };

                await runFakeApp("before");
                const display = await serverX.startXwayland();
                runner.sendData({ type: "xwayland", display });
                await runFakeApp("after");
                serverX.stopXwayland();
                runner.sendData({ type: "stopped" });
                runner.kill();
            });

            const raw = (await waitExit()) as Record<string, unknown>[];
            const before = readXwaylandOut("before");
            const after = readXwaylandOut("after");
            const xwayland = raw.find((r) => r.type === "xwayland");
            expect(before, `没有拿到启动 xwayland 前的环境: ${JSON.stringify(raw)}`).toBeDefined();
            expect(after, `没有拿到启动 xwayland 后的环境: ${JSON.stringify(raw)}`).toBeDefined();
            expect(xwayland, `startXwayland 没有返回 display: ${JSON.stringify(raw)}`).toBeDefined();
            expect(before).toEqual({ display: null });
            const display = Number(xwayland?.display);
            expect(Number.isInteger(display)).toBe(true);
            expect(after).toEqual({ display: `:${display}` });
            expect(raw.some((r) => r.type === "stopped")).toBe(true);
        } finally {
            process.env.PATH = oldPath;
            fs.rmSync(binDir, { recursive: true, force: true });
            fs.rmSync(appPath, { force: true });
            fs.rmSync("/tmp/myde-xwayland-test-out-before", { force: true });
            fs.rmSync("/tmp/myde-xwayland-test-out-after", { force: true });
        }
    });

    it("没有 xwayland-satellite 时不传 DISPLAY", { timeout: 20000 }, async () => {
        writeExecutable(appPath, fakeApp);
        fs.rmSync("/tmp/myde-xwayland-test-out-after", { force: true });
        const oldSatellite = process.env.MYDE_XWAYLAND_SATELLITE;
        // 指向不存在的路径，确保 findExecutable 失败，不受宿主是否安装了真实 satellite 影响
        process.env.MYDE_XWAYLAND_SATELLITE = "/tmp/myde-xwayland-test-missing-satellite";

        try {
            const { waitExit } = testRunnerApp("/bin/true", async ({ serverX, runner }) => {
                const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
                const display = await serverX.startXwayland();
                runner.sendData({ type: "xwayland", display });
                serverX.runApp("/tmp/myde-xwayland-test-app.js /tmp/myde-xwayland-test-out-after");
                await sleep(1000);
                serverX.stopXwayland();
                runner.sendData({ type: "stopped" });
                runner.kill();
            });

            const raw = (await waitExit()) as Record<string, unknown>[];
            const xwayland = raw.find((r) => r.type === "xwayland");
            const after = readXwaylandOut("after");
            expect(xwayland, `startXwayland 没有返回: ${JSON.stringify(raw)}`).toBeDefined();
            expect(xwayland?.display).toBeUndefined();
            expect(after, `应用没有启动: ${JSON.stringify(raw)}`).toBeDefined();
            expect(after).toEqual({ display: null });
            expect(raw.some((r) => r.type === "stopped")).toBe(true);
        } finally {
            if (oldSatellite === undefined) delete process.env.MYDE_XWAYLAND_SATELLITE;
            else process.env.MYDE_XWAYLAND_SATELLITE = oldSatellite;
            fs.rmSync(appPath, { force: true });
            fs.rmSync("/tmp/myde-xwayland-test-out-after", { force: true });
        }
    });
});

afterAll(() => {
    process.env.PATH = oldPath;
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(appPath, { force: true });
});
