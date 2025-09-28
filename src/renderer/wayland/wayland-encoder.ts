import type { WaylandObjectId } from "./wayland-binary";

export class WaylandEncoder {
    private buffer: ArrayBuffer;
    private view: DataView;
    private offset: number;
    private fds: number[] = [];

    constructor(initialSize = 1024) {
        this.buffer = new ArrayBuffer(initialSize);
        this.view = new DataView(this.buffer);
        this.offset = 0;
    }

    // 写入消息头：object_id (32位) + opcode (16位) + 消息长度 (16位)
    writeHeader(objectId: WaylandObjectId, opcode: number): void {
        this.ensureCapacity(8);
        this.view.setUint32(this.offset, objectId, true);
        this.view.setUint16(this.offset + 4, opcode, true);
        // 长度先写0，最后填充
        this.view.setUint16(this.offset + 6, 0, true);
        this.offset += 8;
    }

    writeInt(value: number): void {
        this.ensureCapacity(4);
        this.view.setInt32(this.offset, value, true);
        this.offset += 4;
    }

    writeUint(value: number): void {
        this.ensureCapacity(4);
        this.view.setUint32(this.offset, value, true);
        this.offset += 4;
    }

    writeFixed(value: number): void {
        // fixed类型是32位定点数，小数点后16位
        const fixedValue = Math.round(value * 65536);
        this.writeInt(fixedValue);
    }

    writeString(value: string): void {
        const encoder = new TextEncoder();
        const stringBytes = encoder.encode(`${value}\0`); // C风格字符串以null结尾

        this.writeUint(stringBytes.length); // 长度包含null终止符
        this.ensureCapacity(stringBytes.length);

        new Uint8Array(this.buffer, this.offset).set(stringBytes);
        this.offset += stringBytes.length;

        // 字符串后需要填充到4字节对齐
        const padding = (4 - (stringBytes.length % 4)) % 4;
        this.ensureCapacity(padding);
        this.offset += padding;
    }

    writeObject(objectId: number): void {
        this.writeUint(objectId);
    }

    writeNewId(interfaceName: string, version: number): void {
        // new_id在客户端请求中需要指定接口，在服务端事件中返回新对象ID
        this.writeUint(0); // 占位，实际由接收方填充
    }

    writeArray(data: ArrayBuffer): void {
        this.writeUint(data.byteLength);
        this.ensureCapacity(data.byteLength);
        new Uint8Array(this.buffer, this.offset).set(new Uint8Array(data));
        this.offset += data.byteLength;

        // 数组后需要填充到4字节对齐
        const padding = (4 - (data.byteLength % 4)) % 4;
        this.ensureCapacity(padding);
        this.offset += padding;
    }

    addFileDescriptor(fd: number): void {
        this.fds.push(fd);
        // fd在消息体中不占空间，通过SCM_RIGHTS传递
    }

    // 完成消息并返回最终缓冲区
    finalizeMessage(): { data: ArrayBuffer; fds: number[] } {
        // 更新消息长度
        const messageLength = this.offset;
        this.view.setUint16(6, messageLength, true);

        // 返回实际使用的缓冲区
        const resultBuffer = this.buffer.slice(0, messageLength);
        const resultFds = [...this.fds];

        // 重置状态（可以复用编码器）
        this.buffer = new ArrayBuffer(1024);
        this.view = new DataView(this.buffer);
        this.offset = 0;
        this.fds = [];

        return { data: resultBuffer, fds: resultFds };
    }

    private ensureCapacity(needed: number): void {
        if (this.offset + needed <= this.buffer.byteLength) {
            return;
        }

        // 扩容
        const newSize = Math.max(this.buffer.byteLength * 2, this.offset + needed);
        const newBuffer = new ArrayBuffer(newSize);
        new Uint8Array(newBuffer).set(new Uint8Array(this.buffer));
        this.buffer = newBuffer;
        this.view = new DataView(this.buffer);
    }
}
