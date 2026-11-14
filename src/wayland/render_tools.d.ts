export type renderToolsOn = {
    onToplevelCreate?: (wid: string) => void;
    onToplevelRemove?: (wid: string) => void;
    // canvas为string时是语义光标（wp_cursor_shape_device_v1.shape的枚举名，热点为0），undefined表示隐藏光标
    // hx/hy 是 surface-local 热点；scale 是当前输出缩放，桌面显示热点 = hx/hy × scale
    onCursorUpdata?: (canvas: OffscreenCanvas | string | undefined, hx: number, hy: number, scale: number) => void;
};

export interface renderTools {
    on(op?: renderToolsOn): void;
    idScope(): (id: unknown) => string;
    bindCanvas(id: string): void;
    /**
     * 输出缩放（桌面显示 px = surface 逻辑 px × scale）。
     * renderTools 内部保存逻辑几何，scale 变化时重新套到 DOM 上。
     */
    setScale?(scale: number): void;
    /**
     * `op.logicalWidth/Height` 是 surface 逻辑尺寸；官方实现会按 `scale` 算 CSS 尺寸。
     * 不传时保持位图原尺寸（外部实现的旧行为）。
     */
    renderCanvas(canvas: OffscreenCanvas, id: string, op?: { logicalWidth: number; logicalHeight: number }): void;
    destroyCanvas(id: string): void;
    setCanvasAnchor(id: string, parentId: string): void;
    setCanvasOffset(id: string, x: number, y: number): void;
    setBufferOffset(id: string, x: number, y: number): void;
    createXdgSurfaceEle(id: string, canvasId: string): void;
    getXdgSurfaceEle(id: string): unknown;
    destroyXdgSurfaceEle(id: string, type: "toplevel" | "popup"): void;
    setXdgSurfaceGeo(id: string, width: number, height: number, offsetX: number, offsetY: number): void;
    asToplevel(id: string): void;
    addPopupToXdgSurface(popupSurfaceId: string, parentSurfaceId: string): void;
    setPopupPosi(popupSurfaceId: string, x: number, y: number): void;
    // canvas为string时是语义光标（wp_cursor_shape_device_v1.shape的枚举名，热点为0），undefined表示隐藏光标
    setCursor(canvas: OffscreenCanvas | string | undefined, hotspotX: number, hotspotY: number): void;
}
