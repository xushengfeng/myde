import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { electronViteBuildArgs } from "./build_mode";
import { type HeadlessDisplay, startHeadlessDisplay } from "./headless_display";
import { type PrivateBus, startPrivateBus } from "./private_bus";
import { sleep } from "./process_utils";
import { createTestEnv } from "./test_env";
import { getProjectRoot } from "./test_runner";

/** 进程退出时兜底删除测试 userData，避免 Electron 异常退出后残留 Cache/Crashpad。 */
const activeUserDataDirs = new Set<string>();
process.once("exit", () => {
    for (const dir of [...activeUserDataDirs]) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
    }
});

function removeUserDataDir(dir: string) {
    activeUserDataDirs.delete(dir);
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
}

async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            server.close(() => resolve(port));
        });
    });
}

type CdpError = { code: number; message: string };

class CdpClient {
    private nextId = 1;
    private pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
    >();
    private listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
    private closed = false;

    private constructor(private ws: WebSocket) {
        ws.onmessage = (event) => {
            let message: {
                id?: number;
                method?: string;
                params?: Record<string, unknown>;
                result?: unknown;
                error?: CdpError;
            };
            try {
                message = JSON.parse(String(event.data));
            } catch {
                return;
            }
            if (message.id !== undefined) {
                const pending = this.pending.get(message.id);
                if (!pending) return;
                this.pending.delete(message.id);
                clearTimeout(pending.timer);
                if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
                else pending.resolve(message.result);
                return;
            }
            if (message.method) {
                for (const listener of this.listeners.get(message.method) ?? []) {
                    listener(message.params ?? {});
                }
            }
        };
        ws.onclose = () => {
            this.closed = true;
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(new Error("CDP 连接已关闭"));
            }
            this.pending.clear();
        };
    }

    static async connect(url: string, timeout = 10000): Promise<CdpClient> {
        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), timeout);
            ws.onopen = () => {
                clearTimeout(timer);
                resolve();
            };
            ws.onerror = () => {
                clearTimeout(timer);
                reject(new Error("CDP WebSocket 连接失败"));
            };
        });
        return new CdpClient(ws);
    }

    send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeout = 15000): Promise<T> {
        if (this.closed) return Promise.reject(new Error(`CDP 已关闭，无法发送 ${method}`));
        return new Promise<T>((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP ${method} 超时`));
            }, timeout);
            this.pending.set(id, {
                resolve: (value) => resolve(value as T),
                reject,
                timer,
            });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
        let set = this.listeners.get(method);
        if (!set) {
            set = new Set();
            this.listeners.set(method, set);
        }
        set.add(listener);
        return () => set?.delete(listener);
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        try {
            this.ws.close();
        } catch {}
        for (const pending of this.pending.values()) clearTimeout(pending.timer);
        this.pending.clear();
    }
}

export type ScreenshotClip = {
    x: number;
    y: number;
    width: number;
    height: number;
    /** 截图缩放；小于 1 时 Chromium 直接输出更小的图，适合高频采样 */
    scale?: number;
};

export type ScreenshotOptions = {
    format?: "png" | "jpeg";
    /**
     * 只截一块区域（CSS px）。高频逐帧采样时用它缩小截图和解码成本。
     */
    clip?: ScreenshotClip;
    /** 是否从合成表面截；隐藏窗口必须为 false（默认） */
    fromSurface?: boolean;
};

/** 桌面页面的 DOM / 输入 / 截图 / 日志入口。 */
export type DesktopRunner = {
    /** 原生 CDP 调用，域和参数见 Chrome DevTools Protocol */
    send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
    /** 订阅 CDP 事件，返回取消订阅函数 */
    on(method: string, listener: (params: Record<string, unknown>) => void): () => void;
    /** 在桌面页面求值；返回 JSON 可序列化的值 */
    evaluate<T = unknown>(expression: string): Promise<T>;
    /** 等页面表达式为真 */
    waitFor(expression: string, timeout?: number): Promise<void>;
    /** 截取桌面页面（隐藏窗口也能截）；可只截一块区域 */
    screenshot(options?: ScreenshotOptions): Promise<Buffer>;
    /** 移动指针 */
    move(x: number, y: number): Promise<void>;
    /** 点击 */
    click(x: number, y: number, button?: MouseButton): Promise<void>;
    /** 鼠标事件 */
    mouse(op: MouseEventInput): Promise<void>;
    /** 按键（down + up），可带修饰键 */
    key(key: string, op?: KeyOptions): Promise<void>;
    /** 输入文本 */
    text(text: string): Promise<void>;
    /** 已收到的 console / 异常 / 浏览器日志 */
    logs(): readonly string[];
    /** 清空日志 */
    clearLogs(): void;
    /** electron-vite / Electron 的原始输出（失败排查用） */
    output(): readonly string[];
    /** 关闭 Electron 和私有显示；可重复调用 */
    close(): Promise<void>;
};

export type MouseButton = "left" | "middle" | "right";

export type MouseEventInput = {
    type: "move" | "down" | "up" | "click";
    x: number;
    y: number;
    button?: MouseButton;
    /** 连击次数，默认 1 */
    clickCount?: number;
};

export type KeyOptions = {
    code?: string;
    /** windowVirtualKeyCode；不传按常见键映射 */
    keyCode?: number;
    /** Alt=1, Ctrl=2, Meta=4, Shift=8 */
    modifiers?: number;
};

export type DesktopRunnerOptions = {
    /** 桌面目录，相对项目根或绝对路径；默认 desktop/official。`:test` 表示内置测试桌面。 */
    desktop?: string;
    /** CDP 启动超时，默认 30000ms */
    timeout?: number;
    /** 启动后等待的页面表达式，默认 document.readyState === "complete" */
    ready?: string;
    /** 额外环境变量 */
    env?: Record<string, string>;
    /** 额外 Electron 参数 */
    electronArgs?: string[];
    /**
     * 在私有显示里真正显示窗口。默认隐藏；逐帧截屏/像素测试需要合成帧，
     * 隐藏窗口不会持续提交帧，截屏会等很久。不会出现在宿主桌面上。
     */
    showWindow?: boolean;
};

function resolveDesktop(desktop: string, root: string): string {
    if (desktop === ":test") return desktop;
    const dir = path.isAbsolute(desktop) ? desktop : path.join(root, desktop);
    const packagePath = path.join(dir, "package.json");
    if (!fs.existsSync(packagePath)) {
        throw new Error(`找不到桌面包: ${packagePath}`);
    }
    let main = "index.js";
    try {
        const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { main?: string };
        main = pkg.main ?? main;
    } catch (e) {
        throw new Error(`读取 ${packagePath} 失败: ${String(e)}`);
    }
    const mainPath = path.join(dir, main);
    if (!fs.existsSync(mainPath)) {
        throw new Error(
            `桌面入口不存在: ${mainPath}。先构建桌面（例如 pnpm build:desktop / cd desktop/remote && npm run build）`,
        );
    }
    return dir;
}

async function findPageTarget(
    port: number,
    timeout: number,
    exited: () => string | undefined,
): Promise<{ webSocketDebuggerUrl: string; url: string }> {
    const deadline = Date.now() + timeout;
    let lastError = "";
    while (Date.now() < deadline) {
        const exit = exited();
        if (exit) throw new Error(exit);
        try {
            const list = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as Array<{
                type?: string;
                url?: string;
                webSocketDebuggerUrl?: string;
            }>;
            const page = list.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
            if (page?.webSocketDebuggerUrl) {
                return { webSocketDebuggerUrl: page.webSocketDebuggerUrl, url: page.url ?? "" };
            }
        } catch (e) {
            lastError = String(e);
        }
        await sleep(100);
    }
    throw new Error(`等待 CDP 页面超时（${timeout}ms）：${lastError}`);
}

function formatConsole(params: Record<string, unknown>): string {
    const type = String(params.type ?? "log");
    const args = Array.isArray(params.args) ? params.args : [];
    const text = args
        .map((arg) => {
            const value = arg as { value?: unknown; description?: string; type?: string };
            if (value.type === "undefined") return "undefined";
            if (value.value !== undefined) {
                return typeof value.value === "string" ? value.value : JSON.stringify(value.value);
            }
            return value.description ?? String(value.type ?? "");
        })
        .join(" ");
    return `[console.${type}] ${text}`;
}

/** 按键名 → (code, windowsVirtualKeyCode, 是否要作为文本输入) */
function keyInfo(key: string): { code: string; keyCode: number; text?: string } {
    const table: Record<string, { code: string; keyCode: number; text?: string }> = {
        Enter: { code: "Enter", keyCode: 13, text: "\r" },
        Tab: { code: "Tab", keyCode: 9 },
        Escape: { code: "Escape", keyCode: 27 },
        Backspace: { code: "Backspace", keyCode: 8 },
        Delete: { code: "Delete", keyCode: 46 },
        " ": { code: "Space", keyCode: 32, text: " " },
        ArrowUp: { code: "ArrowUp", keyCode: 38 },
        ArrowDown: { code: "ArrowDown", keyCode: 40 },
        ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
        ArrowRight: { code: "ArrowRight", keyCode: 39 },
        Home: { code: "Home", keyCode: 36 },
        End: { code: "End", keyCode: 35 },
        PageUp: { code: "PageUp", keyCode: 33 },
        PageDown: { code: "PageDown", keyCode: 34 },
    };
    if (table[key]) return table[key];
    const upper = key.length === 1 ? key.toUpperCase() : key;
    const code = /^[a-zA-Z]$/.test(key) ? `Key${upper}` : /^[0-9]$/.test(key) ? `Digit${key}` : key;
    const keyCode = /^[a-zA-Z]$/.test(key) ? upper.charCodeAt(0) : /^[0-9]$/.test(key) ? key.charCodeAt(0) : 0;
    return { code, keyCode, text: key.length === 1 ? key : undefined };
}

class DesktopRunnerImpl implements DesktopRunner {
    private closed = false;
    private readonly consoleLogs: string[] = [];
    private readonly processOutput: string[] = [];
    private exitMessage: string | undefined;

    constructor(
        private readonly cdp: CdpClient,
        private readonly runtime: child_process.ChildProcess,
        private readonly display: HeadlessDisplay | undefined,
        private readonly bus: PrivateBus | undefined,
        private readonly userDataDir: string,
    ) {
        runtime.stdout?.on("data", (data: Buffer) => this.collectOutput(data));
        runtime.stderr?.on("data", (data: Buffer) => this.collectOutput(data));
        runtime.on("exit", (code, signal) => {
            this.exitMessage = `electron-vite 退出：code=${code} signal=${signal}`;
            this.display?.stop();
            this.bus?.stop();
            removeUserDataDir(this.userDataDir);
        });

        cdp.on("Runtime.consoleAPICalled", (params) => {
            this.consoleLogs.push(formatConsole(params));
        });
        cdp.on("Runtime.exceptionThrown", (params) => {
            const details = params.exceptionDetails as
                | { text?: string; exception?: { description?: string; value?: unknown } }
                | undefined;
            const description =
                details?.exception?.description ??
                (details?.exception?.value !== undefined ? String(details.exception.value) : details?.text) ??
                "unknown exception";
            this.consoleLogs.push(`[exception] ${description}`);
        });
        cdp.on("Log.entryAdded", (params) => {
            const entry = params.entry as { level?: string; text?: string; url?: string } | undefined;
            if (!entry) return;
            this.consoleLogs.push(
                `[log.${entry.level ?? "info"}] ${entry.text ?? ""}${entry.url ? ` (${entry.url})` : ""}`,
            );
        });
    }

    private collectOutput(data: Buffer) {
        for (const line of data.toString().split(/\r?\n/)) {
            if (!line) continue;
            this.processOutput.push(line);
            if (this.processOutput.length > 400) this.processOutput.shift();
        }
    }

    send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        return this.cdp.send<T>(method, params);
    }

    on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
        return this.cdp.on(method, listener);
    }

    async evaluate<T = unknown>(expression: string): Promise<T> {
        const result = await this.cdp.send<{
            result?: { value?: T; description?: string };
            exceptionDetails?: { text?: string; exception?: { description?: string } };
        }>("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
        });
        if (result.exceptionDetails) {
            throw new Error(
                result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "页面求值异常",
            );
        }
        return result.result?.value as T;
    }

    async waitFor(expression: string, timeout = 10000): Promise<void> {
        const deadline = Date.now() + timeout;
        let lastError = "";
        while (Date.now() < deadline) {
            try {
                if (await this.evaluate<boolean>(`Boolean(${expression})`)) return;
            } catch (e) {
                lastError = String(e);
            }
            await sleep(50);
        }
        throw new Error(
            `等待页面条件超时（${timeout}ms）：${expression}${lastError ? `；最近错误: ${lastError}` : ""}\n${this.consoleLogs.slice(-20).join("\n")}`,
        );
    }

    async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
        const params: Record<string, unknown> = {
            format: options.format ?? "png",
            // 测试桌面窗口是隐藏的；fromSurface 会等一帧合成，隐藏窗口等不到
            fromSurface: options.fromSurface ?? false,
        };
        if (options.clip) params.clip = options.clip;
        let result: { data: string };
        try {
            result = await this.cdp.send<{ data: string }>("Page.captureScreenshot", {
                ...params,
                // 逐帧采样不需要最优压缩；不认这个参数时退回普通截图
                optimizeForSpeed: true,
            });
        } catch (e) {
            if (!/optimizeForSpeed|Invalid parameters|Unrecognized/i.test(String(e))) throw e;
            result = await this.cdp.send<{ data: string }>("Page.captureScreenshot", params);
        }
        if (!result.data) throw new Error("截屏没有返回数据");
        return Buffer.from(result.data, "base64");
    }

    move(x: number, y: number): Promise<void> {
        return this.mouse({ type: "move", x, y });
    }

    click(x: number, y: number, button: MouseButton = "left"): Promise<void> {
        return this.mouse({ type: "click", x, y, button });
    }

    async mouse(op: MouseEventInput): Promise<void> {
        const button = op.button ?? "left";
        const mask = button === "left" ? 1 : button === "right" ? 2 : 4;
        const clickCount = op.clickCount ?? 1;
        const dispatch = (type: string, buttons: number) =>
            this.cdp.send("Input.dispatchMouseEvent", {
                type,
                x: op.x,
                y: op.y,
                button: type === "mouseMoved" ? "none" : button,
                buttons,
                clickCount,
            });
        if (op.type === "click") {
            await dispatch("mouseMoved", 0);
            await dispatch("mousePressed", mask);
            await dispatch("mouseReleased", 0);
            return;
        }
        if (op.type === "move") {
            await dispatch("mouseMoved", 0);
            return;
        }
        if (op.type === "down") {
            await dispatch("mouseMoved", 0);
            await dispatch("mousePressed", mask);
            return;
        }
        await dispatch("mouseReleased", 0);
    }

    async key(key: string, op: KeyOptions = {}): Promise<void> {
        const info = keyInfo(key);
        const code = op.code ?? info.code;
        const keyCode = op.keyCode ?? info.keyCode;
        const modifiers = op.modifiers ?? 0;
        const base = {
            key,
            code,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode,
        };
        // 带修饰键时按快捷键处理，不能把字符当文本插进去（Ctrl+C 不是输入 c）
        const text = modifiers ? undefined : info.text;

        // 所有事件一次按顺序发出，不逐个等返回：逐个 await 会让“按下”时间被前几次
        // 协议往返推迟几十毫秒，测响应延迟时会算成应用的延迟。
        const pending: Promise<unknown>[] = [];

        // 先真正按下修饰键：桌面把原生按键转成自己的输入事件，修饰状态靠
        // MetaLeft/AltLeft 等按键的 down/up 维护，只给主键带 modifiers 不会生效
        const held: { code: string; key: string; keyCode: number; mask: number }[] = [];
        let current = 0;
        for (const [mask, code, key, keyCode] of [
            [1, "AltLeft", "Alt", 18],
            [2, "ControlLeft", "Control", 17],
            [4, "MetaLeft", "Meta", 91],
            [8, "ShiftLeft", "Shift", 16],
        ] as const) {
            if (!(modifiers & mask)) continue;
            current |= mask;
            held.push({ code, key, keyCode, mask });
            pending.push(
                this.cdp.send("Input.dispatchKeyEvent", {
                    type: "rawKeyDown",
                    key,
                    code,
                    windowsVirtualKeyCode: keyCode,
                    nativeVirtualKeyCode: keyCode,
                    modifiers: current,
                }),
            );
        }

        pending.push(
            this.cdp.send("Input.dispatchKeyEvent", {
                ...base,
                modifiers,
                type: text ? "keyDown" : "rawKeyDown",
                ...(text ? { text, unmodifiedText: text } : {}),
            }),
            this.cdp.send("Input.dispatchKeyEvent", { ...base, modifiers, type: "keyUp" }),
        );

        for (const mod of held.toReversed()) {
            pending.push(
                this.cdp.send("Input.dispatchKeyEvent", {
                    type: "keyUp",
                    key: mod.key,
                    code: mod.code,
                    windowsVirtualKeyCode: mod.keyCode,
                    nativeVirtualKeyCode: mod.keyCode,
                    modifiers: current,
                }),
            );
            current &= ~mod.mask;
        }
        await Promise.all(pending);
    }

    async text(text: string): Promise<void> {
        await this.cdp.send("Input.insertText", { text });
    }

    logs(): readonly string[] {
        return this.consoleLogs;
    }

    clearLogs(): void {
        this.consoleLogs.length = 0;
    }

    output(): readonly string[] {
        return this.processOutput;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.cdp.close();
        await killProcessTree(this.runtime);
        this.display?.stop();
        this.bus?.stop();
        removeUserDataDir(this.userDataDir);
        if (this.exitMessage) this.processOutput.push(this.exitMessage);
    }
}

async function killProcessTree(proc: child_process.ChildProcess): Promise<void> {
    const pid = proc.pid;
    if (!pid) return;
    const signal = (sig: NodeJS.Signals) => {
        try {
            if (process.platform === "linux") process.kill(-pid, sig);
            else proc.kill(sig);
        } catch {}
    };
    signal("SIGTERM");
    await sleep(800);
    signal("SIGKILL");
}

/**
 * 启动一个完整桌面实现（desktop/official、desktop/remote …），用 CDP 驱动。
 *
 * 与 `testRunnerApp` 的区别：
 * - `testRunnerApp` 把 Wayland server 直接交给测试脚本，适合单窗口协议断言。
 * - 这里加载真实桌面包，测试通过 CDP 操作它的 DOM（点击、输入、截图、日志），
 *   适合桌面 UI/窗口管理/面板等端到端测试。
 *
 * 显示仍然是私有的 weston headless + Xwayland，宿主桌面看不到窗口。
 */
export async function startDesktopRunner(opts: DesktopRunnerOptions = {}): Promise<DesktopRunner> {
    const root = getProjectRoot();
    const desktop = resolveDesktop(opts.desktop ?? "desktop/official", root);
    const display = startHeadlessDisplay();
    const bus = startPrivateBus();
    const port = await getFreePort();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myde-test-userdata-"));
    activeUserDataDirs.add(userDataDir);
    const env = createTestEnv({
        desktop,
        display,
        bus,
        userDataDir,
        extraEnv: {
            ...(opts.showWindow ? { MYDE_TEST_SHOW_WINDOW: "1" } : {}),
            ...opts.env,
        },
    });

    const runtime = child_process.spawn(
        "npx",
        [
            "electron-vite",
            "--ignoreConfigWarning",
            "preview",
            ...electronViteBuildArgs(),
            "--",
            ...(display
                ? ["--ozone-platform=x11"]
                : ["--ozone-platform=headless", "--ozone-override-screen-size=1920,1080"]),
            `--remote-debugging-port=${port}`,
            // 隐藏窗口也要正常渲染、跑定时器、处理输入
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            ...(opts.electronArgs ?? []),
        ],
        {
            stdio: ["ignore", "pipe", "pipe"],
            env,
            cwd: root,
            detached: process.platform === "linux",
        },
    );

    const output: string[] = [];
    const collect = (data: Buffer) => {
        for (const line of data.toString().split(/\r?\n/)) {
            if (!line) continue;
            output.push(line);
            if (output.length > 400) output.shift();
        }
    };
    runtime.stdout?.on("data", collect);
    runtime.stderr?.on("data", collect);

    let exitMessage: string | undefined;
    runtime.on("exit", (code, signal) => {
        exitMessage = `electron-vite 退出：code=${code} signal=${signal}`;
    });

    try {
        const target = await findPageTarget(port, opts.timeout ?? 30000, () => exitMessage);
        const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");
        await cdp.send("Log.enable");
        const runner = new DesktopRunnerImpl(cdp, runtime, display, bus, userDataDir);
        if (opts.ready !== undefined) {
            await runner.waitFor(opts.ready, opts.timeout ?? 30000);
        } else {
            await runner.waitFor("document.readyState === 'complete'", opts.timeout ?? 30000);
        }
        return runner;
    } catch (e) {
        await killProcessTree(runtime);
        display?.stop();
        bus?.stop();
        removeUserDataDir(userDataDir);
        const tail = output.slice(-40).join("\n");
        throw new Error(`启动桌面失败：${String(e)}${tail ? `\n--- electron 输出 ---\n${tail}` : ""}`);
    }
}

/**
 * 启动 → 执行测试 → 无论成功失败都关闭。
 *
 * ```ts
 * await testRunnerDesktop(async (desktop) => {
 *     await desktop.waitFor("!!document.querySelector('.panel')");
 *     await desktop.click(20, 20);
 *     expect(await desktop.screenshot()).not.toHaveLength(0);
 * }, { desktop: "desktop/official" });
 * ```
 */
export async function testRunnerDesktop(
    test: (desktop: DesktopRunner) => Promise<void>,
    opts: DesktopRunnerOptions = {},
): Promise<void> {
    const desktop = await startDesktopRunner(opts);
    try {
        await test(desktop);
    } finally {
        await desktop.close();
    }
}
