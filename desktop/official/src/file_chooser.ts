import { button, type ElType, input, select, textarea, txt, view } from "dkh-ui";
import type { FileChooserRequest, NativeFsEntry, PortalChoice, PortalFilter } from "../../../src/desktop-api";
import { matchFilter } from "../../../src/sys_api/xdg_desktop_portal/filters";
import { aLineText, gGlassStyle, gTextStyle, px, sSize2 } from "./ui";

type Place = {
    id: string;
    label: string;
    path: string;
    icon: string;
};

type IconKind = "folder" | "file" | "text" | "code" | "image" | "audio" | "video" | "archive" | "pdf";

const PLACE_LABELS: Record<string, string> = {
    home: "主目录",
    desktop: "桌面",
    documents: "文档",
    downloads: "下载",
    music: "音乐",
    pictures: "图片",
    videos: "视频",
    root: "根目录",
};

const PLACE_FOLDERS = [
    { id: "desktop", label: "桌面", icon: "user-desktop", names: ["Desktop", "桌面"] },
    { id: "documents", label: "文档", icon: "folder-documents", names: ["Documents", "文档"] },
    { id: "downloads", label: "下载", icon: "folder-download", names: ["Downloads", "下载"] },
    { id: "music", label: "音乐", icon: "folder-music", names: ["Music", "音乐"] },
    { id: "pictures", label: "图片", icon: "folder-pictures", names: ["Pictures", "图片"] },
    { id: "videos", label: "视频", icon: "folder-videos", names: ["Videos", "视频"] },
];

/** 目录太大时只铺一部分行，避免一次创建过多 DOM */
const MAX_RENDERED_ROWS = 1200;

const FOLDER_ICON = `<path d="M3 6.8A1.8 1.8 0 0 1 4.8 5h4.3l2 2.3h8.1A1.8 1.8 0 0 1 21 9.1v8.1a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 17.2z" fill="#79aaff" stroke="#4d7fd0" stroke-width="1.1" stroke-linejoin="round"/>`;
const FILE_BASE = `<path d="M6.5 3.5h6.7L18 8.3v12.2H6.5z" fill="#ffffff" stroke="#9aa3ad" stroke-width="1.2" stroke-linejoin="round"/><path d="M13.2 3.5v4.8H18" fill="none" stroke="#9aa3ad" stroke-width="1.2" stroke-linejoin="round"/>`;

const FILE_ICONS: Record<IconKind, string> = {
    folder: FOLDER_ICON,
    file: FILE_BASE,
    text: `${FILE_BASE}<path d="M9 11.5h6M9 14h6M9 16.5h4" fill="none" stroke="#9aa3ad" stroke-width="1.1" stroke-linecap="round"/>`,
    code: `${FILE_BASE}<path d="M10.4 12 8.6 14l1.8 2M13.6 12l1.8 2-1.8 2" fill="none" stroke="#7a8794" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    image: `${FILE_BASE}<rect x="8.2" y="11" width="7.6" height="5.4" rx="0.8" fill="#d7efd7"/><circle cx="14" cy="12.5" r="0.8" fill="#e8b44d"/><path d="M8.8 15.7l1.8-1.8 1.3 1.2 1.2-1.4 1.4 2z" fill="#72b96e"/>`,
    audio: `${FILE_BASE}<path d="M10.2 16.2v-5.6l4.2-.9v5.3" fill="none" stroke="#7a8794" stroke-width="1.2" stroke-linejoin="round"/><circle cx="9.3" cy="16.5" r="1.3" fill="#7a8794"/><circle cx="13.5" cy="15.6" r="1.3" fill="#7a8794"/>`,
    video: `${FILE_BASE}<path d="M10.4 11.4v4.8l4.1-2.4z" fill="#7a8794"/>`,
    archive: `${FILE_BASE}<rect x="8.4" y="10.7" width="7.2" height="6.4" rx="0.9" fill="#f2dfb4" stroke="#c8a760" stroke-width="0.9"/><path d="M12 10.7v6.4" stroke="#c8a760" stroke-width="0.9"/>`,
    pdf: `${FILE_BASE}<path d="M8.2 10.6h7.6v6.8H8.2z" fill="#f6d2d2"/><path d="M10 15.8V12h1.4a1.2 1.2 0 0 1 0 2.4H10" fill="none" stroke="#c75b5b" stroke-width="1" stroke-linecap="round"/>`,
};

const LINE_ICONS: Record<string, string> = {
    "user-home": `<path d="M4 11.2 12 4.5l8 6.7M6.2 10v9.5h11.6V10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    "user-desktop": `<rect x="3.5" y="5" width="17" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 20h6M12 16v4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
    "folder-documents": `<path d="M4 6.5h6l1.8 2H20v9.8H4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 12h8M8 15h6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`,
    "folder-download": `<path d="M4 6.5h6l1.8 2H20v9.8H4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 10.5v4.5M9.8 13l2.2 2.2 2.2-2.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
    "folder-music": `<path d="M4 6.5h6l1.8 2H20v9.8H4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10.6 15.2v-3.6l3.2-.7v3.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="9.9" cy="15.5" r="0.9" fill="currentColor"/><circle cx="13.1" cy="14.8" r="0.9" fill="currentColor"/>`,
    "folder-pictures": `<path d="M4 6.5h6l1.8 2H20v9.8H4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><rect x="8" y="11" width="8" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8.8 15l2-2 1.4 1.3 1.2-1.4 1.8 2.1" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>`,
    "folder-videos": `<path d="M4 6.5h6l1.8 2H20v9.8H4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10.4 11.6v4.2l3.8-2.1z" fill="currentColor"/>`,
    "drive-harddisk": `<rect x="3.5" y="7" width="17" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="7.6" cy="12" r="1" fill="currentColor"/><path d="M11 12h6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`,
    folder: `<path d="M3.5 7a1.8 1.8 0 0 1 1.8-1.8h4l1.8 2.2h7.6A1.8 1.8 0 0 1 20.5 9.2v8.3a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`,
    back: `<path d="M14.5 6 8.5 12l6 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
    up: `<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
    refresh: `<path d="M19 12a7 7 0 1 1-2.1-5M19 4.5V9h-4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
};

function iconEl(content: string, size: number, stroke = false): HTMLElement {
    const holder = document.createElement("div");
    holder.style.width = `${size}px`;
    holder.style.height = `${size}px`;
    holder.style.flexShrink = "0";
    holder.style.display = "flex";
    holder.style.alignItems = "center";
    holder.style.justifyContent = "center";
    holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"${stroke ? "" : ' fill="none"'}>${content}</svg>`;
    return holder;
}

