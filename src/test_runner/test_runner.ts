import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WaylandClient } from "../desktop-api";
import type { renderTools } from "../wayland/render_tools";

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
    const match = code.match(/^\s*\(?\s*([^\)]*)\s*\)?\s*=>\s*{([\s\S]*)}$/);
    if (!match) {
        throw new Error("Cannot parse function code");
    }
    return match[2];
}

export function testRunnerRaw(js: string) {
    const tmpPath = path.join(os.tmpdir(), `myde-test-${Date.now()}`);
    fs.mkdirSync(tmpPath, { recursive: true });
    const pkjson = { main: "index.js", type: "module" };
    fs.writeFileSync(path.join(tmpPath, "package.json"), JSON.stringify(pkjson));
    fs.writeFileSync(path.join(tmpPath, "index.js"), js);

    const env = process.env;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;

    const runtime = child_process.spawn("npx", ["electron-vite", "--ignoreConfigWarning", "preview"], {
        stdio: "pipe",
        env: {
            ...env,
            desktop: tmpPath,
            nodeModule: "on",
            testMode: "on",
        },
        cwd: getProjectRoot(),
    });
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

    const killTimeout = setTimeout(() => {
        runtime.kill();
    }, 20000);

    return {
        kill: () => {
            runtime.kill();
            clearTimeout(killTimeout);
        },
        waitExit: () =>
            new Promise<unknown[]>((resolve) => {
                let exited = false;
                let stdoutEnded = false;
                let graceTimer: ReturnType<typeof setTimeout> | undefined;
                const finish = () => {
                    clearTimeout(killTimeout);
                    if (graceTimer) clearTimeout(graceTimer);
                    resolve(out);
                };
                const maybeFinish = () => {
                    if (exited && stdoutEnded) finish();
                };
                runtime.on("exit", () => {
                    exited = true;
                    maybeFinish();
                    // 进程退出事件可能早于 stdout 读完最后一条 JSON，
                    // 只监听 exit 会丢掉紧邻 kill 之前发送的数据
                    graceTimer = setTimeout(finish, 500);
                });
                runtime.stdout?.on("end", () => {
                    stdoutEnded = true;
                    maybeFinish();
                });
            }),
    };
}

export function testRunnerApp(
    appPath: string,
    script: (a: {
        client: WaylandClient;
        /** 渲染器实例，用于订阅 renderToolsOn（如 cursor 形态） */
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

        const clientPromise = Promise.withResolvers<{
            client: WaylandClient;
            render: renderTools;
            runner: {
                sendData: (data: unknown) => void;
                kill: () => void;
            };
        }>();

        server.on("newClient", (client) => {
            client.onSync("windowBound", () => {
                return { width: window.innerWidth, height: window.innerHeight };
            });
            clientPromise.resolve({
                client: client,
                render: render,
                runner: {
                    sendData: (data) => {
                        ipcRenderer.send("test", { type: "data", data });
                    },
                    kill: () => {
                        ipcRenderer.send("test", { type: "kill" });
                    },
                },
            });
        });

        const p = serverX.runApp(`${__dirname.replace("/out/renderer", "")}/${appPath}`);
        p.stdout.on("data", (data) => {
            ipcRenderer.send("test", { type: "applog", data: data.toString() });
        });
    });
    // baseTeamplate 是函数体原文，末尾没有分号；若直接拼接下一行以 `(` 开头的脚本调用，
    // JS 会按 ASI 规则把两行合并成一条调用链（p.stdout.on(...)(fn)）→ TypeError 中止整个模块，
    // 导致后面的测试脚本永远执行不到。补分号强制语句结束。
    const app = `const appPath="${appPath}"\n${baseTeamplate};\n${`(${script.toString()})(await clientPromise.promise)`}`;
    const r = testRunnerRaw(app);
    return r;
}
