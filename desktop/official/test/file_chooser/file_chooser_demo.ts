import { button, initDKH, input, select, txt, view } from "dkh-ui";
import type {
    FileChooserMode,
    FileChooserRequest,
    FileChooserSelection,
    NativeFsEntry,
    PortalAcceptResult,
    PortalChoice,
    PortalFilter,
} from "../../../../src/desktop-api";
import {
    createFileChooserContent,
    type FileChooserContent,
    fileChooserHeaderIcon,
    fileChooserTitle,
} from "../../src/file_chooser";

type DemoMode = "open" | "directory" | "save" | "save-many";

type DoneCallback = (message: string, detail?: unknown) => void;

// ── 文件树 mock ────────────────────────────────────────────────────────────────
// 页面只依赖 nativefs.list 和 portal.browse.places，这里给 file_chooser 提供和真实的
// 系统 API 同形的数据，浏览器里就能调试路径、筛选、多选和保存模式。
type MockNode = {
    name: string;
    kind: "directory" | "file" | "symlink";
    targetKind?: "directory" | "file";
    size?: number;
    mime?: string;
    mtime?: number;
};

const HOME = "/home/demo";
const BASE_TIME = Date.parse("2026-11-12T14:30:00");

function mtime(offsetMinutes: number): number {
    return BASE_TIME - offsetMinutes * 60_000;
}

function d(name: string, offsetMinutes = 0): MockNode {
    return { name, kind: "directory", mtime: mtime(offsetMinutes) };
}

function f(name: string, size: number, offsetMinutes = 0, mime?: string): MockNode {
    return { name, kind: "file", size, mtime: mtime(offsetMinutes), mime };
}

function link(name: string, targetKind: "directory" | "file", offsetMinutes = 0): MockNode {
    return { name, kind: "symlink", targetKind, mtime: mtime(offsetMinutes) };
}

const TREE: Record<string, MockNode[]> = {
    "/": [d("etc", 4000), d("home", 3000), d("tmp", 2000), d("usr", 1000)],
    "/home": [d("demo")],
    "/home/demo": [
        d("Desktop", 5),
        d("Documents", 15),
        d("Downloads", 25),
        d("Music", 35),
        d("Pictures", 45),
        d("Videos", 55),
        d("Projects", 65),
        d(".config", 75),
        f(".bashrc", 3800, 85),
        f(".secret.txt", 120, 95),
        f("readme.md", 6400, 105),
        link("docs-link", "directory", 115),
    ],
    "/home/demo/Desktop": [f("todo.txt", 480, 10), link("documents", "directory", 20)],
    "/home/demo/Documents": [
        d("旧版本", 200),
        f("报告.txt", 24_800, 30),
        f("notes.md", 3_600, 40),
        f("合同.pdf", 184_000, 50),
        f("archive.zip", 2_500_000, 60),
    ],
    "/home/demo/Documents/旧版本": [f("草稿.txt", 1_200, 300)],
    "/home/demo/Downloads": [
        f("data.tar.gz", 8_200_000, 70),
        f("image.webp", 512_000, 80),
        f("package.deb", 4_100_000, 90),
    ],
    "/home/demo/Music": [f("song.mp3", 5_400_000, 100), f("track.flac", 31_000_000, 110)],
    "/home/demo/Pictures": [f("cat.jpg", 2_200_000, 120), f("logo.svg", 8_400, 130), f("shot.png", 430_000, 140)],
    "/home/demo/Videos": [f("demo.mp4", 84_000_000, 150)],
    "/home/demo/Projects": [d("myde", 160), f("notes.md", 2_200, 170)],
    "/home/demo/Projects/myde": [
        f("main.ts", 12_000, 180),
        f("readme.md", 5_600, 190),
        f("screenshot.png", 820_000, 200),
    ],
    "/home/demo/.config": [f("settings.json", 1_200, 210)],
    "/etc": [f("hosts", 220, 220), f("passwd", 3_100, 230), d("xdg", 240)],
    "/etc/xdg": [d("myde", 310), f("user-dirs.dirs", 900, 320)],
    "/tmp": [f("myde-portal-test-selected.txt", 24, 250)],
    "/usr": [d("bin", 260), d("lib", 270), d("share", 280)],
    "/usr/bin": [],
    "/usr/lib": [],
    "/usr/share": [],
};
// 点进符号链接时和链接目标显示同一批条目，但路径仍按链接路径拼接
TREE["/home/demo/docs-link"] = [f("guide.md", 4_200, 330), f("manual.pdf", 1_800_000, 340)];
TREE["/home/demo/Desktop/documents"] = TREE["/home/demo/docs-link"];

