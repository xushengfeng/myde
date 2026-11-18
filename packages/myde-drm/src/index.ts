import { closeSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// In the CJS build `__filename` exists; in the ESM build fall back to
// `import.meta.url`. Avoid Vite's browser-oriented `import.meta.url` shim,
// which resolves relative to the renderer HTML when `document` exists.
const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);

const packageRoot =
    typeof __dirname === "string" ? join(__dirname, "..") : dirname(dirname(fileURLToPath(import.meta.url)));

interface NativeTexture {
    fd: number;
    offset: number;
    stride: number;
    size: number;
    modifier: string;
    slot: number;
}

interface NativeModule {
    drmFormatName(format: number): string | null;
    electronPixelFormat(format: number): ElectronPixelFormat | null;
    isSupportedFormat(format: number): boolean;
    needsConversion(format: number): boolean;
    convertDmabufToRgba(
        fd: number,
        offset: number,
        stride: number,
        width: number,
        height: number,
        format: number,
    ): Buffer;
    convertShmToRgba(fd: number, offset: number, stride: number, width: number, height: number, format: number): Buffer;
    convertShmToRgbaInto(
        out: Buffer,
        fd: number,
        offset: number,
        stride: number,
        width: number,
        height: number,
        format: number,
    ): Buffer;
    convertShmToRgbaRegion(
        out: Buffer,
        fd: number,
        offset: number,
        stride: number,
        width: number,
        height: number,
        format: number,
        x: number,
        y: number,
        regionWidth: number,
        regionHeight: number,
    ): Buffer;
    releaseDmabufTexture(slot: number): void;
    convertDmabufToTexture(
        fd: number,
        offset: number,
        stride: number,
        width: number,
        height: number,
        format: number,
        owner: string,
    ): NativeTexture | null;
}

function loadNative(): NativeModule {
    const prebuilt = join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "index.node");
    const legacy = join(packageRoot, "index.node");

    if (existsSync(prebuilt)) return require(prebuilt) as NativeModule;
    if (existsSync(legacy)) return require(legacy) as NativeModule;

    throw new Error(`myde-drm: 没有 ${process.platform}-${process.arch} 的原生模块，请先运行 pnpm build:native`);
}

const native = loadNative();

/** DRM fourcc values, as used by linux-dmabuf. */
export const DRM_FORMAT = {
    ARGB8888: 0x34325241, // AR24
    ABGR8888: 0x34324241, // AB24
    RGBA8888: 0x34324152, // RA24
    BGRA8888: 0x34324142, // BA24
    XRGB8888: 0x34325258, // XR24
    XBGR8888: 0x34324258, // XB24
    RGBX8888: 0x34325852, // RX24
    BGRX8888: 0x34325842, // BX24
    NV12: 0x3231564e,
    NV16: 0x3631564e,
    P010: 0x30313050,
} as const;

export type DrmFormat = (typeof DRM_FORMAT)[keyof typeof DRM_FORMAT];

/** `DRM_FORMAT_MOD_LINEAR`. The converter only accepts this modifier. */
export const DRM_FORMAT_MOD_LINEAR = 0n;

/** `DRM_FORMAT_MOD_INVALID`, sent by clients when no modifier was negotiated. */
export const DRM_FORMAT_MOD_INVALID = 0x00ffffffffffffffn;

/** Pixel formats accepted by Electron's `sharedTexture.importSharedTexture`. */
export type ElectronPixelFormat = "bgra" | "rgba" | "rgbaf16" | "nv12" | "nv16" | "p010le";

export interface DmabufPlane {
    /** dma-buf file descriptor. The module never closes it. */
    fd: number;
    /** Byte offset of the plane inside the dma-buf. Defaults to 0. */
    offset?: number;
    /** Bytes per row, including padding. */
    stride: number;
    /** Optional plane size, kept for compatibility with Electron's plane shape. */
    size?: number;
}

