//! 父子窗口层叠测试：父窗口先最大化，再创建带 parent 的子窗口。
//!
//! 用于复现「父窗口最大化时新创建的子窗口被垫在父窗口下面」。
//! 环境变量：
//! - `APP_ID`：父窗口的 appid（默认 child-window-test）
//! - `CHILD_DELAY_MS`：父窗口首帧后多久创建子窗口（默认 600）
//! - `MAXIMIZE`：`1` 时父窗口先 set_maximized（默认 1）
//! - `LIFETIME_MS`：最长运行时间（默认 8000）

use std::os::fd::AsFd;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use simple_app::dmabuf;
use wayland_client::protocol::{wl_buffer, wl_compositor, wl_registry, wl_shm, wl_shm_pool, wl_surface};
use wayland_client::{Connection, Dispatch, EventQueue, QueueHandle};
use wayland_protocols::xdg::decoration::zv1::client::{zxdg_decoration_manager_v1, zxdg_toplevel_decoration_v1};
use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Parent,
    Child,
}

struct Win {
    surface: wl_surface::WlSurface,
    /// 持有引用，保证装饰协议对象不被销毁
    _decoration: Option<zxdg_toplevel_decoration_v1::ZxdgToplevelDecorationV1>,
    pending_size: Option<(i32, i32)>,
    configured_size: Option<(i32, i32)>,
    frame_size: Option<(i32, i32)>,
    buffers: Vec<wl_buffer::WlBuffer>,
    kind: Kind,
    size: (i32, i32),
}

impl Win {
    fn target_size(&self) -> (i32, i32) {
        match self.kind {
            // 父窗口跟随 configure（最大化），子窗口保持固有尺寸
            Kind::Parent => match self.configured_size {
                Some((w, h)) if w > 0 && h > 0 => (w, h),
                _ => self.size,
            },
            Kind::Child => self.size,
        }
    }
}

struct App {
    compositor: Option<wl_compositor::WlCompositor>,
    shm: Option<wl_shm::WlShm>,
    wm_base: Option<xdg_wm_base::XdgWmBase>,
    decoration_manager: Option<zxdg_decoration_manager_v1::ZxdgDecorationManagerV1>,
    windows: Vec<Win>,
}

fn draw(kind: Kind, x: usize, y: usize, width: i32, height: i32) -> [u8; 4] {
    let border = x < 8 || y < 8 || x as i32 >= width - 8 || y as i32 >= height - 8;
    if border {
        return [255, 255, 255, 255];
    }
    // BGRA 通道顺序
    match kind {
        Kind::Parent => [40, 200, 40, 255], // 绿
        Kind::Child => [40, 40, 220, 255],  // 红
    }
}

