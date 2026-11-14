const crypto = require("node:crypto") as typeof import("node:crypto");
const path = require("node:path") as typeof import("node:path");

/**
 * socket 名带进程号和随机后缀。
 * 同一用户下可能同时有多个实例（桌面、并行测试、调试服务），固定名字会让
 * 后启动的一方 unlink 掉前一个的 socket 文件，或让客户端连到错误的服务端。
 */
export function uniqueSocketName(prefix: string): string {
    return `${prefix}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
}

/** 唯一 socket 路径；需要扩展名时由调用方传入。 */
export function uniqueSocketPath(dir: string, prefix: string, ext = ""): string {
    return path.join(dir, uniqueSocketName(prefix) + ext);
}
