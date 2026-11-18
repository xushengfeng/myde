// Electron 入口（package.json 的 main）。
// 单独放一个文件是因为 Electron 45 里 require.main === module 不成立，
// 不能靠它判断「被 start.js require」还是「作为应用入口运行」。

const { app, BrowserWindow, ipcMain } = require("electron");
const run = require("./main");

app.whenReady()
    .then(() => {
        const win = run({ app, BrowserWindow, ipcMain });
        win.on("ready-to-show", () => console.log("[repro] ready-to-show"));
        win.on("show", () => console.log("[repro] window shown"));
        win.webContents.on("did-finish-load", () => {
            console.log("[repro] page loaded");
            void app
                .getGPUInfo("complete")
                .then((info) => {
                    console.log(
                        "[repro] GPU info:",
                        JSON.stringify({
                            devices: info.gpuDevice?.length ?? 0,
                            glRenderer: info.auxAttributes?.glRenderer,
                            glVendor: info.auxAttributes?.glVendor,
                        }),
                    );
                    console.log("[repro] feature status:", JSON.stringify(app.getGPUFeatureStatus()));
                })
                .catch((error) => console.log("[repro] GPU info failed:", String(error)));
        });
        win.webContents.on("did-fail-load", (_e, code, desc) => console.log("[repro] load failed:", code, desc));
        win.webContents.on("render-process-gone", (_e, details) =>
            console.log("[repro] renderer gone:", JSON.stringify(details)),
        );
        // 只用于自动化冒烟检查：不弹窗，加载完就退出
        if (process.env.MYDE_REPRO_SELFTEST === "1") {
            win.hide();
            setTimeout(() => app.quit(), 4000);
        }
    })
    .catch((error) => {
        console.error("[repro] 启动失败:", error);
        app.quit();
    });

app.on("window-all-closed", () => app.quit());