export interface ConvertDmabufToRgbaOptions {
    width: number;
    height: number;
    /**
     * 拷贝池的 owner（通常是 client + surface）。池只会在同一个 owner 内复用
     * 拷贝缓冲；别的 owner 只能回收已空闲足够久的槽位，避免窗口之间串内容。
     */
    owner?: string;
    /** DRM fourcc, see `DRM_FORMAT`. */
    format: number;
    /**
     * DRM format modifier. Only `DRM_FORMAT_MOD_LINEAR` (0) is supported.
     * Defaults to 0.
     */
    modifier?: bigint | string | number;
    /** 32-bit formats use exactly one plane. */
    planes: DmabufPlane[];
}

export interface DrmFormatInfo {
    /** e.g. `DRM_FORMAT_XRGB8888`. */
    name: string;
    /** Format to pass to Electron, or `null` when a conversion is required. */
    electronPixelFormat: ElectronPixelFormat | null;
    /** `true` when Electron cannot import the format directly and it must be converted. */
    needsConversion: boolean;
}

/**
 * Describe a DRM fourcc.
 *
 * Returns `null` for formats this module does not know.
 */
export function getFormatInfo(format: number): DrmFormatInfo | null {
    const name = native.drmFormatName(format);
    if (name === null) return null;
    const electronPixelFormat = native.electronPixelFormat(format);
    return {
        name,
        electronPixelFormat,
        needsConversion: electronPixelFormat === null,
    };
}

/**
 * The Electron pixel format for a DRM fourcc, or `null` if Electron cannot
 * import the buffer directly.
 *
 * ARGB8888/ABGR8888 and NV12/NV16/P010 pass through; the XRGB/XBGR/RGBX/BGRX
 * and RGBA/BGRA families need conversion (alpha handling or channel order).
 */
export function getElectronPixelFormat(format: number): ElectronPixelFormat | null {
    return native.electronPixelFormat(format);
}

/** Whether this module recognizes the DRM fourcc (directly usable or convertible). */
export function isSupportedFormat(format: number): boolean {
    return native.isSupportedFormat(format);
}

/** Whether `format` must be converted before Electron can use it. */
export function needsConversion(format: number): boolean {
    return native.needsConversion(format);
}

/**
 * A dmabuf produced by the GPU converter.
 *
 * `pixelFormat` is what to pass to Electron's `importSharedTexture`. Call
 * `close()` after the import has duplicated the fd.
 */
export interface ConvertedDmabufTexture {
    pixelFormat: "bgra";
    width: number;
    height: number;
    modifier: bigint;
    planes: DmabufPlane[];
    close(): void;
}

interface ValidatedDmabuf {
    width: number;
    height: number;
    format: number;
    modifier: bigint;
    plane: DmabufPlane;
    offset: number;
}

/**
 * Read a LINEAR 32-bit DRM dma-buf and return tightly packed RGBA pixels.
 *
 * The returned Buffer has `width * height * 4` bytes, ready for
 * `new ImageData(new Uint8ClampedArray(buffer), width, height)`.
 *
 * Only `DRM_FORMAT_MOD_LINEAR` is supported. NV12/NV16/P010 are not 32-bit
 * formats: pass them to Electron's `importSharedTexture` unchanged.
 *
 * @throws if the format cannot be converted, the modifier is not linear,
 *         stride/offset are invalid, or mmap fails.
 */
export function convertDmabufToRgba(options: ConvertDmabufToRgbaOptions): Buffer {
    const { width, height, format, plane, offset } = validateDmabuf(options);
    return native.convertDmabufToRgba(plane.fd, offset, plane.stride, width, height, format);
}

