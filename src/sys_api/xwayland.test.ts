import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testRunnerApp } from "../test_runner/test_runner";

const binDir = "/tmp/myde-xwayland-test-bin";
const appPath = "/tmp/myde-xwayland-test-app.js";
const satellitePath = path.join(binDir, "xwayland-satellite");
const xwaylandPath = path.join(binDir, "Xwayland");
const oldPath = process.env.PATH;
const fakeApp = `#!/usr/bin/env node
console.log(JSON.stringify({ display: process.env.DISPLAY ?? null }));
`;

function writeExecutable(file: string, content: string) {
    fs.writeFileSync(file, content);
    fs.chmodSync(file, 0o755);
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

        try {
            const { waitExit } = testRunnerApp("/bin/true", async ({ serverX, runner }) => {
                const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
                const readDisplay = (label: string) =>
                    new Promise<void>((resolve) => {
                        const child = serverX.runApp("/tmp/myde-xwayland-test-app.js");
                        let done = false;
                        const finish = (value?: string) => {
                            if (done) return;
                            done = true;
                            if (value !== undefined) runner.sendData({ type: "env", label, value });
                            resolve();
                        };
                        child.stdout?.on("data", (data) => finish(data.toString().trim()));
                        setTimeout(() => finish(), 1000);
                    });

                await readDisplay("before");
                const display = await serverX.startXwayland();
                runner.sendData({ type: "xwayland", display });
                await sleep(100);
                await readDisplay("after");
                serverX.stopXwayland();
                runner.sendData({ type: "stopped" });
                runner.kill();
            });

            const raw = (await waitExit()) as Record<string, unknown>[];
            const before = raw.find((r) => r.type === "env" && r.label === "before");
            const after = raw.find((r) => r.type === "env" && r.label === "after");
            const xwayland = raw.find((r) => r.type === "xwayland");
            expect(before, `没有拿到启动 xwayland 前的环境: ${JSON.stringify(raw)}`).toBeDefined();
            expect(after, `没有拿到启动 xwayland 后的环境: ${JSON.stringify(raw)}`).toBeDefined();
            expect(xwayland, `startXwayland 没有返回 display: ${JSON.stringify(raw)}`).toBeDefined();
            expect(JSON.parse(String(before?.value))).toEqual({ display: null });
            const display = Number(xwayland?.display);
            expect(Number.isInteger(display)).toBe(true);
            expect(JSON.parse(String(after?.value))).toEqual({ display: `:${display}` });
            expect(raw.some((r) => r.type === "stopped")).toBe(true);
        } finally {
            process.env.PATH = oldPath;
            fs.rmSync(binDir, { recursive: true, force: true });
            fs.rmSync(appPath, { force: true });
        }
    });

    it("没有 xwayland-satellite 时不传 DISPLAY", { timeout: 20000 }, async () => {
        writeExecutable(appPath, fakeApp);
        const oldSatellite = process.env.MYDE_XWAYLAND_SATELLITE;
        // 指向不存在的路径，确保 findExecutable 失败，不受宿主是否安装了真实 satellite 影响
        process.env.MYDE_XWAYLAND_SATELLITE = "/tmp/myde-xwayland-test-missing-satellite";

        try {
            const { waitExit } = testRunnerApp("/bin/true", async ({ serverX, runner }) => {
                const display = await serverX.startXwayland();
                runner.sendData({ type: "xwayland", display });
                const child = serverX.runApp("/tmp/myde-xwayland-test-app.js");
                let done = false;
                const finish = (value?: string) => {
                    if (done) return;
                    done = true;
                    if (value !== undefined) runner.sendData({ type: "env", label: "after", value });
                    serverX.stopXwayland();
                    runner.sendData({ type: "stopped" });
                    runner.kill();
                };
                child.stdout?.on("data", (data) => finish(data.toString().trim()));
                setTimeout(() => finish(), 1500);
            });

            const raw = (await waitExit()) as Record<string, unknown>[];
            const xwayland = raw.find((r) => r.type === "xwayland");
            const after = raw.find((r) => r.type === "env" && r.label === "after");
            expect(xwayland, `startXwayland 没有返回: ${JSON.stringify(raw)}`).toBeDefined();
            expect(xwayland?.display).toBeUndefined();
            expect(after, `应用没有启动: ${JSON.stringify(raw)}`).toBeDefined();
            expect(JSON.parse(String(after?.value))).toEqual({ display: null });
            expect(raw.some((r) => r.type === "stopped")).toBe(true);
        } finally {
            if (oldSatellite === undefined) delete process.env.MYDE_XWAYLAND_SATELLITE;
            else process.env.MYDE_XWAYLAND_SATELLITE = oldSatellite;
            fs.rmSync(appPath, { force: true });
        }
    });
});

afterAll(() => {
    process.env.PATH = oldPath;
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(appPath, { force: true });
});
