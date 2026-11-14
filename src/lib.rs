mod gpu;

use neon::prelude::*;
use neon::types::buffer::TypedArray;
use std::ffi::c_void;

// ---------------------------------------------------------------- DRM formats

const fn fourcc(a: u8, b: u8, c: u8, d: u8) -> u32 {
    (a as u32) | ((b as u32) << 8) | ((c as u32) << 16) | ((d as u32) << 24)
}

pub(crate) const DRM_FORMAT_ARGB8888: u32 = fourcc(b'A', b'R', b'2', b'4');
pub(crate) const DRM_FORMAT_ABGR8888: u32 = fourcc(b'A', b'B', b'2', b'4');
pub(crate) const DRM_FORMAT_RGBA8888: u32 = fourcc(b'R', b'A', b'2', b'4');
pub(crate) const DRM_FORMAT_BGRA8888: u32 = fourcc(b'B', b'A', b'2', b'4');
pub(crate) const DRM_FORMAT_XRGB8888: u32 = fourcc(b'X', b'R', b'2', b'4');
pub(crate) const DRM_FORMAT_XBGR8888: u32 = fourcc(b'X', b'B', b'2', b'4');
pub(crate) const DRM_FORMAT_RGBX8888: u32 = fourcc(b'R', b'X', b'2', b'4');
pub(crate) const DRM_FORMAT_BGRX8888: u32 = fourcc(b'B', b'X', b'2', b'4');
pub(crate) const DRM_FORMAT_NV12: u32 = fourcc(b'N', b'V', b'1', b'2');
pub(crate) const DRM_FORMAT_NV16: u32 = fourcc(b'N', b'V', b'1', b'6');
pub(crate) const DRM_FORMAT_P010: u32 = fourcc(b'P', b'0', b'1', b'0');

fn drm_format_name(format: u32) -> Option<&'static str> {
    match format {
        DRM_FORMAT_ARGB8888 => Some("DRM_FORMAT_ARGB8888"),
        DRM_FORMAT_ABGR8888 => Some("DRM_FORMAT_ABGR8888"),
        DRM_FORMAT_RGBA8888 => Some("DRM_FORMAT_RGBA8888"),
        DRM_FORMAT_BGRA8888 => Some("DRM_FORMAT_BGRA8888"),
        DRM_FORMAT_XRGB8888 => Some("DRM_FORMAT_XRGB8888"),
        DRM_FORMAT_XBGR8888 => Some("DRM_FORMAT_XBGR8888"),
        DRM_FORMAT_RGBX8888 => Some("DRM_FORMAT_RGBX8888"),
        DRM_FORMAT_BGRX8888 => Some("DRM_FORMAT_BGRX8888"),
        DRM_FORMAT_NV12 => Some("DRM_FORMAT_NV12"),
        DRM_FORMAT_NV16 => Some("DRM_FORMAT_NV16"),
        DRM_FORMAT_P010 => Some("DRM_FORMAT_P010"),
        _ => None,
    }
}

/// Formats that Electron's `importSharedTexture` can consume as-is.
fn electron_pixel_format(format: u32) -> Option<&'static str> {
    match format {
        DRM_FORMAT_ARGB8888 => Some("bgra"),
        DRM_FORMAT_ABGR8888 => Some("rgba"),
        DRM_FORMAT_NV12 => Some("nv12"),
        DRM_FORMAT_NV16 => Some("nv16"),
        DRM_FORMAT_P010 => Some("p010le"),
        _ => None,
    }
}

// ------------------------------------------------------------- 32-bit layouts

/// Byte offsets of R/G/B/A in little-endian memory for one 32-bit pixel.
struct FormatInfo {
    r: usize,
    g: usize,
    b: usize,
    /// `None` means the alpha channel is unused and must become 255.
    a: Option<usize>,
}

fn format_info(format: u32) -> Option<FormatInfo> {
    let (r, g, b, a) = match format {
        // ARGB8888: A R G B in the word => B G R A in memory.
        DRM_FORMAT_ARGB8888 => (2, 1, 0, Some(3)),
        // ABGR8888: A B G R => R G B A.
        DRM_FORMAT_ABGR8888 => (0, 1, 2, Some(3)),
        // RGBA8888: R G B A => A B G R.
        DRM_FORMAT_RGBA8888 => (3, 2, 1, Some(0)),
        // BGRA8888: B G R A => A R G B.
        DRM_FORMAT_BGRA8888 => (1, 2, 3, Some(0)),
        // XRGB8888: X R G B => B G R X.
        DRM_FORMAT_XRGB8888 => (2, 1, 0, None),
        // XBGR8888: X B G R => R G B X.
        DRM_FORMAT_XBGR8888 => (0, 1, 2, None),
        // RGBX8888: R G B X => X B G R.
        DRM_FORMAT_RGBX8888 => (3, 2, 1, None),
        // BGRX8888: B G R X => X R G B.
        DRM_FORMAT_BGRX8888 => (1, 2, 3, None),
        _ => return None,
    };
    Some(FormatInfo { r, g, b, a })
}

