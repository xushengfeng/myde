# myde-drm

把 Linux DRM dma-buf 的 32 位像素格式转换成 Electron 能导入的格式，供 Wayland 合成器（myde）在 Electron 不支持某些格式时使用。也提供 wl_shm 共享内存缓冲区的读取和转换。

Electron 的 `sharedTexture.importSharedTexture` 只接受 `bgra`、`rgba`、`rgbaf16`、`nv12`、`nv16`、`p010le`。Chromium 内部其实认识 XRGB/XBGR，但 JS 接口没有暴露，而且 XRGB/XBGR 的 alpha 字节是未定义的。本模块把这些格式补上：
- **GPU 路径（默认）**：用 EGL 导入源 dmabuf，着色器做通道重排/补 alpha，渲染到新的 ARGB8888 GBM dmabuf，再交给 `importSharedTexture`。像素不回到 CPU，也不经过 `putImageData`。
- **CPU 路径（回退）**：mmap 源 dmabuf，Rust 里重排成 RGBA `Buffer`，适合没有 DRM render node、EGL 初始化失败或驱动不能导入该 dmabuf 的情况。
- **每帧不等待 GPU**：EGL 上下文、着色器、FBO 和纹理首次创建后复用，导出用的 GBM buffer 从按尺寸复用的池里取，EGLImage 每帧新建、延迟两帧销毁；绘制后 `glFlush` 提交，依赖 dma-buf 隐式 fence 与 Electron 的导入/合成同步，避免 `glFinish` 阻塞合成线程。
- **输出 buffer 池**：池按 owner（通常 client+surface）隔离，只有调用方 `close()` 后才回收；同一 owner 内直接复用，别的 owner 只能回收空闲 ≥1s 的槽位，避免窗口之间串内容。总内存按预算分配（默认 256MB，`MYDE_DRM_POOL_MB`），预算满时返回 `null`，由调用方回退零拷贝。
- **同步兜底**：如果某个驱动对隐式 fence 支持不好（出现旧帧/花屏），设置 `MYDE_DRM_GPU_FINISH=1`，转换函数会改回每帧 `glFinish` 等待 GPU 完成。
- Rust 原生实现（neon），TypeScript 包装，vite 构建，pnpm 管理
- 只支持 **LINEAR** modifier（当前 myde 的 dmabuf feedback 只广播 modifier 0）
- 只处理单 plane 的 32 位 RGB(A) 格式；NV12/NV16/P010 请继续走 Electron 原生的 `importSharedTexture`

## 构建

本模块是 myde 仓库内的 workspace 包（`packages/myde-drm`），不单独发布；依赖在仓库根目录安装，根目录构建时一起编译：

```bash
pnpm install                # 仓库根目录
pnpm build:packages         # 构建全部 workspace 包（含本模块）
```

在本目录内也可单独构建、测试：

```bash
pnpm build        # cargo build --release + vite build
pnpm test         # TS 单元测试
cargo test        # 包含一个真实 GBM/EGL 的 GPU 冒烟测试（无 DRM 设备时跳过）
pnpm typecheck
```

构建产物：`prebuilds/<platform>-<arch>/index.node`（Rust 原生模块，按 CPU 架构分目录）、`dist/index.js`、`dist/index.cjs`、`dist/index.d.ts`。

同一个 `prebuilds/<platform>-<arch>/` 目录存放本机架构的原生模块，运行时按 `process.arch` 选择。

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
    // 多 surface 时必须传：池只在同一 owner 内复用，跨窗口不会串内容
    owner: `${clientId}:${surfaceId}`,
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
        // 用 c2d.drawImage(frame, ...) 绘制
        // 等绘制/合成不再需要这一帧时再释放，顺序是 frame.close() -> imported.release()
        // -> texture.close()；texture.close() 关闭导出的 fd 并把池槽位还回去。
        requestAnimationFrame(() => {
            frame.close();
            imported.release();
            texture.close();
        });
    }
}
```

`convertDmabufToTexture` 返回 `null` 表示 GPU 路径不可用，或池的内存预算已经满了，继续走下面的 CPU 回退（或零拷贝导入）。GPU 输出固定是 LINEAR `ARGB8888`，所以 `pixelFormat` 是 `"bgra"`。

`owner` 用于池隔离：省略时所有调用方共用一个 owner，多窗口下可能把拷贝缓冲复用到别的窗口。

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

每帧复用同一块输出可以避免分配：

```ts
// 每个 wl_buffer 保存一份，首次提交时按 width * height * 4 分配
const rgba = (buffer.rgba ??= Buffer.allocUnsafe(buffer.width * buffer.height * 4));
const imageData = (buffer.imageData ??= new ImageData(
    new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    buffer.width,
    buffer.height,
));

