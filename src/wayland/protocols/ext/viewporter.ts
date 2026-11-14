import { defineModule } from "../../module";

/**
 * viewporter
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
// 状态类型归本模块声明（P3）
declare module "../../module" {
    interface WaylandDataRegistry {
        wp_viewport: {
            surface: SurfaceId;
        };
    }
}

export const viewporterModule = defineModule({
    name: "viewporter",
    hooks: {
        /**
         * 由 wl_surface.commit 触发（像素已合成、渲染之前）。
         *
         * viewport 的 source/destination 是持续生效的双缓冲状态：commit 后要一直用到下一次
         * set_source/set_destination，不能只在设置它的那次 commit 生效。Chrome 的 popup
         * 收缩就是靠 set_source 裁掉旧内容，读 pending 会让第二次之后的裁剪丢失。
         */
        onFrame: (surfaceId, canvas, _pending, ctx) => {
            const data = ctx.objects.get(surfaceId).data.current;
            const viewport = data.viewport;
            const source = viewport?.source;
            if (!source) return;
            // source 是 surface-local 坐标（已过 buffer_scale），落到 buffer 像素要乘回去。
            // destination 只决定显示尺寸，由 core 记录为 surface 逻辑尺寸；不能在这里
            // 把画布缩到 destination，否则分数缩放会丢掉客户端的 1.5x/2x 像素。
            const bufferScale = data.bufferScale ?? 1;
            const sx = source.x * bufferScale;
            const sy = source.y * bufferScale;
            const sw = source.width * bufferScale;
            const sh = source.height * bufferScale;
            if (sx < 0 || sy < 0 || sx + sw > canvas.width || sy + sh > canvas.height) {
                // set_source 可能发生在对应 buffer attach 之前；当前 canvas 还是旧尺寸。
                // 等新 buffer commit 后再裁剪，避免 drawImage 越界抛异常。
                return canvas;
            }
            const width = Math.max(1, Math.round(sw));
            const height = Math.max(1, Math.round(sh));
            const ncanvas = new OffscreenCanvas(width, height);
            const sctx = ncanvas.getContext("2d");
            sctx?.drawImage(canvas, sx, sy, sw, sh, 0, 0, width, height);
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
            // viewport 是连接在 surface 上的持续状态（双缓冲由 set_* 的 pending 副本完成）
            surface.data.current.viewport = {};
            const viewport = ctx.objects.get(viewportId);
            viewport.data = { surface: surfaceId };
        },
        "wp_viewport.set_source": (x, ctx) => {
            const viewport = ctx.objects.get(x.id);
            const surfaceId = viewport.data.surface;
            const surface = ctx.objects.get(surfaceId);
            const current = surface.data.current.viewport;
            if (current === undefined) return;
            // 双缓冲：pending 是提交前的累积状态；没有 pending 时从 current 复制一份。
            // 同一 commit 前的多次 set_source/set_destination 要作用在同一个 pending 上。
            surface.data.pending.viewport ??= { ...current };
            const viewportData = surface.data.pending.viewport;
            if (x.args.width === -1 && x.args.height === -1 && x.args.x === -1 && x.args.y === -1) {
                viewportData.source = undefined;
                return;
            } else if (x.args.width <= 0 || x.args.height <= 0 || x.args.x < 0 || x.args.y < 0) {
                ctx.postError("wp_viewport", x.id, "bad_value", "Invalid source rectangle");
                return;
            }
            // 不在请求时校验 source 是否超出当前 canvas：客户端通常先 set_source 再 attach
            // 新 buffer，此时拿到的还是旧 buffer 尺寸。越界只在渲染时安全跳过，避免误报
            // out_of_buffer 把客户端连接打死。
            viewportData.source = {
                x: x.args.x,
                y: x.args.y,
                width: x.args.width,
                height: x.args.height,
            };
        },
        "wp_viewport.set_destination": (x, ctx) => {
            const viewport = ctx.objects.get(x.id);
            const surfaceId = viewport.data.surface;
            const surface = ctx.objects.get(surfaceId);
            const current = surface.data.current.viewport;
            if (current === undefined) return;
            surface.data.pending.viewport ??= { ...current };
            const viewportData = surface.data.pending.viewport;
            if (x.args.width === -1 && x.args.height === -1) {
                viewportData.destination = undefined;
                return;
            } else if (x.args.width <= 0 || x.args.height <= 0) {
                ctx.postError("wp_viewport", x.id, "bad_value", "Invalid destination rectangle");
                return;
            } else if (Number.isSafeInteger(x.args.width) === false || Number.isSafeInteger(x.args.height) === false) {
                ctx.postError("wp_viewport", x.id, "bad_size", "Width or height is not a safe integer");
                return;
            }
            viewportData.destination = {
                width: x.args.width,
                height: x.args.height,
            };
        },
        "wp_viewport.destroy": (x, ctx) => {
            const viewport = ctx.objects.get(x.id);
            const surfaceId = viewport.data.surface;
            const surface = ctx.objects.get(surfaceId);
            if (surface) {
                delete surface.data.pending.viewport;
                delete surface.data.current.viewport;
            }
        },
    },
});
