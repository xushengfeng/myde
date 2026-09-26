const fs = require("node:fs") as typeof import("node:fs");

export function newFd(data: string | Uint8Array): { fd: number; size: number } {
    const tmpPath = `/dev/shm/wl-fd-${crypto.randomUUID()}`;
    const fd = fs.openSync(tmpPath, "w+");
    if (typeof data === "string") {
        fs.writeFileSync(fd, data);
    } else {
        fs.writeFileSync(fd, data);
    }
    fs.unlinkSync(tmpPath); // unlink but keep fd open
    return {
        fd,
        size: typeof data === "string" ? Buffer.byteLength(data) : data.length,
    };
}
