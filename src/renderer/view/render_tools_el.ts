import { ele, type ElType, view } from "dkh-ui";
import type { renderTools, renderToolsOn } from "./render_tools";

export class renderToolsHtmlEl implements renderTools {
    private canvasMap = new Map<string, { warpEl: ElType<HTMLElement>; canvas: ElType<HTMLCanvasElement> }>();
    private xdgElMap = new Map<string, { warpEl: ElType<HTMLElement>; canvasWrap: ElType<HTMLElement> }>();
    private _on: renderToolsOn = {};
    private idGen = 0;

    on(op?: renderToolsOn): void {
        if (op) {
            this._on = { ...this._on, ...op };
        }
    }
    idScope(): (id: unknown) => string {
        const baseId = this.idGen++;
        return (id: unknown) => `${baseId}-${String(id)}`;
    }
    bindCanvas(id: string) {
        const canvasEl = ele("canvas").attr({ id: id });
        const warpEl = view().add(canvasEl);
        this.canvasMap.set(id, { warpEl: warpEl, canvas: canvasEl });
    }
    renderCanvas(canvas: OffscreenCanvas, id: string) {
        const el = this.canvasMap.get(id)?.canvas;
        if (el && el instanceof HTMLCanvasElement) {
            el.width = canvas.width;
            el.height = canvas.height;
            const ctx = el.getContext("2d");
            if (ctx) {
                ctx.drawImage(canvas, 0, 0);
            }
        }
    }
    destroyCanvas(id: string): void {
        this.canvasMap.delete(id);
    }
    setCanvasAnchor(id: string, parentId: string) {
        const parent = this.canvasMap.get(parentId);
        const thisChild = this.canvasMap.get(id);
        if (!parent || !thisChild) {
            console.error("error");
            return;
        }
        parent.warpEl.add(thisChild.warpEl);
        // @ts-expect-error
        parent.canvas.style({ anchorName: `--${parentId}` });
        // @ts-expect-error
        thisChild.warpEl.style({ position: "absolute", positionAnchor: `--${parentId}` });
    }
    setCanvasOffset(id: string, x: number, y: number) {
        const thisChild = this.canvasMap.get(id);
        if (!thisChild) {
            console.error("error");
            return;
        }

        thisChild.warpEl.style({ left: `calc(anchor(left) + ${x}px)`, top: `calc(anchor(top) + ${y}px)` });
    }
    createXdgSurfaceEle(id: string, canvasId: string) {
        const canvasEl = this.canvasMap.get(canvasId);
        if (!canvasEl) {
            console.error("error");
            return;
        }
        const el = view().attr({ id: id }).style({ position: "absolute" }).add(canvasEl.warpEl);

        this.xdgElMap.set(id, { warpEl: el, canvasWrap: canvasEl.warpEl });
    }
    getXdgSurfaceEle(id: string) {
        return this.xdgElMap.get(id)?.warpEl.el;
    }
    destroyXdgSurfaceEle(id: string, type: "toplevel" | "popup"): void {
        const el = this.xdgElMap.get(id);
        if (el) {
            if (type === "toplevel" && this._on.onToplevelRemove) {
                this._on.onToplevelRemove?.(id, el.warpEl.el);
            } else {
                el.warpEl.remove();
            }
        }
    }
    setXdgSurfaceGeo(id: string, width: number, height: number, offsetX: number, offsetY: number) {
        const surface = this.xdgElMap.get(id);
        if (!surface) {
            console.error("error");
            return;
        }
        const canvas = surface.canvasWrap;
        const canvasEl = canvas;
        canvasEl.style({ position: "absolute", top: `-${offsetY}px`, left: `-${offsetX}px` });
        surface.warpEl.style({
            width: `${width}px`,
            height: `${height}px`,
        });
    }
    asToplevel(id: string) {
        const el = this.xdgElMap.get(id);
        if (!el) {
            console.error("error");
            return;
        }
        this._on.onToplevelCreate?.(id, el.warpEl.el);
    }
    addPopupToXdgSurface(popupId: string, toplevelId: string) {
        const popup = this.xdgElMap.get(popupId);
        const toplevel = this.xdgElMap.get(toplevelId);
        if (!popup || !toplevel) {
            console.error("error");
            return;
        }
        toplevel.warpEl.add(popup.warpEl);
    }
    setPopupPosi(popupId: string, x: number, y: number) {
        const popup = this.xdgElMap.get(popupId);
        if (!popup) {
            console.error("error");
            return;
        }
        popup.warpEl.style({
            position: "absolute",
            left: `${x}px`,
            top: `${y}px`,
        });
    }
}
