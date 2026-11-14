# myde-drm

把 Linux DRM dma-buf 的 32 位像素格式转换成 Electron 能导入的格式，供 Wayland 合成器（myde）在 Electron 不支持某些格式时使用。也提供 wl_shm 共享内存缓冲区的读取和转换。

Electron 的 `sharedTexture.importSharedTexture` 只接受 `bgra`、`rgba`、`rgbaf16`、`nv12`、`nv16`、`p010le`。Chromium 内部其实认识 XRGB/XBGR，但 JS 接口没有暴露，而且 XRGB/XBGR 的 alpha 字节是未定义的。本模块把这些格式补上：
- **GPU 路径（默认）**：用 EGL 导入源 dmabuf，着色器做通道重排/补 alpha，渲染到新的 ARGB8888 GBM dmabuf，再交给 `importSharedTexture`。像素不回到 CPU，也不经过 `putImageData`。
- **CPU 路径（回退）**：mmap 源 dmabuf，Rust 里重排成 RGBA `Buffer`，适合没有 DRM render node、EGL 初始化失败或驱动不能导入该 dmabuf 的情况。
- Rust 原生实现（neon），TypeScript 包装，vite 构建，pnpm 管理
- 只支持 **LINEAR** modifier（当前 myde 的 dmabuf feedback 只广播 modifier 0）
- 只处理单 plane 的 32 位 RGB(A) 格式；NV12/NV16/P010 请继续走 Electron 原生的 `importSharedTexture`

## 构建

```bash
pnpm install
pnpm build        # cargo build --release + vite build
pnpm test         # TS 单元测试
cargo test        # 包含一个真实 GBM/EGL 的 GPU 冒烟测试（无 DRM 设备时跳过）
pnpm typecheck
```

构建产物：`prebuilds/<platform>-<arch>/index.node`（Rust 原生模块，按 CPU 架构分目录）、`dist/index.js`、`dist/index.cjs`、`dist/index.d.ts`。

同一个 npm 包会包含 x64 与 arm64 的预编译模块，运行时按 `process.arch` 自动选择。

## 用法

### 1. 先判断格式能否直接交给 Electron

```ts
import { getElectronPixelFormat } from "myde-drm";

const pixelFormat = getElectronPixelFormat(bufferObj.format);
if (pixelFormat) {
    // 保持原来的 importSharedTexture 路径
    // ARGB8888 -> bgra, ABGR8888 -> rgba, NV12/NV16/P010 原样传
} else {
    // 需要转换，例如 XRGB8888 / XBGR8888 / RGBX8888 / BGRX8888 / RGBA8888 / BGRA8888
}
```

### 2. GPU 路径：转成新的 dmabuf 再导入

```ts
import { convertDmabufToTexture } from "myde-drm";

const texture = convertDmabufToTexture({
    width: bufferObj.width,
    height: bufferObj.height,
    format: bufferObj.format,
    modifier: 0n, // 只接受 DRM_FORMAT_MOD_LINEAR
    planes: [
        {
            fd: bufferObj.planes[0].fd,
            offset: bufferObj.planes[0].offset,
            stride: bufferObj.planes[0].stride,
        },
    ],
});

if (texture) {
    try {
        const imported = await importSharedTexture({
            textureInfo: {
                handle: {
                    nativePixmap: {
                        planes: texture.planes.map((plane) => ({
                            fd: plane.fd,
                            offset: plane.offset ?? 0,
                            stride: plane.stride,
                            size: plane.size ?? plane.stride * bufferObj.height,
                        })),
                        modifier: texture.modifier.toString(),
                        supportsZeroCopyWebGpuImport: true,
                    },
                },
                codedSize: { width: texture.width, height: texture.height },
                pixelFormat: texture.pixelFormat, // "bgra"
            },
        });
        const frame = imported.getVideoFrame();
        imported.release();
        // 用 c2d.drawImage(frame, ...) 绘制
        frame.close();
    } finally {
        // importSharedTexture 已经 dup 了 fd，可以关闭模块返回的那个
        texture.close();
    }
}
```

`convertDmabufToTexture` 返回 `null` 表示 GPU 路径不可用，继续走下面的 CPU 回退。GPU 输出固定是 LINEAR `ARGB8888`，所以 `pixelFormat` 是 `"bgra"`。

### 3. CPU 回退：转成 RGBA Buffer

