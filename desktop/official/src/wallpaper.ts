import type { ElType } from "dkh-ui";

export type WallpaperSlot = "desktop" | "lock";

export type WallpaperStoreOptions = {
    /** 没有自定义壁纸时使用的桌面自带壁纸 data URL */
    defaultSrc: string;
    getStoredPath(slot: WallpaperSlot): string | undefined;
    setStoredPath(slot: WallpaperSlot, path: string | undefined): void;
    readImage(path: string): Promise<string>;
};

const SLOTS: WallpaperSlot[] = ["desktop", "lock"];

function errorText(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 桌面壁纸和锁屏壁纸。
 *
 * 设置里只保存图片路径；启动和切换时用 nativefs.readImage 读出内容，
 * 读失败（文件被删除、没有权限等）就回落到自带壁纸，并保留错误给设置界面显示。
 */
export function createWallpaperStore(op: WallpaperStoreOptions) {
    const defaultSrc = op.defaultSrc;
    const paths: Record<WallpaperSlot, string | undefined> = {
        desktop: op.getStoredPath("desktop"),
        lock: op.getStoredPath("lock"),
    };
    const srcs: Record<WallpaperSlot, string> = {
        desktop: defaultSrc,
        lock: defaultSrc,
    };
    const errors: Record<WallpaperSlot, string | undefined> = {
        desktop: undefined,
        lock: undefined,
    };
    const elements: Partial<Record<WallpaperSlot, ElType<HTMLImageElement>>> = {};
    const listeners = new Set<() => void>();
    const tokens: Record<WallpaperSlot, number> = { desktop: 0, lock: 0 };

    function paint(slot: WallpaperSlot) {
        elements[slot]?.attr({ src: srcs[slot] });
    }

    function notify() {
        for (const listener of listeners) listener();
    }

    async function load(slot: WallpaperSlot, path: string): Promise<boolean> {
        const token = ++tokens[slot];
        try {
            const dataUrl = await op.readImage(path);
            if (token !== tokens[slot]) return false;
            srcs[slot] = dataUrl;
            errors[slot] = undefined;
        } catch (error) {
            if (token !== tokens[slot]) return false;
            srcs[slot] = defaultSrc;
            errors[slot] = errorText(error);
        }
        paint(slot);
        notify();
        return errors[slot] === undefined;
    }

    for (const slot of SLOTS) {
        const path = paths[slot];
        if (path) void load(slot, path);
    }

    return {
        src: (slot: WallpaperSlot) => srcs[slot],
        error: (slot: WallpaperSlot) => errors[slot],
        isDefault: (slot: WallpaperSlot) => paths[slot] === undefined,
        /** 绑定显示元素；图片加载完成后直接更新它的 src */
        bind(slot: WallpaperSlot, el: ElType<HTMLImageElement>) {
            elements[slot] = el;
            paint(slot);
            return el;
        },
        /** 读取并保存新壁纸；读取失败不会改动当前壁纸和设置 */
        async setPath(slot: WallpaperSlot, path: string) {
            const token = ++tokens[slot];
            let dataUrl: string;
            try {
                dataUrl = await op.readImage(path);
            } catch (error) {
                if (token === tokens[slot]) {
                    errors[slot] = errorText(error);
                    notify();
                }
                throw error;
            }
            if (token !== tokens[slot]) return;
            op.setStoredPath(slot, path);
            paths[slot] = path;
            srcs[slot] = dataUrl;
            errors[slot] = undefined;
            paint(slot);
            notify();
        },
        /** 恢复自带壁纸 */
        reset(slot: WallpaperSlot) {
            op.setStoredPath(slot, undefined);
            paths[slot] = undefined;
            srcs[slot] = defaultSrc;
            errors[slot] = undefined;
            ++tokens[slot];
            paint(slot);
            notify();
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
