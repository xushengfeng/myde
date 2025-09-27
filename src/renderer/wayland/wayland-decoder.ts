export class WaylandDecoder {
    private view: DataView;
    private offset: number;
    private fds: number[];
    private fdIndex: number;

    constructor(buffer: ArrayBufferLike, fds: number[] = []) {
        this.view = new DataView(buffer);
        this.offset = 0;
        this.fds = fds;
        this.fdIndex = 0;
    }

    readHeader(): { objectId: number; opcode: number; length: number } {
        const objectId = this.view.getUint32(this.offset, true);
        const opcode = this.view.getUint16(this.offset + 4, true);
        const length = this.view.getUint16(this.offset + 6, true);
        this.offset += 8;
        return { objectId, opcode, length };
    }

    readInt(): number {
        const value = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return value;
    }

    readUint(): number {
        const value = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return value;
    }

    readFixed(): number {
        const fixedValue = this.readInt();
        return fixedValue / 65536; // 转换为浮点数
    }

    readString(): string {
        const length = this.readUint();
        const stringData = new Uint8Array(this.view.buffer, this.offset, length - 1); // 排除null终止符

        const decoder = new TextDecoder();
        const result = decoder.decode(stringData);

        this.offset += length;

        // 跳过填充
        const padding = (4 - (length % 4)) % 4;
        this.offset += padding;

        return result;
    }

    readObject(): number {
        return this.readUint();
    }

    readNewId(): number {
        return this.readUint(); // 返回新对象的ID
    }

    readArray() {
        const length = this.readUint();
        const arrayData = this.view.buffer.slice(this.offset, this.offset + length);
        this.offset += length;

        // 跳过填充
        const padding = (4 - (length % 4)) % 4;
        this.offset += padding;

        return arrayData;
    }

    readFileDescriptor(): number | null {
        if (this.fdIndex < this.fds.length) {
            return this.fds[this.fdIndex++];
        }
        return null;
    }

    getRemainingBytes(): number {
        return this.view.byteLength - this.offset;
    }
}
