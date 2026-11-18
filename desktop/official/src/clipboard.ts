import type { ClipboardChange, WaylandServer, WinHandle } from "../../../src/wayland";

/** 条目来源：应用复制，或拖入中转站 */
export type ClipboardItemKind = "clipboard" | "drag";

/** 桌面侧剪贴板条目：字节、历史、预览都在这里，wayland server 不保存 */
export interface ClipboardItem {
    id: string;
    mimes: string[];
    bytes: Map<string, Uint8Array>;
    /** 全部 mime 的字节数，用于总量裁剪 */
    size: number;
    /** text/plain 预览（截断），非文本为空 */
    text: string;
    appid: string;
    /** 来源 seat；回放时放回同一把 seat */
    seat: string;
    time: number;
    kind: ClipboardItemKind;
}

export interface ClipboardAddOptions {
    appid: string;
    seat?: string;
    time?: number;
    /** 缺省为应用复制 */
    kind?: ClipboardItemKind;
}

export interface ClipboardStation {
    /** 最新的在前 */
    items: ClipboardItem[];
    /** 键盘焦点进入窗口时把当前剪贴板 offer 过去 */
    offer(handle: WinHandle): void;
    /** 把历史条目放回剪贴板；客户端真正粘贴时 server 会回来要字节 */
    copy(id: string): void;
    remove(id: string): void;
    /** 省略 kind 时清空全部 */
    clear(kind?: ClipboardItemKind): void;
    /** 把外部数据（例如拖拽）存入历史；`read` 按 mime 取字节 */
    add(
        mimes: string[],
        read: (mime: string) => Promise<Uint8Array | null>,
        op: ClipboardAddOptions,
    ): Promise<ClipboardItem | undefined>;
    subscribe(fn: () => void): () => void;
    dispose(): void;
}

/** 值得存进历史的 mime；其余（应用私有格式）直接丢弃 */
const KEPT_MIMES = [
    "text/plain;charset=utf-8",
    "text/plain",
    "text/html",
    "text/uri-list",
    "image/png",
    "image/jpeg",
    "image/webp",
];

const MAX_ITEMS = 50;
const MAX_ITEM_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_TEXT_PREVIEW = 2000;

/** 密码管理器会打这个标记；这类内容不进历史，也不在源退出后回放 */
const SENSITIVE_MIMES = ["x-kde-passwordManagerHint"];

function isKept(mime: string): boolean {
    return KEPT_MIMES.includes(mime);
}

function pickTextMime(mimes: string[]): string | undefined {
    return mimes.find((m) => /^text\/plain(;.*)?$/i.test(m)) ?? mimes.find((m) => m.startsWith("text/"));
}

/**
 * 官方桌面的剪贴板数据层。
 *
 * server 只发 `clipboard.changed` 和按需 `clipboard.read` / `clipboard.requestData`；
 * 这里负责把客户端复制的内容读成历史、在源退出后把最后一条放回剪贴板，并作为
 * “桌面源”在应用粘贴时提供字节。UI（中转站）只消费 `items`。
 */
export function initClipboard(server: WaylandServer): ClipboardStation {
    const items: ClipboardItem[] = [];
    let seq = 0;
    let lastId: string | undefined;
    /** 最近一次 selection 没有进历史（敏感 / 不支持的 mime）：源退出时不要回放旧条目 */
    let skipLast = false;
    const listeners = new Set<() => void>();

    const notify = () => {
        for (const fn of listeners) fn();
    };

    const trim = () => {
        let total = items.reduce((sum, it) => sum + it.size, 0);
        while (items.length > MAX_ITEMS || total > MAX_TOTAL_BYTES) {
            const removed = items.pop();
            if (!removed) break;
            total -= removed.size;
            if (removed.id === lastId) lastId = items[0]?.id;
        }
    };

    server.respond("clipboard.requestData", (id, mime) => items.find((it) => it.id === id)?.bytes.get(mime) ?? null);
    server.respond("dnd.requestData", (id, mime) => items.find((it) => it.id === id)?.bytes.get(mime) ?? null);

    const add = async (
        mimes: string[],
        read: (mime: string) => Promise<Uint8Array | null>,
        op: ClipboardAddOptions,
    ): Promise<ClipboardItem | undefined> => {
        let kept = mimes.filter(isKept);
        // 同一份文本通常同时 offer utf-8 和裸 text/plain；只留 utf-8
        if (kept.some((m) => m === "text/plain;charset=utf-8")) kept = kept.filter((m) => m !== "text/plain");
        if (kept.length === 0) return undefined;
        // 一次性发全部 read：server 按 source 串行化，但 token 在请求发出的这一刻就解析掉了
        const results = await Promise.all(kept.map(async (mime) => [mime, await read(mime)] as const));
        const bytes = new Map<string, Uint8Array>();
        let total = 0;
        for (const [mime, data] of results) {
            if (!data || data.length === 0) continue;
            if (total + data.length > MAX_ITEM_BYTES) break;
            bytes.set(mime, data);
            total += data.length;
        }
        if (bytes.size === 0) return undefined;

        const textMime = pickTextMime([...bytes.keys()]);
        const text = textMime ? new TextDecoder().decode(bytes.get(textMime)) : "";
        const item: ClipboardItem = {
            id: `cb-${++seq}`,
            mimes: [...bytes.keys()],
            bytes,
            size: total,
            text: text.slice(0, MAX_TEXT_PREVIEW),
            appid: op.appid,
            seat: op.seat ?? "seat0",
            time: op.time ?? Date.now(),
            kind: op.kind ?? "clipboard",
        };
        items.unshift(item);
        lastId = item.id;
        skipLast = false;
        trim();
        notify();
        return item;
    };

    const readChange = async (change: ClipboardChange) => {
        if (change.mimes.some((mime) => SENSITIVE_MIMES.includes(mime))) return;
        await add(change.mimes, (mime) => server.request("clipboard.read", change.token, mime), {
            appid: change.appid,
            seat: change.seat,
            time: change.time,
        });
    };

    server.on("clipboard.changed", (change, reason) => {
        if (change) {
            skipLast = true;
            void readChange(change).catch((err) => console.error("clipboard read failed:", err));
            return;
        }
        // 源客户端退出/销毁 source：把最后一条放回剪贴板，内容不随应用消失
        if (reason === "sourceGone" && !skipLast && lastId !== undefined) {
            const item = items.find((it) => it.id === lastId);
            if (item) server.notify("clipboard.set", { id: item.id, mimes: item.mimes, seat: item.seat });
        }
        skipLast = false;
    });

    return {
        items,
        offer: (handle) => server.notify("clipboard.offer", handle),
        copy: (id) => {
            const item = items.find((it) => it.id === id);
            if (!item) return;
            lastId = item.id;
            skipLast = false;
            server.notify("clipboard.set", { id: item.id, mimes: item.mimes, seat: item.seat });
        },
        remove: (id) => {
            const index = items.findIndex((it) => it.id === id);
            if (index < 0) return;
            items.splice(index, 1);
            if (lastId === id) lastId = items[0]?.id;
            notify();
        },
        clear: (kind) => {
            if (kind) {
                for (let i = items.length - 1; i >= 0; i--) {
                    if (items[i]?.kind === kind) items.splice(i, 1);
                }
            } else {
                items.length = 0;
            }
            if (lastId !== undefined && !items.some((it) => it.id === lastId)) lastId = items[0]?.id;
            notify();
        },
        add,
        subscribe: (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        dispose: () => listeners.clear(),
    };
}
