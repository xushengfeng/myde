import * as zlib from "node:zlib";

export type DecodedPng = {
    width: number;
    height: number;
    /** 每像素通道数：1 灰度、2 灰度+alpha、3 RGB、4 RGBA */
    channels: number;
    /** 按行紧密排列的 8 位样本，长度为 width * height * channels */
    data: Uint8Array;
};

type Header = {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    interlace: number;
};

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * 解一张 8 位、非隔行的 PNG（Chromium 截屏的输出格式）。
 *
 * 支持灰度、RGB、灰度+alpha、RGBA 和调色板；遇到 16 位或 Adam7 直接抛错，
 * 因为测试里只会拿到 Chromium 生成的截图，不为了兼容全部 PNG 规范增加代码。
 */
export function decodePng(png: Uint8Array): DecodedPng {
    for (let i = 0; i < SIGNATURE.length; i++) {
        if (png[i] !== SIGNATURE[i]) throw new Error("不是 PNG 文件");
    }
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let offset = 8;
    let header: Header | undefined;
    let palette: Uint8Array | undefined;
    const idat: Uint8Array[] = [];
    while (offset + 8 <= png.byteLength) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
        const start = offset + 8;
        if (start + length > png.byteLength) throw new Error("PNG 数据被截断");
        if (type === "IHDR") {
            header = {
                width: view.getUint32(start),
                height: view.getUint32(start + 4),
                bitDepth: png[start + 8],
                colorType: png[start + 9],
                interlace: png[start + 12],
            };
        } else if (type === "PLTE") {
            palette = png.subarray(start, start + length);
        } else if (type === "IDAT") {
            idat.push(png.subarray(start, start + length));
        } else if (type === "IEND") {
            break;
        }
        offset = start + length + 4; // 跳过 CRC
    }
    if (!header) throw new Error("PNG 缺少 IHDR");
    if (header.bitDepth !== 8) throw new Error(`PNG 位深 ${header.bitDepth} 不支持，只支持 8 位`);
    if (header.interlace !== 0) throw new Error("PNG 隔行扫描不支持");
    const channels = CHANNELS_BY_COLOR_TYPE[header.colorType];
    if (channels === undefined) throw new Error(`PNG 颜色类型 ${header.colorType} 不支持`);
    if (header.colorType === 3 && !palette) throw new Error("调色板 PNG 缺少 PLTE");

    const inflated = zlib.inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
    const { width, height } = header;
    const stride = width * channels;
    const data = new Uint8Array(stride * height);
    let source = 0;
    for (let y = 0; y < height; y++) {
        const filter = inflated[source++];
        const row = y * stride;
        const prior = row - stride;
        for (let x = 0; x < stride; x++) {
            const raw = inflated[source + x];
            const left = x >= channels ? data[row + x - channels] : 0;
            const up = y > 0 ? data[prior + x] : 0;
            const upLeft = y > 0 && x >= channels ? data[prior + x - channels] : 0;
            let value: number;
            switch (filter) {
                case 0:
                    value = raw;
                    break;
                case 1:
                    value = raw + left;
                    break;
                case 2:
                    value = raw + up;
                    break;
                case 3:
                    value = raw + ((left + up) >> 1);
                    break;
                case 4:
                    value = raw + paeth(left, up, upLeft);
                    break;
                default:
                    throw new Error(`PNG 行过滤类型 ${filter} 不支持`);
            }
            data[row + x] = value & 0xff;
        }
        source += stride;
    }

    if (header.colorType === 3) {
        const rgb = new Uint8Array(width * height * 3);
        const colors = palette as Uint8Array;
        for (let i = 0; i < width * height; i++) {
            const index = data[i] * 3;
            rgb[i * 3] = colors[index] ?? 0;
            rgb[i * 3 + 1] = colors[index + 1] ?? 0;
            rgb[i * 3 + 2] = colors[index + 2] ?? 0;
        }
        return { width, height, channels: 3, data: rgb };
    }
    return { width, height, channels, data };
}

function paeth(left: number, up: number, upLeft: number) {
    const p = left + up - upLeft;
    const pa = Math.abs(p - left);
    const pb = Math.abs(p - up);
    const pc = Math.abs(p - upLeft);
    if (pa <= pb && pa <= pc) return left;
    if (pb <= pc) return up;
    return upLeft;
}

/** 把解码结果转成亮度图；忽略 alpha（截屏没有透明度变化可测）。 */
export function toLuma(image: DecodedPng): Uint8Array {
    const count = image.width * image.height;
    const luma = new Uint8Array(count);
    const data = image.data;
    if (image.channels === 1) {
        luma.set(data.subarray(0, count));
        return luma;
    }
    if (image.channels === 2) {
        for (let i = 0; i < count; i++) luma[i] = data[i * 2];
        return luma;
    }
    const step = image.channels;
    for (let i = 0; i < count; i++) {
        const offset = i * step;
        // 整数近似 Rec.601 亮度，够区分“变了”和“没变”
        luma[i] = (data[offset] * 77 + data[offset + 1] * 150 + data[offset + 2] * 29) >> 8;
    }
    return luma;
}
