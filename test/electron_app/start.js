#!/usr/bin/env node

/**
 * Electron 启动器
 *
 * 用法: node start.js <script.js>
 *
 * script.js 导出一个函数，接收 context 对象:
 *   - app: electron app
 *   - BrowserWindow: BrowserWindow 类
 *   - createWindow(opts): 创建窗口
 *     - opts.html: HTML 字符串或文件路径
 *     - opts.js: 渲染进程 JS 文件路径 (会自动包装为 HTML)
 *     - opts.width/height: 窗口尺寸
 *     - opts.devtools: 打开开发者工具 (默认 true)
 *
 * script.js 可以是:
 *   module.exports = (ctx) => { ctx.createWindow({ js: './renderer.js' }) }
 *   或直接执行创建窗口代码
 */

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

// ========== 非 electron 环境: 用 electron 启动自身 ==========
if (!process.versions.electron) {
    const script = process.argv[2];
    if (!script || !fs.existsSync(path.resolve(script))) {
        console.error("用法: node start.js <script.js>");
        process.exit(1);
    }

    // 查找 electron 可执行文件
    function findElectron() {
        // 1. 尝试 node_modules/.bin/electron (本项目)
        const localBin = path.join(__dirname, "../../node_modules/.bin/electron");
        if (fs.existsSync(localBin)) return localBin;

        // 2. 尝试当前目录 node_modules
        const cwdBin = path.join(process.cwd(), "node_modules/.bin/electron");
        if (fs.existsSync(cwdBin)) return cwdBin;

        // 3. 尝试全局
        try {
            return require.resolve("electron");
        } catch {
            // ignore
        }

        // 4. 尝试 npx
        return "npx electron";
    }

    const electronBin = findElectron();
    const isNpx = electronBin.startsWith("npx");
    const args = isNpx ? ["electron", __filename, script] : [__filename, script];

    const child = spawn(electronBin, args, {
        stdio: "inherit",
        env: process.env,
    });

    child.on("exit", (code) => process.exit(code ?? 0));
} else {
    // ========== electron 环境: 执行用户脚本 ==========
    const { app, BrowserWindow } = require("electron");

    const userScript = process.argv[2];
    if (!userScript) {
        console.error("缺少脚本参数");
        process.exit(1);
    }

    const scriptPath = path.resolve(userScript);
    if (!fs.existsSync(scriptPath)) {
        console.error(`脚本不存在: ${scriptPath}`);
        process.exit(1);
    }

    function wrapJS(jsPath) {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { width: 100vw; height: 100vh; overflow: hidden; }
    </style>
</head>
<body>
    <script>
        try {
            require(${JSON.stringify(jsPath)});
        } catch(e) {
            document.body.innerHTML = '<pre style="color:red;padding:20px;white-space:pre-wrap">' + e.stack + '</pre>';
            console.error(e);
        }
    </script>
</body>
</html>`;
    }

    function loadContent(win, opts) {
        if (opts.html) {
            if (opts.html.startsWith("<")) {
                win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(opts.html));
            } else {
                win.loadFile(opts.html);
            }
        } else if (opts.js) {
            const jsPath = path.resolve(opts.js);
            const html = wrapJS(jsPath);
            win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
        }
    }

    function createWindow(opts = {}) {
        const win = new BrowserWindow({
            width: opts.width || 1200,
            height: opts.height || 800,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
            },
        });

        win.webContents.on("console-message", ({ message, level }) => {
            if (level === "info") {
                console.log(JSON.stringify({ data: message }));
            }
        });

        loadContent(win, opts);

        if (opts.devtools === true) {
            win.webContents.openDevTools();
        }

        return win;
    }

    app.whenReady().then(() => {
        const ctx = { app, BrowserWindow, createWindow };

        const script = fs.readFileSync(scriptPath, "utf-8");
        if (script.includes("module.exports")) {
            const mod = require(scriptPath);
            const fn = typeof mod === "function" ? mod : mod.default;

            if (typeof fn === "function") {
                fn(ctx);
            }
        } else {
            createWindow({
                js: scriptPath,
                width: 800,
                height: 600,
            });
        }
    });

    app.on("window-all-closed", () => app.quit());
}