const MIME_TYPES: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    pdf: "application/pdf",
    zip: "application/zip",
    gz: "application/gzip",
    deb: "application/vnd.debian.binary-package",
    webp: "image/webp",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    flac: "audio/flac",
    mp4: "video/mp4",
    ts: "application/typescript",
    json: "application/json",
};

function mimeOf(name: string, kind: "directory" | "file" | "symlink", targetKind?: "directory" | "file"): string {
    if ((kind === "symlink" ? targetKind : kind) === "directory") return "inode/directory";
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    return MIME_TYPES[ext] ?? "application/octet-stream";
}

function normalizePath(input?: string): string {
    let path = input?.trim() || "~";
    if (path === "~") path = HOME;
    else if (path.startsWith("~/")) path = `${HOME}/${path.slice(2)}`;
    if (!path.startsWith("/")) throw new Error(`需要绝对路径: ${path}`);
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class MockNativeFs {
    async list(dirPath?: string, opts?: { showHidden?: boolean }): Promise<{ path: string; entries: NativeFsEntry[] }> {
        const dir = normalizePath(dirPath);
        const nodes = TREE[dir];
        await delay(80);
        if (!nodes) throw new Error(`没有这个目录: ${dir}`);
        const showHidden = opts?.showHidden ?? false;
        const entries: NativeFsEntry[] = nodes
            .filter((node) => showHidden || !node.name.startsWith("."))
            .map((node) => ({
                name: node.name,
                path: dir === "/" ? `/${node.name}` : `${dir}/${node.name}`,
                kind: node.kind,
                targetKind: node.targetKind,
                size: node.kind === "directory" ? 0 : (node.size ?? 0),
                mtime: node.mtime ?? BASE_TIME,
                hidden: node.name.startsWith("."),
                mime: node.mime ?? mimeOf(node.name, node.kind, node.targetKind),
            }));
        entries.sort((a, b) => {
            const aDir = a.kind === "directory" || a.targetKind === "directory";
            const bDir = b.kind === "directory" || b.targetKind === "directory";
            if (aDir !== bDir) return aDir ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
        });
        return { path: dir, entries };
    }
}

(globalThis as unknown as { myde: unknown }).myde = {
    MSysApi: {
        nativefs: new MockNativeFs(),
        getEnv: () => ({ HOME, USER: "demo" }),
        portal: {
            browse: {
                places: async () => [
                    { id: "home", label: "Home", path: HOME, icon: "user-home" },
                    { id: "desktop", label: "Desktop", path: `${HOME}/Desktop`, icon: "user-desktop" },
                    { id: "documents", label: "Documents", path: `${HOME}/Documents`, icon: "folder-documents" },
                    { id: "downloads", label: "Downloads", path: `${HOME}/Downloads`, icon: "folder-download" },
                    { id: "music", label: "Music", path: `${HOME}/Music`, icon: "folder-music" },
                    { id: "pictures", label: "Pictures", path: `${HOME}/Pictures`, icon: "folder-pictures" },
                    { id: "videos", label: "Videos", path: `${HOME}/Videos`, icon: "folder-videos" },
                    { id: "root", label: "Root", path: "/", icon: "drive-harddisk" },
                ],
            },
        },
    },
};

// ── 假 FileChooserRequest ─────────────────────────────────────────────────────
class DemoRequest implements FileChooserRequest {
    readonly id = `demo-${Date.now()}`;
    readonly appId = "org.myde.FileChooserDemo";
    readonly parentWindow = "";
    readonly title = "";
    readonly modal = true;
    readonly acceptLabel = "";
    readonly mode: FileChooserMode;
    readonly multiple: boolean;
    readonly directory: boolean;
    readonly filters: PortalFilter[];
    readonly currentFilter?: PortalFilter;
    readonly choices: PortalChoice[];
    readonly currentFolder?: string;
    readonly currentName: string;
    readonly currentFile?: string;
    readonly files: string[];

    private readonly onDone: DoneCallback;
    private readonly cancelHandlers = new Set<() => void>();
    private closed = false;

    constructor(op: { mode: DemoMode; multiple: boolean; folder: string; extras: boolean }, onDone: DoneCallback) {
        this.mode = op.mode === "directory" ? "open" : op.mode;
        this.directory = op.mode === "directory";
        this.multiple = op.mode === "open" || op.mode === "directory" ? op.multiple : false;
        this.currentFolder = op.folder || undefined;
        this.onDone = onDone;

        this.filters =
            op.extras && op.mode !== "directory"
                ? [
                      { name: "全部", rules: [{ kind: "glob", pattern: "*" }] },
                      {
                          name: "文本",
                          rules: [
                              { kind: "glob", pattern: "*.txt" },
                              { kind: "glob", pattern: "*.md" },
                          ],
                      },
                      { name: "图片", rules: [{ kind: "mime", pattern: "image/*" }] },
                  ]
                : [];

        this.choices = op.extras
            ? [
                  {
                      id: "encoding",
                      label: "编码",
                      options: [
                          { id: "utf8", label: "UTF-8" },
                          { id: "latin1", label: "Latin-1" },
                      ],
                      initial: "utf8",
                  },
                  { id: "backup", label: "备份原文件", options: [], initial: "false" },
              ]
            : [];

        this.currentName = this.mode === "save" ? "未命名.txt" : "";
        this.files = this.mode === "save-many" ? ["未命名.txt", "副本.txt"] : [];
    }

    async accept(selection: FileChooserSelection): Promise<PortalAcceptResult> {
        if (this.closed) return { ok: false, error: "请求已结束" };
        this.closed = true;
        console.log("[file-chooser demo] accept", selection);
        this.onDone(`接受 ${selection.paths.length} 个路径`, {
            paths: selection.paths,
            choices: selection.choices,
            currentFilter: selection.currentFilter,
        });
        return { ok: true };
    }

    async cancel(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        console.log("[file-chooser demo] cancel");
        this.onDone("用户取消");
    }

    async fail(message?: string): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.onDone(`请求失败：${message ?? ""}`);
    }

    onCancel(handler: () => void): () => void {
        if (this.closed) {
            handler();
            return () => {};
        }
        this.cancelHandlers.add(handler);
        return () => {
            this.cancelHandlers.delete(handler);
        };
    }

    closeFromFrontend(): void {
        if (this.closed) return;
        this.closed = true;
        this.onDone("应用调用了 Request.Close");
        const handlers = [...this.cancelHandlers];
        this.cancelHandlers.clear();
        for (const handler of handlers) handler();
    }
}

