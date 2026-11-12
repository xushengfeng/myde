const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

import type { ConnectStorage } from "./storage";

/**
 * 明文文件存储，只用于 node 测试或受信任的本地环境。
 * 文件内容是一个 key-value JSON，每次保存先写临时文件再 rename。
 */
export class FileConnectStorage implements ConnectStorage {
    private filePath: string;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    getItem(key: string): string | null {
        return this.read()[key] ?? null;
    }

    setItem(key: string, value: string): void {
        const data = this.read();
        data[key] = value;
        this.write(data);
    }

    removeItem(key: string): void {
        const data = this.read();
        delete data[key];
        this.write(data);
    }

    private read(): Record<string, string> {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, string>;
            }
            return {};
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
            // 文件损坏时从空存储开始，避免阻断启动。
            if (error instanceof SyntaxError) return {};
            throw error;
        }
    }

    private write(data: Record<string, string>): void {
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tempPath = `${this.filePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(data), { encoding: "utf-8", mode: 0o600 });
        fs.renameSync(tempPath, this.filePath);
    }
}
