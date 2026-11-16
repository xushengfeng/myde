use std::os::fd::OwnedFd;
use std::time::{Duration, Instant};

use anyhow::Result;
use simple_app::dmabuf;
use simple_app::DRM_FORMAT_ARGB8888;
use wayland_client::protocol::{
    wl_buffer, wl_callback, wl_compositor, wl_registry, wl_shm, wl_shm_pool, wl_surface,
};
use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle};
use wayland_protocols::wp::linux_dmabuf::zv1::client::{
    zwp_linux_buffer_params_v1, zwp_linux_dmabuf_v1,
};
use wayland_protocols::wp::viewporter::client::{wp_viewport, wp_viewporter};
use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};

/// 疯狂提交 dmabuf 帧，用来观察合成器是否有每帧资源泄漏。
///
/// 两段：先普通全 buffer 提交，再挂一个 wp_viewport.source（合成器每帧会为它新建画布），
/// 每段之间静置采样 /proc/meminfo 的 GPUActive。输出 `MEM ...` 行交给测试解析。

const WIDTH: i32 = 2560;
const HEIGHT: i32 = 1440;
/// 客户端缓冲池大小；服务端 release 后才复用
const BUFFER_COUNT: usize = 4;
const FLOOD: Duration = Duration::from_millis(1500);
const IDLE: Duration = Duration::from_millis(1500);

struct App {
    compositor: Option<wl_compositor::WlCompositor>,
    linux_dmabuf: Option<zwp_linux_dmabuf_v1::ZwpLinuxDmabufV1>,
    xdg_wm_base: Option<xdg_wm_base::XdgWmBase>,
    viewporter: Option<wp_viewporter::WpViewporter>,
    buffers: Vec<(wl_buffer::WlBuffer, OwnedFd)>,
    busy: Vec<bool>,
    configured: bool,
    frames: u64,
}

impl App {
    fn new() -> Self {
        Self {
            compositor: None,
            linux_dmabuf: None,
            xdg_wm_base: None,
            viewporter: None,
            buffers: Vec::new(),
            busy: Vec::new(),
            configured: false,
            frames: 0,
        }
    }
}

fn gpu_active_mb() -> Option<u64> {
    let s = std::fs::read_to_string("/proc/meminfo").ok()?;
    for line in s.lines() {
        if let Some(rest) = line.strip_prefix("GPUActive:") {
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some(kb / 1024);
        }
    }
    None
}

fn mem_line(phase: &str, frames: u64) {
    match gpu_active_mb() {
        Some(mb) => println!("MEM phase={phase} gpu_active_mb={mb} frames={frames}"),
        None => println!("MEM phase={phase} gpu_active_mb=NA frames={frames}"),
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
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
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
                "wp_viewporter" => {
                    state.viewporter = Some(registry.bind(name, version.min(1), qh, ()));
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
                fn event(_: &mut Self, _: &$ty, _: <$ty as Proxy>::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
            }
        )*
    };
}

impl_ignore_dispatch!(
    wl_compositor::WlCompositor,
    wl_surface::WlSurface,
    wl_shm::WlShm,
    wl_shm_pool::WlShmPool,
    wl_callback::WlCallback,
    zwp_linux_dmabuf_v1::ZwpLinuxDmabufV1,
    xdg_toplevel::XdgToplevel,
    wp_viewporter::WpViewporter,
    wp_viewport::WpViewport,
);

impl Dispatch<wl_buffer::WlBuffer, ()> for App {
    fn event(
        state: &mut Self,
        buffer: &wl_buffer::WlBuffer,
        event: wl_buffer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_buffer::Event::Release = event {
            if let Some(i) = state.buffers.iter().position(|(b, _)| b.id() == buffer.id()) {
                state.busy[i] = false;
            }
        }
    }
}

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
        _: &mut Self,
        params: &zwp_linux_buffer_params_v1::ZwpLinuxBufferParamsV1,
        event: zwp_linux_buffer_params_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let zwp_linux_buffer_params_v1::Event::Failed = event {
            eprintln!("dmabuf buffer params failed");
            params.destroy();
        }
    }
}

