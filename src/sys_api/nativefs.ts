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

export interface NativeFsListResult {
    /** 解析 `~` 后的绝对路径 */
    path: string;
    entries: NativeFsEntry[];
}

function homeDir(): string {
    return os.homedir() || process.env.HOME || "/";
}

function resolveDir(input: string | undefined): string {
    let dir = input?.trim() || "~";
    if (dir === "~") dir = homeDir();
    else if (dir.startsWith("~/")) dir = path.join(homeDir(), dir.slice(2));
    if (dir.includes("\0")) throw new Error("路径包含 NUL");
    if (!path.isAbsolute(dir)) throw new Error(`需要绝对路径: ${dir}`);
    return path.normalize(dir);
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
 * 目前只有 `list`：列出目录项和元数据，不读取文件内容。路径支持绝对路径和 `~`。
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
}