/**
 * Convert a LINEAR 32-bit DRM dma-buf into a new ARGB8888 dmabuf on the GPU.
 *
 * The result can be passed to Electron's `importSharedTexture` with
 * `pixelFormat: "bgra"`, keeping the GPU path instead of reading pixels back
 * to the CPU. Call `close()` once the import has duplicated the fd.
 *
 * Returns `null` when the GPU path is unavailable (no DRM render node, EGL
 * initialization failed, or the driver cannot import this dma-buf). Fall back
 * to `convertDmabufToRgba` in that case.
 */
export function convertDmabufToTexture(options: ConvertDmabufToRgbaOptions): ConvertedDmabufTexture | null {
    const { width, height, format, plane, offset } = validateDmabuf(options);
    const result = native.convertDmabufToTexture(
        plane.fd,
        offset,
        plane.stride,
        width,
        height,
        format,
        options.owner ?? "",
    );
    if (result === null) return null;

    let closed = false;
    return {
        pixelFormat: "bgra",
        width,
        height,
        modifier: BigInt(result.modifier),
        planes: [
            {
                fd: result.fd,
                offset: result.offset,
                stride: result.stride,
                size: result.size,
            },
        ],
        close() {
            if (closed) return;
            closed = true;
            closeSync(result.fd);
            // 把输出的 GBM buffer 还给池子；调用方要等消费者（Electron 的导入纹理）
            // 释放后再 close，槽位才会被下一帧复用。
            native.releaseDmabufTexture(result.slot);
        },
    };
}

export interface ConvertShmToRgbaOptions {
    width: number;
    height: number;
    /**
     * wl_shm format value. The protocol's legacy `argb8888` (0) and `xrgb8888`
     * (1) entries are mapped to their DRM fourcc; all other entries are
     * already DRM fourcc values, see `DRM_FORMAT`.
     */
    format: number;
    /** File descriptor of the wl_shm pool. The module never closes it. */
    fd: number;
    /** Byte offset of the buffer inside the pool. Defaults to 0. */
    offset?: number;
    /** Bytes per row, including padding. */
    stride: number;
}

/**
 * Read a wl_shm buffer and return tightly packed RGBA pixels.
 *
 * The pool is mmap'ed when it is large enough, so memfd, `shm_open` files and
 * regular files all work without a dma-buf round trip. An undersized pool
 * falls back to `pread`, and bytes beyond the end of the file stay transparent
 * black.
 *
 * Pass a `Buffer` as `into` to reuse the same output memory every frame
 * (avoiding a fresh `width * height * 4` allocation); it is returned as-is.
 *
 * Only the 32-bit RGB formats listed in the README are supported. Pass the
 * `format` from `wl_shm_pool.create_buffer` unchanged.
 *
 * @throws if the format cannot be converted, stride/offset are invalid, or
 *         `into` is not exactly `width * height * 4` bytes.
 */
interface ValidatedShm {
    width: number;
    height: number;
    fd: number;
    stride: number;
    offset: number;
    format: number;
}

function validateShm(options: ConvertShmToRgbaOptions): ValidatedShm {
    const { width, height, fd, stride } = options;
    assertPositiveInt(width, "width");
    assertPositiveInt(height, "height");
    assertPositiveInt(options.format, "format", true);
    assertPositiveInt(fd, "fd", true);
    assertPositiveInt(stride, "stride");
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error("offset must be a non-negative safe integer");
    }
    return { width, height, fd, stride, offset, format: normalizeShmFormat(options.format) };
}

function outputSize(width: number, height: number): number {
    const size = width * height * 4;
    if (!Number.isSafeInteger(size)) {
        throw new Error("output size overflows a safe integer");
    }
    return size;
}

export function convertShmToRgba(options: ConvertShmToRgbaOptions, into?: Buffer): Buffer {
    const { width, height, fd, stride, offset, format } = validateShm(options);

    if (into !== undefined) {
        if (!Buffer.isBuffer(into)) {
            throw new Error("into must be a Buffer");
        }
        const size = outputSize(width, height);
        if (into.byteLength !== size) {
            throw new Error(`into must be exactly ${size} bytes, got ${into.byteLength}`);
        }
        return native.convertShmToRgbaInto(into, fd, offset, stride, width, height, format);
    }
    return native.convertShmToRgba(fd, offset, stride, width, height, format);
}

