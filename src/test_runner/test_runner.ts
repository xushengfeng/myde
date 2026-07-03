import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WaylandClient } from "../desktop-api";

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
            } catch {}
        }
    });
    runtime.stderr?.on("data", (data) => {
        const lineData = data.toString();
        console.error(lineData);
    });

    const killTimeout = setTimeout(() => {
        runtime.kill();
    }, 10000);

    return {
        kill: () => {
            runtime.kill();
            clearTimeout(killTimeout);
        },
        waitExit: () =>
            new Promise<unknown[]>((resolve) =>
                runtime.on("exit", () => {
                    resolve(out);
                    clearTimeout(killTimeout);
                }),
            ),
    };
}

export function testRunnerApp(
    appPath: string,
    script: (a: {
        client: WaylandClient;
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
            dev: true,
            render: render,
        });
        const server = serverX.server;

        const clientPromise = Promise.withResolvers<{
            client: WaylandClient;
            runner: {
                sendData: (data: unknown) => void;
                kill: () => void;
            };
        }>();

        server.on("newClient", (client) => {
            client.onSync("windowBound", () => {
                return { width: window.innerWidth, height: window.innerHeight };
            });
            console.log("insert");
            clientPromise.resolve({
                client: client,
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

        serverX.runApp(`${__dirname.replace("/out/renderer", "")}/${appPath}`);
    });
    const app = `const appPath="${appPath}"\n${baseTeamplate}\n${`(${script.toString()})(await clientPromise.promise)`}`;
    const r = testRunnerRaw(app);
    return r;
}
