import { defineModule, type ModuleCtx, type WaylandObjectId2 } from "../../module";
import { getEnumValue } from "../../utils/wayland-proto";

/**
 * presentation-time
 *
 * Chromium 在 Wayland 下从 `wp_presentation_feedback.presented.refresh` 估算显示刷新率；
 * 没有这个协议时它退回 60Hz，即使 `wl_output.mode` 报的是 120。
 *
 * 当前由 Electron 桌面渲染，没有 DRM vblank 可读：在桌面 rAF 上回 presented，
 * 时间戳用 CLOCK_MONOTONIC，refresh 取桌面刷新率。每个 surface 每次 rAF 只回
 * 一个，避免客户端按 presented 的节奏跑超刷新率。
 */

/** 120Hz 的刷新间隔（纳秒）。 */
const REFRESH_NS = 8_333_333;

const CLOCK_MONOTONIC = 1;

declare module "../../module" {
    interface WaylandDomainRegistry {
        presentation: {
            /** surface → 该 surface 上等待 presented 的 feedback 对象 */
            bySurface: Map<WaylandObjectId2<"wl_surface">, Set<WaylandObjectId2<"wp_presentation_feedback">>>;
            /** feedback → 所属 surface（销毁时反查） */
            byFeedback: Map<WaylandObjectId2<"wp_presentation_feedback">, WaylandObjectId2<"wl_surface">>;
            /** 单调递增的 vblank 序号 */
            seq: number;
            /** 已排队等待下一次 rAF 的 presented */
            raf: boolean;
        };
    }
}

function nowNsec(): bigint {
    return process.hrtime.bigint();
}

function sendPresented(ctx: ModuleCtx, feedbackId: WaylandObjectId2<"wp_presentation_feedback">) {
    const ns = nowNsec();
    const sec = ns / 1_000_000_000n;
    const nsec = Number(ns % 1_000_000_000n);
    const seq = ctx.domain.presentation.seq++;
    // 时间戳先关联到已绑定的 output，客户端会再用 refresh 字段做 vblank 预测
    for (const output of ctx.domain.output.outputs) {
        ctx.sendNow(feedbackId, "wp_presentation_feedback.sync_output", { output });
    }
    ctx.sendNow(feedbackId, "wp_presentation_feedback.presented", {
        tv_sec_hi: Number((sec >> 32n) & 0xffffffffn),
        tv_sec_lo: Number(sec & 0xffffffffn),
        tv_nsec: nsec,
        refresh: REFRESH_NS,
        seq_hi: Math.floor(seq / 2 ** 32),
        seq_lo: seq >>> 0,
        flags: getEnumValue("wp_presentation_feedback.kind", ["vsync"]),
    });
}

function removeFeedback(ctx: ModuleCtx, feedbackId: WaylandObjectId2<"wp_presentation_feedback">) {
    const p = ctx.domain.presentation;
    const surface = p.byFeedback.get(feedbackId);
    p.byFeedback.delete(feedbackId);
    if (surface !== undefined) {
        const set = p.bySurface.get(surface);
        set?.delete(feedbackId);
        if (set?.size === 0) p.bySurface.delete(surface);
    }
    // presented/discarded 之后对象自动销毁，协议里没有客户端 destroy 请求
    ctx.objects.delete(feedbackId);
}

export const presentationModule = defineModule({
    name: "presentation-time",
    globals: [
        {
            name: "wp_presentation",
            onBind: (msg, ctx) => {
                ctx.send(msg.id as WaylandObjectId2<"wp_presentation">, "wp_presentation.clock_id", {
                    clk_id: CLOCK_MONOTONIC,
                });
            },
        },
    ],
    domain: {
        presentation: () => ({ bySurface: new Map(), byFeedback: new Map(), seq: 1, raf: false }),
    },
    requests: {
        "wp_presentation.feedback": (x, ctx) => {
            const p = ctx.domain.presentation;
            const feedbackId = x.args.callback;
            const surface = x.args.surface;
            p.byFeedback.set(feedbackId, surface);
            let set = p.bySurface.get(surface);
            if (!set) {
                set = new Set();
                p.bySurface.set(surface, set);
            }
            set.add(feedbackId);
        },
    },
    hooks: {
        onFrame: (surfaceId, canvas, _pending, ctx) => {
            const p = ctx.domain.presentation;
            if (p.bySurface.has(surfaceId) && !p.raf) {
                p.raf = true;
                const drain = () => {
                    p.raf = false;
                    let more = false;
                    for (const [sid, set] of p.bySurface) {
                        const first = set.values().next();
                        if (first.done) {
                            p.bySurface.delete(sid);
                            continue;
                        }
                        sendPresented(ctx, first.value);
                        removeFeedback(ctx, first.value);
                        if (set.size === 0) p.bySurface.delete(sid);
                        else more = true;
                    }
                    if (more) {
                        p.raf = true;
                        requestAnimationFrame(drain);
                    }
                };
                requestAnimationFrame(drain);
            }
            return canvas;
        },
        onDestroy: (surfaceId, ctx) => {
            const p = ctx.domain.presentation;
            const set = p.bySurface.get(surfaceId);
            if (set) {
                for (const feedbackId of [...set]) {
                    ctx.sendNow(feedbackId, "wp_presentation_feedback.discarded", {});
                    removeFeedback(ctx, feedbackId);
                }
            }
        },
    },
});
