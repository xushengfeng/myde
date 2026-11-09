const { pathToFileURL } = require("node:url") as typeof import("node:url");

/** D-Bus `ay` 里的路径：UTF-8，第一个 NUL 之后忽略。 */
export function decodePathBytes(bytes: number[] | undefined): string | undefined {
    if (!bytes || bytes.length === 0) return undefined;
    const text = Buffer.from(bytes).toString("utf8");
    const nul = text.indexOf("\0");
    const path = nul === -1 ? text : text.slice(0, nul);
    return path.length > 0 ? path : undefined;
}

/** 生成 D-Bus `ay` 用的 NUL 结尾路径。 */
export function encodePathBytes(path: string): number[] {
    return Array.from(Buffer.from(`${path}\0`, "utf8"));
}

/** 后端返回给前端的 file:// URI。 */
export function pathToUri(path: string): string {
    return pathToFileURL(path).href;
}
