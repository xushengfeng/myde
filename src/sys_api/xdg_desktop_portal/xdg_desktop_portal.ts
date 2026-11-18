import { type dbusIO, dbusServer } from "myde-dbus";
import { EventEmitter } from "../../event-emitter/event-emitter";
import { AccessRequestImpl, parseAccessOptions } from "./access";
import { portalFileBrowser } from "./browse";
import { FileChooserRequestImpl, parseFileChooserOptions } from "./file_chooser";
import type { PortalRequestBase } from "./portal_request";
import {
    PickColorRequestImpl,
    parseScreenshotOptions,
    SCREENSHOT_TARGET_BITS,
    ScreenshotRequestImpl,
} from "./screenshot";
import type { FileChooserMode, ScreenshotTarget, XdgPortalEvents } from "./types";
import { optionValue, type WireDict, type WireVar } from "./wire";

export const DEFAULT_PORTAL_BUS_NAME = "org.freedesktop.impl.portal.desktop.myde";
export const DEFAULT_PORTAL_OBJECT_PATH = "/org/freedesktop/portal/desktop";

interface PortalReply {
    signature: "ua{sv}";
    value: [number, WireDict];
}

function failedReply(): PortalReply {
    return { signature: "ua{sv}", value: [2, []] };
}

/** 抛出带合法 D-Bus 错误名的异常；普通的 Error.name 不是合法错误名，会让服务端断开连接 */
function dbusError(name: string, message: string): Error {
    const error = new Error(message);
    error.name = name;
    return error;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * MyDE 的 xdg-desktop-portal 后端。
 *
 * 前端（系统 xdg-desktop-portal）负责 sender 校验、request path、Documents portal
 * 和沙箱文件授权；这里实现 FileChooser、Screenshot、Access，并把交互通过事件交给桌面。
 *
 * 注意：前端只有在配置了 `org.freedesktop.impl.portal.Access` 后端时才会提供
 * Screenshot portal，所以 Access 不能省略。
 */
export class xdgDesktopPortal extends EventEmitter<XdgPortalEvents> {
    private readonly dbus: dbusIO;
    private readonly dbusServer: dbusServer;
    private readonly objectPath: string;
    private readonly requests = new Map<string, PortalRequestBase>();
    /** 前端向应用广告的截屏目标；桌面在第一次截屏请求前可用 setScreenshotTargets 扩展 */
    private readonly screenshotTargets = new Set<ScreenshotTarget>(["screen"]);
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
        this.dbusServer.addObject(this.objectPath, "org.freedesktop.impl.portal.Screenshot", {
            Screenshot: (handle: string, appId: string, parentWindow: string, options: WireDict) =>
                this.takeScreenshot(handle, appId, parentWindow, options),
            PickColor: (handle: string, appId: string, parentWindow: string, options: WireDict) =>
                this.pickColor(handle, appId, parentWindow, options),
        });
        this.dbusServer.addObject(this.objectPath, "org.freedesktop.impl.portal.Access", {
            AccessDialog: (
                handle: string,
                appId: string,
                parentWindow: string,
                title: string,
                subtitle: string,
                body: string,
                options: WireDict,
            ) => this.accessDialog(handle, appId, parentWindow, title, subtitle, body, options),
        });
        // myde-dbus 的服务端没有内建 Properties，这里自己实现截图接口的 version / AvailableTargets
        this.dbusServer.addObject(this.objectPath, "org.freedesktop.DBus.Properties", {
            Get: (iface: string, name: string) => this.getProperty(iface, name),
            GetAll: (iface: string) => this.getAllProperties(iface),
            Set: () => {
                throw dbusError("org.freedesktop.DBus.Error.PropertyReadOnly", "portal 属性只读");
            },
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

    /**
     * 设置前端广告给应用的截屏目标。桌面能处理窗口/区域选择时在初始化阶段调用；
     * 缺省只广告 "screen"（后端自己截全屏）。
     */
    setScreenshotTargets(targets: ScreenshotTarget[]): void {
        this.screenshotTargets.clear();
        for (const target of targets) this.screenshotTargets.add(target);
    }

    private async openFile(
        mode: FileChooserMode,
        handle: string,
        appId: string,
        parentWindow: string,
        title: string,
        options: WireDict | undefined,
    ): Promise<PortalReply> {
        if (this.destroyed || !handle.startsWith("/") || this.requests.has(handle)) {
            return failedReply();
        }

        let request: FileChooserRequestImpl | undefined;
        try {
            request = new FileChooserRequestImpl({
                id: handle,
                appId: appId ?? "",
                parentWindow: parentWindow ?? "",
                title: title ?? "",
                mode,
                options: parseFileChooserOptions(options),
            });
            this.trackRequest(request);
            if (this.listenerCount("fileChooser.request") === 0) {
                await request.fail("desktop 没有注册 fileChooser.request 监听");
            } else {
                this.emit("fileChooser.request", request);
            }
            const result = await request.wait();
            return { signature: "ua{sv}", value: [result.response, result.results] };
        } catch (e) {
            console.warn(`[portal] file chooser ${handle} failed:`, e);
            await request?.fail(errorMessage(e));
            return failedReply();
        } finally {
            if (request) this.untrackRequest(request.id);
        }
    }

    private async takeScreenshot(
        handle: string,
        appId: string,
        parentWindow: string,
        options: WireDict | undefined,
    ): Promise<PortalReply> {
        if (this.destroyed || !handle.startsWith("/") || this.requests.has(handle)) {
            return failedReply();
        }

        let request: ScreenshotRequestImpl | undefined;
        try {
            request = new ScreenshotRequestImpl({
                id: handle,
                appId: appId ?? "",
                parentWindow: parentWindow ?? "",
                options: parseScreenshotOptions(options),
            });
            this.trackRequest(request);
            if (this.listenerCount("screenshot.request") === 0) {
                // 没有桌面 UI：直接截整个桌面。interactive 只是提示，可以忽略。
                const result = await request.captureDefault();
                if (!result.ok) console.warn(`[portal] 默认截屏失败: ${result.error}`);
            } else {
                this.emit("screenshot.request", request);
            }
            const result = await request.wait();
            return { signature: "ua{sv}", value: [result.response, result.results] };
        } catch (e) {
            console.warn(`[portal] screenshot ${handle} failed:`, e);
            await request?.fail(errorMessage(e));
            return failedReply();
        } finally {
            if (request) this.untrackRequest(request.id);
        }
    }

    private async pickColor(
        handle: string,
        appId: string,
        parentWindow: string,
        options: WireDict | undefined,
    ): Promise<PortalReply> {
        if (this.destroyed || !handle.startsWith("/") || this.requests.has(handle)) {
            return failedReply();
        }

        let request: PickColorRequestImpl | undefined;
        try {
            const dict = Array.isArray(options) ? options : [];
            request = new PickColorRequestImpl({
                id: handle,
                appId: appId ?? "",
                parentWindow: parentWindow ?? "",
                modal: optionValue(dict, "modal", "b") ?? true,
            });
            this.trackRequest(request);
            if (this.listenerCount("screenshot.pickColor") === 0) {
                await request.fail("desktop 没有注册 screenshot.pickColor 监听");
            } else {
                this.emit("screenshot.pickColor", request);
            }
            const result = await request.wait();
            return { signature: "ua{sv}", value: [result.response, result.results] };
        } catch (e) {
            console.warn(`[portal] pick color ${handle} failed:`, e);
            await request?.fail(errorMessage(e));
            return failedReply();
        } finally {
            if (request) this.untrackRequest(request.id);
        }
    }

    private async accessDialog(
        handle: string,
        appId: string,
        parentWindow: string,
        title: string,
        subtitle: string,
        body: string,
        options: WireDict | undefined,
    ): Promise<PortalReply> {
        if (this.destroyed || !handle.startsWith("/") || this.requests.has(handle)) {
            return failedReply();
        }

        let request: AccessRequestImpl | undefined;
        try {
            request = new AccessRequestImpl({
                id: handle,
                appId: appId ?? "",
                parentWindow: parentWindow ?? "",
                title: title ?? "",
                subtitle: subtitle ?? "",
                body: body ?? "",
                options: parseAccessOptions(options),
            });
            this.trackRequest(request);
            if (this.listenerCount("access.request") === 0) {
                // 权限记录与控制在 myde 侧做；在接上之前先全部允许，避免截图等 portal 不可用。
                console.log(`[portal] 没有桌面处理权限请求，默认允许: ${request.title}`);
                await request.accept();
            } else {
                this.emit("access.request", request);
            }
            const result = await request.wait();
            return { signature: "ua{sv}", value: [result.response, result.results] };
        } catch (e) {
            console.warn(`[portal] access dialog ${handle} failed:`, e);
            await request?.fail(errorMessage(e));
            return failedReply();
        } finally {
            if (request) this.untrackRequest(request.id);
        }
    }

    private trackRequest(request: PortalRequestBase): void {
        this.requests.set(request.id, request);
        this.dbusServer.addObject(request.id, "org.freedesktop.impl.portal.Request", {
            Close: async () => {
                request.closeFromFrontend();
            },
        });
    }

    private untrackRequest(handle: string): void {
        this.requests.delete(handle);
        this.dbusServer.removeObject(handle, "org.freedesktop.impl.portal.Request");
    }

    private portalProperties(iface: string): Record<string, WireVar> {
        if (iface !== "org.freedesktop.impl.portal.Screenshot") return {};
        let targets = 0;
        for (const target of this.screenshotTargets) targets |= SCREENSHOT_TARGET_BITS[target];
        return {
            version: { signature: "u", value: [3] },
            AvailableTargets: { signature: "u", value: [targets] },
        };
    }

    private getProperty(iface: string, name: string): { signature: "v"; value: [WireVar] } {
        const property = this.portalProperties(iface)[name];
        if (!property) {
            throw dbusError("org.freedesktop.DBus.Error.UnknownProperty", `未知属性 ${iface}.${name}`);
        }
        return { signature: "v", value: [property] };
    }

    private getAllProperties(iface: string): { signature: "a{sv}"; value: [WireDict] } {
        const properties = Object.entries(this.portalProperties(iface)).map(([name, property]): [string, WireVar] => [
            name,
            property,
        ]);
        return { signature: "a{sv}", value: [properties] };
    }
}

export type {
    AccessRequest,
    FileChooserMode,
    FileChooserRequest,
    FileChooserSelection,
    PickColorRequest,
    PortalAcceptResult,
    PortalChoice,
    PortalChoiceOption,
    PortalDirEntry,
    PortalFileKind,
    PortalFilter,
    PortalFilterRule,
    PortalPlace,
    PortalStat,
    ScreenshotAcceptOptions,
    ScreenshotAcceptResult,
    ScreenshotRequest,
    ScreenshotTarget,
    XdgPortalEvents,
} from "./types";
