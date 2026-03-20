const fs = require("fs") as typeof import("fs");
const fsp = require("fs/promises") as typeof import("fs/promises");
const path = require("path") as typeof import("path");

class vfs {
    private basePath: string;
    constructor(basePath: string) {
        this.basePath = path.resolve(basePath);
    }

    private resolvePath(p: string): string {
        const fullPath = path.resolve(path.join(this.basePath, p));
        if (!fullPath.startsWith(this.basePath)) {
            throw new Error("Path traversal detected");
        }
        return fullPath;
    }

    // 读取文件为 ArrayBuffer
    async readFile(p: string): Promise<ArrayBuffer> {
        const fullPath = this.resolvePath(p);
        const data = await fsp.readFile(fullPath);
        return new Uint8Array(data).buffer;
    }

    readFileSync(p: string): ArrayBuffer {
        const fullPath = this.resolvePath(p);
        const data = fs.readFileSync(fullPath);
        return new Uint8Array(data).buffer;
    }

    // 读取文件为文本
    async readTextFile(p: string): Promise<string> {
        const fullPath = this.resolvePath(p);
        return await fsp.readFile(fullPath, "utf-8");
    }

    readTextFileSync(p: string): string {
        const fullPath = this.resolvePath(p);
        return fs.readFileSync(fullPath, "utf-8");
    }

    // 读取文件为 DataURL
    async readFileAsDataURL(p: string): Promise<string> {
        const fullPath = this.resolvePath(p);
        const data = await fsp.readFile(fullPath);
        const ext = path.extname(fullPath).slice(1).toLowerCase();
        const mime = this.getMimeType(ext);
        const base64 = data.toString("base64");
        return `data:${mime};base64,${base64}`;
    }

    readFileAsDataURLSync(p: string): string {
        const fullPath = this.resolvePath(p);
        const data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath).slice(1).toLowerCase();
        const mime = this.getMimeType(ext);
        const base64 = data.toString("base64");
        return `data:${mime};base64,${base64}`;
    }

    // 读取文件为 Blob
    async readFileAsBlob(p: string): Promise<Blob> {
        const fullPath = this.resolvePath(p);
        const data = await fsp.readFile(fullPath);
        const ext = path.extname(fullPath).slice(1).toLowerCase();
        const mime = this.getMimeType(ext);
        return new Blob([new Uint8Array(data)], { type: mime });
    }

    readFileAsBlobSync(p: string): Blob {
        const fullPath = this.resolvePath(p);
        const data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath).slice(1).toLowerCase();
        const mime = this.getMimeType(ext);
        return new Blob([new Uint8Array(data)], { type: mime });
    }

    // 检查文件/目录是否存在
    async exists(p: string): Promise<boolean> {
        try {
            const fullPath = this.resolvePath(p);
            await fsp.access(fullPath);
            return true;
        } catch {
            return false;
        }
    }

    existsSync(p: string): boolean {
        try {
            const fullPath = this.resolvePath(p);
            return fs.existsSync(fullPath);
        } catch {
            return false;
        }
    }

    // 检查是否为文件
    async isFile(p: string): Promise<boolean> {
        try {
            const fullPath = this.resolvePath(p);
            const stat = await fsp.stat(fullPath);
            return stat.isFile();
        } catch {
            return false;
        }
    }

    isFileSync(p: string): boolean {
        try {
            const fullPath = this.resolvePath(p);
            return fs.statSync(fullPath).isFile();
        } catch {
            return false;
        }
    }

    // 检查是否为目录
    async isDirectory(p: string): Promise<boolean> {
        try {
            const fullPath = this.resolvePath(p);
            const stat = await fsp.stat(fullPath);
            return stat.isDirectory();
        } catch {
            return false;
        }
    }

    isDirectorySync(p: string): boolean {
        try {
            const fullPath = this.resolvePath(p);
            return fs.statSync(fullPath).isDirectory();
        } catch {
            return false;
        }
    }

    // 获取文件信息
    async stat(p: string): Promise<{ size: number; mtime: number; isFile: boolean; isDirectory: boolean }> {
        const fullPath = this.resolvePath(p);
        const s = await fsp.stat(fullPath);
        return {
            size: s.size,
            mtime: s.mtimeMs,
            isFile: s.isFile(),
            isDirectory: s.isDirectory(),
        };
    }

    statSync(p: string): { size: number; mtime: number; isFile: boolean; isDirectory: boolean } {
        const fullPath = this.resolvePath(p);
        const s = fs.statSync(fullPath);
        return {
            size: s.size,
            mtime: s.mtimeMs,
            isFile: s.isFile(),
            isDirectory: s.isDirectory(),
        };
    }

    // 读取目录内容
    async readdir(p: string): Promise<string[]> {
        const fullPath = this.resolvePath(p);
        return await fsp.readdir(fullPath);
    }

    readdirSync(p: string): string[] {
        const fullPath = this.resolvePath(p);
        return fs.readdirSync(fullPath);
    }

    // 读取目录详细内容
    async readdirWithTypes(p: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>> {
        const fullPath = this.resolvePath(p);
        const entries = await fsp.readdir(fullPath, { withFileTypes: true });
        return entries.map((e) => ({
            name: e.name,
            isFile: e.isFile(),
            isDirectory: e.isDirectory(),
        }));
    }

    // 获取 MIME 类型
    private getMimeType(ext: string): string {
        const mimeTypes: Record<string, string> = {
            txt: "text/plain",
            html: "text/html",
            htm: "text/html",
            css: "text/css",
            js: "application/javascript",
            json: "application/json",
            xml: "application/xml",
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            svg: "image/svg+xml",
            webp: "image/webp",
            ico: "image/x-icon",
            mp3: "audio/mpeg",
            wav: "audio/wav",
            ogg: "audio/ogg",
            mp4: "video/mp4",
            webm: "video/webm",
            pdf: "application/pdf",
            zip: "application/zip",
        };
        return mimeTypes[ext] || "application/octet-stream";
    }
}

export { vfs };