// ------------------------------------------------------------- dma-buf access

#[repr(C)]
struct DmaBufSync {
    flags: u64,
}

const DMA_BUF_SYNC_READ: u64 = 1 << 0;
const DMA_BUF_SYNC_START: u64 = 0 << 2;
const DMA_BUF_SYNC_END: u64 = 1 << 2;

const IOC_NRBITS: u32 = 8;
const IOC_TYPEBITS: u32 = 8;
const IOC_SIZEBITS: u32 = 14;
const IOC_NRSHIFT: u32 = 0;
const IOC_TYPESHIFT: u32 = IOC_NRSHIFT + IOC_NRBITS;
const IOC_SIZESHIFT: u32 = IOC_TYPESHIFT + IOC_TYPEBITS;
const IOC_DIRSHIFT: u32 = IOC_SIZESHIFT + IOC_SIZEBITS;
const IOC_WRITE: u32 = 1;

const fn iow(kind: u8, nr: u32, size: usize) -> libc::c_ulong {
    ((IOC_WRITE << IOC_DIRSHIFT)
        | ((size as u32) << IOC_SIZESHIFT)
        | ((kind as u32) << IOC_TYPESHIFT)
        | (nr << IOC_NRSHIFT)) as libc::c_ulong
}

const DMA_BUF_IOCTL_SYNC: libc::c_ulong = iow(b'b', 0, std::mem::size_of::<DmaBufSync>());

fn dma_buf_sync(fd: i32, flags: u64) {
    let mut sync = DmaBufSync { flags };
    // ENOTTY on non-dmabuf fds (tests use regular files); no need to fail.
    unsafe {
        libc::ioctl(fd, DMA_BUF_IOCTL_SYNC, &mut sync);
    }
}

struct DmaBufMapping {
    ptr: *mut c_void,
    len: usize,
    fd: i32,
}

