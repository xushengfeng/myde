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

    if (fds !== undefined) ipc.write({ data: Buffer.from(JSON.stringify({ id, options })), fds }, () => {});
    return promise;
}

sharedTexture.setSharedTextureReceiver(async (cb, id) => {
    const receiver = sharedTextureCbMap.get(id);
    if (receiver) {
        receiver(cb.importedSharedTexture);
        sharedTextureCbMap.delete(id);
    } else {
        console.error(`No receiver found for shared texture id ${id}`);
    }
});

const ipc = new usocket.USocket({ path: "/tmp/myde.sock" });
