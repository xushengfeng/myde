import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
    build: {
        lib: {
            entry: resolve(__dirname, "src/index.ts"),
            formats: ["es"],
            fileName: "server",
        },
        rollupOptions: {
            external: ["dkh-ui", "../../src/renderer/desktop-api"],
        },
        outDir: "dist",
        sourcemap: true,
        minify: false,
    },
});
