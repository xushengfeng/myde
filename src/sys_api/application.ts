import type { FSWatcher } from "node:fs";

const fs = require("node:fs/promises") as typeof import("node:fs/promises");
const fsSync = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const os = require("node:os") as typeof import("node:os");
const { scheduler } = require("node:timers/promises") as typeof import("node:timers/promises");

import ini from "ini";

const appPaths = [
    "/usr/share/applications/",
    "/usr/local/share/applications/",
    path.join(os.homedir() || "", ".local/share/applications/"),
];

type DesktopEntry = {
    name: string;
    nameLocal: string;
    comment: string;
    commentLocal: string;
    icon: string;
    exec: string;
    desktopFile: string;
};

// 桌面应用列表缓存
let entriesCache: DesktopEntry[] | null = null;
let entriesCacheLans: string[] = [];
// 同一时刻可能有多个调用方请求列表，共享同一次加载，避免重复扫描
let entriesPending: Promise<DesktopEntry[]> | null = null;
let entriesPendingLans: string[] = [];
let watchers: FSWatcher[] = [];
let isWatching = false;

/** 限制并发的异步映射，避免一次性打开过多文件 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await fn(items[index]);
        }
    });
    await Promise.all(workers);
    return results;
}

async function _getDesktopEntry(appId: string, dirs: string[], lans: string[] = []) {
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
                const pureExec = (exec as string).replace(/%.?/g, "");
                return {
                    name: entry.Name || "",
                    nameLocal: name,
                    comment: entry.Comment || "",
                    commentLocal: comment,
                    icon: entry.Icon || "",
                    exec: pureExec.trim(),
                    desktopFile: appId,
                } as DesktopEntry;
            }
        } catch {
            /* skip error */
        }
    }
    return undefined;
}

async function _loadDesktopEntries(lans: string[] = []): Promise<DesktopEntry[]> {
    const jobs: { appId: string; dir: string }[] = [];
    for (const dir of appPaths) {
        let files: string[] = [];
        try {
            files = (await fs.readdir(dir)).filter((f) => f.endsWith(".desktop"));
        } catch {
            continue;
        }
        for (const file of files) {
            jobs.push({ appId: file.replace(/\.desktop$/, ""), dir });
        }
    }
    const entries = await mapLimit(jobs, 32, ({ appId, dir }) => _getDesktopEntry(appId, [dir], lans));
    return entries.filter((e): e is DesktopEntry => e !== undefined);
}

function startWatching() {
    if (isWatching) return;
    isWatching = true;

    for (const dir of appPaths) {
        try {
            const watcher = fsSync.watch(dir, { persistent: false }, () => {
                entriesCache = null;
            });
            watcher.on("error", () => {});
            watchers.push(watcher);
        } catch {
            /* directory may not exist */
        }
    }
}

function stopWatching() {
    for (const watcher of watchers) {
        watcher.close();
    }
    watchers = [];
    isWatching = false;
}

async function getDesktopEntries(lans: string[] = []): Promise<DesktopEntry[]> {
    // 启动监听（首次调用时）
    startWatching();

    // 检查缓存是否有效（语言参数相同）
    if (entriesCache && JSON.stringify(entriesCacheLans) === JSON.stringify(lans)) {
        return entriesCache;
    }

    // 已有相同参数的加载正在进行，直接复用，避免重复读取所有 desktop 文件
    if (entriesPending && JSON.stringify(entriesPendingLans) === JSON.stringify(lans)) {
        return entriesPending;
    }

    entriesPendingLans = lans;
    const pending = _loadDesktopEntries(lans).then((entries) => {
        entriesCache = entries;
        entriesCacheLans = lans;
        return entries;
    });
    entriesPending = pending;
    try {
        return await pending;
    } finally {
        if (entriesPending === pending) {
            entriesPending = null;
        }
    }
}

// 强制刷新缓存
async function refreshDesktopEntries(lans: string[] = []): Promise<DesktopEntry[]> {
    entriesCache = null;
    entriesPending = null;
    return getDesktopEntries(lans);
}

async function getDesktopEntry(appId: string, lans: string[] = []) {
    return _getDesktopEntry(appId, appPaths, lans);
}

export type DesktopIconConfig = {
    size?: number;
    scale?: number;
    theme?: string;
    themeBasePath?: string;
};

const iconSizeCache = new Map<string, string[]>();
const iconBlobCache = new Map<string, string>();
// 同一个图标（同尺寸/主题）可能被多个调用方同时请求，共享一次查找
const iconPendingCache = new Map<string, Promise<string | undefined>>();
const iconMissCache = new Set<string>();

