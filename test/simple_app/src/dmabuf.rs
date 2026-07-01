use std::os::fd::{AsFd, OwnedFd};

use anyhow::Result;
use wayland_client::protocol::wl_buffer;
use wayland_client::QueueHandle;
use wayland_protocols::wp::linux_dmabuf::zv1::client::{
    zwp_linux_buffer_params_v1, zwp_linux_dmabuf_v1,
};

/// Open the first available DRM render node.
fn open_drm_render_node() -> Result<std::fs::File> {
    for i in 128..=150 {
        let path = format!("/dev/dri/renderD{i}");
        if let Ok(file) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
        {
            return Ok(file);
        }
    }
    anyhow::bail!("No DRM render node found under /dev/dri/renderD128..150");
}

/// Allocate a GPU buffer via GBM on the DRM render node and export it as a
/// dma-buf fd.  Returns `(dma_buf_fd, stride)`.
pub fn create_gbm_dmabuf(
    width: i32,
    height: i32,
    draw: impl Fn(usize, usize) -> [u8; 4],
) -> Result<(OwnedFd, u32)> {
    let drm = open_drm_render_node()?;

    let dev = gbm::Device::new(drm)?;

    let mut bo = dev.create_buffer_object::<()>(
        width as u32,
        height as u32,
        gbm::Format::Argb8888,
        gbm::BufferObjectFlags::LINEAR | gbm::BufferObjectFlags::RENDERING,
    )?;

    let stride = bo.stride();

    bo.map_mut(0, 0, width as u32, height as u32, |mapped| {
        let buf = mapped.buffer_mut();
        for y in 0..height as usize {
            for x in 0..width as usize {
                let off = y * stride as usize + x * 4;
                let p = draw(x, y);
                buf[off..off + 4].copy_from_slice(&p);
            }
        }
    })?;

    let fd = bo.fd()?;
    Ok((fd, stride))
}

pub fn create_memfd_with_pixels(
    width: i32,
    height: i32,
    stride: i32,
    draw: impl Fn(usize, usize) -> [u8; 4],
) -> Result<OwnedFd> {
    let size = (stride * height) as usize;
    let fd = rustix::fs::memfd_create("pixel-data", rustix::fs::MemfdFlags::CLOEXEC)?;
    rustix::fs::ftruncate(&fd, size as u64)?;

    {
        let file = std::fs::File::from(fd.try_clone()?);
        let mut mmap = unsafe { memmap2::MmapMut::map_mut(&file)? };

        for y in 0..height as usize {
            for x in 0..width as usize {
                let offset = y * stride as usize + x * 4;
                let pixel = draw(x, y);
                mmap[offset..offset + 4].copy_from_slice(&pixel);
            }
        }
        mmap.flush()?;
    }

    Ok(fd)
}

pub fn create_dmabuf_buffer<D>(
    dmabuf: &zwp_linux_dmabuf_v1::ZwpLinuxDmabufV1,
    qh: &QueueHandle<D>,
    fd: &impl AsFd,
    width: i32,
    height: i32,
    stride: u32,
    format: u32,
) -> Result<wl_buffer::WlBuffer>
where
    D: 'static
        + wayland_client::Dispatch<zwp_linux_buffer_params_v1::ZwpLinuxBufferParamsV1, ()>
        + wayland_client::Dispatch<wl_buffer::WlBuffer, ()>,
{
    let params = dmabuf.create_params(qh, ());
    params.add(fd.as_fd(), 0, 0, stride, 0, 0);
    let buffer = params.create_immed(
        width,
        height,
        format,
        zwp_linux_buffer_params_v1::Flags::empty(),
        qh,
        (),
    );
    params.destroy();
    Ok(buffer)
}
