import { defineModule } from "../module";

/**
 * viewporter
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
export const viewporterModule = defineModule({
    name: "viewporter",
    hooks: {
        /**
         * 由 wl_surface.commit 触发（像素已合成、渲染之前）。
         * 读 pending.viewport 而非合并后的 current —— 与原内联实现一致，
         * 因此 viewport 只在设置它的那次 commit 生效；这是既有行为，勿"顺手修正"。
         */
        onFrame: (_surfaceId, canvas, pending) => {
            const viewport = pending.viewport;
            if (!viewport || !(viewport.destination || viewport.source)) return;
            const { source, destination } = viewport;
            let dwidth = 1;
            let dheight = 1;
            if (!destination && source) {
                dwidth = source.width;
                dheight = source.height;
            } else if (destination) {
                dwidth = destination.width;
                dheight = destination.height;
            }
            const ncanvas = new OffscreenCanvas(dwidth, dheight);
            const sctx = ncanvas.getContext("2d");
            if (source) {
                sctx?.drawImage(canvas, source.x, source.y, source.width, source.height, 0, 0, dwidth, dheight);
            } else {
                sctx?.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, dwidth, dheight);
            }
            return ncanvas;
        },
    },
    requests: {
        "wp_viewporter.get_viewport": (x, ctx) => {
            const viewportId = x.args.id;
            const surfaceId = x.args.surface;
            const surface = ctx.objects.get(surfaceId);
            if (!surface) {
                console.error(`Surface ${surfaceId} not found for get_viewport`);
                return;
            }
            if (surface.data.current.viewport) {
                if (surface.data.current.viewport.source || surface.data.current.viewport.destination) {
                    ctx.postError("wp_viewporter", x.id, "viewport_exists", "Surface already has a viewport");
                    return;
                }
            }
            surface.data.pending.viewport = {};
            const viewport = ctx.objects.get(viewportId);
            viewport.data = { surface: surfaceId };
        },
        "wp_viewport.set_source": (x, ctx) => {
            const viewport = ctx.objects.get(x.id);
            const surfaceId = viewport.data.surface;
            const surface = ctx.objects.get(surfaceId);
            const viewportData = surface.data.pending.viewport;
            if (viewportData) {
                if (x.args.width === -1 && x.args.height === -1 && x.args.x === -1 && x.args.y === -1) {
                    viewportData.source = undefined;
                    return;
                } else if (x.args.width <= 0 || x.args.height <= 0 || x.args.x < 0 || x.args.y < 0) {
                    ctx.postError("wp_viewport", x.id, "bad_value", "Invalid source rectangle");
                    return;
                } else if (
                    x.args.x + x.args.width > surface.data.canvas.width ||
                    x.args.y + x.args.height > surface.data.canvas.height
                ) {
                    ctx.postError(
                        "wp_viewport",
                        x.id,
                        "out_of_buffer",
                        "Source rectangle exceeds surface buffer bounds",
                    );
                    return;
                }
                viewportData.source = {
                    x: x.args.x,
                    y: x.args.y,
                    width: x.args.width,
                    height: x.args.height,
                };
            }
        },
        "wp_viewport.set_destination": (x, ctx) => {
            const viewport = ctx.objects.get(x.id);
            const surfaceId = viewport.data.surface;
            const surface = ctx.objects.get(surfaceId);
            const viewportData = surface.data.pending.viewport;
            if (viewportData) {
                if (x.args.width === -1 && x.args.height === -1) {
                    viewportData.destination = undefined;
                    return;
                } else if (x.args.width <= 0 || x.args.height <= 0) {
                    ctx.postError("wp_viewport", x.id, "bad_value", "Invalid destination rectangle");
                    return;
                } else if (
                    Number.isSafeInteger(x.args.width) === false ||
                    Number.isSafeInteger(x.args.height) === false
                ) {
                    ctx.postError("wp_viewport", x.id, "bad_size", "Width or height is not a safe integer");
                    return;
                }
                viewportData.destination = {
                    width: x.args.width,
                    height: x.args.height,
                };
            }
        },
        "wp_viewport.destroy": (x, ctx) => {
            const viewport = ctx.objects.get(x.id);
            const surfaceId = viewport.data.surface;
            const surface = ctx.objects.get(surfaceId);
            if (surface) {
                delete surface.data.pending.viewport;
            }
        },
    },
});
