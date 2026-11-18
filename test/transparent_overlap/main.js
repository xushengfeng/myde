// myde 透明窗口动画复现应用
//
// 直接运行（由 run.sh 负责选对 myde 的 wayland 显示）：
//   test/transparent_overlap/run.sh
//   test/transparent_overlap/run.sh x11
//
// 也可以让 test/electron_app/start.js 加载本文件（测试框架用）。

const path = require("node:path");
const { ipcMain } = require("electron");

function logEnv(appRef) {
    console.log("[repro] WAYLAND_DISPLAY =", process.env.WAYLAND_DISPLAY || "(unset)");
    console.log("[repro] DISPLAY         =", process.env.DISPLAY || "(unset)");
    console.log("[repro] XDG_SESSION_TYPE=", process.env.XDG_SESSION_TYPE || "(unset)");
    console.log("[repro] argv            =", process.argv.slice(1).join(" "));
    try {
        const status = appRef.getGPUFeatureStatus();
        console.log(
            "[repro] GPU:",
            JSON.stringify({
                compositing: status.gpu_compositing,
                webgl: status.webgl,
                rasterization: status.rasterization,
            }),
        );
    } catch (e) {
        console.log("[repro] GPU status unavailable:", String(e));
    }
}

function run({ app: appRef, BrowserWindow: BW, ipcMain: ipcMainRef }) {
    const win = new BW({
        width: 680,
        height: 500,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: true,
        show: process.env.MYDE_REPRO_SELFTEST !== "1",
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false,
        },
    });
    win.setBackgroundColor("#00000000");
    win.loadFile(path.join(__dirname, "index.html"));

    let resizeTimer;
    const toggleResize = () => {
        if (resizeTimer) {
            clearInterval(resizeTimer);
            resizeTimer = undefined;
            win.setSize(680, 500);
            return false;
        }
        let big = false;
        resizeTimer = setInterval(() => {
            big = !big;
            try {
                win.setSize(big ? 760 : 620, big ? 560 : 440);
            } catch {}
        }, 2500);
        return true;
    };

    const onIpc = ipcMainRef ?? ipcMain;
    onIpc.on("repro:resize", (event) => {
        event.returnValue = toggleResize();
    });
    onIpc.on("repro:quit", () => appRef.quit());

    logEnv(appRef);
    return win;
}

module.exports = run;
