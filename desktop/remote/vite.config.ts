import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
    build: {
        lib: {
            entry: resolve(__dirname, "src/index.ts"),
            formats: ["es"],
            fileName: "server",
        },
        rollupOptions: {
            external: [
                "dkh-ui",
                "../../src/renderer/desktop-api",
                "../../src/remote_connect/sconnect",
                "../../src/remote_connect/peerjs_adapter",
            ],
        },
        outDir: "dist",
        sourcemap: true,
        minify: false,
    },
});
