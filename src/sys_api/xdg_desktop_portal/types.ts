import type { ScreenshotImage } from "../screenshot";

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
    readonly title: string;
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
    "screenshot.request": [request: ScreenshotRequest];
    "screenshot.pickColor": [request: PickColorRequest];
    "access.request": [request: AccessRequest];
};

/** 截屏目标，对应 portal 的 target 位 */
export type ScreenshotTarget = "screen" | "window" | "area" | "active-window";

export interface ScreenshotAcceptOptions {
    /** 保存目录，缺省是 `<Pictures>/Screenshots` */
    directory?: string;
    /** 文件名（含或不含 .png），缺省按时间生成 */
    name?: string;
}

export type ScreenshotAcceptResult = { ok: true; uri: string; path: string } | { ok: false; error: string };

export interface ScreenshotRequest extends PortalRequest {
    /** 应用希望先在截图前提供裁剪/选择窗口等交互 */
    readonly interactive: boolean;
    readonly target: ScreenshotTarget;
    /** 前端已经查过 screenshot 权限 */
    readonly permissionStoreChecked: boolean;
    /**
     * 提交截屏。后端负责把 PNG 写到图片目录并转成 file:// URI。
     * 桌面可以用 `MSysApi.screenshot.capture()` 得到图像。
     */
    accept(image: ScreenshotImage, options?: ScreenshotAcceptOptions): Promise<ScreenshotAcceptResult>;
}

export interface PickColorRequest extends PortalRequest {
    /** color 是 sRGB，三个分量都在 0..1 */
    accept(color: [number, number, number]): Promise<PortalAcceptResult>;
}

export interface AccessRequest extends PortalRequest {
    readonly title: string;
    readonly subtitle: string;
    readonly body: string;
    readonly denyLabel: string;
    readonly grantLabel: string;
    readonly icon: string;
    readonly choices: PortalChoice[];
    /** 用户允许：response=0 */
    accept(choices?: Record<string, string>): Promise<PortalAcceptResult>;
    /** 用户拒绝：response=1 */
    deny(): Promise<void>;
}

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
