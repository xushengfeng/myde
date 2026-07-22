import type { InputDevice, InputEvent } from "../input";
import { EventEmitter } from "../../event-emitter/event-emitter";

export interface FsLike {
    openSync(path: string, flags: string | number): number;
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
    read(
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
        callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void,
    ): void;
    closeSync(fd: number): void;
    constants?: {
        O_RDONLY: number;
        O_NONBLOCK: number;
    };
}

export type EvdevReaderEvents = {
    event: [InputEvent];
    error: [Error];
    close: [];
};

export class EvdevReader extends EventEmitter<EvdevReaderEvents> {
    private fd: number = -1;
    private readonly EVENT_SIZE = 24;
    private device: InputDevice;
    private fs: FsLike;
    private running = false;
    private readBuffer: Buffer;

    constructor(device: InputDevice, fs: FsLike) {
        super();
        this.device = device;
        this.fs = fs;
        // 增加缓冲区大小到 1024 个事件 (约 24KB)。
        // 之前只有 16 个事件，导致高回报率的鼠标稍微快速移动就会填满缓冲区，
        // 从而被切分成多个极小的读取碎片，产生每次重新进入 libuv 线程池的调度开销，表现出明显的"掉帧"、"卡顿"或"不跟手"感。
        this.readBuffer = Buffer.alloc(this.EVENT_SIZE * 1024);
    }

    open(): void {
        try {
            // 注意：不要使用 O_NONBLOCK。我们将使用阻塞读取，依靠 Node.js 的线程池进行真正的异步等待。
            // 必须在主进程/入口处设置 process.env.UV_THREADPOOL_SIZE = '128' (或者更高)，
            // 否则默认的 4 个线程会被输入设备占满，导致其他 fs 操作卡死！
            this.fd = this.fs.openSync(this.device.path, "r");
            this.running = true;
            this.readLoop();
        } catch (err) {
            this.emit("error", err as Error);
        }
    }

    private readLoop(): void {
        if (!this.running || this.fd < 0) return;

        // 这里使用基于回调的异步 read。在不设置 O_NONBLOCK 时，这个调用会阻塞在 libuv 的线程池中。
        // 这就是为什么 C/C++ 桌面不卡（它们用 epoll，0 线程占用）而 Node 默认会卡（占满 4 个默认线程）。
        // 只要调大了 UV_THREADPOOL_SIZE，这种方式就能实现和 C/C++ 一样的高性能、0 延迟、0 轮询开销。
        this.fs.read(
            this.fd,
            this.readBuffer,
            0,
            this.readBuffer.length,
            null,
            (err: NodeJS.ErrnoException | null, bytesRead: number) => {
                if (!this.running || this.fd < 0) return;

                if (err) {
                    if (err.code !== "EAGAIN" && err.code !== "EWOULDBLOCK") {
                        this.emit("error", err);
                        return;
                    }
                } else if (bytesRead > 0) {
                    const eventCount = Math.floor(bytesRead / this.EVENT_SIZE);
                    for (let i = 0; i < eventCount; i++) {
                        const offset = i * this.EVENT_SIZE;
                        const event = this.parseEvent(this.readBuffer, offset);
                        this.emit("event", event);
                    }
                }

                this.readLoop();
            },
        );
    }

    close(): void {
        this.running = false;
        if (this.fd >= 0) {
            try {
                this.fs.closeSync(this.fd);
            } catch {
                // ignore
            }
            this.fd = -1;
        }
        this.emit("close");
    }

    private parseEvent(buf: Buffer, offset: number): InputEvent {
        const sec = Number(buf.readBigInt64LE(offset));
        const usec = Number(buf.readBigInt64LE(offset + 8));

        return {
            device: this.device,
            type: buf.readUInt16LE(offset + 16),
            code: buf.readUInt16LE(offset + 18),
            value: buf.readInt32LE(offset + 20),
            timestamp: sec * 1_000_000 + usec,
        };
    }
}