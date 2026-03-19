export type renderToolsOn = {
    onToplevelCreate?: (wid: string, el: HTMLElement) => void;
    onToplevelRemove?: (wid: string, el: HTMLElement) => void;
};

export interface renderTools {
    on(op?: renderToolsOn): void;
    idScope(): (id: unknown) => string;
    bindCanvas(id: string): void;
    renderCanvas(canvas: OffscreenCanvas, id: string): void;
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
}
