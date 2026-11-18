/** 截屏矩形，坐标是桌面页面的 CSS 像素（DIP），相对页面左上角。 */
export interface ScreenshotRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * 截屏结果。`width`/`height` 是 PNG 的实际像素尺寸：
 * HiDPI 下会大于请求的 CSS 尺寸。
 */
export interface ScreenshotImage {
    png: Uint8Array;
    width: number;
    height: number;
}

export interface ScreenshotCaptureOptions {
    /** 只截取页面的一块区域；缺省截取整个页面 */
    rect?: ScreenshotRect;
}

export interface ScreenshotSaveOptions {
    /** 保存目录，缺省是图片目录下的 Screenshots */
    directory?: string;
    /** 文件名（含或不含 .png），缺省按时间生成 */
    name?: string;
}

export interface SavedScreenshot {
    /** 实际写入的绝对路径 */
    path: string;
    /** 文件的 file:// URI */
    uri: string;
}

// 桌面加载器启动后会删掉 window.require；模块求值时先留住引用，之后才能取 ipcRenderer。
const nodeRequire = typeof require === "function" ? require : undefined;

function rendererIpc(): typeof import("electron").ipcRenderer {
    if (!nodeRequire) throw new Error("截屏需要 Electron 渲染进程");
    const { ipcRenderer } = nodeRequire("electron") as typeof import("electron");
    return ipcRenderer;
}

/**
 * 截取桌面输出。
 *
 * 截的是桌面页面（所有窗口、壁纸、面板等），不包含系统光标。
 * 需要 Electron 渲染进程；纯 web 环境没有 ipcRenderer，调用会抛错。
 */
export class screenshot {
    /** 截取整个页面或 `options.rect` 指定的一块区域。 */
    async capture(options?: ScreenshotCaptureOptions): Promise<ScreenshotImage> {
        const result = (await rendererIpc().invoke(
            "screenshot:capture",
            options?.rect ? { rect: options.rect } : {},
        )) as ScreenshotImage | undefined;
        if (!result || !(result.png instanceof Uint8Array) || result.png.byteLength === 0) {
            throw new Error("截屏失败：没有拿到图像数据");
        }
        return result;
    }

    /**
     * 把截屏 PNG 写到图片目录（`<Pictures>/Screenshots`）。
     * 返回实际路径和 file:// URI，重名时自动加序号。
     */
    async save(image: ScreenshotImage, options?: ScreenshotSaveOptions): Promise<SavedScreenshot> {
        if (!image?.png || image.png.byteLength === 0) {
            throw new Error("截屏失败：没有可保存的图像数据");
        }
        return (await rendererIpc().invoke("screenshot:save", {
            png: image.png,
            name: options?.name,
            directory: options?.directory,
        })) as SavedScreenshot;
    }
}
