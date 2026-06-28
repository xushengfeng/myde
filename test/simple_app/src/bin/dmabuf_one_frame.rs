use anyhow::Result;
use simple_app::dmabuf;
use simple_app::DRM_FORMAT_XRGB8888;
use wayland_client::protocol::{
    wl_buffer, wl_compositor, wl_registry, wl_shm, wl_shm_pool, wl_surface,
};
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols::wp::linux_dmabuf::zv1::client::{
    zwp_linux_buffer_params_v1, zwp_linux_dmabuf_v1,
};
use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};

struct App {
    compositor: Option<wl_compositor::WlCompositor>,
    linux_dmabuf: Option<zwp_linux_dmabuf_v1::ZwpLinuxDmabufV1>,
    xdg_wm_base: Option<xdg_wm_base::XdgWmBase>,
    buffer: Option<wl_buffer::WlBuffer>,
    configured: bool,
    running: bool,
}

impl App {
    fn new() -> Self {
        Self {
            compositor: None,
            linux_dmabuf: None,
            xdg_wm_base: None,
            buffer: None,
            configured: false,
            running: true,
        }
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for App {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global { name, interface, version } = event {
            match interface.as_str() {
                "wl_compositor" => {
                    state.compositor = Some(registry.bind(name, version.min(4), qh, ()));
                }
                "zwp_linux_dmabuf_v1" => {
                    state.linux_dmabuf = Some(registry.bind(name, version.min(5), qh, ()));
                }
                "xdg_wm_base" => {
                    state.xdg_wm_base = Some(registry.bind(name, version.min(5), qh, ()));
                }
                _ => {}
            }
        }
    }
}

macro_rules! impl_ignore_dispatch {
    ($($ty:ty),* $(,)?) => {
        $(
            impl Dispatch<$ty, ()> for App {
                fn event(_: &mut Self, _: &$ty, _: <$ty as wayland_client::Proxy>::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
            }
        )*
    };
}

impl_ignore_dispatch!(
    wl_compositor::WlCompositor,
    wl_surface::WlSurface,
    wl_shm::WlShm,
    wl_shm_pool::WlShmPool,
    wl_buffer::WlBuffer,
    zwp_linux_dmabuf_v1::ZwpLinuxDmabufV1,
    xdg_toplevel::XdgToplevel,
);

impl Dispatch<xdg_surface::XdgSurface, ()> for App {
    fn event(
        state: &mut Self,
        xdg_surface: &xdg_surface::XdgSurface,
        event: xdg_surface::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_surface::Event::Configure { serial } = event {
            xdg_surface.ack_configure(serial);
            state.configured = true;
        }
    }
}

impl Dispatch<xdg_wm_base::XdgWmBase, ()> for App {
    fn event(
        _: &mut Self,
        wm_base: &xdg_wm_base::XdgWmBase,
        event: xdg_wm_base::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_wm_base::Event::Ping { serial } = event {
            wm_base.pong(serial);
        }
    }
}

impl Dispatch<zwp_linux_buffer_params_v1::ZwpLinuxBufferParamsV1, ()> for App {
    fn event(
        state: &mut Self,
        _: &zwp_linux_buffer_params_v1::ZwpLinuxBufferParamsV1,
        event: zwp_linux_buffer_params_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let zwp_linux_buffer_params_v1::Event::Created { buffer } = event {
            state.buffer = Some(buffer);
        }
    }
}

fn main() -> Result<()> {
    let conn = Connection::connect_to_env()?;
    let mut event_queue = conn.new_event_queue::<App>();
    let qh = event_queue.handle();

    let display = conn.display();
    let _registry = display.get_registry(&qh, ());

    let mut app = App::new();
    event_queue.roundtrip(&mut app)?;

    let compositor = app.compositor.clone().expect("wl_compositor not available");
    let dmabuf = app.linux_dmabuf.clone().expect("zwp_linux_dmabuf_v1 not available");
    let wm_base = app.xdg_wm_base.clone().expect("xdg_wm_base not available");

    let surface = compositor.create_surface(&qh, ());
    let xdg_surface = wm_base.get_xdg_surface(&surface, &qh, ());
    let xdg_toplevel = xdg_surface.get_toplevel(&qh, ());
    xdg_toplevel.set_title("dmabuf_one_frame".into());
    surface.commit();

    while !app.configured {
        event_queue.blocking_dispatch(&mut app)?;
    }

    let width = 256i32;
    let height = 256i32;

    let (dma_buf_fd, gbm_stride) = dmabuf::create_gbm_dmabuf(width, height, |x, y| {
        [
            (x % 256) as u8,
            (y % 256) as u8,
            ((x + y) % 256) as u8,
            255,
        ]
    })?;

    let buffer = dmabuf::create_dmabuf_buffer(
        &dmabuf,
        &qh,
        &dma_buf_fd,
        width,
        height,
        gbm_stride,
        DRM_FORMAT_XRGB8888,
    )?;

    surface.attach(Some(&buffer), 0, 0);
    surface.damage_buffer(0, 0, width, height);
    surface.commit();

    println!("Displaying {width}x{height} frame via dmabuf. Close window to exit.");

    while app.running {
        event_queue.blocking_dispatch(&mut app)?;
    }

    Ok(())
}
