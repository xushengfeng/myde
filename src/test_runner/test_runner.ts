import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WaylandServer } from "../wayland";
import type { renderTools } from "../wayland/render_tools";
import { electronViteBuildArgs } from "./build_mode";
import { startHeadlessDisplay } from "./headless_display";
import { createTestEnv } from "./test_env";

/** 进程退出时兜底清理临时测试桌面（worker 可能不走 testRunner 的 cleanup）。 */
const activeTmpPaths = new Set<string>();
process.once("exit", () => {
    for (const tmpPath of [...activeTmpPaths]) fs.rmSync(tmpPath, { recursive: true, force: true });
});

export function getProjectRoot() {
    let p = __dirname;
    for (let i = 0; i < 10; i++) {
        if (fs.readdirSync(p).includes("package.json")) {
            return p;
        }
        p = p.split(path.sep).slice(0, -1).join(path.sep);
    }
    throw new Error("Cannot find project root");
}

function getFunctionRawCode(fn: (...args: any[]) => any) {
    const code = fn.toString();
    const match = code.match(/^\s*\(?\s*([^)]*)\s*\)?\s*=>\s*{([\s\S]*)}$/);
    if (!match) {
        throw new Error("Cannot parse function code");
    }
    return match[2];
}

export function testRunnerRaw(js: string) {
    const tmpPath = path.join(os.tmpdir(), `myde-test-${Date.now()}`);
    activeTmpPaths.add(tmpPath);
    fs.mkdirSync(tmpPath, { recursive: true });
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myde-test-userdata-"));
    activeTmpPaths.add(userDataDir);
    const pkjson = { main: "index.js", type: "module" };
    fs.writeFileSync(path.join(tmpPath, "package.json"), JSON.stringify(pkjson));
    fs.writeFileSync(path.join(tmpPath, "index.js"), js);

    // 测试实例不接宿主的显示服务：宿主可能同时在跑多个桌面实现，
    // WAYLAND_DISPLAY/DISPLAY 指向哪一个都不确定，接上去就会在别人的桌面上开窗口。
    // 优先用私有的 weston headless + Xwayland（能拿到 GPU），没有就用 headless ozone。
    const display = startHeadlessDisplay();
    const testEnv = createTestEnv({
        desktop: tmpPath,
        display,
        userDataDir,
        extraEnv: { nodeModule: "on" },
    });

    const runtime = child_process.spawn(
        "npx",
        [
            "electron-vite",
            "--ignoreConfigWarning",
            "preview",
            ...electronViteBuildArgs(),
            // electron-vite 会把 `--` 之后的参数通过 ELECTRON_CLI_ARGS 传给 Electron。
            // headless ozone 默认屏幕只有 1x1，会让 window.innerWidth 等布局值失真。
            "--",
            ...(display
                ? ["--ozone-platform=x11"]
                : ["--ozone-platform=headless", "--ozone-override-screen-size=1920,1080"]),
            // 测试桌面自身是隐藏窗口，不能让它被当成后台页限制定时器/输入投递
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
        ],
        {
            stdio: "pipe",
            env: testEnv,
            cwd: getProjectRoot(),
        },
    );
    const out: unknown[] = [];
    runtime.stdout?.on("data", (data) => {
        const lineData = data.toString();
        if (lineData.startsWith("{")) {
            try {
                const jsonData = JSON.parse(lineData);
                out.push(jsonData);
                return;
            } catch {}
        }
        // 非 JSON 行是 electron 主进程/桌面侧的普通输出，
        // 直接丢弃会让模板内的报错完全不可见，转发到 stderr 便于排查
        process.stderr.write(lineData);
    });
    runtime.stderr?.on("data", (data) => {
        const lineData = data.toString();
        console.error(lineData);
    });

    let killed = false;
    const kill = () => {
        if (killed) return;
        killed = true;
        runtime.kill();
        clearTimeout(killTimeout);
        // 部分测试（tray/notification）不等待 waitExit，npx 的 stdout 可能被
        // Electron 子进程一直持有；测试数据已经发完，这里直接收掉 weston，
        // 不依赖 runtime 的 exit 事件，否则 worker 退出后 weston 会成为孤儿。
        display?.stop();
    };
    const killTimeout = setTimeout(kill, 20000);
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(killTimeout);
        // 提前退出（含超时/测试失败）也不能留下 weston / 临时桌面 / userData
        display?.stop();
        for (const dir of [tmpPath, userDataDir]) {
            activeTmpPaths.delete(dir);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
    runtime.on("exit", cleanup);

    return {
        kill,
        waitExit: () =>
            new Promise<unknown[]>((resolve) => {
                let settled = false;
                let exited = false;
                let stdoutEnded = false;
                let graceTimer: ReturnType<typeof setTimeout> | undefined;
                const resolveOnce = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    if (graceTimer) clearTimeout(graceTimer);
                    resolve(out);
                };
                const maybeFinish = () => {
                    if (exited && stdoutEnded) resolveOnce();
                };
                runtime.on("exit", () => {
                    exited = true;
                    maybeFinish();
                    // 进程退出事件可能早于 stdout 读完最后一条 JSON，
                    // 只监听 exit 会丢掉紧邻 kill 之前发送的数据
                    graceTimer = setTimeout(resolveOnce, 500);
                });
                runtime.stdout?.on("end", () => {
                    stdoutEnded = true;
                    maybeFinish();
                });
            }),
    };
}

