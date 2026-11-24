import type { Readable } from "node:stream";
import { EventEmitter } from "../event-emitter/event-emitter";

export type AppProcessEvents = {
    /** 进程结束；signal 用字符串，helper 代启动时要跨进程传 */
    exit: [code: number | null, signal: string | null];
    /** 启动失败（如可执行文件不存在） */
    error: [error: Error];
};

/**
 * runApp 返回的应用句柄。
 *
 * 本地 spawn 和 session helper 代启动共用同一套事件：helper 代启动时应用在登录
 * 会话的 cgroup 里，pid 由 helper 异步回传，stdout/stderr 也由 helper 直接写日志。
 */
export class AppProcess extends EventEmitter<AppProcessEvents> {
    pid?: number;
    /** 退出码；没退出或未拿到时为 null */
    exitCode: number | null = null;
    /** 只有本地 spawn 才有管道；helper 代启动时输出直接进应用日志 */
    stdout?: Readable;
    stderr?: Readable;

    private readonly stop?: (signal?: NodeJS.Signals) => boolean;

    constructor(pid?: number, stop?: (signal?: NodeJS.Signals) => boolean) {
        super();
        this.pid = pid;
        this.stop = stop;
    }

    /** 请求结束进程；helper 代启动时经 IPC 转给 helper */
    kill(signal?: NodeJS.Signals): boolean {
        if (!this.stop) return false;
        try {
            return this.stop(signal);
        } catch {
            return false;
        }
    }
}
