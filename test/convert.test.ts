import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
    convertDmabufToRgba,
    convertShmToRgba,
    convertShmToRgbaRegion,
    DRM_FORMAT,
    getElectronPixelFormat,
    getFormatInfo,
    isSupportedFormat,
    needsConversion,
} from "../src/index";

type Rgba = [number, number, number, number];
type Encoder = (pixel: Rgba) => [number, number, number, number];

const CASES: { name: string; format: number; encode: Encoder }[] = [
    { name: "ARGB8888", format: DRM_FORMAT.ARGB8888, encode: ([r, g, b, a]) => [b, g, r, a] },
    { name: "ABGR8888", format: DRM_FORMAT.ABGR8888, encode: ([r, g, b, a]) => [r, g, b, a] },
    { name: "RGBA8888", format: DRM_FORMAT.RGBA8888, encode: ([r, g, b, a]) => [a, b, g, r] },
    { name: "BGRA8888", format: DRM_FORMAT.BGRA8888, encode: ([r, g, b, a]) => [a, r, g, b] },
    // X is 0, so a converter that reads it as alpha would produce transparent pixels.
    { name: "XRGB8888", format: DRM_FORMAT.XRGB8888, encode: ([r, g, b]) => [b, g, r, 0] },
    { name: "XBGR8888", format: DRM_FORMAT.XBGR8888, encode: ([r, g, b]) => [r, g, b, 0] },
    { name: "RGBX8888", format: DRM_FORMAT.RGBX8888, encode: ([r, g, b]) => [0, b, g, r] },
    { name: "BGRX8888", format: DRM_FORMAT.BGRX8888, encode: ([r, g, b]) => [0, r, g, b] },
];

const PIXELS: Rgba[] = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 14, 15, 16],
    [17, 18, 19, 20],
    [21, 22, 23, 24],
];

const directory = mkdtempSync(join(tmpdir(), "myde-drm-"));

afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
});

function writePlane(
    format: number,
    encode: Encoder,
    pixels: Rgba[],
    width: number,
    height: number,
    stride: number,
    offset: number,
): string {
    const path = join(directory, `${format.toString(16)}-${width}x${height}.bin`);
    const data = Buffer.alloc(offset + stride * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = encode(pixels[y * width + x]);
            data.set(pixel, offset + y * stride + x * 4);
        }
    }
    writeFileSync(path, data);
    return path;
}

function convert(
    path: string,
    options: {
        width: number;
        height: number;
        format: number;
        stride: number;
        offset: number;
        modifier?: bigint | string;
    },
): Buffer {
    const fd = openSync(path, "r");
    try {
        return convertDmabufToRgba({
            width: options.width,
            height: options.height,
            format: options.format,
            modifier: options.modifier,
            planes: [{ fd, offset: options.offset, stride: options.stride }],
        });
    } finally {
        closeSync(fd);
    }
}

describe("format mapping", () => {
    it("passes Electron-supported formats through", () => {
        expect(getElectronPixelFormat(DRM_FORMAT.ARGB8888)).toBe("bgra");
        expect(getElectronPixelFormat(DRM_FORMAT.ABGR8888)).toBe("rgba");
        expect(getElectronPixelFormat(DRM_FORMAT.NV12)).toBe("nv12");
        expect(getElectronPixelFormat(DRM_FORMAT.NV16)).toBe("nv16");
        expect(getElectronPixelFormat(DRM_FORMAT.P010)).toBe("p010le");

        expect(needsConversion(DRM_FORMAT.ARGB8888)).toBe(false);
        expect(needsConversion(DRM_FORMAT.NV12)).toBe(false);
    });

    it("reports formats that need conversion", () => {
        const direct: Record<string, string> = {
            ARGB8888: "bgra",
            ABGR8888: "rgba",
        };
        for (const { name, format } of CASES) {
            const info = getFormatInfo(format);
            expect(info, name).not.toBeNull();
            expect(info?.name).toBe(`DRM_FORMAT_${name}`);
            if (direct[name]) {
                expect(info?.needsConversion, name).toBe(false);
                expect(getElectronPixelFormat(format), name).toBe(direct[name]);
            } else {
                expect(info?.needsConversion, name).toBe(true);
                expect(getElectronPixelFormat(format), name).toBeNull();
            }
        }
    });

    it("rejects unknown fourcc values", () => {
        expect(getFormatInfo(0x12345678)).toBeNull();
        expect(isSupportedFormat(0x12345678)).toBe(false);
        expect(needsConversion(0x12345678)).toBe(false);
    });
});