// ── 页面 ──────────────────────────────────────────────────────────────────────
initDKH({ pureStyle: true });

const style = document.createElement("style");
style.textContent = `
    html, body { height: 100%; }
    body {
        margin: 0;
        background: #dfe6ee;
        font-family: system-ui, sans-serif;
        color: #111;
        overflow: auto;
    }
    * { box-sizing: border-box; }
`;
document.head.appendChild(style);

const modeSelect = select<DemoMode>([
    { name: "打开文件", value: "open" },
    { name: "选择文件夹", value: "directory" },
    { name: "保存文件", value: "save" },
    { name: "保存多个文件", value: "save-many" },
]).sv("open");
const multipleCheckbox = input("checkbox").attr({ checked: true });
const extrasCheckbox = input("checkbox").attr({ checked: true });
const folderInput = input("text").sv(HOME).style({
    width: "360px",
    height: "30px",
    padding: "0 9px",
    borderRadius: "8px",
    border: "1px solid #00000024",
    background: "#fff",
    boxSizing: "border-box",
    fontSize: "12px",
});
const openButton = button(txt("重新打开")).style({
    padding: "6px 14px",
    borderRadius: "7px",
    border: "1px solid #0088dd",
    background: "#00aaff",
    color: "#fff",
    cursor: "pointer",
    fontSize: "12px",
});
const closeFromFrontendButton = button(txt("模拟 Request.Close")).style({
    padding: "6px 12px",
    borderRadius: "7px",
    border: "1px solid #00000020",
    background: "#fff",
    cursor: "pointer",
    fontSize: "12px",
});

function control(label: string, el: { el: HTMLElement }) {
    return view("x")
        .style({ alignItems: "center", gap: "7px", fontSize: "12px" })
        .add([txt(label).style({ opacity: "0.7" }), el]);
}

