import * as path from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
    main: {
        build: {
            rollupOptions: {
                input: {
                    main: path.resolve(__dirname, "src/main/main.ts"),
                    // 必须在 Chromium 搬动主进程 cgroup 之前启动，单独作为入口
                    polkit_helper: path.resolve(__dirname, "src/main/polkit_helper.ts"),
                },
            },
        },
    },
    renderer: {
        build: {
            rollupOptions: {
                input: {
                    frame: path.resolve(__dirname, "src/renderer/main.html"),
                    test: path.resolve(__dirname, "src/renderer/test.html"),
                },
            },
        },
    },
});
