import { defineConfig } from "electron-vite";
import * as path from "node:path";

export default defineConfig({
    main: {},
    renderer: {
        build: {
            rollupOptions: {
                input: {
                    frame: path.resolve(__dirname, "src/renderer/main.html"),
                },
            },
        },
    },
});