function placeIconEl(icon: string): HTMLElement {
    return iconEl(LINE_ICONS[icon] ?? LINE_ICONS.folder, 16, true);
}

function entryIconEl(entry: NativeFsEntry): HTMLElement {
    const kind = iconKindOf(entry);
    const el = iconEl(FILE_ICONS[kind], 20);
    if (entry.kind === "symlink") el.style.opacity = "0.75";
    return el;
}

function iconKindOf(entry: NativeFsEntry): IconKind {
    if (isDir(entry)) return "folder";
    const mime = entry.mime;
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    if (mime === "application/pdf") return "pdf";
    if (mime.includes("zip") || mime.includes("gzip") || mime.includes("x-tar") || mime.includes("x-xz"))
        return "archive";
    if (mime.includes("7z") || mime.includes("debian") || mime.includes("x-rpm")) return "archive";
    const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
    if (["js", "mjs", "ts", "json", "xml", "yaml", "yml", "css", "html", "htm", "sh", "py", "rs", "go"].includes(ext))
        return "code";
    if (mime.startsWith("text/") || mime === "application/json") return "text";
    return "file";
}

function isDir(entry: NativeFsEntry): boolean {
    return entry.kind === "directory" || entry.targetKind === "directory";
}

function isFile(entry: NativeFsEntry): boolean {
    return !isDir(entry);
}

function parentPath(p: string): string {
    if (p === "/") return "/";
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
}

function baseName(p: string): string {
    const i = p.lastIndexOf("/");
    return i === -1 ? p : p.slice(i + 1);
}

function joinPath(dir: string, name: string): string {
    if (name.startsWith("/")) return name;
    return dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
}

function samePath(a: string, b: string): boolean {
    const normalize = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
    return normalize(a) === normalize(b);
}

