import { button, type ElType, image, view } from "dkh-ui";
import type { ClipboardItem, ClipboardItemKind, ClipboardStation } from "./clipboard";
import { getIconXEl } from "./icon";
import { aLineText, gGlassStyle, iItem, px, sourceTag, sSize, sSize2, ui, uScrollList } from "./ui";

/** 弹窗和列表固定宽度，内容多少不影响布局 */
const CONTENT_WIDTH = sSize(8);
/** 列表固定高度，无内容时也保留同样大小 */
const LIST_HEIGHT = sSize(1.5) * 4;
const DROP_IDLE_BG = gGlassStyle.itemInBg.backgroundColor;
const DROP_READY_BG = "rgba(74,158,255,0.08)";
const DROP_HOVER_BG = "rgba(74,158,255,0.18)";

export interface ClipboardStationTool {
    /** 顶栏图标 */
    el: ElType<HTMLElement>;
    /** 拖拽开始/结束：切换列表的落点底色 */
    setDragActive(active: boolean): void;
    /** 指针是否落在弹窗内；拖拽经过时高亮 */
    setDropHover(hover: boolean): void;
    containsPoint(x: number, y: number): boolean;
}

export function clipboardPreview(item: ClipboardItem): string {
    if (item.text) {
        const line = item.text.split("\n").find((l) => l.trim().length > 0) ?? "";
        return line.length > 90 ? `${line.slice(0, 90)}…` : line;
    }
    if (item.mimes.some((m) => m.startsWith("image/"))) return "[图片]";
    if (item.mimes.includes("text/uri-list")) return "[文件]";
    return item.mimes[0] ?? "[未知内容]";
}