const toolbar = view("x")
    .data({ test: "toolbar" })
    .style({
        width: "100%",
        maxWidth: "880px",
        gap: "16px",
        alignItems: "center",
        flexWrap: "wrap",
        padding: "10px 12px",
        borderRadius: "12px",
        background: "#ffffffaa",
    })
    .add([
        control("模式", modeSelect),
        view("x")
            .style({ alignItems: "center", gap: "6px", fontSize: "12px" })
            .add([multipleCheckbox, txt("多选")]),
        view("x")
            .style({ alignItems: "center", gap: "6px", fontSize: "12px" })
            .add([extrasCheckbox, txt("filters / choices")]),
        control("起始目录", folderInput),
        openButton,
        closeFromFrontendButton,
    ]);

const resultText = txt("等待操作").style({
    width: "100%",
    maxWidth: "880px",
    minHeight: "44px",
    padding: "8px 10px",
    borderRadius: "8px",
    background: "#ffffff88",
    fontFamily: "monospace",
    fontSize: "11px",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    color: "#333",
});

const titleText = txt("打开文件").style({
    fontWeight: "600",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
});
const headerIconHost = view("x").style({ width: "20px", height: "20px", flexShrink: "0" });
const header = view("x")
    .style({
        height: "48px",
        alignItems: "center",
        gap: "10px",
        padding: "0 46px 0 16px",
        flexShrink: "0",
        borderBottom: "1px solid #00000012",
        boxSizing: "border-box",
    })
    .add([headerIconHost, titleText]);

const contentHost = view("y").style({ flexGrow: "1", minHeight: "0", position: "relative" });
const closeButton = button(txt("×")).style({
    position: "absolute",
    top: "12px",
    right: "12px",
    zIndex: "20",
    width: "24px",
    height: "24px",
    padding: "0",
    border: "none",
    borderRadius: "50%",
    background: "rgba(255, 255, 255, 0.92)",
    boxShadow: "0 1px 4px #00000055",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "16px",
    lineHeight: "1",
});
const shell = view("y").data({ test: "shell" }).style({
    position: "relative",
    width: "100%",
    maxWidth: "880px",
    height: "600px",
    flexShrink: "0",
    borderRadius: "18px",
    background: "rgba(245, 245, 245, 0.97)",
    boxShadow: "0 12px 40px #00000033",
    overflow: "hidden",
});
shell.add([header, contentHost, closeButton]);

const page = view("y").data({ test: "page" }).style({
    width: "100%",
    padding: "16px",
    gap: "12px",
    alignItems: "center",
    minHeight: "100%",
    boxSizing: "border-box",
});
page.add([toolbar, shell, resultText]);
page.addInto(document.body);

function setResult(message: string, detail?: unknown): void {
    resultText.sv(detail === undefined ? message : `${message}\n${JSON.stringify(detail, null, 2)}`);
}

let content: FileChooserContent | undefined;
let request: DemoRequest | undefined;
let closed = true;

function showClosedPlaceholder(): void {
    contentHost.clear().add(
        view("x")
            .style({
                flexGrow: "1",
                alignItems: "center",
                justifyContent: "center",
                opacity: "0.55",
                fontSize: "13px",
            })
            .add(txt("对话框已结束，点击「重新打开」继续测试。")),
    );
}

function closeCurrent(message: string, detail?: unknown): void {
    if (closed) return;
    closed = true;
    content?.dispose();
    content = undefined;
    request = undefined;
    showClosedPlaceholder();
    setResult(message, detail);
}

function mount(): void {
    content?.dispose();
    content = undefined;
    closed = false;

    request = new DemoRequest(
        {
            mode: modeSelect.gv as DemoMode,
            multiple: multipleCheckbox.el.checked,
            folder: folderInput.gv.trim(),
            extras: extrasCheckbox.el.checked,
        },
        closeCurrent,
    );

    const created = createFileChooserContent({
        request,
        close: () => closeCurrent("窗口已关闭"),
    });
    content = created;

    contentHost.clear().add(created.el);
    titleText.sv(fileChooserTitle(request));
    headerIconHost.clear().add(fileChooserHeaderIcon(request));
    setResult(`${fileChooserTitle(request)}：等待操作`);
}

openButton.on("click", mount);
closeFromFrontendButton.on("click", () => request?.closeFromFrontend());
closeButton.on("click", () => void request?.cancel());

mount();
