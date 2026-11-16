import { button, type ElType, image, spacer, view } from "dkh-ui";
import type { ClipboardItem, ClipboardStation } from "./clipboard";
import { getIconXEl } from "./icon";
import { dynamicScrollList } from "./scroll-list";
import { aLineText, iItem, px, sSize, sSize2 } from "./ui";

export interface ClipboardStationTool {
    /** 顶栏图标 */
    el: ElType<HTMLElement>;
    /** 拖拽开始/结束：显示“松开存入中转站” */
    setDragActive(active: boolean): void;
    /** 指针是否落在弹窗内；拖拽经过时高亮 */
    setDropHover(hover: boolean): void;
    containsPoint(x: number, y: number): boolean;
}

function previewOf(item: ClipboardItem): string {
    if (item.text) {
        const line = item.text.split("\n").find((l) => l.trim().length > 0) ?? "";
        return line.length > 90 ? `${line.slice(0, 90)}…` : line;
    }
    if (item.mimes.some((m) => m.startsWith("image/"))) return "[图片]";
    if (item.mimes.includes("text/uri-list")) return "[文件]";
    return item.mimes[0] ?? "[未知内容]";
}

function timeOf(t: number): string {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 剪贴板历史 + 拖拽中转站共用一个顶栏工具。
 *
 * 正常点击图标打开历史；客户端开始拖拽时由桌面调用 `setDragActive(true)` 自动展开，
 * 弹窗顶部出现放置提示，指针进入后高亮。
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

    const dropHint = view("x")
        .style({
            display: "none",
            alignItems: "center",
            justifyContent: "center",
            padding: px(sSize2.padding),
            borderRadius: px(sSize2.radius1),
            background: "rgba(0,0,0,0.05)",
            border: "1px dashed rgba(0,0,0,0.25)",
        })
        .add(aLineText().sv("松开存入中转站"));

    const empty = view("x")
        .style({ justifyContent: "center", padding: px(sSize2.padding), opacity: 0.6 })
        .add(aLineText().sv("暂无剪贴板内容"));

    const list = dynamicScrollList<string>({
        itemSize: sSize(1.5),
        containerSize: sSize(1.5) * 4,
        direction: "down",
        keyExtractor: (id) => id,
        renderItem: (id) => {
            const row = iItem({ type: "h", size: 1.5 }).style({
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: "2px",
                padding: `0 ${px(sSize2.paddingx)}`,
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
                            width: px(sSize(1.5)),
                            height: px(sSize(1.5)),
                            objectFit: "cover",
                            borderRadius: px(6),
                            flexShrink: 0,
                        })
                        .addInto(head);
                }
            }
            aLineText().sv(previewOf(item)).addInto(head).style({ flexGrow: 1 });

            const del = button(getIconXEl("cross", { size: 12, width: 16, height: 16 }))
                .style({ width: px(20), height: px(20), flexShrink: 0 })
                .on("click", (e) => {
                    e.stopPropagation();
                    if (Date.now() < suppressClicksUntil) return;
                    station.remove(id);
                });
            del.addInto(head);

            row.add([
                head,
                aLineText()
                    .sv(`${item.appid || "未知应用"} · ${timeOf(item.time)}`)
                    .style({ opacity: 0.55, fontSize: "0.8em" }),
            ]);
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
    });

    const clearBtn = button()
        .style({
            width: "fit-content",
            height: "fit-content",
            flexShrink: 0,
            padding: `2px ${px(6)}`,
            borderRadius: px(6),
        })
        .add(aLineText().sv("清空"))
        .on("click", () => {
            if (Date.now() < suppressClicksUntil) return;
            station.clear();
        });

    const header = view("x")
        .style({ alignItems: "center", gap: px(6) })
        .add([aLineText().sv("剪贴板").style({ fontWeight: "600" }), spacer(), clearBtn]);

    const panel = view("y")
        .style({ width: px(sSize(6)), gap: px(sSize2.padding) })
        .add([dropHint, header, empty, list.el]);
    panel.addInto(op.tipEl);

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
        list.el.style({ display: ids.length > 0 ? "" : "none" });
        empty.style({ display: ids.length > 0 ? "none" : "" });
    };
    station.subscribe(update);
    update();

    return {
        el: icon,
        setDragActive(active) {
            dragActive = active;
            dropHint.style({ display: active ? "" : "none" });
            if (active) {
                dropHint.style({ background: "rgba(0,0,0,0.05)" });
            } else {
                suppressClicksUntil = Date.now() + 400;
                panel.style({ outline: "none" });
            }
        },
        setDropHover(hover) {
            if (!dragActive) {
                panel.style({ outline: "none" });
                return;
            }
            panel.style({
                outline: hover ? "2px solid rgba(74,158,255,0.9)" : "none",
            });
            dropHint.style({
                background: hover ? "rgba(74,158,255,0.18)" : "rgba(0,0,0,0.05)",
            });
        },
        containsPoint(x, y) {
            const target = document.elementFromPoint(x, y);
            return panel.el.contains(target) || icon.el.contains(target);
        },
    };
}
