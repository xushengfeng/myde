const { sharedTexture } = require("electron") as typeof import("electron");
const usocket = require("myde-unix-socket") as typeof import("myde-unix-socket");

/**
 * 共享纹理跨进程接收：协议侧需要 GPU 帧时用（dmabuf attach 路径）。
 * 原在 server.ts 顶层，随 wl_surface.attach 迁出一并下沉。
 */
let sharedTextureCounter = 1;
const sharedTextureCbMap = new Map<number, (cb: ReturnType<typeof sharedTexture.importSharedTexture>) => void>();
export async function importSharedTexture(
    options: Parameters<typeof sharedTexture.importSharedTexture>[0],
): Promise<ReturnType<typeof sharedTexture.importSharedTexture>> {
    const id = sharedTextureCounter++;
    const { promise, resolve } = Promise.withResolvers<ReturnType<typeof sharedTexture.importSharedTexture>>();
    sharedTextureCbMap.set(id, resolve);
    const fds = options.textureInfo.handle.nativePixmap?.planes.map((p) => p.fd);

    if (fds !== undefined && ipc) ipc.write({ data: Buffer.from(JSON.stringify({ id, options })), fds }, () => {});
    return promise;
}

/**
 * 注册接收端。只有 electron 渲染进程才有共享纹理；纯 node 环境（如协议模块单测
 * 直接 import 模块图）拿不到它，此时跳过注册——那些环境根本用不到 GPU 帧。
 */
sharedTexture?.setSharedTextureReceiver?.(async (cb, id) => {
    const receiver = sharedTextureCbMap.get(id);
    if (receiver) {
        receiver(cb.importedSharedTexture);
        sharedTextureCbMap.delete(id);
    } else {
        console.error(`No receiver found for shared texture id ${id}`);
    }
});

/**
 * 与主进程约定的共享纹理通道。只在 electron 渲染进程里建——纯 node 环境
 * （协议模块单测会 import 到这张模块图）没有对面，建了也只是连接失败。
 */
const ipc = sharedTexture ? new usocket.USocket({ path: "/tmp/myde.sock" }) : undefined;