describe("convertDmabufToRgba", () => {
    for (const { name, format, encode } of CASES) {
        it(`converts ${name} to tightly packed RGBA`, () => {
            const width = 3;
            const height = 2;
            const stride = width * 4 + 16;
            const offset = 64;
            const pixels = PIXELS.slice(0, width * height);
            const path = writePlane(format, encode, pixels, width, height, stride, offset);

            const rgba = convert(path, { width, height, format, stride, offset });

            expect(rgba.length).toBe(width * height * 4);
            const isOpaqueX = name.includes("X");
            const expected = pixels.flatMap(([r, g, b, a]) => [r, g, b, isOpaqueX ? 255 : a]);
            expect(Array.from(rgba)).toEqual(expected);
        });
    }

    it("supports a zero offset", () => {
        const width = 1;
        const height = 1;
        const path = writePlane(DRM_FORMAT.XBGR8888, CASES[5].encode, [[1, 2, 3, 0]], width, height, 4, 0);
        expect(Array.from(convert(path, { width, height, format: DRM_FORMAT.XBGR8888, stride: 4, offset: 0 }))).toEqual(
            [1, 2, 3, 255],
        );
    });

    it("rejects non-linear modifiers", () => {
        const path = join(directory, "modifier.bin");
        writeFileSync(path, Buffer.alloc(64));
        const fd = openSync(path, "r");
        try {
            expect(() =>
                convertDmabufToRgba({
                    width: 2,
                    height: 2,
                    format: DRM_FORMAT.XRGB8888,
                    modifier: 0x0100000000000001n,
                    planes: [{ fd, stride: 8 }],
                }),
            ).toThrow(/DRM_FORMAT_MOD_LINEAR/);
        } finally {
            closeSync(fd);
        }
    });

    it("rejects a stride smaller than width * 4", () => {
        const path = join(directory, "stride.bin");
        writeFileSync(path, Buffer.alloc(64));
        expect(() => convert(path, { width: 4, height: 1, format: DRM_FORMAT.ARGB8888, stride: 8, offset: 0 })).toThrow(
            /stride/,
        );
    });

    it("rejects planes other than 32-bit RGB", () => {
        const path = join(directory, "nv12.bin");
        writeFileSync(path, Buffer.alloc(64));
        expect(() => convert(path, { width: 2, height: 2, format: DRM_FORMAT.NV12, stride: 4, offset: 0 })).toThrow(
            /not a 32-bit RGB format/,
        );
    });

    it("rejects more than one plane", () => {
        const path = join(directory, "two-planes.bin");
        writeFileSync(path, Buffer.alloc(64));
        const fd = openSync(path, "r");
        try {
            expect(() =>
                convertDmabufToRgba({
                    width: 2,
                    height: 2,
                    format: DRM_FORMAT.XRGB8888,
                    planes: [
                        { fd, stride: 8 },
                        { fd, stride: 8 },
                    ],
                }),
            ).toThrow(/exactly one plane/);
        } finally {
            closeSync(fd);
        }
    });
});