impl DmaBufMapping {
    fn new(fd: i32, len: usize) -> Result<Self, String> {
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ,
                libc::MAP_SHARED,
                fd,
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            return Err(format!(
                "mmap(fd={fd}, len={len}) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        dma_buf_sync(fd, DMA_BUF_SYNC_START | DMA_BUF_SYNC_READ);
        Ok(Self { ptr, len, fd })
    }
}

impl Drop for DmaBufMapping {
    fn drop(&mut self) {
        dma_buf_sync(self.fd, DMA_BUF_SYNC_END | DMA_BUF_SYNC_READ);
        unsafe {
            libc::munmap(self.ptr, self.len);
        }
    }
}

// ---------------------------------------------------------------- conversion

fn convert_pixels(
    src: &[u8],
    dst: &mut [u8],
    width: usize,
    height: usize,
    stride: usize,
    info: &FormatInfo,
) {
    let row_bytes = width * 4;

    // ABGR8888 is already R G B A in memory.
    if info.r == 0 && info.g == 1 && info.b == 2 && info.a == Some(3) && stride == row_bytes {
        dst.copy_from_slice(&src[..row_bytes * height]);
        return;
    }

    for y in 0..height {
        let src_start = y * stride;
        let src_row = &src[src_start..src_start + row_bytes];
        let dst_row = &mut dst[y * row_bytes..(y + 1) * row_bytes];

        let (src_pixels, _) = src_row.as_chunks::<4>();
        let (dst_pixels, _) = dst_row.as_chunks_mut::<4>();

        for (s, d) in src_pixels.iter().zip(dst_pixels.iter_mut()) {
            d[0] = s[info.r];
            d[1] = s[info.g];
            d[2] = s[info.b];
            d[3] = match info.a {
                Some(a) => s[a],
                None => 0xff,
            };
        }
    }
}

// --------------------------------------------------------------- Neon glue

fn arg_u32(cx: &mut FunctionContext, index: usize, name: &str) -> NeonResult<u32> {
    let value = cx.argument::<JsNumber>(index)?.value(cx);
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > u32::MAX as f64 {
        return cx.throw_error(format!("{name} must be an unsigned 32-bit integer"));
    }
    Ok(value as u32)
}

fn arg_u64(cx: &mut FunctionContext, index: usize, name: &str) -> NeonResult<u64> {
    let value = cx.argument::<JsNumber>(index)?.value(cx);
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > 2f64.powi(53) {
        return cx.throw_error(format!("{name} must be a non-negative safe integer"));
    }
    Ok(value as u64)
}

fn js_drm_format_name(mut cx: FunctionContext) -> JsResult<JsValue> {
    let format = arg_u32(&mut cx, 0, "format")?;
    match drm_format_name(format) {
        Some(name) => Ok(cx.string(name).upcast()),
        None => Ok(cx.null().upcast()),
    }
}

fn js_electron_pixel_format(mut cx: FunctionContext) -> JsResult<JsValue> {
    let format = arg_u32(&mut cx, 0, "format")?;
    match electron_pixel_format(format) {
        Some(name) => Ok(cx.string(name).upcast()),
        None => Ok(cx.null().upcast()),
    }
}

fn js_is_supported_format(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let format = arg_u32(&mut cx, 0, "format")?;
    Ok(cx.boolean(drm_format_name(format).is_some()))
}

fn js_needs_conversion(mut cx: FunctionContext) -> JsResult<JsBoolean> {
    let format = arg_u32(&mut cx, 0, "format")?;
    Ok(cx.boolean(drm_format_name(format).is_some() && electron_pixel_format(format).is_none()))
}

struct ConvertRequest {
    fd: i32,
    offset: usize,
    stride: usize,
    width: usize,
    height: usize,
    info: FormatInfo,
}

fn parse_convert_request(cx: &mut FunctionContext) -> NeonResult<ConvertRequest> {
    let fd = arg_u32(cx, 0, "fd")? as i32;
    let offset = arg_u64(cx, 1, "offset")?;
    let stride = arg_u32(cx, 2, "stride")? as usize;
    let width = arg_u32(cx, 3, "width")? as usize;
    let height = arg_u32(cx, 4, "height")? as usize;
    let format = arg_u32(cx, 5, "format")?;

    if width == 0 || height == 0 {
        return cx.throw_error("width and height must be greater than zero");
    }

    let info = match format_info(format) {
        Some(info) => info,
        None => {
            let name = drm_format_name(format).unwrap_or("unsupported format");
            return cx.throw_error(format!(
                "{name} is not a 32-bit RGB format and cannot be converted to RGBA"
            ));
        }
    };

    let row_bytes = match width.checked_mul(4) {
        Some(value) => value,
        None => return cx.throw_error("width is too large"),
    };
    if stride < row_bytes {
        return cx.throw_error(format!(
            "stride {stride} is smaller than width * 4 ({row_bytes})"
        ));
    }

    let offset = match usize::try_from(offset) {
        Ok(value) => value,
        Err(_) => return cx.throw_error("offset is too large for this platform"),
    };

    Ok(ConvertRequest {
        fd,
        offset,
        stride,
        width,
        height,
        info,
    })
}

fn output_len(request: &ConvertRequest) -> Result<usize, String> {
    request
        .width
        .checked_mul(request.height)
        .and_then(|value| value.checked_mul(4))
        .ok_or_else(|| "output size overflows usize".to_string())
}

fn js_convert_dmabuf_to_rgba(mut cx: FunctionContext) -> JsResult<JsBuffer> {
    let request = parse_convert_request(&mut cx)?;

    let mapped_len = match (request.stride.checked_mul(request.height))
        .and_then(|value| value.checked_add(request.offset))
    {
        Some(value) => value,
        None => return cx.throw_error("buffer size overflows usize"),
    };
    if mapped_len == 0 {
        return cx.throw_error("buffer size must be greater than zero");
    }

    let out_len = match output_len(&request) {
        Ok(value) => value,
        Err(error) => return cx.throw_error(error),
    };

    let ConvertRequest {
        fd,
        offset,
        stride,
        width,
        height,
        info,
        ..
    } = request;

    let mapping = match DmaBufMapping::new(fd, mapped_len) {
        Ok(mapping) => mapping,
        Err(error) => return cx.throw_error(error),
    };

    // SAFETY: the mapping covers `mapped_len` bytes, and the rows we read stay
    // inside `offset + stride * height` with `stride >= width * 4`.
    let src = unsafe {
        std::slice::from_raw_parts((mapping.ptr as *const u8).add(offset), stride * height)
    };

    let mut buffer = cx.buffer(out_len)?;
    {
        let dst = buffer.as_mut_slice(&mut cx);
        convert_pixels(src, dst, width, height, stride, &info);
    }

    Ok(buffer)
}

/// Read `dst.len()` bytes at `offset` with `pread`.
///
/// The fd may be a memfd, a `shm_open` file or any regular file. A short file
/// leaves the remaining bytes as they are (zeroed by the caller), matching the
/// way an undersized wl_shm pool is treated as transparent.
fn read_at(fd: i32, offset: usize, dst: &mut [u8]) -> Result<(), String> {
    let mut offset =
        i64::try_from(offset).map_err(|_| "offset is too large for this platform".to_string())?;
    let mut done = 0usize;
    while done < dst.len() {
        let request = dst.len() - done;
        let bytes = unsafe {
            libc::pread(
                fd,
                dst[done..].as_mut_ptr().cast::<c_void>(),
                request,
                offset,
            )
        };
        if bytes < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("reading fd {fd} failed: {error}"));
        }
        if bytes == 0 {
            break;
        }
        let bytes = bytes as usize;
        done += bytes;
        offset = offset
            .checked_add(bytes as i64)
            .ok_or_else(|| "offset overflows i64".to_string())?;
    }
    Ok(())
}

