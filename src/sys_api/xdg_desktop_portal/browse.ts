import type { Dirent, Stats } from "node:fs";

const fs = require("node:fs") as typeof import("node:fs");
const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");

import { matchFilter as matchFilterRule } from "./filters";
import type { PortalDirEntry, PortalFileKind, PortalFilter, PortalPlace, PortalStat } from "./types";

const MIME_TYPES: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    csv: "text/csv",
    js: "application/javascript",
    mjs: "application/javascript",
    ts: "application/typescript",
    json: "application/json",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    ico: "image/x-icon",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    flac: "audio/flac",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    mp4: "video/mp4",
    mkv: "video/x-matroska",
    webm: "video/webm",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    zip: "application/zip",
    gz: "application/gzip",
    xz: "application/x-xz",
    tar: "application/x-tar",
    "7z": "application/x-7z-compressed",
    deb: "application/vnd.debian.binary-package",
    rpm: "application/x-rpm",
};

export function mimeOfPath(filePath: string, kind?: PortalFileKind): string {
    if (kind === "directory") return "inode/directory";
    const ext = path.extname(filePath).slice(1).toLowerCase();
    return MIME_TYPES[ext] ?? "application/octet-stream";
}

function normalizePath(p: string): string {
    if (typeof p !== "string" || p.length === 0) throw new Error("路径为空");
    if (p.includes("\0")) throw new Error("路径包含 NUL");
    if (!path.isAbsolute(p)) throw new Error(`需要绝对路径: ${p}`);
    return path.normalize(p);
}

function kindOf(stats: Stats | Dirent): PortalFileKind {
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
}

async function targetKindOf(filePath: string): Promise<PortalFileKind | undefined> {
    try {
        return kindOf(await fsp.stat(filePath));
    } catch {
        return undefined;
    }
}

function homeDir(): string {
    return process.env.HOME || os.homedir();
}

function expandUserDir(value: string): string {
    let out = value.trim();
    if (out.startsWith('"') && out.endsWith('"')) out = out.slice(1, -1);
    const home = homeDir();
    out = out.replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, home);
    if (out.startsWith("~/")) out = path.join(home, out.slice(2));
    return path.normalize(out);
}

function readUserDirs(): Map<string, string> {
    const result = new Map<string, string>();
    const configHome = process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config");
    const file = path.join(configHome, "user-dirs.dirs");
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return result;
    }
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        if (!key.startsWith("XDG_") || !key.endsWith("_DIR")) continue;
        const value = expandUserDir(line.slice(eq + 1));
        if (value) result.set(key, value);
    }
    return result;
}

/**
 * 文件选择器用的窄文件系统接口。
 *
 * 只提供目录枚举、元数据和 places，不提供 readFile，避免桌面插件借文件选择
 * API 读取任意文件内容。需要缩略图时再单独加受限的预览接口。
 */
export class portalFileBrowser {
    private readonly _home = homeDir();

    home(): string {
        return this._home;
    }

    async list(dirPath: string, opts?: { showHidden?: boolean }): Promise<PortalDirEntry[]> {
        const dir = normalizePath(dirPath);
        const showHidden = opts?.showHidden ?? false;
        const dirents = await fsp.readdir(dir, { withFileTypes: true });
        const entries: PortalDirEntry[] = [];

        for (const dirent of dirents) {
            if (!showHidden && dirent.name.startsWith(".")) continue;
            const fullPath = path.join(dir, dirent.name);
            const kind = kindOf(dirent);
            const targetKind = kind === "symlink" ? await targetKindOf(fullPath) : undefined;
            let lstat: Stats | undefined;
            try {
                lstat = await fsp.lstat(fullPath);
            } catch {
                // 目录项在读取过程中被删除：仍返回名称，元数据给 0
            }
            const effectiveKind = targetKind ?? kind;
            entries.push({
                name: dirent.name,
                path: fullPath,
                kind,
                targetKind,
                size: lstat?.size ?? 0,
                mtime: lstat?.mtimeMs ?? 0,
                hidden: dirent.name.startsWith("."),
                mime: mimeOfPath(fullPath, effectiveKind),
            });
        }

        entries.sort((a, b) => {
            const aDir = a.kind === "directory" || a.targetKind === "directory";
            const bDir = b.kind === "directory" || b.targetKind === "directory";
            if (aDir !== bDir) return aDir ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        });
        return entries;
    }

    async stat(filePath: string): Promise<PortalStat | undefined> {
        const p = normalizePath(filePath);
        let stats: Stats;
        try {
            stats = await fsp.lstat(p);
        } catch {
            return undefined;
        }
        const kind = kindOf(stats);
        const targetKind = kind === "symlink" ? await targetKindOf(p) : undefined;
        return {
            path: p,
            kind,
            targetKind,
            size: stats.size,
            mtime: stats.mtimeMs,
        };
    }

    async places(): Promise<PortalPlace[]> {
        const userDirs = readUserDirs();
        const defs: { id: string; label: string; icon: string; path: string }[] = [
            { id: "home", label: "Home", icon: "user-home", path: this._home },
            {
                id: "desktop",
                label: "Desktop",
                icon: "user-desktop",
                path: userDirs.get("XDG_DESKTOP_DIR") ?? path.join(this._home, "Desktop"),
            },
            {
                id: "documents",
                label: "Documents",
                icon: "folder-documents",
                path: userDirs.get("XDG_DOCUMENTS_DIR") ?? path.join(this._home, "Documents"),
            },
            {
                id: "downloads",
                label: "Downloads",
                icon: "folder-download",
                path: userDirs.get("XDG_DOWNLOAD_DIR") ?? path.join(this._home, "Downloads"),
            },
            {
                id: "music",
                label: "Music",
                icon: "folder-music",
                path: userDirs.get("XDG_MUSIC_DIR") ?? path.join(this._home, "Music"),
            },
            {
                id: "pictures",
                label: "Pictures",
                icon: "folder-pictures",
                path: userDirs.get("XDG_PICTURES_DIR") ?? path.join(this._home, "Pictures"),
            },
            {
                id: "videos",
                label: "Videos",
                icon: "folder-videos",
                path: userDirs.get("XDG_VIDEOS_DIR") ?? path.join(this._home, "Videos"),
            },
            { id: "root", label: "Root", icon: "drive-harddisk", path: "/" },
        ];

        const result: PortalPlace[] = [];
        for (const def of defs) {
            try {
                if (def.id !== "root" && !(await fsp.stat(def.path)).isDirectory()) continue;
            } catch {
                continue;
            }
            result.push({ id: def.id, label: def.label, path: def.path, icon: def.icon });
        }
        return result;
    }

    matchFilter(name: string, mime: string, filter: PortalFilter): boolean {
        return matchFilterRule(name, mime, filter);
    }
}
