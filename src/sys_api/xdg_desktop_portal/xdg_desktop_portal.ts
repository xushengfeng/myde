import { type dbusIO, dbusServer } from "myde-dbus";
import { EventEmitter } from "../../event-emitter/event-emitter";
import { portalFileBrowser } from "./browse";
import { FileChooserRequestImpl, type PortalBackendResult, parseFileChooserOptions } from "./file_chooser";
import type { FileChooserMode, XdgPortalEvents } from "./types";

export const DEFAULT_PORTAL_BUS_NAME = "org.freedesktop.impl.portal.desktop.myde";
export const DEFAULT_PORTAL_OBJECT_PATH = "/org/freedesktop/portal/desktop";

type WireVar = { signature: string; value: unknown[] };
type WireDict = [string, WireVar][];

/**
 * MyDE 的 xdg-desktop-portal 后端。
 *
 * 前端（系统 xdg-desktop-portal）负责 sender 校验、request path、Documents portal
 * 和沙箱文件授权；这里只实现 org.freedesktop.impl.portal.FileChooser，并把交互
 * 通过 `fileChooser.request` 交给桌面实现。
 */
export class xdgDesktopPortal extends EventEmitter<XdgPortalEvents> {
    private readonly dbus: dbusIO;
    private readonly dbusServer: dbusServer;
    private readonly objectPath: string;
    private readonly requests = new Map<string, FileChooserRequestImpl>();
    private destroyed = false;
    readonly browse: portalFileBrowser;

    constructor(dbus: dbusIO, opts?: { busName?: string; objectPath?: string }) {
        super();
        this.dbus = dbus;
        this.objectPath = opts?.objectPath ?? DEFAULT_PORTAL_OBJECT_PATH;
        this.dbusServer = new dbusServer(dbus, opts?.busName ?? DEFAULT_PORTAL_BUS_NAME);
        this.browse = new portalFileBrowser();
    }

    async init(): Promise<void> {
        await this.dbus.connect();
        await this.dbusServer.init();
        this.dbusServer.addObject(this.objectPath, "org.freedesktop.impl.portal.FileChooser", {
            OpenFile: (handle: string, appId: string, parentWindow: string, title: string, options: WireDict) =>
                this.openFile("open", handle, appId, parentWindow, title, options),
            SaveFile: (handle: string, appId: string, parentWindow: string, title: string, options: WireDict) =>
                this.openFile("save", handle, appId, parentWindow, title, options),
            SaveFiles: (handle: string, appId: string, parentWindow: string, title: string, options: WireDict) =>
                this.openFile("save-many", handle, appId, parentWindow, title, options),
        });
    }

    async destroy(): Promise<void> {
        this.destroyed = true;
        for (const request of [...this.requests.values()]) {
            await request.fail("portal destroyed");
            this.requests.delete(request.id);
            this.dbusServer.removeObject(request.id, "org.freedesktop.impl.portal.Request");
        }
    }

    private async openFile(
        mode: FileChooserMode,
        handle: string,
        appId: string,
        parentWindow: string,
        title: string,
        options: WireDict | undefined,
    ): Promise<{ signature: "ua{sv}"; value: [number, WireDict] }> {
        const failed = (): { signature: "ua{sv}"; value: [number, WireDict] } => ({
            signature: "ua{sv}",
            value: [2, []],
        });

        if (this.destroyed || !handle.startsWith("/") || this.requests.has(handle)) {
            return failed();
        }

        const request = new FileChooserRequestImpl({
            id: handle,
            appId: appId ?? "",
            parentWindow: parentWindow ?? "",
            title: title ?? "",
            mode,
            options: parseFileChooserOptions(options),
        });
        this.requests.set(handle, request);
        this.dbusServer.addObject(handle, "org.freedesktop.impl.portal.Request", {
            Close: async () => {
                request.closeFromFrontend();
            },
        });

        try {
            if (this.listenerCount("fileChooser.request") === 0) {
                await request.fail("desktop 没有注册 fileChooser.request 监听");
            } else {
                this.emit("fileChooser.request", request);
            }
            const result: PortalBackendResult = await request.wait();
            return { signature: "ua{sv}", value: [result.response, result.results] };
        } finally {
            this.requests.delete(handle);
            this.dbusServer.removeObject(handle, "org.freedesktop.impl.portal.Request");
        }
    }
}

export type {
    FileChooserMode,
    FileChooserRequest,
    FileChooserSelection,
    PortalAcceptResult,
    PortalChoice,
    PortalChoiceOption,
    PortalDirEntry,
    PortalFileKind,
    PortalFilter,
    PortalFilterRule,
    PortalPlace,
    PortalStat,
    XdgPortalEvents,
} from "./types";