fn js_convert_shm_to_rgba(mut cx: FunctionContext) -> JsResult<JsBuffer> {
    let request = parse_convert_request(&mut cx)?;

    let src_len = match request.stride.checked_mul(request.height) {
        Some(value) => value,
        None => return cx.throw_error("buffer size overflows usize"),
    };
    if src_len == 0 {
        return cx.throw_error("buffer size must be greater than zero");
    }

    let out_len = match output_len(&request) {
        Ok(value) => value,
        Err(error) => return cx.throw_error(error),
    };

    let ConvertRequest {
        fd,
        offset,
        stride,
        width,
        height,
        info,
        ..
    } = request;

    let mut src = vec![0u8; src_len];
    if let Err(error) = read_at(fd, offset, &mut src) {
        return cx.throw_error(error);
    }

    let mut buffer = cx.buffer(out_len)?;
    {
        let dst = buffer.as_mut_slice(&mut cx);
        convert_pixels(&src, dst, width, height, stride, &info);
    }

    Ok(buffer)
}

fn js_convert_dmabuf_to_texture(mut cx: FunctionContext) -> JsResult<JsValue> {
    let fd = arg_u32(&mut cx, 0, "fd")? as i32;
    let offset = arg_u64(&mut cx, 1, "offset")?;
    let stride = arg_u32(&mut cx, 2, "stride")?;
    let width = arg_u32(&mut cx, 3, "width")?;
    let height = arg_u32(&mut cx, 4, "height")?;
    let format = arg_u32(&mut cx, 5, "format")?;

    if width == 0 || height == 0 {
        return cx.throw_error("width and height must be greater than zero");
    }

    let converted = match gpu::convert(fd, offset, stride, width, height, format) {
        Ok(Some(converted)) => converted,
        Ok(None) => return Ok(cx.null().upcast()),
        Err(error) => {
            eprintln!("myde-drm: GPU conversion failed: {error}");
            return Ok(cx.null().upcast());
        }
    };

    let object = cx.empty_object();
    let fd = cx.number(converted.fd);
    let offset = cx.number(converted.offset);
    let stride = cx.number(converted.stride);
    let size = cx.number(converted.size as f64);
    let modifier = cx.string(converted.modifier.to_string());
    object.set(&mut cx, "fd", fd)?;
    object.set(&mut cx, "offset", offset)?;
    object.set(&mut cx, "stride", stride)?;
    object.set(&mut cx, "size", size)?;
    object.set(&mut cx, "modifier", modifier)?;
    Ok(object.upcast())
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("drmFormatName", js_drm_format_name)?;
    cx.export_function("electronPixelFormat", js_electron_pixel_format)?;
    cx.export_function("isSupportedFormat", js_is_supported_format)?;
    cx.export_function("needsConversion", js_needs_conversion)?;
    cx.export_function("convertDmabufToRgba", js_convert_dmabuf_to_rgba)?;
    cx.export_function("convertShmToRgba", js_convert_shm_to_rgba)?;
    cx.export_function("convertDmabufToTexture", js_convert_dmabuf_to_texture)?;
    Ok(())
}
