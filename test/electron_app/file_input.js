// 用现有的 test/electron_app 启动一个带文件元素的窗口：
//   cd test/electron_app && npm run file
// npm script 会带上 GTK_USE_PORTAL=1，让 GTK 文件对话框走 xdg-desktop-portal；
// 在 MyDE 的 internal portal 环境里就能看到官方桌面的弹窗。

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

        for (const [id, title] of [
            ["open-one", "打开单个文件"],
            ["open-many", "打开多个文件"],
            ["open-dir", "选择文件夹"],
        ]) {
            const input = document.getElementById(id);
            input.addEventListener("change", () => show(title, input.files));
        }

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
    createWindow({
        html,
        width: 760,
        height: 620,
        devtools: false,
    });
};
