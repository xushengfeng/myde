use std::os::fd::AsFd;

use anyhow::Result;
use simple_app::dmabuf;
use wayland_client::protocol::{
    wl_buffer, wl_compositor, wl_region, wl_registry, wl_shm, wl_shm_pool, wl_surface,
};
use wayland_client::{Connection, Dispatch, QueueHandle, WEnum};
use wayland_protocols::ext::background_effect::v1::client::{
    ext_background_effect_manager_v1, ext_background_effect_surface_v1,
};
use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};

const DEFAULT_WIDTH: i32 = 700;
const DEFAULT_HEIGHT: i32 = 480;
/// 模糊区域离窗口边缘的距离：让圆角外没有一块方形模糊。
const BLUR_INSET: i32 = 12;
/// 挖掉的矩形：这里应该看到清晰的桌面，用来验证 region 的 subtract 语义。
const HOLE_WIDTH: i32 = 176;
const HOLE_HEIGHT: i32 = 112;
const HOLE_MARGIN: i32 = 34;

struct App {
    compositor: Option<wl_compositor::WlCompositor>,
    shm: Option<wl_shm::WlShm>,
    xdg_wm_base: Option<xdg_wm_base::XdgWmBase>,
    background_effect_manager:
        Option<ext_background_effect_manager_v1::ExtBackgroundEffectManagerV1>,
    background_effect: Option<ext_background_effect_surface_v1::ExtBackgroundEffectSurfaceV1>,
    /// 服务端广播过 blur 能力；没有能力时创建 effect 对象也没有效果。
    blur_supported: bool,
    /// 是否创建并设置模糊区域（`--no-blur` 可做对比）。
    want_blur: bool,
    /// 等待按新尺寸重画
    needs_frame: bool,
    /// 已经提交过的尺寸：configure 尺寸没变时不必重画
    frame_size: Option<(i32, i32)>,
    configured_size: Option<(i32, i32)>,
    running: bool,
}

impl App {
    fn new(want_blur: bool) -> Self {
        Self {
            compositor: None,
            shm: None,
            xdg_wm_base: None,
            background_effect_manager: None,
            background_effect: None,
            blur_supported: false,
            want_blur,
            needs_frame: false,
            configured_size: None,
            frame_size: None,
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
        let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        else {
            return;
        };
        match interface.as_str() {
            "wl_compositor" => {
                state.compositor = Some(registry.bind(name, version.min(4), qh, ()));
            }
            "wl_shm" => {
                state.shm = Some(registry.bind(name, version.min(1), qh, ()));
            }
            "xdg_wm_base" => {
                state.xdg_wm_base = Some(registry.bind(name, version.min(5), qh, ()));
            }
            "ext_background_effect_manager_v1" => {
                state.background_effect_manager = Some(registry.bind(name, version.min(1), qh, ()));
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
    wl_surface::WlSurface,
    wl_shm::WlShm,
    wl_shm_pool::WlShmPool,
    wl_buffer::WlBuffer,
    wl_region::WlRegion,
    ext_background_effect_surface_v1::ExtBackgroundEffectSurfaceV1,
);

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
                if width > 0 && height > 0 {
                    state.configured_size = Some((width, height));
                }
            }
            xdg_toplevel::Event::Close => state.running = false,
            _ => {}
        }
    }
}