export type TestServerX = {
    runApp: (
        exec: string,
        op?: number | { xServerNum?: number; env?: Record<string, string> },
    ) => import("node:child_process").ChildProcess;
    startXwayland: () => Promise<number | undefined>;
    stopXwayland: () => void;
    server: WaylandServer;
};

export function testRunnerApp(
    appPath: string,
    script: (a: {
        /** wayland 服务端：窗口/光标/剪贴板的事件、查询、命令都在这 */
        server: WaylandServer;
        /** MSysApi.server() 的完整返回值（含 startXwayland） */
        serverX: TestServerX;
        /** 渲染器实例，用于取窗口元素与像素预览 */
        render: renderTools;
        runner: {
            sendData: (data: unknown) => void;
            kill: () => void;
        };
    }) => void,
) {
    const baseTeamplate = getFunctionRawCode(() => {
        const { ipcRenderer } = require("electron");
        const render = new myde.MUtils.renderToolsHtmlEl();

        const serverX = myde.MSysApi.server({
            render: render,
        });
        const server = serverX.server;

        // 桌面可用空间
        server.respond("surfaceBounds.request", () => {
            return { width: window.innerWidth, height: window.innerHeight };
        });

        const p = serverX.runApp(`${__dirname.replace("/out/renderer", "")}/${appPath}`);
        p.stdout?.on("data", (data) => {
            ipcRenderer.send("test", { type: "applog", data: data.toString() });
        });
        p.stderr?.on("data", (data) => {
            ipcRenderer.send("test", { type: "applog", data: data.toString() });
        });
    });
    // runner 只被拼出来的脚本读取，写成模板内的 TS 常量会触发未使用告警，故拼在字符串侧
    const runnerCode =
        "const runner={sendData:(data)=>ipcRenderer.send('test',{type:'data',data}),kill:()=>ipcRenderer.send('test',{type:'kill'})};";
    // baseTeamplate 是函数体原文，末尾没有分号；若直接拼接下一行以 `(` 开头的脚本调用，
    // JS 会按 ASI 规则把两行合并成一条调用链（p.stdout.on(...)(fn)）→ TypeError 中止整个模块，
    // 导致后面的测试脚本永远执行不到。补分号强制语句结束。
    const app = `const appPath="${appPath}"\n${baseTeamplate};\n${runnerCode}\nPromise.resolve((${script.toString()})({ server, serverX, render, runner })).catch((error) => {\n    ipcRenderer.send("test", { type: "applog", data: "TEST_CALLBACK_ERROR " + String(error?.stack ?? error) });\n    ipcRenderer.send("test", { type: "kill" });\n})`;
    const r = testRunnerRaw(app);
    return r;
}