function getDesktopIcon(_icon: string, op?: DesktopIconConfig): Promise<string | undefined> {
    if (!_icon) return Promise.resolve(undefined);

    const cacheKey = `${_icon}:${op?.size || 48}:${op?.scale || 1}:${op?.theme || ""}:${op?.themeBasePath || ""}`;

    // 检查缓存
    const cached = iconBlobCache.get(cacheKey);
    if (cached !== undefined) {
        return Promise.resolve(cached);
    }
    if (iconMissCache.has(cacheKey)) {
        return Promise.resolve(undefined);
    }
    const pending = iconPendingCache.get(cacheKey);
    if (pending) {
        return pending;
    }

    const task = _getDesktopIcon(_icon, op, cacheKey).finally(() => {
        iconPendingCache.delete(cacheKey);
    });
    iconPendingCache.set(cacheKey, task);
    return task;
}

async function _getDesktopIcon(_icon: string, op: DesktopIconConfig | undefined, cacheKey: string) {
    let iconPath: string | undefined;

    // 如果 icon 是绝对路径或文件存在则直接使用
    if (_icon.startsWith("/")) {
        if (await fs.stat(_icon).catch(() => false)) {
            iconPath = _icon;
        }
    } else {
        const icon = _icon.replace(/\.png$/, "").replace(/\.svg$/, "");

        async function findInPath(dir: string, iconName: string) {
            const exts = [".png", ".svg"];
            for (const ext of exts) {
                const p = path.join(dir, iconName + ext);
                if (await fs.stat(p).catch(() => false)) {
                    return p;
                }
            }
            return undefined;
        }

        async function findInDir(dir: string): Promise<undefined | string> {
            const index = path.join(dir, "index.theme");
            if (await fs.stat(index).catch(() => false)) {
                const iconSize = op?.size || 48;
                const iconScale = op?.scale || 1;
                const sizeCacheKey = `${dir}:${iconSize}:${iconScale}`;

                let pd = iconSizeCache.get(sizeCacheKey);
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
                    iconSizeCache.set(sizeCacheKey, pd);
                }

                if (pd.length > 0) {
                    for (const p of pd) {
                        const fullDir = path.join(dir, p);
                        const x = await findInPath(fullDir, icon);
                        if (x) return x;
                    }
                }
            } else {
                const todo = [{ dir, depth: 0 }];
                while (todo.length > 0) {
                    await scheduler.yield();
                    // biome-ignore lint/style/noNonNullAssertion: checked above
                    const currentDirX = todo.shift()!;
                    if (currentDirX.depth > 3) break;
                    const currentDir = currentDirX.dir;
                    const baseName = path.basename(currentDir, path.extname(currentDir));
                    if (baseName === icon) {
                        const stat = await fs.stat(currentDir);
                        if (!stat) continue;
                        if (stat.isFile()) return currentDir;
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

        async function findThemeDirsWithPath(theme: string | undefined, basePath?: string) {
            if (theme === undefined) return undefined;
            if (!basePath) return undefined;
            const g = path.join(basePath, theme);
            if (await fs.stat(g).catch(() => false)) return g;
            return undefined;
        }

        async function findThemeDirs(theme: string | undefined) {
            if (theme === undefined) return undefined;
            const g = path.join("/usr/share/icons/", theme);
            if (await fs.stat(g).catch(() => false)) return g;
            return undefined;
        }

        async function findThemeDirsUser(theme: string | undefined) {
            if (theme === undefined) return undefined;
            const local = path.join(os.homedir() || "", ".local/share/icons/", theme);
            if (await fs.stat(local).catch(() => false)) return local;
            return undefined;
        }

        const iconDirs = [
            await findThemeDirsWithPath(op?.theme, op?.themeBasePath),
            (await findThemeDirsUser(op?.theme)) ?? (await findThemeDirs(op?.theme)),
            await findThemeDirsWithPath("hicolor", op?.themeBasePath),
            await findThemeDirs("hicolor"),
            await findThemeDirsUser("hicolor"),
            "/usr/share/pixmaps/",
        ].filter((i) => i !== undefined) as string[];

        for (const dir of iconDirs) {
            const s = await findInDir(dir);
            if (s) {
                iconPath = s;
                break;
            }
        }

        if (!iconPath) {
            iconPath = await findInPath("/usr/share/icons/", icon);
        }
    }

    if (!iconPath) {
        iconMissCache.add(cacheKey);
        return undefined;
    }

    // 读取文件并创建 blob URL
    try {
        const data = await fs.readFile(iconPath);
        const ext = path.extname(iconPath).slice(1).toLowerCase();
        const mime = ext === "svg" ? "image/svg+xml" : `image/${ext}`;
        const blob = new Blob([new Uint8Array(data)], { type: mime });
        const blobUrl = URL.createObjectURL(blob);
        iconBlobCache.set(cacheKey, blobUrl);
        return blobUrl;
    } catch {
        iconMissCache.add(cacheKey);
        return undefined;
    }
}

export { getDesktopEntries, getDesktopEntry, getDesktopIcon, refreshDesktopEntries, stopWatching };
