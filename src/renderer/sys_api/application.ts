const fs = require("node:fs/promises") as typeof import("node:fs/promises");
const path = require("node:path") as typeof import("node:path");
const os = require("node:os") as typeof import("node:os");
import ini from "ini";

const appPaths = [
    "/usr/share/applications/",
    "/usr/local/share/applications/",
    path.join(os.homedir() || "", ".local/share/applications/"),
];

async function getDesktopEntries(lans: string[] = []) {
    const entries: Array<{
        name: string;
        nameLocal: string;
        comment: string;
        commentLocal: string;
        icon: string;
        exec: string;
        rawDesktopPath: string;
    }> = [];
    for (const dir of appPaths) {
        let files: string[] = [];
        try {
            files = (await fs.readdir(dir)).filter((f) => f.endsWith(".desktop"));
        } catch (e) {
            console.error(`Error reading directory ${dir}:`, e);
            continue;
        }
        for (const file of files) {
            const filePath = path.join(dir, file);
            try {
                const content = await fs.readFile(filePath, "utf-8");
                const parsed = ini.parse(content);
                const entry = parsed["Desktop Entry"] || {};
                const exec = entry.Exec || "";
                const name = entry[lans.map((i) => `Name[${i}]`).find((l) => l in entry) || "Name"];
                const comment = entry[lans.map((i) => `Comment[${i}]`).find((l) => l in entry) || "Comment"] || "";
                if (exec) {
                    const pureExec = (exec as string).replace(/%.?/g, ""); // 去掉参数
                    entries.push({
                        name: entry.Name || "",
                        nameLocal: name,
                        comment: entry.Comment || "",
                        commentLocal: comment,
                        icon: entry.Icon || "",
                        exec: pureExec.trim(),
                        rawDesktopPath: filePath,
                    });
                }
            } catch {
                /* skip error */
            }
        }
    }
    return entries;
}

async function getDesktopIcon(icon: string): Promise<string | undefined> {
    // 如果 icon 是绝对路径或文件存在则直接返回
    if (!icon) return undefined;
    if (icon.startsWith("/")) {
        if (await fs.stat(icon).catch(() => false)) return icon;
        return undefined;
    }
    // 常见图标搜索路径
    const iconSizes = [16, 32, 48, 64, 128, 256, 512];
    const userIconDirs = path.join(os.homedir() || "", ".local/share/icons/hicolor/");
    const iconDirs = ["/usr/share/pixmaps/", "/usr/share/icons/hicolor/scalable/apps/"].concat(
        iconSizes.flatMap((size) => [
            `/usr/share/icons/hicolor/${size}x${size}/apps/`,
            path.join(userIconDirs, `${size}x${size}/apps/`),
        ]),
    );
    const exts = [".png", ".svg", ".xpm"];
    if (icon === "com.coolapk.market") console.log(iconDirs);
    for (const dir of iconDirs.toReversed()) {
        for (const ext of exts) {
            const iconPath = path.join(dir, icon + ext);
            if (await fs.stat(iconPath).catch(() => false)) {
                if (icon === "com.coolapk.market") console.log(iconPath);
                return iconPath;
            }
        }
    }
    return undefined;
}

export { getDesktopEntries };
export { getDesktopIcon };