export function clipboardTime(t: number): string {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 剪贴板历史 + 拖拽中转站共用一个顶栏工具。
 *
 * 正常点击图标打开历史；客户端开始拖拽时由桌面调用 `setDragActive(true)` 自动展开，
 * 拖入的内容标记为“拖拽”，与普通复制内容共用列表、分别清空。
 */
export function createClipboardStationTool(op: {
    station: ClipboardStation;
    /** 工具的弹窗容器，由 `getTool` 提供 */
    tipEl: HTMLElement;
    /** 复制后关闭弹窗 */
    onCopy?: () => void;
    /** 从历史条目拖出：start 建立会话，move/end 驱动目标 */
    onDragItem?: (item: ClipboardItem, phase: "start" | "move" | "end", x: number, y: number) => void;
}): ClipboardStationTool {
    const { station } = op;
    // 拖拽开始后 400ms 内忽略 click，避免 pointerup 在弹窗上合成一次误点
    let suppressClicksUntil = 0;
    let dragActive = false;
    let dragItem: ClipboardItem | undefined;
    let dragOrigin = { x: 0, y: 0 };
    let draggingOut = false;
    /** 图片预览的 object URL，条目移除时回收 */
    const imageUrls = new Map<string, string>();

    const icon = view("x")
        .style({ alignItems: "center" })
        .add(getIconXEl("clipboard", { size: 20, width: 24, height: 24 }));

    const list = uScrollList<string>({
        itemSize: sSize(1.5),
        containerSize: LIST_HEIGHT,
        direction: "down",
        crossSize: CONTENT_WIDTH,
        keyExtractor: (id) => id,
        renderItem: (id) => {
            const row = iItem({ type: "h", size: 1.5 }).style({
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: "2px",
                padding: `0 ${px(sSize2.paddingx)}`,
                overflow: "hidden",
                cursor: "pointer",
            });
            const item = station.items.find((it) => it.id === id);
            if (!item) return row;

            const head = view("x").style({ alignItems: "center", gap: px(6) });
            const imageMime = item.mimes.find((m) => m.startsWith("image/"));
            if (!item.text && imageMime) {
                const bytes = item.bytes.get(imageMime);
                if (bytes) {
                    const key = `${item.id}:${imageMime}`;
                    let url = imageUrls.get(key);
                    if (!url) {
                        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: imageMime }));
                        imageUrls.set(key, url);
                    }
                    image(url, item.appid)
                        .style({
                            width: px(sSize(1)),
                            height: px(sSize(1)),
                            objectFit: "cover",
                            borderRadius: px(6),
                            flexShrink: 0,
                        })
                        .addInto(head);
                }
            }
            aLineText().sv(clipboardPreview(item)).addInto(head).style({ flexGrow: 1 });

            const del = button(getIconXEl("cross", { size: 12, width: 16, height: 16 }))
                .style({ width: px(20), height: px(20), flexShrink: 0 })
                .on("click", (e) => {
                    e.stopPropagation();
                    if (Date.now() < suppressClicksUntil) return;
                    station.remove(id);
                });
            del.addInto(head);

            const meta = view("x").style({ alignItems: "center", gap: px(4) });
            if (item.kind === "drag") {
                meta.add(sourceTag("拖拽"));
            }
            meta.add(
                aLineText()
                    .sv(`${item.appid || "未知应用"} · ${clipboardTime(item.time)}`)
                    .style({ opacity: 0.55, fontSize: "0.8em" }),
            );

            row.add([head, meta]);
            row.on("click", () => {
                if (dragActive || Date.now() < suppressClicksUntil) return;
                station.copy(id);
                op.onCopy?.();
            });
            row.on("pointerdown", (e) => {
                const pe = e as PointerEvent;
                if (dragActive || Date.now() < suppressClicksUntil) return;
                if ((pe.target as HTMLElement | null)?.closest("button")) return;
                dragItem = item;
                dragOrigin = { x: pe.clientX, y: pe.clientY };
                draggingOut = false;
            });
            return row;
        },
        empty: "暂无内容",
    });

    function clearButton(label: string, kind: ClipboardItemKind) {
        return button()
            .style({
                width: "100%",
                height: "100%",
                flexShrink: "0",
                padding: `0 ${px(sSize2.paddingx)}`,
                borderRadius: "inherit",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
            })
            .add(aLineText().sv(label))
            .on("click", () => {
                if (Date.now() < suppressClicksUntil) return;
                station.clear(kind);
            });
    }

    const listItem = ui
        .barItem()
        .style({
            width: px(CONTENT_WIDTH),
            height: px(LIST_HEIGHT),
            transition: "background-color 120ms",
        })
        .add(list.el);

    const actions = view("x").style({
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: px(sSize2.padding),
        width: "100%",
        height: px(sSize(1)),
    });
    const clearDrag = ui
        .barItem()
        .style({
            height: px(sSize(1)),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
        })
        .add(clearButton("清空拖拽", "drag"));
    const clearClipboard = ui
        .barItem()
        .style({
            height: px(sSize(1)),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
        })
        .add(clearButton("清空剪贴板", "clipboard"));
    actions.add([clearDrag, clearClipboard]);

    const panel = ui.bar([listItem, actions]);
    panel.el.addInto(op.tipEl);

    const onPointerMove = (e: PointerEvent) => {
        if (!dragItem) return;
        if (!draggingOut && Math.hypot(e.clientX - dragOrigin.x, e.clientY - dragOrigin.y) > 6) {
            draggingOut = true;
            op.onDragItem?.(dragItem, "start", e.clientX, e.clientY);
        }
        if (draggingOut) op.onDragItem?.(dragItem, "move", e.clientX, e.clientY);
    };
    const onPointerUp = (e: PointerEvent) => {
        if (dragItem && draggingOut) {
            op.onDragItem?.(dragItem, "end", e.clientX, e.clientY);
            suppressClicksUntil = Date.now() + 400;
        }
        dragItem = undefined;
        draggingOut = false;
    };
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);

    const update = () => {
        const ids = station.items.map((it) => it.id);
        const keep = new Set(ids);
        for (const [key, url] of imageUrls) {
            if (keep.has(key.slice(0, key.indexOf(":")))) continue;
            URL.revokeObjectURL(url);
            imageUrls.delete(key);
        }
        list.setList(ids);
    };
    station.subscribe(update);
    update();

    return {
        el: icon,
        setDragActive(active) {
            dragActive = active;
            listItem.style({ backgroundColor: active ? DROP_READY_BG : DROP_IDLE_BG });
            if (!active) suppressClicksUntil = Date.now() + 400;
        },
        setDropHover(hover) {
            if (!dragActive) {
                listItem.style({ backgroundColor: DROP_IDLE_BG });
                return;
            }
            listItem.style({ backgroundColor: hover ? DROP_HOVER_BG : DROP_READY_BG });
        },
        containsPoint(x, y) {
            const target = document.elementFromPoint(x, y);
            return panel.el.el.contains(target) || icon.el.contains(target);
        },
    };
}