export interface ShmRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Convert only `region` of a wl_shm buffer into a full-frame `into` Buffer.
 *
 * The returned Buffer is the same full-frame buffer; pixels outside `region`
 * are left untouched. This lets a compositor convert only the damage area,
 * reusing the previous RGBA contents for everything else.
 */
export function convertShmToRgbaRegion(options: ConvertShmToRgbaOptions, into: Buffer, region: ShmRegion): Buffer {
    const { width, height, fd, stride, offset, format } = validateShm(options);
    if (!Buffer.isBuffer(into)) {
        throw new Error("into must be a Buffer");
    }
    const size = outputSize(width, height);
    if (into.byteLength !== size) {
        throw new Error(`into must be exactly ${size} bytes, got ${into.byteLength}`);
    }
    assertPositiveInt(region.x, "region.x", true);
    assertPositiveInt(region.y, "region.y", true);
    assertPositiveInt(region.width, "region.width", true);
    assertPositiveInt(region.height, "region.height", true);
    if (region.x + region.width > width || region.y + region.height > height) {
        throw new Error(
            `region ${region.width}x${region.height}+${region.x}+${region.y} is outside the ${width}x${height} buffer`,
        );
    }
    if (region.width === 0 || region.height === 0) return into;

    return native.convertShmToRgbaRegion(
        into,
        fd,
        offset,
        stride,
        width,
        height,
        format,
        region.x,
        region.y,
        region.width,
        region.height,
    );
}

/**
 * wl_shm's `argb8888` and `xrgb8888` entries predate the DRM fourcc values and
 * are 0 and 1; every other entry uses the DRM fourcc directly.
 */
function normalizeShmFormat(format: number): number {
    if (format === 0) return DRM_FORMAT.ARGB8888;
    if (format === 1) return DRM_FORMAT.XRGB8888;
    return format;
}

function validateDmabuf(options: ConvertDmabufToRgbaOptions): ValidatedDmabuf {
    const { width, height, format, planes } = options;
    assertPositiveInt(width, "width");
    assertPositiveInt(height, "height");
    assertPositiveInt(format, "format");

    const modifier = normalizeModifier(options.modifier);
    if (modifier !== DRM_FORMAT_MOD_LINEAR) {
        throw new Error(`only DRM_FORMAT_MOD_LINEAR is supported, got modifier ${modifier.toString(16)}`);
    }

    if (!Array.isArray(planes) || planes.length !== 1) {
        throw new Error(`32-bit formats require exactly one plane, got ${planes?.length ?? 0}`);
    }

    const plane = planes[0];
    assertPositiveInt(plane.fd, "planes[0].fd", true);
    assertPositiveInt(plane.stride, "planes[0].stride");
    const offset = plane.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error("planes[0].offset must be a non-negative safe integer");
    }

    return { width, height, format, modifier, plane, offset };
}

function assertPositiveInt(value: number, name: string, allowZero = false): void {
    if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 0xffffffff) {
        throw new Error(`${name} must be an integer in [${allowZero ? 0 : 1}, 2^32-1]`);
    }
}

function normalizeModifier(modifier: bigint | string | number | undefined): bigint {
    if (modifier === undefined) return DRM_FORMAT_MOD_LINEAR;
    if (typeof modifier === "bigint") return modifier;
    if (typeof modifier === "number" && Number.isInteger(modifier)) return BigInt(modifier);
    if (typeof modifier === "string" && modifier.length > 0) {
        try {
            return BigInt(modifier);
        } catch {
            throw new Error(`invalid modifier: ${modifier}`);
        }
    }
    throw new Error("modifier must be a bigint or an integer string");
}