// 返回的就是传入的 rgba
convertShmToRgba({ fd: poolFd, offset, stride, width, height, format }, rgba);
c2d.putImageData(imageData, 0, 0);
```

`convertShmToRgba` 优先 mmap 整个 pool（文件足够大时），映射会按 `(st_dev, st_ino)` 缓存（最多 8 个 pool），不会每帧重新建立页表；文件比 `offset + stride * height` 短时才回退到 `pread`，多出来的像素按透明黑处理。`format` 直接用 `wl_shm_pool.create_buffer` 里的值：wl_shm 的 `argb8888`/`xrgb8888` 是历史遗留的 0/1，模块会映射到对应 DRM fourcc，其余值本身就是 DRM fourcc。它不要求 fd 是 dma-buf，也不接受 modifier。ARGB8888/XRGB8888 走 SSE2 的 32 位换字节快路径，ARGB 保留 alpha，XRGB 补 255。

如果一次提交只有局部变化，可以只转换 damage 区域：

```ts
convertShmToRgbaRegion(options, rgba, { x: 100, y: 80, width: 320, height: 200 });
```

输出仍是整帧 Buffer，区域外的像素保持不变。myde 会把 `damage`/`damage_buffer` 合并成包围盒后调用它，所以终端光标、局部刷新这类场景不再每帧转换整个画面。

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

## 性能打点

GPU 转换默认开启分阶段计时：每 60 次转换汇总一次 avg/max，单次总耗时 ≥4ms 的帧会额外打印一行明细，方便抓偶发尖峰。输出走 stderr。

```bash
pnpm dev                                      # 默认：每 60 帧汇总
MYDE_DRM_GPU_TRACE=1 pnpm dev                 # 每帧打印
MYDE_DRM_GPU_TRACE=120 pnpm dev               # 每 120 帧汇总
MYDE_DRM_GPU_TRACE=0 pnpm dev                 # 关闭
```

阶段：

| 阶段         | 含义                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `current`    | `eglMakeCurrent`（已经 current 时接近 0）                                                        |
| `gbm_create` | 从池里取（命中）或 `gbm_bo_create`（预算内新建）导出 buffer                                   |
| `gbm_fd`     | `gbm_bo_get_fd` 导出 dma-buf fd                                                                  |
| `images`     | 创建源/目标（以及 alpha）EGLImage                                                                |
| `bind`       | `glEGLImageTargetTexture2DOES` 绑定到复用的纹理                                                  |
| `fbo`        | 绑定 FBO 和 `glCheckFramebufferStatus`                                                           |
| `draw`       | `glDrawArrays` + 提交；默认只 `glFlush`，设置 `MYDE_DRM_GPU_FINISH=1` 时才包含 `glFinish` 的等待 |
| `unbind`     | 解绑 FBO/纹理/程序                                                                               |
| `recycle`    | 销毁两帧前的 EGLImage                                                                            |

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
- GPU 路径的输出 buffer 按尺寸池化，池按 owner 隔离、按字节预算（`MYDE_DRM_POOL_MB`，默认 256MB）分配；预算满时返回 `null`，需要调用方回退。跨 owner 回收一个槽位要求它空闲 ≥ `MYDE_DRM_STEAL_IDLE_MS`（默认 1000ms）。
- `convertDmabufToTexture` 返回的 `close()` 必须等消费方用完再调用：关闭导出的 fd 并把池槽位还回去。`convertDmabufToRgba` 的输入 fd 由调用方拥有，模块不会 close。
- CPU 路径每次都会分配 `width * height * 4` 的新 Buffer，能直通的格式不要走这里。