fn create_buffer(
    shm: &wl_shm::WlShm,
    qh: &QueueHandle<App>,
    kind: Kind,
    width: i32,
    height: i32,
) -> Result<wl_buffer::WlBuffer> {
    let stride = width * 4;
    let fd = dmabuf::create_memfd_with_pixels(width, height, stride, |x, y| draw(kind, x, y, width, height))?;
    let pool: wl_shm_pool::WlShmPool = shm.create_pool(fd.as_fd(), stride * height, qh, ());
    let buffer = pool.create_buffer(0, width, height, stride, wl_shm::Format::Argb8888, qh, ());
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
        if let wl_registry::Event::Global { name, interface, version } = event {
            match interface.as_str() {
                "wl_compositor" => state.compositor = Some(registry.bind(name, version.min(4), qh, ())),
                "wl_shm" => state.shm = Some(registry.bind(name, version.min(1), qh, ())),
                "xdg_wm_base" => state.wm_base = Some(registry.bind(name, version.min(5), qh, ())),
                "zxdg_decoration_manager_v1" => {
                    state.decoration_manager = Some(registry.bind(name, version.min(1), qh, ()))
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

impl Dispatch<xdg_surface::XdgSurface, u32> for App {
    fn event(
        state: &mut Self,
        xdg_surface: &xdg_surface::XdgSurface,
        event: xdg_surface::Event,
        index: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_surface::Event::Configure { serial } = event {
            xdg_surface.ack_configure(serial);
            if let Some(win) = state.windows.get_mut(*index as usize) {
                win.configured_size = win.pending_size.or(win.configured_size);
            }
        }
    }
}

impl Dispatch<xdg_toplevel::XdgToplevel, u32> for App {
    fn event(
        state: &mut Self,
        _: &xdg_toplevel::XdgToplevel,
        event: xdg_toplevel::Event,
        index: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            xdg_toplevel::Event::Configure { width, height, .. } => {
                if let Some(win) = state.windows.get_mut(*index as usize) {
                    win.pending_size = Some((width, height));
                }
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
    zxdg_decoration_manager_v1::ZxdgDecorationManagerV1,
    zxdg_toplevel_decoration_v1::ZxdgToplevelDecorationV1,
);

impl App {
    /// 让父窗口最大化，等 configure 变成最大化尺寸后按新尺寸重画
    fn maximize_parent(
        &mut self,
        index: usize,
        toplevel: &xdg_toplevel::XdgToplevel,
        shm: &wl_shm::WlShm,
        qh: &QueueHandle<App>,
        queue: &mut EventQueue<App>,
    ) -> Result<()> {
        toplevel.set_maximized();
        queue.flush()?;
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            queue.roundtrip(self)?;
            if self.windows[index].target_size() != self.windows[index].size {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let (w, h) = self.windows[index].target_size();
        let buffer = create_buffer(shm, qh, Kind::Parent, w, h)?;
        let surface = self.windows[index].surface.clone();
        surface.attach(Some(&buffer), 0, 0);
        surface.damage_buffer(0, 0, w, h);
        surface.commit();
        queue.flush()?;
        self.windows[index].buffers.push(buffer);
        self.windows[index].frame_size = Some((w, h));
        eprintln!(
            "{{\"event\":\"parent_maximized\",\"t\":{},\"width\":{w},\"height\":{h}}}",
            now_ms()
        );
        Ok(())
    }
}


fn main() -> Result<()> {
    let appid = std::env::var("APP_ID").unwrap_or_else(|_| "child-window-test".to_string());
    let maximize = std::env::var("MAXIMIZE").map(|v| v != "0").unwrap_or(true);
    let maximize_after_child = std::env::var("MAXIMIZE_AFTER_CHILD").map(|v| v == "1").unwrap_or(false);
    let late_parent = std::env::var("LATE_PARENT").map(|v| v == "1").unwrap_or(false);
    let child_delay = Duration::from_millis(
        std::env::var("CHILD_DELAY_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(600),
    );
    let lifetime = Duration::from_millis(
        std::env::var("LIFETIME_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(8000),
    );
    let started_at = Instant::now();

    let conn = Connection::connect_to_env().context("连接 Wayland 失败")?;
    let mut queue = conn.new_event_queue();
    let qh = queue.handle();
    let _registry = conn.display().get_registry(&qh, ());
    let mut app = App {
        compositor: None,
        shm: None,
        wm_base: None,
        decoration_manager: None,
        windows: Vec::new(),
    };
    queue.roundtrip(&mut app)?;

    let compositor = app.compositor.as_ref().context("缺少 wl_compositor")?.clone();
    let wm_base = app.wm_base.as_ref().context("缺少 xdg_wm_base")?.clone();
    let shm = app.shm.as_ref().context("缺少 wl_shm")?.clone();

    // 父窗口
    let parent_index = app.windows.len() as u32;
    let surface = compositor.create_surface(&qh, ());
    let xdg_surface = wm_base.get_xdg_surface(&surface, &qh, parent_index);
    let toplevel = xdg_surface.get_toplevel(&qh, parent_index);
    toplevel.set_app_id(appid.clone());
    toplevel.set_title("Parent Window".to_string());
    let decoration = app.decoration_manager.as_ref().map(|manager| {
        let decoration = manager.get_toplevel_decoration(&toplevel, &qh, ());
        decoration.set_mode(zxdg_toplevel_decoration_v1::Mode::ServerSide);
        decoration
    });
    app.windows.push(Win {
        surface: surface.clone(),
        _decoration: decoration,
        pending_size: None,
        configured_size: None,
        frame_size: None,
        buffers: Vec::new(),
        kind: Kind::Parent,
        size: (800, 600),
    });
    surface.commit();
    queue.roundtrip(&mut app)?;

    let buffer = create_buffer(&shm, &qh, Kind::Parent, 800, 600)?;
    surface.attach(Some(&buffer), 0, 0);
    surface.damage_buffer(0, 0, 800, 600);
    surface.commit();
    queue.flush()?;
    app.windows[parent_index as usize].buffers.push(buffer);
    app.windows[parent_index as usize].frame_size = Some((800, 600));
    eprintln!("{{\"event\":\"parent_first_buffer\",\"t\":{}}}", now_ms());

    if maximize && !maximize_after_child {
        app.maximize_parent(parent_index as usize, &toplevel, &shm, &qh, &mut queue)?;
    }

    std::thread::sleep(child_delay);

    // 子窗口：父窗口已经最大化后才创建，初始 commit 前 set_parent
    let child_index = app.windows.len() as u32;
    let child_surface = compositor.create_surface(&qh, ());
    let child_xdg_surface = wm_base.get_xdg_surface(&child_surface, &qh, child_index);
    let child_toplevel = child_xdg_surface.get_toplevel(&qh, child_index);
    if !late_parent {
        child_toplevel.set_parent(Some(&toplevel));
    }
    child_toplevel.set_title("Child Dialog".to_string());
    let child_decoration = app.decoration_manager.as_ref().map(|manager| {
        let decoration = manager.get_toplevel_decoration(&child_toplevel, &qh, ());
        decoration.set_mode(zxdg_toplevel_decoration_v1::Mode::ServerSide);
        decoration
    });
    app.windows.push(Win {
        surface: child_surface.clone(),
        _decoration: child_decoration,
        pending_size: None,
        configured_size: None,
        frame_size: None,
        buffers: Vec::new(),
        kind: Kind::Child,
        size: (400, 300),
    });
    child_surface.commit();
    queue.flush()?;
    queue.roundtrip(&mut app)?;
    let child_buffer = create_buffer(&shm, &qh, Kind::Child, 400, 300)?;
    child_surface.attach(Some(&child_buffer), 0, 0);
    child_surface.damage_buffer(0, 0, 400, 300);
    child_surface.commit();
    queue.flush()?;
    app.windows[child_index as usize].buffers.push(child_buffer);
    app.windows[child_index as usize].frame_size = Some((400, 300));
    eprintln!("{{\"event\":\"child_created\",\"t\":{}}}", now_ms());

    if late_parent {
        std::thread::sleep(Duration::from_millis(200));
        child_toplevel.set_parent(Some(&toplevel));
        child_surface.commit();
        queue.flush()?;
        eprintln!("{{\"event\":\"child_parent_set\",\"t\":{}}}", now_ms());
    }

    if maximize && maximize_after_child {
        std::thread::sleep(Duration::from_millis(500));
        app.maximize_parent(parent_index as usize, &toplevel, &shm, &qh, &mut queue)?;
    }

    while started_at.elapsed() < lifetime {
        queue.roundtrip(&mut app)?;
        // 跟随 configure 重画（最大化尺寸变化）
        for index in 0..app.windows.len() {
            let (w, h) = app.windows[index].target_size();
            if app.windows[index].frame_size != Some((w, h)) && w > 0 && h > 0 {
                let kind = app.windows[index].kind;
                let buffer = create_buffer(&shm, &qh, kind, w, h)?;
                let surface = app.windows[index].surface.clone();
                surface.attach(Some(&buffer), 0, 0);
                surface.damage_buffer(0, 0, w, h);
                surface.commit();
                queue.flush()?;
                app.windows[index].buffers.push(buffer);
                app.windows[index].frame_size = Some((w, h));
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}
