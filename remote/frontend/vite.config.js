import { defineConfig } from "vite";

export default defineConfig({
    root: "./src",
    build: {
        outDir: "../dist",
        emptyOutDir: true,
    },
    server: {
        port: 8081,
        proxy: {
            "/ws": {
                target: "ws://localhost:8080",
                ws: true,
            },
        },
    },
});
