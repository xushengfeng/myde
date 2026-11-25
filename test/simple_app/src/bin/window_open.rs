//! 可控制时刻的测试窗口：用于官方桌面启动动画的逐帧测试。
//!
//! 行为全部由环境变量控制，事件时间写到 `EVENTS_FILE`，测试按 epoch 毫秒对齐：
//! - `CREATE_AT`：创建 xdg_toplevel 的时刻（epoch ms，或 `never`）
//! - `BUFFER_AT`：提交首帧的时刻（epoch ms，或 `never`）
//! - `FULLSCREEN_AT`：调用 set_fullscreen 的时刻（epoch ms，可省略）
//! - `SIZE_MODE`：`fixed`（忽略 configure，用 WIDTH×HEIGHT）或 `configure`
//! - `WIDTH` / `HEIGHT`：buffer 尺寸（默认 800×600）
//! - `APP_ID`：xdg_toplevel.set_app_id（默认 window-open-test）
//! - `LIFETIME_MS`：最长运行时间（默认 8000）
//!
//! 按需求不发送任何 xdg 尺寸设置：不调用 set_window_geometry、set_min_size、
//! set_max_size；窗口大小只由 buffer 或 configure 决定。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::fd::AsFd;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use simple_app::dmabuf;
use wayland_client::protocol::{
    wl_buffer, wl_compositor, wl_registry, wl_shm, wl_shm_pool, wl_surface,
};
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[derive(Clone, Copy)]
enum When {
    At(u128),
    Never,
}

fn parse_when(name: &str) -> Result<When> {
    match std::env::var(name) {
        Ok(value) if value.eq_ignore_ascii_case("never") => Ok(When::Never),
        Ok(value) if !value.is_empty() => Ok(When::At(
            value.parse::<u128>().with_context(|| format!("{name}={value} 不是毫秒时间戳"))?,
        )),
        _ => Ok(When::At(0)),
    }
}

fn env_i32(name: &str, default: i32) -> i32 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn sleep_until(when: When) {
    let When::At(target) = when else { return };
    loop {
        let now = now_ms();
        if target <= now {
            return;
        }
        let wait = (target - now).min(20) as u64;
        std::thread::sleep(Duration::from_millis(wait.max(1)));
    }
}

struct Events {
    file: Option<File>,
}

impl Events {
    fn new() -> Self {
        let path = std::env::var("EVENTS_FILE").ok().filter(|p| !p.is_empty());
        let file = path.and_then(|p| OpenOptions::new().create(true).append(true).open(p).ok());
        Self { file }
    }

    fn emit(&mut self, event: &str, extra: &str) {
        let line = if extra.is_empty() {
            format!("{{\"event\":\"{event}\",\"t\":{}}}\n", now_ms())
        } else {
            format!("{{\"event\":\"{event}\",\"t\":{},\"extra\":{extra}}}\n", now_ms())
        };
        if let Some(file) = &mut self.file {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
        }
        eprint!("{line}");
    }
}

struct App {
    compositor: Option<wl_compositor::WlCompositor>,
    shm: Option<wl_shm::WlShm>,
    wm_base: Option<xdg_wm_base::XdgWmBase>,
    surface: Option<wl_surface::WlSurface>,
    xdg_surface: Option<xdg_surface::XdgSurface>,
    toplevel: Option<xdg_toplevel::XdgToplevel>,
    buffers: Vec<wl_buffer::WlBuffer>,
    configured_size: Option<(i32, i32)>,
    pending_size: Option<(i32, i32)>,
    acked_serial: Option<u32>,
    /// 已经画/提交过的尺寸
    frame_size: Option<(i32, i32)>,
    running: bool,
    events: Events,
}

impl App {
    fn new() -> Self {
        Self {
            compositor: None,
            shm: None,
            wm_base: None,
            surface: None,
            xdg_surface: None,
            toplevel: None,
            buffers: Vec::new(),
            configured_size: None,
            pending_size: None,
            acked_serial: None,
            frame_size: None,
            running: true,
            events: Events::new(),
        }
    }

    fn target_size(&self, mode: &str, width: i32, height: i32) -> (i32, i32) {
        if mode == "configure" {
            if let Some((w, h)) = self.configured_size {
                if w > 0 && h > 0 {
                    return (w, h);
                }
            }
        }
        (width, height)
    }
}

