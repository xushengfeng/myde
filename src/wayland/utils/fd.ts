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

/** `ls -l /proc/self/fd` 里判断一个 fd 是否已经关掉（用于测试和诊断） */
export function isFdOpen(fd: number): boolean {
    try {
        fs.fstatSync(fd);
        return true;
    } catch {
        return false;
    }
}

/**
 * 一个连接持有的 fd 引用计数。
 *
 * 客户端的 fd 经 SCM_RIGHTS 到达后，同一个 fd 会被多个协议对象共用：`wl_shm_pool`
 * 和它创建的 `wl_buffer` 就是同一份映射。所以不能每个对象各自 close —— 必须等最后
 * 一个使用者销毁、或连接断开时才真正 close，否则会把还在读的 fd 关掉。
 * 不 close 的后果是 buffer 被 dma-buf 引用钉住：客户端早就销毁了，显存却一直不释放。
 */
export class FdRegistry {
    private refs = new Map<number, number>();

    /** 登记一个 fd，引用 +1 */
    retain(fd: number): void {
        this.refs.set(fd, (this.refs.get(fd) ?? 0) + 1);
    }

    /**
     * 引用 -1，归零时 close。
     * 未登记的 fd 直接忽略：服务端自己创建、生命周期单独管理的 fd 不走这里。
     */
    release(fd: number): void {
        const count = this.refs.get(fd);
        if (count === undefined) return;
        if (count > 1) {
            this.refs.set(fd, count - 1);
            return;
        }
        this.refs.delete(fd);
        try {
            fs.closeSync(fd);
        } catch {
            // 已经被关掉（异常路径重复释放）时不再报错
        }
    }

    /** 连接断开：关掉还登记着的全部 fd */
    closeAll(): void {
        for (const fd of this.refs.keys()) {
            try {
                fs.closeSync(fd);
            } catch {
                // ignore
            }
        }
        this.refs.clear();
    }
}
