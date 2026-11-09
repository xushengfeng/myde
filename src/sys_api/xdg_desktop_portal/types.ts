export type PortalFilterRule = { kind: "glob" | "mime"; pattern: string };

export interface PortalFilter {
    name: string;
    rules: PortalFilterRule[];
}

export interface PortalChoiceOption {
    id: string;
    label: string;
}

export interface PortalChoice {
    id: string;
    label: string;
    /** 空数组表示布尔选择（true/false） */
    options: PortalChoiceOption[];
    initial: string;
}

export type FileChooserMode = "open" | "save" | "save-many";

export interface PortalRequest {
    /** 与 portal 后端收到的 request object path 相同 */
    readonly id: string;
    readonly appId: string;
    /** 原样保留 wayland:<token> / x11:<id>；当前没有 xdg-foreign，暂不解析 */
    readonly parentWindow: string;
    readonly title: string;
    readonly modal: boolean;
    /** 用户取消：response=1 */
    cancel(): Promise<void>;
    /** 内部失败：response=2 */
    fail(message?: string): Promise<void>;
    /** 应用调用 org.freedesktop.impl.portal.Request.Close 时触发 */
    onCancel(handler: () => void): () => void;
}

export interface FileChooserSelection {
    /** 绝对路径，由 portal 后端转成 file:// URI */
    paths: string[];
    choices?: Record<string, string>;
    currentFilter?: PortalFilter;
}

export type PortalAcceptResult = { ok: true } | { ok: false; error: string };

export interface FileChooserRequest extends PortalRequest {
    readonly mode: FileChooserMode;
    readonly acceptLabel: string;
    readonly multiple: boolean;
    readonly directory: boolean;
    readonly filters: PortalFilter[];
    readonly currentFilter?: PortalFilter;
    readonly choices: PortalChoice[];
    readonly currentFolder?: string;
    readonly currentName: string;
    readonly currentFile?: string;
    /** SaveFiles 的文件名列表（不含目录） */
    readonly files: string[];
    accept(selection: FileChooserSelection): Promise<PortalAcceptResult>;
}

export type XdgPortalEvents = {
    "fileChooser.request": [request: FileChooserRequest];
};

export type PortalFileKind = "file" | "directory" | "symlink" | "other";

export interface PortalDirEntry {
    name: string;
    path: string;
    kind: PortalFileKind;
    targetKind?: PortalFileKind;
    size: number;
    mtime: number;
    hidden: boolean;
    mime: string;
}

export interface PortalStat {
    path: string;
    kind: PortalFileKind;
    targetKind?: PortalFileKind;
    size: number;
    mtime: number;
}

export interface PortalPlace {
    id: string;
    label: string;
    path: string;
    icon: string;
}
