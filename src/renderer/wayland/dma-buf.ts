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

function fourcc_code(a: string, b: string, c: string, d: string): number {
    return (
        ((a.charCodeAt(0) & 0xff) |
            ((b.charCodeAt(0) & 0xff) << 8) |
            ((c.charCodeAt(0) & 0xff) << 16) |
            ((d.charCodeAt(0) & 0xff) << 24)) >>>
        0
    );
}

export enum DRM_FORMAT {
    DRM_FORMAT_XRGB8888 = fourcc_code("X", "R", "2", "4"),
    DRM_FORMAT_XBGR8888 = fourcc_code("X", "B", "2", "4"),
    DRM_FORMAT_RGBX8888 = fourcc_code("R", "X", "2", "4"),
    DRM_FORMAT_BGRX8888 = fourcc_code("B", "X", "2", "4"),
    DRM_FORMAT_ARGB8888 = fourcc_code("A", "R", "2", "4"),
    DRM_FORMAT_ABGR8888 = fourcc_code("A", "B", "2", "4"),
    DRM_FORMAT_RGBA8888 = fourcc_code("R", "A", "2", "4"),
    DRM_FORMAT_BGRA8888 = fourcc_code("B", "A", "2", "4"),
}
