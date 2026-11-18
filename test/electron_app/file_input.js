// 用现有的 test/electron_app 启动一个带文件元素的窗口：
//   cd test/electron_app && npm run file
// npm script 会带上 GTK_USE_PORTAL=1，让 GTK 文件对话框走 xdg-desktop-portal；
// 在 MyDE 的 internal portal 环境里就能看到官方桌面的弹窗。
//
// 过滤器的两种来源都会触发：
//   - <input type="file" accept="...">：Chromium 自己生成 portal filters
//   - Electron dialog.showOpenDialog/showSaveDialog 的 filters：GTK 生成命名过滤器

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8" />
    <title>文件选择器测试</title>
    <style>
        * { box-sizing: border-box; }
        body {
            margin: 0;
            padding: 24px;
            font-family: system-ui, sans-serif;
            background: #f4f6f8;
            color: #111;
        }
        h1 { margin: 0 0 8px; font-size: 20px; }
        p { margin: 0; color: #555; font-size: 13px; line-height: 1.6; }
        .panel {
            margin-top: 20px;
            padding: 16px;
            border: 1px solid #00000014;
            border-radius: 12px;
            background: #fff;
        }
        .row {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
            padding: 10px 0;
            border-bottom: 1px solid #0000000d;
        }
        .row:last-child { border-bottom: none; }
        .label { width: 170px; font-size: 13px; color: #333; }
        .hint { font-size: 12px; color: #888; }
        input[type="file"] { max-width: 100%; font-size: 12px; }
        button {
            padding: 7px 14px;
            border: 1px solid #0088dd;
            border-radius: 8px;
            background: #00aaff;
            color: #fff;
            font-size: 13px;
            cursor: pointer;
        }
        button:disabled { opacity: 0.45; cursor: default; }
        pre {
            margin: 0;
            min-height: 80px;
            padding: 10px;
            border-radius: 8px;
            background: #f7f8fa;
            font-family: monospace;
            font-size: 11px;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }
        .env {
            margin-top: 8px;
            font-family: monospace;
            font-size: 11px;
            color: #666;
            white-space: pre-wrap;
        }
    </style>
</head>
<body>
    <h1>文件选择器测试</h1>
    <p>下面的元素会触发 Chromium / xdg-desktop-portal 的文件选择请求。在 MyDE 内部 portal 环境里打开本应用，就能看到官方桌面的文件选择器。</p>
    <div class="env" id="env"></div>

    <div class="panel">
        <div class="row">
            <span class="label">打开单个文件</span>
            <input id="open-one" type="file" />
            <span class="hint">OpenFile</span>
        </div>
        <div class="row">
            <span class="label">打开多个文件</span>
            <input id="open-many" type="file" multiple />
            <span class="hint">multiple</span>
        </div>
        <div class="row">
            <span class="label">选择文件夹</span>
            <input id="open-dir" type="file" webkitdirectory />
            <span class="hint">directory</span>
        </div>
        <div class="row">
            <span class="label">保存文件</span>
            <button id="save" type="button">触发保存对话框</button>
            <span class="hint">download + Electron 保存对话框；需要 GTK_USE_PORTAL=1（npm script 已带）</span>
        </div>
        <div class="row">
            <span class="label">结果</span>
            <pre id="result">还没有选择文件。</pre>
        </div>
    </div>

    <div class="panel">
        <p>过滤器测试</p>
        <div class="row">
            <span class="label">accept 扩展名</span>
            <input id="open-accept-ext" type="file" accept=".txt,.md,.json" />
            <span class="hint">accept=".txt,.md,.json"</span>
        </div>
        <div class="row">
            <span class="label">accept MIME</span>
            <input id="open-accept-mime" type="file" accept="image/*,text/plain" />
            <span class="hint">accept="image/*,text/plain"</span>
        </div>
        <div class="row">
            <span class="label">accept 混合多选</span>
            <input id="open-accept-mixed" type="file" multiple accept="image/png,image/jpeg,.txt,.md" />
            <span class="hint">multiple + MIME/glob 混合</span>
        </div>
        <div class="row">
            <span class="label">dialog 打开（命名筛选）</span>
            <button id="dialog-open" type="button">showOpenDialog</button>
            <span class="hint">filters: 图片 / 文本 / PDF，Electron 会自动补「All Files」</span>
        </div>
        <div class="row">
            <span class="label">dialog 保存（命名筛选）</span>
            <button id="dialog-save" type="button">showSaveDialog</button>
            <span class="hint">filters: 文本 / JSON</span>
        </div>
        <div class="row">
            <span class="label">过滤器结果</span>
            <pre id="filter-result">还没有触发过滤器对话框。</pre>
        </div>
    </div>

    <script>
        const result = document.getElementById("result");
        const saveButton = document.getElementById("save");
        document.getElementById("env").textContent =
            "DBUS_SESSION_BUS_ADDRESS = " + (process.env.DBUS_SESSION_BUS_ADDRESS || "(未设置)") +
            "\\nXDG_CURRENT_DESKTOP = " + (process.env.XDG_CURRENT_DESKTOP || "(未设置)");

        function filePath(file) {
            try {
                const { webUtils } = require("electron");
                if (webUtils?.getPathForFile) return webUtils.getPathForFile(file);
            } catch {}
            return file.path || file.name;
        }

        function show(title, files) {
            const list = [...files];
            result.textContent = list.length === 0
                ? title + "：没有选择文件"
                : title + "（" + list.length + "）：\\n" + list.map((file) => "  " + filePath(file)).join("\\n");
        }

        const filterResult = document.getElementById("filter-result");

        function showFiltered(title, list) {
            filterResult.textContent = list.length === 0
                ? title + "：没有选择文件"
                : title + "（" + list.length + "）：\\n" + list.map((path) => "  " + path).join("\\n");
        }

        for (const [id, title] of [
            ["open-one", "打开单个文件"],
            ["open-many", "打开多个文件"],
            ["open-dir", "选择文件夹"],
        ]) {
            const input = document.getElementById(id);
            input.addEventListener("change", () => show(title, input.files));
        }

        for (const [id, title] of [
            ["open-accept-ext", "accept 扩展名"],
            ["open-accept-mime", "accept MIME"],
            ["open-accept-mixed", "accept 混合多选"],
        ]) {
            const input = document.getElementById(id);
            input.addEventListener("change", () => {
                const files = [...input.files];
                showFiltered(title, files.map(filePath));
            });
        }

        const { ipcRenderer } = require("electron");

        document.getElementById("dialog-open").addEventListener("click", async () => {
            try {
                const outcome = await ipcRenderer.invoke("dialog:open-filtered");
                showFiltered("dialog 打开", outcome.canceled ? [] : outcome.filePaths);
            } catch (error) {
                filterResult.textContent = "dialog 打开失败：" + error;
            }
        });

        document.getElementById("dialog-save").addEventListener("click", async () => {
            try {
                const outcome = await ipcRenderer.invoke("dialog:save-filtered");
                showFiltered("dialog 保存", outcome.canceled || !outcome.filePath ? [] : [outcome.filePath]);
            } catch (error) {
                filterResult.textContent = "dialog 保存失败：" + error;
            }
        });

        saveButton.addEventListener("click", () => {
            const blob = new Blob(["MyDE file chooser test\\n"], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = "myde-test.txt";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            result.textContent = "已发起保存下载。如果弹出保存对话框，就是系统的文件选择器。";
        });
    </script>
</body>
</html>`;

module.exports = ({ createWindow }) => {
    const win = createWindow({
        html,
        width: 760,
        height: 720,
        devtools: false,
    });

    const { dialog, ipcMain } = require("electron");

    // Electron 的 filters 会经 GTK/portal 变成命名过滤器，用来验证桌面端筛选
    ipcMain.handle("dialog:open-filtered", () =>
        dialog.showOpenDialog(win, {
            title: "过滤器测试：打开文件",
            properties: ["openFile", "multiSelections"],
            filters: [
                { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"] },
                { name: "文本", extensions: ["txt", "md", "json"] },
                { name: "PDF", extensions: ["pdf"] },
            ],
        }),
    );

    ipcMain.handle("dialog:save-filtered", () =>
        dialog.showSaveDialog(win, {
            title: "过滤器测试：保存文件",
            defaultPath: "myde-filter-test.txt",
            filters: [
                { name: "文本", extensions: ["txt", "md"] },
                { name: "JSON", extensions: ["json"] },
            ],
        }),
    );
};
