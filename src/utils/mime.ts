const path = require("node:path") as typeof import("node:path");

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

/** 按扩展名推断 MIME；目录固定为 inode/directory */
export function mimeOfPath(filePath: string, kind?: "file" | "directory" | "symlink" | "other"): string {
    if (kind === "directory") return "inode/directory";
    const ext = path.extname(filePath).slice(1).toLowerCase();
    return MIME_TYPES[ext] ?? "application/octet-stream";
}