```ts
import { convertDmabufToRgba } from "myde-drm";

const rgba = convertDmabufToRgba({
    width: bufferObj.width,
    height: bufferObj.height,
    format: bufferObj.format,
    modifier: 0n,
    planes: [
        {
            fd: bufferObj.planes[0].fd,
            offset: bufferObj.planes[0].offset,
            stride: bufferObj.planes[0].stride,
        },
    ],
});

const image = new ImageData(
    new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    bufferObj.width,
    bufferObj.height,
);
ctx.putImageData(image, 0, 0);
```

`convertDmabufToRgba` 返回的 Buffer 长度是 `width * height * 4`，行间没有 padding。

### 4. wl_shm：读取共享内存并转成 RGBA Buffer

```ts
import { convertShmToRgba } from "myde-drm";

const rgba = convertShmToRgba({
    fd: poolFd, // wl_shm.create_pool 拿到的 fd
    offset: buffer.offset,
    stride: buffer.stride,
    width: buffer.width,
    height: buffer.height,
    format: buffer.format, // wl_shm_pool.create_buffer 的 format，可原样传入
});

const image = new ImageData(
    new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    buffer.width,
    buffer.height,
);
```

`convertShmToRgba` 在 Rust 里用 `pread` 读取 fd（memfd、`shm_open` 文件或普通文件均可），再按 `format` 重排成 RGBA，长度同样是 `width * height * 4`。`format` 直接用 `wl_shm_pool.create_buffer` 里的值：wl_shm 的 `argb8888`/`xrgb8888` 是历史遗留的 0/1，模块会映射到对应 DRM fourcc，其余值本身就是 DRM fourcc。文件比 `offset + stride * height` 短时，多出来的像素按透明黑处理。它不要求 fd 是 dma-buf，也不接受 modifier。

### 5. 只查询格式

```ts
import { getFormatInfo, isSupportedFormat, needsConversion } from "myde-drm";

getFormatInfo(DRM_FORMAT.XRGB8888);
// {
//   name: "DRM_FORMAT_XRGB8888",
//   electronPixelFormat: null,
//   needsConversion: true
// }

isSupportedFormat(DRM_FORMAT.XRGB8888); // true
needsConversion(DRM_FORMAT.ARGB8888); // false
```

## 格式表

下表中的“内存字节”是 little-endian 下每个像素从低地址到高地址的字节顺序。

| DRM fourcc            | 内存字节 | Electron 直接导入 | GPU 转换   | CPU 转换       |
| --------------------- | -------- | ----------------- | ---------- | -------------- |
| `DRM_FORMAT_ARGB8888` | B G R A  | `bgra`            | 不需要     | 不需要         |
| `DRM_FORMAT_ABGR8888` | R G B A  | `rgba`            | 不需要     | 不需要         |
| `DRM_FORMAT_XRGB8888` | B G R X  | —                 | A=255      | 转 RGBA，A=255 |
| `DRM_FORMAT_XBGR8888` | R G B X  | —                 | A=255      | 转 RGBA，A=255 |
| `DRM_FORMAT_RGBX8888` | X B G R  | —                 | A=255      | 转 RGBA，A=255 |
| `DRM_FORMAT_BGRX8888` | X R G B  | —                 | A=255      | 转 RGBA，A=255 |
| `DRM_FORMAT_RGBA8888` | A B G R  | —                 | 保留 alpha | 转 RGBA        |
| `DRM_FORMAT_BGRA8888` | A R G B  | —                 | 保留 alpha | 转 RGBA        |
| `DRM_FORMAT_NV12`     | 多平面   | `nv12`            | 不处理     | 不处理         |
| `DRM_FORMAT_NV16`     | 多平面   | `nv16`            | 不处理     | 不处理         |
| `DRM_FORMAT_P010`     | 多平面   | `p010le`          | 不处理     | 不处理         |

GPU 路径对 RGBX/BGRX/RGBA/BGRA 会从偏移 1 处按 ARGB/ABGR 导入，避开第一个字节；RGBA/BGRA 再额外导入一张 ABGR 图取 alpha。

## 限制

- modifier 必须是 `DRM_FORMAT_MOD_LINEAR`（0）。tiled buffer 无法直接 mmap，非 0 modifier 会抛错。
- 只支持单 plane 的 32 位格式。NV12/NV16/P010 不做转换。
- GPU 路径需要能打开 DRM render node，并且系统提供 EGL/GBM 和 `EGL_EXT_image_dma_buf_import`；否则自动回退到 CPU。
- GPU 路径每帧创建一块新的 GBM buffer；后续可以按尺寸做 buffer 池。
- `convertDmabufToTexture` 返回的 fd 需要调用 `close()`；`convertDmabufToRgba` 的输入 fd 由调用方拥有，模块不会 close。
- CPU 路径每次都会分配 `width * height * 4` 的新 Buffer，能直通的格式不要走这里。
