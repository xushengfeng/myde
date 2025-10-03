export function createFormatTableBuffer(pairs: { format: number; modifier: bigint }[]): Buffer {
    const buf = Buffer.alloc(pairs.length * 16);
    for (let i = 0; i < pairs.length; i++) {
        const offset = i * 16;
        buf.writeUInt32LE(pairs[i].format, offset); // 格式，4字节
        buf.writeUInt32LE(0, offset + 4); // 填充，4字节
        buf.writeBigUInt64LE(pairs[i].modifier, offset + 8); // 修饰符，8字节
    }
    return buf;
}