describe("convertShmToRgba", () => {
    function convertShm(
        path: string,
        options: { width: number; height: number; format: number; stride: number; offset?: number },
    ): Buffer {
        const fd = openSync(path, "r");
        try {
            return convertShmToRgba({ fd, ...options });
        } finally {
            closeSync(fd);
        }
    }

    for (const { name, format, encode } of CASES) {
        it(`converts ${name} to tightly packed RGBA`, () => {
            const width = 3;
            const height = 2;
            const stride = width * 4 + 16;
            const offset = 64;
            const pixels = PIXELS.slice(0, width * height);
            const path = writePlane(format, encode, pixels, width, height, stride, offset);

            const rgba = convertShm(path, { width, height, format, stride, offset });

            expect(rgba.length).toBe(width * height * 4);
            const isOpaqueX = name.includes("X");
            const expected = pixels.flatMap(([r, g, b, a]) => [r, g, b, isOpaqueX ? 255 : a]);
            expect(Array.from(rgba)).toEqual(expected);
        });
    }

    it("defaults the offset to zero", () => {
        const path = writePlane(DRM_FORMAT.ARGB8888, CASES[0].encode, [[1, 2, 3, 4]], 1, 1, 4, 0);
        expect(Array.from(convertShm(path, { width: 1, height: 1, format: DRM_FORMAT.ARGB8888, stride: 4 }))).toEqual([
            1, 2, 3, 4,
        ]);
    });

    it("maps the legacy wl_shm argb8888/xrgb8888 values", () => {
        const argb = writePlane(DRM_FORMAT.ARGB8888, CASES[0].encode, [[1, 2, 3, 4]], 1, 1, 4, 0);
        expect(Array.from(convertShm(argb, { width: 1, height: 1, format: 0, stride: 4 }))).toEqual([1, 2, 3, 4]);

        const xrgb = writePlane(DRM_FORMAT.XRGB8888, CASES[4].encode, [[1, 2, 3, 0]], 1, 1, 4, 0);
        expect(Array.from(convertShm(xrgb, { width: 1, height: 1, format: 1, stride: 4 }))).toEqual([1, 2, 3, 255]);
    });

    it("writes into a caller-provided Buffer", () => {
        const width = 2;
        const height = 2;
        const pixels = PIXELS.slice(0, width * height);
        const path = writePlane(DRM_FORMAT.ARGB8888, CASES[0].encode, pixels, width, height, 8, 0);
        const fd = openSync(path, "r");
        const out = Buffer.allocUnsafe(width * height * 4);
        try {
            const returned = convertShmToRgba({ fd, width, height, format: DRM_FORMAT.ARGB8888, stride: 8 }, out);
            expect(returned).toBe(out);
        } finally {
            closeSync(fd);
        }
        const expected = pixels.flatMap(([r, g, b, a]) => [r, g, b, a]);
        expect(Array.from(out)).toEqual(expected);
    });

    it("rejects a wrong-sized output Buffer", () => {
        const path = writePlane(DRM_FORMAT.ARGB8888, CASES[0].encode, [[1, 2, 3, 4]], 1, 1, 4, 0);
        const fd = openSync(path, "r");
        try {
            expect(() =>
                convertShmToRgba({ fd, width: 1, height: 1, format: DRM_FORMAT.ARGB8888, stride: 4 }, Buffer.alloc(3)),
            ).toThrow(/exactly 4 bytes/);
        } finally {
            closeSync(fd);
        }
    });

    it("converts only the requested region", () => {
        const width = 3;
        const height = 2;
        const stride = width * 4 + 8;
        const pixels = PIXELS.slice(0, width * height);
        const path = writePlane(DRM_FORMAT.ARGB8888, CASES[0].encode, pixels, width, height, stride, 16);
        const fd = openSync(path, "r");
        const out = Buffer.alloc(width * height * 4, 0xaa);
        try {
            convertShmToRgbaRegion({ fd, width, height, format: DRM_FORMAT.ARGB8888, stride, offset: 16 }, out, {
                x: 1,
                y: 1,
                width: 2,
                height: 1,
            });
        } finally {
            closeSync(fd);
        }

        const expected = Buffer.alloc(width * height * 4, 0xaa);
        for (const x of [1, 2]) {
            const [r, g, b, a] = pixels[width + x];
            expected.set([r, g, b, a], (width + x) * 4);
        }
        expect(Array.from(out)).toEqual(Array.from(expected));
    });

    it("rejects a region outside the buffer", () => {
        const path = writePlane(DRM_FORMAT.ARGB8888, CASES[0].encode, [[1, 2, 3, 4]], 1, 1, 4, 0);
        const fd = openSync(path, "r");
        try {
            expect(() =>
                convertShmToRgbaRegion(
                    { fd, width: 1, height: 1, format: DRM_FORMAT.ARGB8888, stride: 4 },
                    Buffer.alloc(4),
                    { x: 1, y: 0, width: 1, height: 1 },
                ),
            ).toThrow(/outside/);
        } finally {
            closeSync(fd);
        }
    });

    it("treats a short pool as transparent black", () => {
        const path = join(directory, "short-pool.bin");
        writeFileSync(path, Buffer.from([3, 2, 1, 255]));
        const rgba = convertShm(path, { width: 2, height: 1, format: DRM_FORMAT.ARGB8888, stride: 8 });
        expect(Array.from(rgba)).toEqual([1, 2, 3, 255, 0, 0, 0, 0]);
    });

    it("rejects a stride smaller than width * 4", () => {
        const path = join(directory, "shm-stride.bin");
        writeFileSync(path, Buffer.alloc(64));
        expect(() => convertShm(path, { width: 4, height: 1, format: DRM_FORMAT.ARGB8888, stride: 8 })).toThrow(
            /stride/,
        );
    });

    it("rejects formats that are not 32-bit RGB", () => {
        const path = join(directory, "shm-nv12.bin");
        writeFileSync(path, Buffer.alloc(64));
        expect(() => convertShm(path, { width: 2, height: 2, format: DRM_FORMAT.NV12, stride: 4 })).toThrow(
            /not a 32-bit RGB format/,
        );
    });
});
