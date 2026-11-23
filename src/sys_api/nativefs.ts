import type { Stats } from "node:fs";

const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");

import { mimeOfPath } from "../utils/mime";

export type NativeFsFileKind = "file" | "directory" | "symlink" | "other";

export interface NativeFsEntry {
    name: string;
    /** 绝对路径 */
    path: string;
    kind: NativeFsFileKind;
    /** 符号链接指向的对象类型；普通文件不填 */
    targetKind?: NativeFsFileKind;
    size: number;
    /** 毫秒时间戳 */
    mtime: number;
    hidden: boolean;
    mime: string;
}

export interface NativeFsListOptions {
    showHidden?: boolean;
}

export interface NativeFsReadImageOptions {
    /** 图片文件大小上限，默认 32MB */
    maxBytes?: number;
}

export interface NativeFsListResult {
    /** 解析 `~` 后的绝对路径 */
    path: string;
    entries: NativeFsEntry[];
}

function homeDir(): string {
    return os.homedir() || process.env.HOME || "/";
}

function resolvePath(input: string | undefined, fallback: string): string {
    let p = input?.trim() || fallback;
    if (p === "~") p = homeDir();
    else if (p.startsWith("~/")) p = path.join(homeDir(), p.slice(2));
    if (p.includes("\0")) throw new Error("路径包含 NUL");
    if (!path.isAbsolute(p)) throw new Error(`需要绝对路径: ${p}`);
    return path.normalize(p);
}

function resolveDir(input: string | undefined): string {
    return resolvePath(input, "~");
}

function kindOf(stats: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): NativeFsFileKind {
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
}

function effectiveKind(entry: NativeFsEntry): NativeFsFileKind {
    return entry.targetKind ?? entry.kind;
}

/**
 * 桌面可用的原生文件系统只读接口。
 *
 * `list` 列出目录项和元数据；`readImage` 只读取图片文件并转成 data URL，
 * 不提供读取其他文件内容的接口。路径支持绝对路径和 `~`。
 */
export class nativefs {
    async list(dirPath?: string, opts?: NativeFsListOptions): Promise<NativeFsListResult> {
        const dir = resolveDir(dirPath);
        const showHidden = opts?.showHidden ?? false;
        const dirents = await fsp.readdir(dir, { withFileTypes: true });
        const entries: NativeFsEntry[] = [];

        for (const dirent of dirents) {
            if (!showHidden && dirent.name.startsWith(".")) continue;
            const fullPath = path.join(dir, dirent.name);
            const kind = kindOf(dirent);
            let targetKind: NativeFsFileKind | undefined;
            if (kind === "symlink") {
                try {
                    targetKind = kindOf(await fsp.stat(fullPath));
                } catch {
                    // 断开的符号链接：保留链接本身，targetKind 留空
                }
            }
            let lstat: Stats | undefined;
            try {
                lstat = await fsp.lstat(fullPath);
            } catch {
                // 读取过程中被删除：仍返回名称，元数据给 0
            }
            entries.push({
                name: dirent.name,
                path: fullPath,
                kind,
                targetKind,
                size: lstat?.size ?? 0,
                mtime: lstat?.mtimeMs ?? 0,
                hidden: dirent.name.startsWith("."),
                mime: mimeOfPath(fullPath, targetKind ?? kind),
            });
        }

        entries.sort((a, b) => {
            const aDir = effectiveKind(a) === "directory";
            const bDir = effectiveKind(b) === "directory";
            if (aDir !== bDir) return aDir ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        });

        return { path: dir, entries };
    }

    /**
     * 读取图片文件并返回 data URL，供桌面壁纸等只需要图片内容的场景使用。
     * 只接受 `image/*`，且大小不超过 `maxBytes`（默认 32MB）。
     */
    async readImage(filePath: string, opts?: NativeFsReadImageOptions): Promise<string> {
        const file = resolvePath(filePath, "");
        const stats = await fsp.stat(file);
        if (!stats.isFile()) throw new Error(`不是文件: ${file}`);
        const maxBytes = opts?.maxBytes ?? 32 * 1024 * 1024;
        if (stats.size > maxBytes) {
            throw new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
        }
        const mime = mimeOfPath(file, "file");
        if (!mime.startsWith("image/")) throw new Error(`不是图片文件: ${file}`);
        const data = await fsp.readFile(file);
        return `data:${mime};base64,${data.toString("base64")}`;
    }
}
