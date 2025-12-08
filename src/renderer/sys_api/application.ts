const fs = require("node:fs/promises") as typeof import("node:fs/promises");
const path = require("node:path") as typeof import("node:path");
const os = require("node:os") as typeof import("node:os");
import ini from "ini";

const appPaths = [
    "/usr/share/applications/",
    "/usr/local/share/applications/",
    path.join(os.homedir() || "", ".local/share/applications/"),
];
async function getDesktopEntry(appId: string, lans: string[] = []) {
    return _getDesktopEntry(appId, appPaths, lans);
}

async function _getDesktopEntry(appId: string, dirs: string[], lans: string[] = []) {
    type T = {
        name: string;
        nameLocal: string;
        comment: string;
        commentLocal: string;
        icon: string;
        exec: string;
        rawDesktopPath: string;
    };
    const desktopFile = `${appId}.desktop`;
    for (const dir of dirs) {
        const filePath = path.join(dir, desktopFile);
        try {
            const content = await fs.readFile(filePath, "utf-8");
            const parsed = ini.parse(content);
            const entry = parsed["Desktop Entry"] || {};
            if (entry.NoDisplay === true) return undefined;
            const exec = entry.Exec || "";
            const name = entry[lans.map((i) => `Name[${i}]`).find((l) => l in entry) || "Name"];
            const comment = entry[lans.map((i) => `Comment[${i}]`).find((l) => l in entry) || "Comment"] || "";
            if (exec) {
                const pureExec = (exec as string).replace(/%.?/g, ""); // 去掉参数
                return {
                    name: entry.Name || "",
                    nameLocal: name,
                    comment: entry.Comment || "",
                    commentLocal: comment,
                    icon: entry.Icon || "",
                    exec: pureExec.trim(),
                    rawDesktopPath: filePath,
                } as T;
            }
        } catch {
            /* skip error */
        }
    }
    return undefined;
}

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
            const appid = file.replace(/\.desktop$/, "");
            const e = await _getDesktopEntry(appid, [dir], lans);
            if (e) entries.push(e);
        }
    }
    return entries;
}

export type DesktopIconConfig = {
    size?: number;
    scale?: number;
    theme?: string;
};

const iconSizeCache = new Map<string, string[]>();

async function getDesktopIcon(_icon: string, op?: DesktopIconConfig): Promise<string | undefined> {
    // 如果 icon 是绝对路径或文件存在则直接返回
    if (!_icon) return undefined;
    if (_icon.startsWith("/")) {
        if (await fs.stat(_icon).catch(() => false)) return _icon;
        return undefined;
    }
    const icon = _icon.replace(/\.png$/, "").replace(/\.svg$/, "");
    async function findInPath(dir: string, iconName: string) {
        const exts = [".png", ".svg"];
        for (const ext of exts) {
            const iconPath = path.join(dir, iconName + ext);
            if (await fs.stat(iconPath).catch(() => false)) {
                return iconPath;
            }
        }
        return undefined;
    }
    async function findInDir(dir: string): Promise<undefined | string> {
        const index = path.join(dir, "index.theme");
        if (await fs.stat(index).catch(() => false)) {
            const iconSize = op?.size || 48;
            const iconScale = op?.scale || 1;
            const cacheKey = `${dir}:${iconSize}:${iconScale}`;

            let pd = iconSizeCache.get(cacheKey);
            if (!pd) {
                const content = await fs.readFile(index, "utf-8");
                const parsed = ini.parse(content);
                const dirs = Object.keys(parsed).filter((k) => k !== "Icon Theme" && k !== "Directories");
                const x = dirs.reverse().map((d) => {
                    const o: PreDirectory = { dir: d, Size: 0 };
                    const po = parsed[d];
                    if (po.Size) o.Size = Number(po.Size);
                    if (po.MinSize) o.MinSize = Number(po.MinSize);
                    if (po.MaxSize) o.MaxSize = Number(po.MaxSize);
                    if (po.Threshold) o.Threshold = Number(po.Threshold);
                    return o;
                });

                pd = Array.from(new Set(findP(x, iconSize, iconScale).concat(x.map((i) => i.dir))));
                iconSizeCache.set(cacheKey, pd);
            }

            if (pd.length > 0) {
                for (const p of pd) {
                    const fullDir = path.join(dir, p);
                    const x = await findInPath(fullDir, icon);
                    if (x) {
                        return x;
                    }
                }
            }
        } else {
            const todo = [{ dir, depth: 0 }];
            while (todo.length > 0) {
                // biome-ignore lint/style/noNonNullAssertion: checked above
                const currentDirX = todo.shift()!;
                if (currentDirX.depth > 3) break;
                const currentDir = currentDirX.dir;
                const baseName = path.basename(currentDir, path.extname(currentDir));
                if (baseName === icon) {
                    const stat = await fs.stat(currentDir);
                    if (!stat) continue;
                    if (stat.isFile()) {
                        return currentDir;
                    }
                }
                const stat = await fs.stat(currentDir);
                if (!stat) continue;
                if (stat.isDirectory()) {
                    const files = await fs.readdir(currentDir);
                    for (const f of files) {
                        todo.push({ dir: path.join(currentDir, f), depth: currentDirX.depth + 1 });
                    }
                }
            }
            return undefined;
        }
        return undefined;
    }
    type PreDirectory = {
        dir: string;
        Size: number;
        Scale?: number;
        MaxSize?: number;
        MinSize?: number;
        Threshold?: number;
    };
    function findP(x: PreDirectory[], size: number, scale = 1) {
        function f(x: PreDirectory[], size: number) {
            const k = x.filter((i) => {
                const min = i.Threshold ? i.Size - i.Threshold : (i.MinSize ?? i.Size);
                const max = i.Threshold ? i.Size + i.Threshold : (i.MaxSize ?? i.Size);
                return min <= size && size <= max;
            });
            return k.sort((a, b) => Math.abs(a.Size - size) - Math.abs(b.Size - size)).map((i) => i.dir);
        }
        if (scale !== 1) {
            const sx = x.filter((i) => i.Scale === scale);
            return f(sx, size).concat(
                f(
                    x.filter((i) => (i.Scale ?? 1) === 1),
                    size * scale,
                ),
            );
        }
        return f(x, size);
    }
    async function findThemeDirs(theme: string | undefined) {
        if (theme === undefined) return undefined;
        const g = path.join("/usr/share/icons/", theme);
        if (await fs.stat(g).catch(() => false)) {
            return g;
        }
        return undefined;
    }
    async function findThemeDirsUser(theme: string | undefined) {
        if (theme === undefined) return undefined;
        const local = path.join(os.homedir() || "", ".local/share/icons/", theme);
        if (await fs.stat(local).catch(() => false)) {
            return local;
        }
        return undefined;
    }
    const iconDirs = [
        (await findThemeDirsUser(op?.theme)) ?? (await findThemeDirs(op?.theme)),
        await findThemeDirs("hicolor"),
        await findThemeDirsUser("hicolor"),
        "/usr/share/pixmaps/",
    ].filter((i) => i !== undefined) as string[];
    for (const dir of iconDirs) {
        const s = await findInDir(dir);
        if (s) return s;
    }
    const s = await findInPath("/usr/share/icons/", icon); // 有些在单层的，不再主题里面
    if (s) return s;

    console.log(icon);

    return undefined;
}

export { getDesktopEntry };
export { getDesktopEntries };
export { getDesktopIcon };