fn dispatch_for(app: &mut App, queue: &mut EventQueue<App>, dur: Duration, phase: &str) {
    let start = Instant::now();
    let mut last = Instant::now();
    while start.elapsed() < dur {
        let _ = queue.dispatch_pending(app);
        let _ = queue.flush();
        if last.elapsed() >= Duration::from_millis(500) {
            mem_line(phase, app.frames);
            last = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn flood(
    app: &mut App,
    queue: &mut EventQueue<App>,
    surface: &wl_surface::WlSurface,
    dur: Duration,
) -> Result<()> {
    // 默认 60fps，模拟视频；FLOOD_INTERVAL_MS=0 可改成尽可能快（直接启动时用）
    let interval = std::env::var("FLOOD_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(16));
    let start = Instant::now();
    let mut last = Instant::now();
    let mut next_frame = Instant::now();
    while start.elapsed() < dur {
        if !interval.is_zero() {
            let now = Instant::now();
            if now < next_frame {
                std::thread::sleep(next_frame - now);
            }
            next_frame = Instant::now() + interval;
        }
        if let Some(i) = app.busy.iter().position(|b| !b) {
            let buffer = app.buffers[i].0.clone();
            surface.attach(Some(&buffer), 0, 0);
            surface.damage_buffer(0, 0, WIDTH, HEIGHT);
            surface.commit();
            app.busy[i] = true;
            app.frames += 1;
            queue.flush()?;
            let _ = queue.dispatch_pending(app);
        } else {
            // 没有空闲 buffer 就等 release，节流到服务端消费速度
            queue.blocking_dispatch(app)?;
        }
        if last.elapsed() >= Duration::from_millis(500) {
            mem_line("flood", app.frames);
            last = Instant::now();
        }
    }
    Ok(())
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
    let dmabuf = app
        .linux_dmabuf
        .clone()
        .expect("zwp_linux_dmabuf_v1 not available");
    let wm_base = app.xdg_wm_base.clone().expect("xdg_wm_base not available");

    let surface = compositor.create_surface(&qh, ());
    let xdg_surface = wm_base.get_xdg_surface(&surface, &qh, ());
    let xdg_toplevel = xdg_surface.get_toplevel(&qh, ());
    xdg_toplevel.set_title("dmabuf_flood".into());
    surface.commit();

    while !app.configured {
        event_queue.blocking_dispatch(&mut app)?;
    }

    // 一次性建好客户端 buffer 池；每帧只 attach/commit，不新建 wl_buffer
    for i in 0..BUFFER_COUNT {
        let shade = (i * 60) as u8;
        let (fd, stride) = dmabuf::create_gbm_dmabuf(WIDTH, HEIGHT, |x, y| {
            [shade, (x % 256) as u8, (y % 256) as u8, 255]
        })?;
        let buffer = dmabuf::create_dmabuf_buffer(
            &dmabuf,
            &qh,
            &fd,
            WIDTH,
            HEIGHT,
            stride,
            DRM_FORMAT_ARGB8888,
        )?;
        app.buffers.push((buffer, fd));
        app.busy.push(false);
    }

    println!("PHASE plain start");
    mem_line("baseline", app.frames);
    flood(&mut app, &mut event_queue, &surface, FLOOD)?;
    dispatch_for(&mut app, &mut event_queue, IDLE, "plain_idle");

    if let Some(viewporter) = app.viewporter.clone() {
        println!("PHASE viewport start");
        let viewport = viewporter.get_viewport(&surface, &qh, ());
        // source 让合成器每帧走一次裁剪画布分配（和 Firefox 视频路径相似）
        viewport.set_source(0.0, 0.0, WIDTH as f64, HEIGHT as f64);
        viewport.set_destination(WIDTH / 2, HEIGHT / 2);
        surface.commit();
        event_queue.roundtrip(&mut app)?;
        mem_line("viewport_baseline", app.frames);
        flood(&mut app, &mut event_queue, &surface, FLOOD)?;
        dispatch_for(&mut app, &mut event_queue, IDLE, "viewport_idle");
    } else {
        eprintln!("wp_viewporter not available, skip viewport phase");
    }

    for (buffer, _) in &app.buffers {
        buffer.destroy();
    }
    event_queue.flush()?;
    println!("DONE frames={}", app.frames);
    Ok(())
}
