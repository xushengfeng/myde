import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
    build: {
        lib: {
            entry: {
                sconnect: resolve(__dirname, "sconnect.ts"),
                peerjs_adapter: resolve(__dirname, "peerjs_adapter.ts"),
                loopback_adapter: resolve(__dirname, "loopback_adapter.ts"),
            },
            formats: ["es"],
        },
        rollupOptions: {
            external: ["peerjs"],
            output: {
                entryFileNames: "[name].js",
                chunkFileNames: "[name]-[hash].js",
            },
        },
        outDir: "dist",
        sourcemap: true,
        minify: false,
    },
});
