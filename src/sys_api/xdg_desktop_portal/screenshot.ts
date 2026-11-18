import type { ScreenshotImage } from "../screenshot";
import { screenshot as screenshotCapture } from "../screenshot";
import { PortalRequestBase } from "./portal_request";
import type {
    PickColorRequest,
    PortalAcceptResult,
    ScreenshotAcceptOptions,
    ScreenshotAcceptResult,
    ScreenshotRequest,
    ScreenshotTarget,
} from "./types";
import { optionValue, variant, type WireDict } from "./wire";

/** 截屏目标对应的 portal target 位 */
export const SCREENSHOT_TARGET_BITS: Record<ScreenshotTarget, number> = {
    screen: 1,
    window: 2,
    area: 4,
    "active-window": 8,
};

const TARGET_BY_BIT = new Map<number, ScreenshotTarget>([
    [1, "screen"],
    [2, "window"],
    [4, "area"],
    [8, "active-window"],
]);

export interface ParsedScreenshotOptions {
    modal: boolean;
    interactive: boolean;
    target: ScreenshotTarget;
    permissionStoreChecked: boolean;
}

/** portal 的 Screenshot 选项。缺省 target 按屏幕处理（保持旧版行为）。 */
export function parseScreenshotOptions(options: WireDict | undefined): ParsedScreenshotOptions {
    const dict = Array.isArray(options) ? options : [];
    const targetBits = optionValue(dict, "target", "u") ?? 1;
    return {
        modal: optionValue(dict, "modal", "b") ?? true,
        interactive: optionValue(dict, "interactive", "b") ?? false,
        target: TARGET_BY_BIT.get(targetBits) ?? "screen",
        permissionStoreChecked: optionValue(dict, "permission_store_checked", "b") ?? false,
    };
}

/**
 * 一个截屏请求。桌面 accept 后由后端把 PNG 写到图片目录，
 * 返回给前端的只有 file:// URI。
 */
export class ScreenshotRequestImpl extends PortalRequestBase implements ScreenshotRequest {
    readonly interactive: boolean;
    readonly target: ScreenshotTarget;
    readonly permissionStoreChecked: boolean;

    private readonly capture: screenshotCapture;

    constructor(op: {
        id: string;
        appId: string;
        parentWindow: string;
        options: ParsedScreenshotOptions;
        /** 测试或自定义桌面可以替换截屏实现 */
        capture?: screenshotCapture;
    }) {
        super({
            id: op.id,
            appId: op.appId,
            parentWindow: op.parentWindow,
            modal: op.options.modal,
        });
        this.interactive = op.options.interactive;
        this.target = op.options.target;
        this.permissionStoreChecked = op.options.permissionStoreChecked;
        this.capture = op.capture ?? new screenshotCapture();
    }

    /** 没有桌面 UI 时截全屏。失败时按内部错误结束请求。 */
    async captureDefault(): Promise<ScreenshotAcceptResult> {
        try {
            return await this.accept(await this.capture.capture());
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            await this.fail(error);
            return { ok: false, error };
        }
    }

    async accept(image: ScreenshotImage, options?: ScreenshotAcceptOptions): Promise<ScreenshotAcceptResult> {
        if (this.isClosed) return { ok: false, error: "请求已结束" };
        if (!image?.png || image.png.byteLength === 0) return { ok: false, error: "截屏数据为空" };
        try {
            const saved = await this.capture.save(image, options);
            if (this.isClosed) return { ok: false, error: "请求已结束" };
            this.finish(0, [["uri", variant("s", [saved.uri])]]);
            return { ok: true, uri: saved.uri, path: saved.path };
        } catch (e) {
            console.warn("[portal] screenshot accept failed:", e);
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }
}

/** 取色请求。桌面做取色 UI，返回 sRGB 三个 0..1 分量。 */
export class PickColorRequestImpl extends PortalRequestBase implements PickColorRequest {
    async accept(color: [number, number, number]): Promise<PortalAcceptResult> {
        if (this.isClosed) return { ok: false, error: "请求已结束" };
        if (
            !Array.isArray(color) ||
            color.length !== 3 ||
            !color.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
        ) {
            return { ok: false, error: "颜色必须是 0..1 的 RGB 三个分量" };
        }
        this.finish(0, [["color", variant("(ddd)", [color])]]);
        return { ok: true };
    }
}