function formatSize(size: number): string {
    if (size < 1024) return `${size} B`;
    const units = ["KB", "MB", "GB", "TB", "PB"];
    let value = size / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatTime(ms: number): string {
    if (!ms) return "";
    const d = new Date(ms);
    const pad = (v: number) => String(v).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function fieldStyle<T extends HTMLElement>(el: ElType<T>, width?: string): ElType<T> {
    return el.style({
        width: width ?? "100%",
        height: "32px",
        padding: "0 9px",
        borderRadius: "8px",
        border: "1px solid #00000024",
        background: "#fff",
        boxSizing: "border-box",
        flexShrink: "0",
        fontSize: "12px",
        color: "#111",
    });
}

function actionButton(label: string, primary: boolean) {
    return button(txt(label)).style({
        padding: "6px 14px",
        minWidth: primary ? "76px" : "60px",
        borderRadius: "7px",
        border: primary ? "1px solid #0088dd" : "1px solid #00000020",
        background: primary ? "#00aaff" : "#fff",
        color: primary ? "#fff" : "#111",
        cursor: "pointer",
        fontSize: "12px",
        flexShrink: "0",
    });
}

function iconButton(icon: string, label: string, onClick: () => void) {
    const btn = button(iconEl(LINE_ICONS[icon], 17, true))
        .style({
            width: "28px",
            height: "28px",
            padding: "0",
            border: "none",
            borderRadius: "7px",
            background: "transparent",
            color: "#444",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: "0",
            transition: "background 0.12s ease",
        })
        .on("click", onClick);
    btn.on("pointerenter", () => {
        if (!btn.el.disabled) btn.style({ background: "#00000010" });
    });
    btn.on("pointerleave", () => btn.style({ background: "transparent" }));
    btn.el.setAttribute("aria-label", label);
    return btn;
}

function createToggle(get: () => boolean, set: (value: boolean) => void) {
    let value = get();
    const knob = view().style({
        width: "18px",
        height: "18px",
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 3px #00000044",
        transition: "all 0.15s ease",
    });
    const track = view("x")
        .style({
            width: "38px",
            height: "22px",
            padding: "2px",
            boxSizing: "border-box",
            borderRadius: "11px",
            cursor: "pointer",
            flexShrink: "0",
            transition: "background 0.15s ease",
        })
        .add(knob);

    function render() {
        track.style({
            background: value ? "#00aaff" : "#00000026",
            justifyContent: value ? "flex-end" : "flex-start",
        });
    }
    render();

    track.on("click", () => {
        value = !value;
        render();
        set(value);
    });
    return track;
}

export type FileChooserContentOptions = {
    request: FileChooserRequest;
    /** 关闭并回收当前选择器窗口；在 accept 成功后调用 */
    close(): void;
};

export type FileChooserContent = {
    el: ElType<HTMLElement>;
    dispose(): void;
};

export function createFileChooserContent(op: FileChooserContentOptions): FileChooserContent {
    const req = op.request;
    const mode = req.mode;
    let disposed = false;
    let loadToken = 0;

    let places: Place[] = [
        { id: "home", label: "主目录", path: myde.MSysApi.getEnv().HOME || "/", icon: "user-home" },
        { id: "root", label: "根目录", path: "/", icon: "drive-harddisk" },
    ];
    let currentPath =
        req.currentFolder ?? (req.currentFile ? parentPath(req.currentFile) : myde.MSysApi.getEnv().HOME || "~");
    let entries: NativeFsEntry[] = [];
    let visibleEntries: NativeFsEntry[] = [];
    let selection = new Set<string>();
    let cursorIndex = -1;
    const backStack: string[] = [];
    let lastClick: { path: string; time: number } | undefined;
    let showHidden = false;
    let loaded = false;
    let loading = true;
    let busy = false;
    let listError = "";
    let actionError = "";
    let filterIndex = req.filters.length > 0 ? 0 : -1;
    if (req.currentFilter) {
        const i = req.filters.findIndex((filter) => filter.name === req.currentFilter?.name);
        if (i >= 0) filterIndex = i;
    }

    const initialName = req.currentName || (req.currentFile ? baseName(req.currentFile) : (req.files[0] ?? ""));

    const el = view("y").style({
        flexGrow: "1",
        minHeight: "0",
        minWidth: "0",
    });

    // ── 左侧位置栏 ─────────────────────────────────────────────────────────────
    const placesEl = view("y").style({ gap: "2px" });
    const sidebar = view("y").style({
        width: "168px",
        padding: px(sSize2.padding),
        gap: "2px",
        borderRight: "1px solid #00000014",
        flexShrink: "0",
        boxSizing: "border-box",
        overflowY: "auto",
    });

    const hiddenToggle = createToggle(
        () => showHidden,
        (value) => {
            showHidden = value;
            void loadDirectory(currentPath);
        },
    );
    const hiddenRow = view("x")
        .style({
            alignItems: "center",
            gap: "8px",
            padding: `6px ${px(sSize2.padding)}`,
            marginTop: "auto",
            flexShrink: "0",
        })
        .add([hiddenToggle, txt("显示隐藏文件").style({ fontSize: "12px", opacity: "0.7" })]);

    sidebar.add([
        txt("位置").style({
            fontSize: "11px",
            opacity: "0.55",
            padding: `6px ${px(sSize2.padding)}`,
            flexShrink: "0",
        }),
        placesEl,
        hiddenRow,
    ]);

    // ── 顶部工具栏 ─────────────────────────────────────────────────────────────
    const backBtn = iconButton("back", "后退", () => void goBack());
    const upBtn = iconButton("up", "上一级", () => void navigate(parentPath(currentPath)));
    const refreshBtn = iconButton("refresh", "刷新", () => void loadDirectory(currentPath));
    const crumbs = view("x").style({
        flexGrow: "1",
        minWidth: "0",
        height: "30px",
        alignItems: "center",
        gap: "1px",
        overflowX: "auto",
        overflowY: "hidden",
        whiteSpace: "nowrap",
        scrollbarWidth: "none",
    });
    const toolbar = view("x")
        .style({
            height: "46px",
            padding: "0 10px",
            gap: "4px",
            alignItems: "center",
            flexShrink: "0",
            borderBottom: "1px solid #00000012",
            boxSizing: "border-box",
        })
        .add([backBtn, upBtn, refreshBtn, crumbs]);

    // ── 文件列表 ───────────────────────────────────────────────────────────────
    const GRID_COLUMNS = "minmax(0, 1fr) 92px 140px";
    const listHeader = view("x")
        .style({
            display: "grid",
            gridTemplateColumns: GRID_COLUMNS,
            gap: "8px",
            padding: "0 12px",
            height: "28px",
            alignItems: "center",
            flexShrink: "0",
            fontSize: "11px",
            opacity: "0.55",
        })
        .add([txt("名称"), txt("大小").style({ textAlign: "right" }), txt("修改时间").style({ textAlign: "right" })]);
    const listEl = view("y").style({
        flexGrow: "1",
        minHeight: "0",
        overflowY: "auto",
        padding: "0 8px 8px",
        gap: "2px",
    });

    // ── 底部操作区 ─────────────────────────────────────────────────────────────
    const footer = view("y").style({
        padding: "10px 12px",
        borderTop: "1px solid #00000012",
        gap: "8px",
        flexShrink: "0",
        boxSizing: "border-box",
    });

    let filenameInput: ElType<HTMLInputElement> | undefined;
    let filenameArea: ElType<HTMLTextAreaElement> | undefined;
    if (mode === "save") {
        filenameInput = fieldStyle(input("text").sv(initialName), "100%");
        filenameInput.style({ flexGrow: "1", flexShrink: "1", minWidth: "0", width: "auto" });
        filenameInput.on("input", () => {
            actionError = "";
            updateAcceptState();
        });
        footer.add(
            view("x")
                .style({ alignItems: "center", gap: "8px" })
                .add([
                    txt("文件名").style({
                        fontSize: "12px",
                        opacity: "0.65",
                        width: "48px",
                        flexShrink: "0",
                        whiteSpace: "nowrap",
                    }),
                    filenameInput,
                ]),
        );
    } else if (mode === "save-many") {
        filenameArea = textarea("每行一个文件名");
        filenameArea.sv(req.files.length > 0 ? req.files.join("\n") : initialName).style({
            width: "100%",
            height: "68px",
            padding: "7px 9px",
            borderRadius: "8px",
            border: "1px solid #00000024",
            background: "#fff",
            boxSizing: "border-box",
            resize: "none",
            fontSize: "12px",
            color: "#111",
            lineHeight: "1.45",
        });
        filenameArea.on("input", () => {
            actionError = "";
            updateAcceptState();
        });
        footer.add(
            view("y")
                .style({ gap: "4px" })
                .add([txt("文件名").style({ fontSize: "12px", opacity: "0.65" }), filenameArea]),
        );
    }

    const choiceValues: Record<string, string> = {};
    const choiceEls: ElType<HTMLElement>[] = [];
    for (const choice of req.choices) {
        choiceValues[choice.id] = initialChoiceValue(choice);
        const control =
            choice.options.length > 0
                ? (() => {
                      const sel = select(
                          choice.options.map((option) => ({
                              name: option.label || option.id,
                              value: option.id,
                          })),
                      ).sv(choiceValues[choice.id]);
                      sel.on("change", () => {
                          choiceValues[choice.id] = sel.gv;
                      });
                      return fieldStyle(sel, "150px");
                  })()
                : createToggle(
                      () => choiceValues[choice.id] === "true",
                      (value) => {
                          choiceValues[choice.id] = value ? "true" : "false";
                      },
                  );
        choiceEls.push(
            view("x")
                .style({ alignItems: "center", gap: "7px" })
                .add([txt(choice.label || choice.id).style({ fontSize: "12px", opacity: "0.7" }), control]),
        );
    }
    if (choiceEls.length > 0) {
        footer.add(view("x").style({ flexWrap: "wrap", gap: "8px 16px", alignItems: "center" }).add(choiceEls));
    }

    let filterSelect: ElType<HTMLSelectElement> | undefined;
    if (req.filters.length > 0 && !req.directory) {
        filterSelect = select(
            req.filters.map((filter, index) => ({
                name: filter.name || `过滤器 ${index + 1}`,
                value: String(index),
            })),
        ).sv(String(filterIndex));
        filterSelect.on("change", () => {
            filterIndex = Number(filterSelect?.gv ?? 0);
            renderList();
        });
    }

    const statusText = txt("").style({
        fontSize: "12px",
        opacity: "0.65",
        flexGrow: "1",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    });
    const cancelBtn = actionButton("取消", false).on("click", () => {
        void req.cancel();
        op.close();
    });
    const acceptBtn = actionButton(req.acceptLabel || defaultAcceptLabel(req), true).on("click", () => void submit());

    const actionRow = view("x")
        .style({ alignItems: "center", gap: "8px", minWidth: "0", flexWrap: "wrap" })
        .add([...(filterSelect ? [fieldStyle(filterSelect, "168px")] : []), statusText, cancelBtn, acceptBtn]);
    footer.add(actionRow);

    const main = view("y")
        .style({ flexGrow: "1", minWidth: "0", minHeight: "0" })
        .add([toolbar, listHeader, listEl, footer]);
    const body = view("x").style({ flexGrow: "1", minHeight: "0", minWidth: "0" }).add([sidebar, main]);
    el.add(body);

    // ── 数据加载 ───────────────────────────────────────────────────────────────
    function initialChoiceValue(choice: PortalChoice): string {
        if (choice.options.length === 0) return choice.initial === "true" ? "true" : "false";
        if (choice.options.some((option) => option.id === choice.initial)) return choice.initial;
        return choice.options[0]?.id ?? "";
    }

    function defaultAcceptLabel(request: FileChooserRequest): string {
        if (request.directory) return "选择文件夹";
        if (request.mode === "save" || request.mode === "save-many") return "保存";
        return "打开";
    }

    function selectedFilter(): PortalFilter | undefined {
        return filterIndex >= 0 ? req.filters[filterIndex] : undefined;
    }

    function selectedEntries(): NativeFsEntry[] {
        return entries.filter((entry) => selection.has(entry.path));
    }

    function selectedValidFiles(): NativeFsEntry[] {
        return selectedEntries().filter(isFile);
    }

    function filteredEntries(): NativeFsEntry[] {
        const filter = selectedFilter();
        return entries.filter((entry) => {
            if (req.directory && !isDir(entry)) return false;
            if (isDir(entry) || !filter) return true;
            return matchFilter(entry.name, entry.mime, filter);
        });
    }

    function homePath(): string {
        return places.find((place) => place.id === "home")?.path ?? myde.MSysApi.getEnv().HOME ?? "/";
    }

    function breadcrumbParts(): { label: string; path: string }[] {
        const parts = [{ label: "/", path: "/" }];
        const home = homePath();
        if (home && home !== "/" && (currentPath === home || currentPath.startsWith(`${home}/`))) {
            parts.push({ label: "主目录", path: home });
            let acc = home;
            for (const name of currentPath.slice(home.length).split("/").filter(Boolean)) {
                acc = acc === "/" ? `/${name}` : `${acc}/${name}`;
                parts.push({ label: name, path: acc });
            }
            return parts;
        }
        let acc = "/";
        for (const name of currentPath.split("/").filter(Boolean)) {
            acc = acc === "/" ? `/${name}` : `${acc}/${name}`;
            parts.push({ label: name, path: acc });
        }
        return parts;
    }

    async function fallbackPlaces(): Promise<Place[]> {
        const home = myde.MSysApi.getEnv().HOME || "/";
        const result: Place[] = [{ id: "home", label: "主目录", path: home, icon: "user-home" }];
        try {
            const listing = await myde.MSysApi.nativefs.list(home);
            for (const def of PLACE_FOLDERS) {
                const found = listing.entries.find(
                    (entry) =>
                        isDir(entry) && def.names.some((name) => entry.name.toLowerCase() === name.toLowerCase()),
                );
                if (found) result.push({ id: def.id, label: def.label, path: found.path, icon: def.icon });
            }
        } catch {
            // 主目录不可读时只保留主目录和根目录
        }
        result.push({ id: "root", label: "根目录", path: "/", icon: "drive-harddisk" });
        return result;
    }

    async function loadPlaces(): Promise<void> {
        let next: Place[] | undefined;
        const portal = myde.MSysApi.portal;
        if (portal) {
            try {
                const list = await portal.browse.places();
                if (list.length > 0) next = list.map((place) => ({ ...place }));
            } catch {
                // portal 不可用时退回主目录扫描
            }
        }
        next ??= await fallbackPlaces();
        if (disposed) return;
        places = next;
        renderPlaces();
        renderBreadcrumb();
    }

    function renderPlaces(): void {
        placesEl.clear();
        for (const place of places) {
            const active = samePath(place.path, currentPath);
            const item = view("x")
                .style({
                    padding: `7px ${px(sSize2.padding)}`,
                    borderRadius: px(sSize2.radius1),
                    cursor: "pointer",
                    alignItems: "center",
                    gap: "8px",
                    flexShrink: "0",
                    background: active ? "#ffffff" : "transparent",
                    fontWeight: active ? gTextStyle.weight.strong : gTextStyle.weight.regular,
                    transition: "background 0.12s ease",
                    userSelect: "none",
                })
                .add([placeIconEl(place.icon), aLineText().sv(PLACE_LABELS[place.id] ?? place.label)])
                .on("click", () => void navigate(place.path));
            item.on("pointerenter", () => {
                if (!samePath(place.path, currentPath)) item.style({ background: "#ffffff80" });
            });
            item.on("pointerleave", () => {
                if (!samePath(place.path, currentPath)) item.style({ background: "transparent" });
            });
            placesEl.add(item);
        }
    }

    function renderBreadcrumb(): void {
        crumbs.clear();
        const parts = breadcrumbParts();
        parts.forEach((part, index) => {
            if (index > 0) crumbs.add(txt("›").style({ opacity: "0.4", flexShrink: "0", fontSize: "12px" }));
            const last = index === parts.length - 1;
            const btn = view("x")
                .style({
                    padding: "4px 6px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    flexShrink: "0",
                    maxWidth: "180px",
                    fontWeight: last ? gTextStyle.weight.strong : gTextStyle.weight.regular,
                    transition: "background 0.12s ease",
                })
                .add(aLineText().sv(part.label))
                .on("click", () => void navigate(part.path));
            if (!last) {
                btn.on("pointerenter", () => btn.style({ background: "#0000000d" }));
                btn.on("pointerleave", () => btn.style({ background: "transparent" }));
            }
            crumbs.add(btn);
        });
        requestAnimationFrame(() => {
            crumbs.el.scrollLeft = crumbs.el.scrollWidth;
        });
    }

    function updateToolbar(): void {
        const canBack = backStack.length > 0;
        const canUp = currentPath !== "/";
        backBtn.attr({ disabled: !canBack });
        backBtn.style({ opacity: canBack ? "1" : "0.3", cursor: canBack ? "pointer" : "default" });
        upBtn.attr({ disabled: !canUp });
        upBtn.style({ opacity: canUp ? "1" : "0.3", cursor: canUp ? "pointer" : "default" });
    }

    function updateStatus(): void {
        if (busy) {
            statusText.style({ color: "#555", opacity: "1" }).sv("正在提交…");
        } else if (actionError) {
            statusText.style({ color: "#c33", opacity: "1" }).sv(actionError);
        } else if (listError) {
            statusText.style({ color: "#c33", opacity: "1" }).sv(listError);
        } else if (loading) {
            statusText.style({ color: "#555", opacity: "0.7" }).sv("正在读取…");
        } else {
            const base = `${visibleEntries.length} 项`;
            const showSelection = mode === "open";
            const count = req.directory ? selection.size : selectedValidFiles().length;
            const multiHint = req.multiple ? (req.directory ? " · 点击文件夹可多选" : " · 点击文件可多选") : "";
            if (showSelection && count > 0) {
                const hint = req.multiple ? (req.directory ? " · 点击文件夹继续多选" : " · 点击文件继续多选") : "";
                statusText.style({ color: "#666", opacity: "0.7" }).sv(`已选择 ${count} 项 · ${base}${hint}`);
            } else if (showSelection && selection.size > 0) {
                statusText.style({ color: "#666", opacity: "0.7" }).sv(`双击文件夹进入 · ${base}`);
            } else {
                statusText.style({ color: "#666", opacity: "0.7" }).sv(`${base}${multiHint}`);
            }
        }
    }

    function updateAcceptState(): void {
        const enabled = canSubmit();
        acceptBtn.attr({ disabled: !enabled });
        acceptBtn.style({ opacity: enabled ? "1" : "0.45", cursor: enabled ? "pointer" : "default" });
    }

    function canSubmit(): boolean {
        if (disposed || busy || loading || !loaded) return false;
        if (mode === "save") return !!filenameInput?.gv.trim();
        if (mode === "save-many") return !!filenameArea?.gv.trim();
        if (req.directory) return true;
        return selectedValidFiles().length > 0;
    }

    function selectionRowStyle(row: ElType<HTMLDivElement>, entry: NativeFsEntry): void {
        const selected = selection.has(entry.path);
        row.style({
            background: selected ? "rgba(0, 170, 255, 0.14)" : "#ffffff88",
            boxShadow: selected ? "inset 0 0 0 1px rgba(0, 136, 221, 0.55)" : "none",
        });
    }

    function updateSelection(): void {
        for (const entry of visibleEntries) {
            const row = rowEls.get(entry.path);
            if (row) selectionRowStyle(row, entry);
        }
        updateStatus();
        updateAcceptState();
    }

    function renderList(): void {
        rowEls.clear();
        listEl.clear();
        visibleEntries = filteredEntries();

        if (loading) {
            listEl.add(centerMessage("正在读取…"));
            updateStatus();
            updateAcceptState();
            return;
        }
        if (listError && entries.length === 0) {
            listEl.add(
                view("y")
                    .style({ padding: "40px 0", gap: "8px", alignItems: "center" })
                    .add([
                        txt(listError).style({
                            fontSize: "12px",
                            color: "#c33",
                            maxWidth: "420px",
                            textAlign: "center",
                        }),
                        actionButton("重试", false).on("click", () => void loadDirectory(currentPath)),
                    ]),
            );
            updateStatus();
            updateAcceptState();
            return;
        }
        if (visibleEntries.length === 0) {
            listEl.add(centerMessage(entries.length === 0 ? "此文件夹为空" : "没有匹配的文件"));
            updateStatus();
            updateAcceptState();
            return;
        }

        const shown = visibleEntries.slice(0, MAX_RENDERED_ROWS);
        for (const entry of shown) {
            listEl.add(createRow(entry));
        }
        if (visibleEntries.length > MAX_RENDERED_ROWS) {
            listEl.add(
                txt(`目录项较多，仅显示前 ${MAX_RENDERED_ROWS} 项`).style({
                    fontSize: "11px",
                    opacity: "0.55",
                    padding: "8px 12px",
                    textAlign: "center",
                }),
            );
        }
        updateSelection();
    }

    const rowEls = new Map<string, ElType<HTMLDivElement>>();

    function createRow(entry: NativeFsEntry): ElType<HTMLDivElement> {
        const sizeText = isDir(entry) ? "" : formatSize(entry.size);
        const name = view("x")
            .style({ alignItems: "center", gap: "8px", minWidth: "0" })
            .add([
                entryIconEl(entry),
                txt(entry.name).style({
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: "13px",
                }),
                ...(entry.kind === "symlink"
                    ? [txt("链接").style({ fontSize: "10px", opacity: "0.45", flexShrink: "0" })]
                    : []),
            ]);
        const row = view("x")
            .data({ "entry-path": entry.path })
            .style({
                display: "grid",
                gridTemplateColumns: GRID_COLUMNS,
                gap: "8px",
                alignItems: "center",
                padding: "6px 10px",
                minHeight: "34px",
                borderRadius: px(sSize2.radius1),
                boxSizing: "border-box",
                cursor: "default",
                transition: "background 0.1s ease",
                userSelect: "none",
                ...gGlassStyle.itemInBg,
            })
            .add([
                name,
                txt(sizeText).style({
                    fontSize: "12px",
                    opacity: "0.6",
                    textAlign: "right",
                    whiteSpace: "nowrap",
                    fontVariantNumeric: "tabular-nums",
                }),
                txt(formatTime(entry.mtime)).style({
                    fontSize: "12px",
                    opacity: "0.6",
                    textAlign: "right",
                    whiteSpace: "nowrap",
                    fontVariantNumeric: "tabular-nums",
                }),
            ]);
        rowEls.set(entry.path, row);
        selectionRowStyle(row, entry);

        row.on("click", () => selectRow(entry));
        row.on("pointerenter", () => {
            if (!selection.has(entry.path)) row.style({ background: "#ffffffdd" });
        });
        row.on("pointerleave", () => {
            if (!selection.has(entry.path)) row.style({ background: "#ffffff88" });
        });
        return row;
    }

    function centerMessage(message: string) {
        return view("x")
            .style({ padding: "40px 0", justifyContent: "center", opacity: "0.55", fontSize: "12px" })
            .add(txt(message));
    }

    function selectRow(entry: NativeFsEntry): void {
        const now = performance.now();
        const doubleClick = lastClick?.path === entry.path && now - lastClick.time < 450;
        if (doubleClick) {
            lastClick = undefined;
            openRow(entry);
            return;
        }
        lastClick = { path: entry.path, time: now };
        cursorIndex = visibleEntries.indexOf(entry);
        // 合成 click 不带 Ctrl/Meta 状态（evdev 桌面输入），多选直接按点击切换选中
        if (req.multiple) {
            if (selection.has(entry.path)) selection.delete(entry.path);
            else selection.add(entry.path);
        } else {
            selection.clear();
            selection.add(entry.path);
        }
        if (mode === "save" && !isDir(entry)) {
            filenameInput?.sv(entry.name);
        }
        actionError = "";
        updateSelection();
        el.el.focus({ preventScroll: true });
    }

    function openRow(entry: NativeFsEntry): void {
        if (isDir(entry)) {
            void navigate(entry.path);
            return;
        }
        if (mode === "save") {
            filenameInput?.sv(entry.name);
            actionError = "";
            updateAcceptState();
            return;
        }
        if (mode === "save-many") return;
        if (req.multiple) {
            // 双击打开当前文件；多选请点击多个文件后按确认按钮
            selection = new Set([entry.path]);
        } else if (!selection.has(entry.path)) {
            selection.clear();
            selection.add(entry.path);
        }
        updateSelection();
        void submit();
    }

    async function loadDirectory(target: string): Promise<boolean> {
        const token = ++loadToken;
        loading = true;
        listError = "";
        actionError = "";
        updateToolbar();
        renderList();
        try {
            const listing = await myde.MSysApi.nativefs.list(target, { showHidden });
            if (disposed || token !== loadToken) return false;
            currentPath = listing.path;
            entries = listing.entries;
            selection = new Set();
            cursorIndex = -1;
            lastClick = undefined;
            loaded = true;
            loading = false;
            listError = "";
            listEl.el.scrollTop = 0;
            renderBreadcrumb();
            renderPlaces();
            updateToolbar();
            renderList();
            return true;
        } catch (error) {
            if (disposed || token !== loadToken) return false;
            loading = false;
            listError = errorText(error);
            renderList();
            return false;
        }
    }

    async function navigate(target: string): Promise<void> {
        if (samePath(target, currentPath)) return;
        const previous = currentPath;
        const ok = await loadDirectory(target);
        if (ok && previous) {
            backStack.push(previous);
            updateToolbar();
        }
    }

    async function goBack(): Promise<void> {
        const target = backStack.pop();
        if (!target) return;
        await loadDirectory(target);
        updateToolbar();
    }

    function collectChoiceValues(): Record<string, string> | undefined {
        return req.choices.length > 0 ? { ...choiceValues } : undefined;
    }

    function showActionError(message: string): void {
        actionError = message;
        updateStatus();
    }

    async function submit(): Promise<void> {
        if (!canSubmit()) return;
        actionError = "";
        busy = true;
        updateStatus();
        updateAcceptState();

        let paths: string[] = [];
        if (mode === "save") {
            const name = filenameInput?.gv.trim() ?? "";
            if (!name) {
                busy = false;
                showActionError("请输入文件名");
                return;
            }
            paths = [joinPath(currentPath, name)];
        } else if (mode === "save-many") {
            const names = (filenameArea?.gv ?? "")
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
            if (names.length === 0) {
                busy = false;
                showActionError("请输入至少一个文件名");
                return;
            }
            paths = names.map((name) => joinPath(currentPath, name));
        } else if (req.directory) {
            const dirs = selectedEntries()
                .filter(isDir)
                .map((entry) => entry.path);
            paths = dirs.length > 0 ? dirs : [currentPath];
        } else {
            const files = selectedValidFiles().map((entry) => entry.path);
            if (files.length === 0) {
                busy = false;
                showActionError("请选择文件");
                return;
            }
            paths = req.multiple ? files : files.slice(0, 1);
        }

        try {
            const result = await req.accept({
                paths,
                choices: collectChoiceValues(),
                currentFilter: selectedFilter(),
            });
            if (disposed) return;
            if (result.ok) {
                op.close();
                return;
            }
            busy = false;
            showActionError(result.error);
        } catch (error) {
            if (disposed) return;
            busy = false;
            showActionError(errorText(error));
        }
        updateAcceptState();
    }

    function moveCursor(delta: number): void {
        if (visibleEntries.length === 0) return;
        cursorIndex = Math.max(0, Math.min(visibleEntries.length - 1, cursorIndex + delta));
        const entry = visibleEntries[cursorIndex];
        if (!entry) return;
        selection = new Set();
        if (req.directory || isFile(entry)) selection.add(entry.path);
        if (mode === "save" && isFile(entry)) filenameInput?.sv(entry.name);
        actionError = "";
        updateSelection();
        rowEls.get(entry.path)?.el.scrollIntoView({ block: "nearest" });
    }

    function onKeyDown(event: KeyboardEvent): void {
        if (event.isComposing) return;
        const target = event.target as HTMLElement | null;
        const inField = !!target?.closest("input, textarea, select");
        const filenameFocused = mode === "save" && !!filenameInput && filenameInput.el === target;
        if (event.key === "Escape") {
            event.preventDefault();
            void req.cancel();
            op.close();
            return;
        }
        if (event.key === "Enter" && (filenameFocused || !inField)) {
            event.preventDefault();
            if (filenameFocused) {
                void submit();
                return;
            }
            const entry = visibleEntries[cursorIndex];
            if (entry) openRow(entry);
            else void submit();
            return;
        }
        if (inField) return;
        if (event.key === "ArrowDown") {
            event.preventDefault();
            moveCursor(1);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveCursor(-1);
        } else if (event.key === "Backspace") {
            event.preventDefault();
            void navigate(parentPath(currentPath));
        }
    }

    el.el.tabIndex = 0;
    el.el.style.outline = "none";
    el.el.addEventListener("keydown", onKeyDown);
    const unsubscribeCancel = req.onCancel(() => {
        if (disposed) return;
        // 排队期间就被取消的请求会在订阅时同步回调；延后一帧，等窗口注册完成再关闭
        queueMicrotask(() => {
            if (!disposed) op.close();
        });
    });

    renderPlaces();
    renderBreadcrumb();
    updateToolbar();
    updateAcceptState();
    renderList();
    void loadPlaces();
    void loadDirectory(currentPath);
    queueMicrotask(() => {
        if (!disposed) el.el.focus({ preventScroll: true });
    });

    return {
        el,
        dispose: () => {
            disposed = true;
            unsubscribeCancel();
            el.el.removeEventListener("keydown", onKeyDown);
        },
    };
}

export function fileChooserTitle(request: FileChooserRequest): string {
    if (request.title) return request.title;
    if (request.directory) return "选择文件夹";
    if (request.mode === "save") return "保存文件";
    if (request.mode === "save-many") return "保存多个文件";
    return request.multiple ? "打开多个文件" : "打开文件";
}

export function fileChooserHeaderIcon(request: FileChooserRequest): HTMLElement {
    return iconEl(request.directory ? FOLDER_ICON : FILE_ICONS.file, 18);
}