fn draw_pixel(x: usize, y: usize, width: i32, height: i32) -> [u8; 4] {
    let x = x as i32;
    let y = y as i32;
    // 高对比棋盘格 + 白色边框，逐帧位移估计需要清晰的边缘
    let border = x < 6 || y < 6 || x >= width - 6 || y >= height - 6;
    if border {
        return [250, 250, 250, 255];
    }
    let cell = 48;
    let checker = ((x / cell) + (y / cell)) % 2 == 0;
    let base = if checker {
        [196, 92, 40, 255] // B,G,R: 深蓝
    } else {
        [240, 190, 140, 255] // B,G,R: 浅蓝
    };
    // 中间一条红色横带，方便对齐中心
    if (y - height / 2).abs() < 12 {
        return [60, 60, 220, 255];
    }
    base
}

fn create_shm_buffer(
    shm: &wl_shm::WlShm,
    qh: &QueueHandle<App>,
    width: i32,
    height: i32,
) -> Result<wl_buffer::WlBuffer> {
    let stride = width * 4;
    let fd = dmabuf::create_memfd_with_pixels(width, height, stride, |x, y| {
        draw_pixel(x, y, width, height)
    })?;
    let pool: wl_shm_pool::WlShmPool =
        shm.create_pool(fd.as_fd(), stride * height, qh, ());
    let buffer = pool.create_buffer(
        0,
        width,
        height,
        stride,
        wl_shm::Format::Argb8888,
        qh,
        (),
    );
    pool.destroy();
    Ok(buffer)
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
                "wl_shm" => {
                    state.shm = Some(registry.bind(name, version.min(1), qh, ()));
                }
                "xdg_wm_base" => {
                    state.wm_base = Some(registry.bind(name, version.min(5), qh, ()));
                }
                _ => {}
            }
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
            state.acked_serial = Some(serial);
            state.configured_size = state
                .pending_size
                .map(|(w, h)| (w, h))
                .or(state.configured_size);
            let size = state.configured_size;
            let extra = match size {
                Some((w, h)) => format!("{{\"width\":{w},\"height\":{h}}}"),
                None => "null".to_string(),
            };
            state.events.emit("configure", &extra);
        }
    }
}