impl Dispatch<ext_background_effect_manager_v1::ExtBackgroundEffectManagerV1, ()> for App {
    fn event(
        state: &mut Self,
        _: &ext_background_effect_manager_v1::ExtBackgroundEffectManagerV1,
        event: ext_background_effect_manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let ext_background_effect_manager_v1::Event::Capabilities { flags } = event {
            state.blur_supported = match flags {
                WEnum::Value(flags) => {
                    flags.contains(ext_background_effect_manager_v1::Capability::Blur)
                }
                WEnum::Unknown(value) => {
                    println!("background_effect capabilities: unknown flags 0x{value:x}");
                    false
                }
            };
            println!("background_effect capabilities: {flags:?}");
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
            state.needs_frame = true;
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

fn rounded_rect_contains(x: f32, y: f32, width: f32, height: f32, radius: f32) -> bool {
    if x < 0.0 || y < 0.0 || x >= width || y >= height {
        return false;
    }
    let cx = x.clamp(radius, (width - radius).max(radius));
    let cy = y.clamp(radius, (height - radius).max(radius));
    let dx = x - cx;
    let dy = y - cy;
    dx * dx + dy * dy <= radius * radius
}

fn hole_rect(width: i32, height: i32) -> (i32, i32, i32, i32) {
    (
        width - HOLE_WIDTH - HOLE_MARGIN,
        height - HOLE_HEIGHT - HOLE_MARGIN,
        HOLE_WIDTH,
        HOLE_HEIGHT,
    )
}

/// 画一帧 ARGB8888（wl_shm 的字节序是 B,G,R,A）。
fn draw_pixel(x: usize, y: usize, width: i32, height: i32) -> [u8; 4] {
    let w = width as f32;
    let h = height as f32;
    let (xf, yf) = (x as f32 + 0.5, y as f32 + 0.5);

    if !rounded_rect_contains(xf, yf, w, h, 26.0) {
        return [0, 0, 0, 0];
    }

    let (hx, hy, hw, hh) = hole_rect(width, height);
    let in_hole = (hx..hx + hw).contains(&(x as i32)) && (hy..hy + hh).contains(&(y as i32));
    if in_hole {
        // 区域被 subtract：这里没有模糊，所以 surface 像素必须透明，才能看见清晰的桌面。
        let outline = 2;
        let near_edge = (x as i32 - hx) < outline
            || (hy + hh - 1 - y as i32) < outline
            || (hx + hw - 1 - x as i32) < outline
            || (y as i32 - hy) < outline;
        return if near_edge {
            [200, 210, 255, 220]
        } else {
            [0, 0, 0, 0]
        };
    }

    // 标题栏
    if (y as i32) < 46 {
        let line = (y as i32) == 45;
        if line {
            return [96, 130, 220, 255];
        }
        // 三个窗口按钮
        let dy = yf - 23.0;
        for (i, color) in [[255, 95, 86], [255, 189, 46], [39, 201, 63]]
            .into_iter()
            .enumerate()
        {
            let dx = xf - (24.0 + i as f32 * 20.0);
            if dx * dx + dy * dy <= 5.0 * 5.0 {
                return [color[2], color[1], color[0], 245];
            }
        }
        return [20, 24, 34, 235];
    }

    // 主体：上浅下深的半透明底色
    let t = ((y as i32 - 46).max(0) as f32) / (h - 46.0).max(1.0);
    let base = [
        (38.0 + 14.0 * (1.0 - t)) as u8,
        (44.0 + 16.0 * (1.0 - t)) as u8,
        (66.0 + 22.0 * (1.0 - t)) as u8,
    ];

    let left_card = (28..300).contains(&(x as i32)) && (74..250).contains(&(y as i32));
    let right_card = (x as i32) >= 330
        && (x as i32) < width - 28
        && (y as i32) >= 74
        && (y as i32) < height - 28;

    if right_card {
        // 右侧卡片上放几条“文字”，再用蓝色强调块穿过去
        if (y as i32) >= 104 && (y as i32) < 112 {
            return [110, 165, 255, 210];
        }
        let bar = (y as i32 - 132) / 28;
        let bar_y = (y as i32 - 132) % 28;
        if (0..4).contains(&bar)
            && bar_y < 10
            && (x as i32) >= 356
            && (x as i32) < 356 + 240 + bar * 36
        {
            return [170, 190, 220, 190];
        }
        return [base[2], base[1], base[0], 150];
    }

    if left_card {
        // 左侧卡片：标题 + 三行说明
        if (y as i32) >= 96 && (y as i32) < 108 && (x as i32) >= 52 && (x as i32) < 210 {
            return [235, 240, 255, 225];
        }
        if (y as i32) >= 130
            && (y as i32) < 218
            && (y as i32 - 130) % 30 < 9
            && (x as i32) >= 52
            && (x as i32) < 52 + 180 + ((y as i32 - 130) / 30) * 20
        {
            return [150, 165, 195, 185];
        }
        return [base[0] + 14, base[1] + 12, base[2] + 18, 190];
    }

    [base[2], base[1], base[0], 168]
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
    let pool = shm.create_pool(fd.as_fd(), stride * height, qh, ());
    let buffer = pool.create_buffer(0, width, height, stride, wl_shm::Format::Argb8888, qh, ());
    pool.destroy();
    Ok(buffer)
}

/// 设置模糊区域：整窗内缩一圈，再 subtract 右下角的矩形（画面上那里是透明的洞）。
fn set_blur_region(app: &App, qh: &QueueHandle<App>, width: i32, height: i32) {
    let (Some(compositor), Some(effect)) = (&app.compositor, &app.background_effect) else {
        return;
    };
    let region = compositor.create_region(qh, ());
    let inset = BLUR_INSET.min(width / 2).min(height / 2);
    region.add(inset, inset, width - inset * 2, height - inset * 2);
    let (hx, hy, hw, hh) = hole_rect(width, height);
    region.subtract(hx, hy, hw, hh);
    effect.set_blur_region(Some(&region));
    region.destroy();
}

fn draw_frame(app: &mut App, qh: &QueueHandle<App>, surface: &wl_surface::WlSurface) -> Result<()> {
    let width = app
        .configured_size
        .map(|(w, _)| w)
        .filter(|w| *w > 0)
        .unwrap_or(DEFAULT_WIDTH);
    let height = app
        .configured_size
        .map(|(_, h)| h)
        .filter(|h| *h > 0)
        .unwrap_or(DEFAULT_HEIGHT);

    if app.frame_size == Some((width, height)) {
        app.needs_frame = false;
        return Ok(());
    }

    let shm = app.shm.as_ref().expect("wl_shm not available");
    let buffer = create_shm_buffer(shm, qh, width, height)?;
    surface.attach(Some(&buffer), 0, 0);
    surface.damage_buffer(0, 0, width, height);

    if app.want_blur {
        set_blur_region(app, qh, width, height);
        let inset = BLUR_INSET.min(width / 2).min(height / 2);
        let (hx, hy, hw, hh) = hole_rect(width, height);
        println!(
            "blur region: add({inset},{inset},{},{}) subtract({hx},{hy},{hw},{hh})",
            width - inset * 2,
            height - inset * 2,
        );
    }
    surface.commit();
    println!("committed {width}x{height} frame");
    app.frame_size = Some((width, height));
    app.needs_frame = false;
    Ok(())
}

fn main() -> Result<()> {
    let want_blur = !std::env::args().any(|arg| arg == "--no-blur");

    let conn = Connection::connect_to_env()?;
    let mut event_queue = conn.new_event_queue::<App>();
    let qh = event_queue.handle();

    let display = conn.display();
    let _registry = display.get_registry(&qh, ());

    let mut app = App::new(want_blur);
    event_queue.roundtrip(&mut app)?;

    let compositor = app.compositor.clone().expect("wl_compositor not available");
    let wm_base = app.xdg_wm_base.clone().expect("xdg_wm_base not available");
    if app.shm.is_none() {
        anyhow::bail!("wl_shm not available");
    }

    let surface = compositor.create_surface(&qh, ());
    let xdg_surface = wm_base.get_xdg_surface(&surface, &qh, ());
    let xdg_toplevel = xdg_surface.get_toplevel(&qh, ());
    xdg_toplevel.set_title("ext-background-effect test".into());
    xdg_toplevel.set_app_id("background_effect_test".into());

    if let Some(manager) = &app.background_effect_manager {
        if want_blur {
            app.background_effect = Some(manager.get_background_effect(&surface, &qh, ()));
        }
    } else {
        println!("ext_background_effect_manager_v1 is not available; running without blur");
    }

    surface.commit();
    while !app.needs_frame {
        event_queue.blocking_dispatch(&mut app)?;
    }

    draw_frame(&mut app, &qh, &surface)?;
    println!(
        "window shown (blur requested: {want_blur}, supported: {}). Close the window to exit.",
        app.blur_supported
    );

    while app.running {
        event_queue.blocking_dispatch(&mut app)?;
        if app.needs_frame {
            draw_frame(&mut app, &qh, &surface)?;
        }
    }
    Ok(())
}
