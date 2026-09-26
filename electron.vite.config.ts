import * as path from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
    main: {},
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