impl Dispatch<xdg_toplevel::XdgToplevel, ()> for App {
    fn event(
        state: &mut Self,
        _: &xdg_toplevel::XdgToplevel,
        event: xdg_toplevel::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            xdg_toplevel::Event::Configure { width, height, .. } => {
                state.pending_size = Some((width, height));
            }
            xdg_toplevel::Event::Close => {
                state.events.emit("close_requested", "");
                state.running = false;
            }
            _ => {}
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
    wl_shm::WlShm,
    wl_shm_pool::WlShmPool,
    wl_buffer::WlBuffer,
    wl_surface::WlSurface,
);

fn main() -> Result<()> {
    let appid = std::env::var("APP_ID").unwrap_or_else(|_| "window-open-test".to_string());
    let width = env_i32("WIDTH", 800);
    let height = env_i32("HEIGHT", 600);
    let size_mode = std::env::var("SIZE_MODE").unwrap_or_else(|_| "fixed".to_string());
    let create_at = parse_when("CREATE_AT")?;
    let buffer_at = parse_when("BUFFER_AT")?;
    let fullscreen_at = std::env::var("FULLSCREEN_AT")
        .ok()
        .filter(|v| !v.is_empty())
        .map(|_| parse_when("FULLSCREEN_AT"))
        .transpose()?;
    let lifetime = Duration::from_millis(std::env::var("LIFETIME_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(8000));

    let started_at = std::time::Instant::now();
    let mut app = App::new();
    app.events.emit(
        "process_start",
        &format!("{{\"pid\":{},\"width\":{width},\"height\":{height},\"sizeMode\":\"{size_mode}\"}}", std::process::id()),
    );

    let conn = Connection::connect_to_env().context("连接 Wayland 失败")?;
    let mut queue = conn.new_event_queue();
    let qh = queue.handle();
    let _registry = conn.display().get_registry(&qh, ());
    queue.roundtrip(&mut app)?;
    app.events.emit("connected", "");

    let When::At(create_target) = create_at else {
        app.events.emit("create_skipped", "");
        // 保持进程存活，但不创建窗口
        while started_at.elapsed() < lifetime {
            let _ = queue.roundtrip(&mut app);
            std::thread::sleep(Duration::from_millis(20));
        }
        return Ok(());
    };
    if create_target > now_ms() {
        sleep_until(When::At(create_target));
    }

    let compositor = app.compositor.as_ref().context("缺少 wl_compositor")?.clone();
    let wm_base = app.wm_base.as_ref().context("缺少 xdg_wm_base")?.clone();
    let surface = compositor.create_surface(&qh, ());
    let xdg_surface = wm_base.get_xdg_surface(&surface, &qh, ());
    let toplevel = xdg_surface.get_toplevel(&qh, ());
    toplevel.set_app_id(appid.clone());
    toplevel.set_title("Window Open Test".to_string());
    app.surface = Some(surface.clone());
    app.xdg_surface = Some(xdg_surface.clone());
    app.toplevel = Some(toplevel.clone());
    app.events.emit("toplevel_created", &format!("{{\"appid\":\"{appid}\"}}"));

    // 初始 commit（无 buffer）：服务端收到后才发 configure
    surface.commit();
    queue.flush()?;
    app.events.emit("initial_commit", "");
    queue.roundtrip(&mut app)?;

    let buffer_time = match buffer_at {
        When::At(t) => t,
        When::Never => u128::MAX,
    };
    let fullscreen_time = match fullscreen_at {
        Some(When::At(t)) => t,
        _ => u128::MAX,
    };
    let buffer_done = matches!(buffer_at, When::Never);
    let mut fullscreen_done = fullscreen_at.is_none() || matches!(fullscreen_at, Some(When::Never));

    // 全屏时刻早于首帧时刻时，先切全屏（首帧前全屏）
    if !fullscreen_done && !buffer_done && fullscreen_time <= buffer_time {
        sleep_until(When::At(fullscreen_time));
        toplevel.set_fullscreen(None);
        queue.flush()?;
        // 先拿到全屏 configure，后续 buffer 才能按全屏尺寸创建
        queue.roundtrip(&mut app)?;
        app.events.emit("fullscreen", "");
        fullscreen_done = true;
    }

    if !buffer_done {
        sleep_until(buffer_at);
        let shm = app.shm.as_ref().context("缺少 wl_shm")?.clone();
        let (w, h) = app.target_size(&size_mode, width, height);
        let buffer = create_shm_buffer(&shm, &qh, w, h)?;
        surface.attach(Some(&buffer), 0, 0);
        surface.damage_buffer(0, 0, w, h);
        surface.commit();
        queue.flush()?;
        app.buffers.push(buffer);
        app.frame_size = Some((w, h));
        app.events
            .emit("first_buffer", &format!("{{\"width\":{w},\"height\":{h}}}"));
    } else {
        app.events.emit("buffer_skipped", "");
    }

    if !fullscreen_done {
        sleep_until(When::At(fullscreen_time));
        toplevel.set_fullscreen(None);
        queue.flush()?;
        app.events.emit("fullscreen", "");
    }

    let mut next_roundtrip = std::time::Instant::now();
    while app.running && started_at.elapsed() < lifetime {
        if std::time::Instant::now() >= next_roundtrip {
            queue.roundtrip(&mut app)?;
            next_roundtrip = std::time::Instant::now() + Duration::from_millis(20);
        } else {
            std::thread::sleep(Duration::from_millis(4));
        }

        // configure 后（全屏/尺寸变化）按新尺寸重画；fixed 模式保持原尺寸
        if size_mode == "configure" {
            if let Some((w, h)) = app.configured_size {
                if w > 0 && h > 0 && app.frame_size != Some((w, h)) {
                    let shm = app.shm.as_ref().context("缺少 wl_shm")?.clone();
                    let buffer = create_shm_buffer(&shm, &qh, w, h)?;
                    surface.attach(Some(&buffer), 0, 0);
                    surface.damage_buffer(0, 0, w, h);
                    surface.commit();
                    queue.flush()?;
                    app.buffers.push(buffer);
                    app.frame_size = Some((w, h));
                    app.events
                        .emit("resize_buffer", &format!("{{\"width\":{w},\"height\":{h}}}"));
                }
            }
        }
    }

    app.events.emit("exit", "");
    Ok(())
}
