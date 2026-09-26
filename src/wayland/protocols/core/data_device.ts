import { defineModule } from "../../module";

const fs = require("node:fs") as typeof import("node:fs");

import { newFd } from "../../utils/fd";
import { waylandObjectId } from "../../utils/wayland-proto";

/**
 * wl_data_device 家族
 *
 * 由 server.ts 的 newOp() 迁出；handler 只认 ctx，不接触 WaylandClient。
 */
// 状态类型归本模块声明（P3）
declare module "../../module" {
    interface WaylandDataRegistry {
        wl_data_source: { offers: string[] };
    }
}

export const dataDeviceModule = defineModule({
    name: "wl_data_device 家族",
    requests: {
        "wl_data_device_manager.create_data_source": (x, ctx) => {
            const src = ctx.objects.get(x.args.id);
            src.data = { offers: [] };
        },
        "wl_data_device_manager.get_data_device": (x, ctx) => {
            const ddId = x.args.id;
            const dataDevices = ctx.client.state.dataDevices || new Set();
            dataDevices.add(ddId);
            ctx.client.state.dataDevices = dataDevices;
        },
        "wl_data_source.offer": (x, ctx) => {
            const src = ctx.objects.get(x.id);
            if (!src) return;
            src.data.offers.push(x.args.mime_type);
            console.log(`wl_data_source#${x.id} offer ${x.args.mime_type}`);
        },
        "wl_data_offer.receive": (x, ctx) => {
            const offerId = x.id;
            const mime = x.args.mime_type;
            const fd = x.args.fd;

            // fallback: compositor-local paste flow – keep pendingPaste and emit paste for external handler
            if (ctx.client.state.pendingPaste) {
                console.warn("Existing pending paste request - rejecting previous");
                try {
                    fs.closeSync(ctx.client.state.pendingPaste.fd);
                } catch {
                    // ignore
                }
                clearTimeout(ctx.client.state.pendingPaste.timeout);
                ctx.client.state.pendingPaste = undefined;
            }

            const timeout = setTimeout(() => {
                if (!ctx.client.state.pendingPaste) return;
                console.warn("paste request timed out");
                try {
                    fs.closeSync(ctx.client.state.pendingPaste.fd);
                } catch {
                    // ignore
                }
                ctx.client.state.pendingPaste = undefined;
            }, 10000);

            ctx.client.state.pendingPaste = { offerId, fd, mime, timeout };
            ctx.client.emit("paste");
        },
        "wl_data_device.set_selection": (x, ctx) => {
            const srcId = waylandObjectId(x.args.source, "wl_data_source");
            if (!srcId) {
                console.log("Selection cleared");
                return;
            }

            const src = ctx.objects.get(srcId);
            if (!src) {
                console.warn(`Selection source ${srcId} not found`);
                return;
            }

            const offers = src.data.offers;
            // 优先尝试 text/plain;charset=utf-8，然后 text/plain
            let mime = offers.find((m: string) => /text\/plain.*utf-?8/i.test(m));
            if (!mime) mime = offers.find((m: string) => /^text\/plain($|;)/i.test(m));
            if (!mime) {
                // 回退到第一个 offer
                mime = offers[0];
            }

            if (!mime) {
                console.log(`No offered mime types from source ${srcId}`);
                return;
            }

            // 创建一个临时 fd 传给客户端，让客户端往里面写入数据
            const { fd } = newFd("");

            try {
                // 发送请求，要求客户端把 mime 类型的数据写入我们提供的 fd
                ctx.sendNow(srcId, "wl_data_source.send", { mime_type: mime, fd: fd });

                // TODO: 使用基于 EOF 的读取更优雅，但客户端行为差异导致未能稳定工作，
                // 先回退到简单的延时读取（不优雅），以后再改进为可靠的 EOF/poll 检测。
                setTimeout(() => {
                    try {
                        const st = fs.fstatSync(fd);
                        const len = Number(st.size) || 0;
                        if (len === 0) {
                            // 若 size 为 0，尝试读取最多 64KB 的数据
                            const tryBuf = new Uint8Array(65536);
                            let read = 0;
                            try {
                                read = fs.readSync(fd, tryBuf, 0, tryBuf.length, 0);
                            } catch {
                                // ignore
                            }
                            const content = Buffer.from(tryBuf.buffer, tryBuf.byteOffset, read).toString("utf8");
                            console.log(`Clipboard (from ${srcId}) [len=${read}]:`, content);
                        } else {
                            const arr = new Uint8Array(len);
                            fs.readSync(fd, arr, 0, len, 0);
                            const content = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("utf8");
                            console.log(`Clipboard (from ${srcId}) [len=${len}]:`, content);
                            ctx.client.emit("copy", content);
                        }
                    } catch (err) {
                        console.error("Error reading selection fd:", err);
                    } finally {
                        try {
                            fs.closeSync(fd);
                        } catch {
                            // ignore
                        }
                    }
                }, 200);
            } catch (err) {
                console.error("Error sending wl_data_source.send:", err);
                try {
                    fs.closeSync(fd);
                } catch {
                    // ignore
                }
            }
        },
    },
});
