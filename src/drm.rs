use smithay::backend::allocator::{
    Format as DrmFormat, Fourcc as DrmFourcc, Modifier as DrmModifier,
};
use smithay::reexports::calloop::EventLoop;
use smithay::{
    backend::{
        allocator::gbm::{GbmAllocator, GbmBufferFlags, GbmDevice},
        drm::{
            compositor::{DrmCompositor, FrameFlags},
            exporter::gbm::GbmFramebufferExporter,
            DrmDevice, DrmDeviceFd,
        },
        egl::{context::EGLContext, display::EGLDisplay},
        renderer::{
            element::surface::{render_elements_from_surface_tree, WaylandSurfaceRenderElement},
            gles::GlesRenderer,
            ImportDma,
        },
    },
    output::{Output, OutputModeSource, PhysicalProperties, Subpixel},
    reexports::drm::control::{connector, crtc, framebuffer, Device as DrmControlDevice},
    utils::Transform as SmithayTransform,
};
use std::fs::OpenOptions;
use std::os::unix::io::{AsFd, OwnedFd};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{debug, error, info, warn};

use crate::backend::RenderBackend;
use crate::protocol::{ModeInfo, Rect, ScreenInfo};
use crate::wayland::App;

/// 计算画布相关矩形（内容坐标系：原点为窗口内容（xdg window geometry）左上角，
/// 即协议 rect 的坐标系）。返回 (离屏画布矩形, 应用内容范围)：
///
/// - 应用内容范围 = 各窗口 surface tree 包围盒的并集（含阴影/悬出部分），
///   与应用大小实时同步；默认显示区域即此范围，保证画布不裁切应用；
/// - 离屏画布矩形 = 应用内容范围 ∪ SetWindowSize 声明的 (0, 0, w, h)，
///   仅作为 rect 截取的坐标空间（可突破物理屏幕）。
fn canvas_rects(state: &App, canvas_size: Option<(u32, u32)>) -> (Rect, Rect) {
    let mut x0 = 0i32;
    let mut y0 = 0i32;
    let mut x1 = 0i32;
    let mut y1 = 0i32;
    let mut has_window = false;

    for window in state.space.elements() {
        let geo = window.geometry();
        let bbox = window.bbox();
        // 内容坐标 = surface tree 坐标 - geo.loc
        let wx0 = bbox.loc.x - geo.loc.x;
        let wy0 = bbox.loc.y - geo.loc.y;
        let wx1 = wx0 + bbox.size.w;
        let wy1 = wy0 + bbox.size.h;
        if has_window {
            x0 = x0.min(wx0);
            y0 = y0.min(wy0);
            x1 = x1.max(wx1);
            y1 = y1.max(wy1);
        } else {
            (x0, y0, x1, y1) = (wx0, wy0, wx1, wy1);
            has_window = true;
        }
    }

    let app_rect = Rect {
        x: x0,
        y: y0,
        width: (x1 - x0).max(0) as u32,
        height: (y1 - y0).max(0) as u32,
    };

    // 离屏画布 = 应用内容范围 ∪ 声明画布 (0, 0, w, h)
    let (decl_w, decl_h) = canvas_size.unwrap_or((0, 0));
    let ox0 = x0.min(0);
    let oy0 = y0.min(0);
    let ox1 = x1.max(decl_w as i32);
    let oy1 = y1.max(decl_h as i32);
    let offscreen_rect = Rect {
        x: ox0,
        y: oy0,
        width: (ox1 - ox0).max(0) as u32,
        height: (oy1 - oy0).max(0) as u32,
    };

    (offscreen_rect, app_rect)
}

struct DrmOutputData {
    crtc: crtc::Handle,
    connector: connector::Handle,
    mode: smithay::reexports::drm::control::Mode,
    /// connector 支持的全部模式（EDID 顺序）
    all_modes: Vec<smithay::reexports::drm::control::Mode>,
    width: u32,
    height: u32,
    smithay_output: Output,
}

fn mode_info(mode: &smithay::reexports::drm::control::Mode) -> ModeInfo {
    ModeInfo {
        width: mode.size().0 as u32,
        height: mode.size().1 as u32,
        refresh_rate: mode.vrefresh(),
    }
}

/// 启动模式：保持 EDID 首选模式的分辨率，在同一分辨率里选刷新率最高的模式。
///
/// connector 的 `modes()` 按 EDID 顺序排列，`modes()[0]` 通常是首选分辨率但
/// 刷新率可能是 60Hz；直接取第一个会让 120Hz 屏幕只跑 60Hz。
fn pick_startup_mode(
    modes: &[smithay::reexports::drm::control::Mode],
) -> Option<smithay::reexports::drm::control::Mode> {
    let first = modes.first()?;
    let size = first.size();
    modes
        .iter()
        .filter(|mode| mode.size() == size)
        .max_by_key(|mode| mode.vrefresh())
        .copied()
}

/// 去重后的模式列表：同一分辨率/刷新率只保留一个。
fn mode_list(modes: &[smithay::reexports::drm::control::Mode]) -> Vec<ModeInfo> {
    let mut list = Vec::new();
    for mode in modes {
        let info = mode_info(mode);
        if !list.contains(&info) {
            list.push(info);
        }
    }
    list
}

/// 设置一个 DRM connector 的 DPMS 状态。
///
/// 直接设 connector 的 `DPMS` 属性，保留 CRTC 活跃状态，唤醒时仍可正常 page flip。
/// 不使用 `DrmCompositor::clear()`：它会 reset CRTC/connector，适合 VT 切换，
/// 但普通熄屏后直接 queue_frame 会因 CRTC 不活跃而失败。
///
/// TODO: 权限/VT/热插拔
/// - 目前依赖 wrap 已能打开 `/dev/dri/card*` 并成为 DRM master（root 或 video 组）；
///   后续可接 libseat/logind 的 TakeDevice，DPMS 本身不需要额外权限。
/// - VT 切换、热插拔、多 GPU 时还需要同步 DPMS 状态。
fn set_dpms(fd: &DrmDeviceFd, connector_handle: connector::Handle, on: bool) -> anyhow::Result<()> {
    let props = fd.get_properties(connector_handle)?;
    for (&prop, _) in props.iter() {
        let info = fd.get_property(prop)?;
        if info
            .name()
            .to_str()
            .map(|name| name == "DPMS")
            .unwrap_or(false)
        {
            // DRM_MODE_DPMS_ON = 0, DRM_MODE_DPMS_OFF = 3
            fd.set_property(connector_handle, prop, if on { 0u64 } else { 3u64 })?;
            return Ok(());
        }
    }
    anyhow::bail!("connector {:?} 没有 DPMS 属性", connector_handle)
}

/// 启动前的 CRTC 状态（文本控制台/fbcon）。退出时用 `set_crtc` 原样恢复：
/// smithay 的 `DrmDevice::drop` 是按属性快照恢复的，而 `DrmDevice::new` 里的
/// reset 已经释放了原来的 MODE_ID blob，在部分驱动（如 xe）上会 EINVAL。
#[derive(Debug, Clone)]
struct SavedCrtc {
    crtc: crtc::Handle,
    connectors: Vec<connector::Handle>,
    mode: smithay::reexports::drm::control::Mode,
    fb: framebuffer::Handle,
    position: (u32, u32),
}

/// 在 `DrmDevice::new` 之前记录当前显示状态。VT 里的 fbcon 会以
/// CRTC + fb + mode 的形式出现在这里。
fn capture_crtc_state(fd: &DrmDeviceFd) -> Vec<SavedCrtc> {
    let Ok(res) = fd.resource_handles() else {
        return Vec::new();
    };
    let mut saved = Vec::new();
    for &crtc_handle in res.crtcs() {
        let Ok(info) = fd.get_crtc(crtc_handle) else {
            continue;
        };
        let (Some(fb), Some(mode)) = (info.framebuffer(), info.mode()) else {
            continue;
        };
        let mut connectors = Vec::new();
        for &conn in res.connectors() {
            let Ok(conn_info) = fd.get_connector(conn, false) else {
                continue;
            };
            let Some(enc) = conn_info.current_encoder() else {
                continue;
            };
            let Ok(enc_info) = fd.get_encoder(enc) else {
                continue;
            };
            if enc_info.crtc() == Some(crtc_handle) {
                connectors.push(conn);
            }
        }
        if connectors.is_empty() {
            continue;
        }
        saved.push(SavedCrtc {
            crtc: crtc_handle,
            connectors,
            mode,
            fb,
            position: info.position(),
        });
    }
    saved
}

// Wayland 变体比 Custom 大 ~300B；渲染循环每帧构造元素，装箱会引入额外堆分配，
// 这里保持内联以减少每帧分配开销
#[allow(clippy::large_enum_variant)]
pub enum MyElement {
    Wayland(WaylandSurfaceRenderElement<GlesRenderer>),
    Custom(crate::custom_element::CropStretchElement),
}

impl smithay::backend::renderer::element::Element for MyElement {
    fn id(&self) -> &smithay::backend::renderer::element::Id {
        match self {
            MyElement::Wayland(e) => e.id(),
            MyElement::Custom(e) => e.id(),
        }
    }
    fn current_commit(&self) -> smithay::backend::renderer::utils::CommitCounter {
        match self {
            MyElement::Wayland(e) => e.current_commit(),
            MyElement::Custom(e) => e.current_commit(),
        }
    }
    fn src(&self) -> smithay::utils::Rectangle<f64, smithay::utils::Buffer> {
        match self {
            MyElement::Wayland(e) => e.src(),
            MyElement::Custom(e) => e.src(),
        }
    }
    fn transform(&self) -> smithay::utils::Transform {
        match self {
            MyElement::Wayland(e) => e.transform(),
            MyElement::Custom(e) => e.transform(),
        }
    }
    fn geometry(
        &self,
        scale: smithay::utils::Scale<f64>,
    ) -> smithay::utils::Rectangle<i32, smithay::utils::Physical> {
        match self {
            MyElement::Wayland(e) => e.geometry(scale),
            MyElement::Custom(e) => e.geometry(scale),
        }
    }
    fn damage_since(
        &self,
        scale: smithay::utils::Scale<f64>,
        commit: Option<smithay::backend::renderer::utils::CommitCounter>,
    ) -> smithay::backend::renderer::utils::DamageSet<i32, smithay::utils::Physical> {
        match self {
            MyElement::Wayland(e) => e.damage_since(scale, commit),
            MyElement::Custom(e) => e.damage_since(scale, commit),
        }
    }
    fn opaque_regions(
        &self,
        scale: smithay::utils::Scale<f64>,
    ) -> smithay::backend::renderer::utils::OpaqueRegions<i32, smithay::utils::Physical> {
        match self {
            MyElement::Wayland(e) => e.opaque_regions(scale).to_vec().into_iter().collect(),
            MyElement::Custom(_) => smithay::backend::renderer::utils::OpaqueRegions::default(),
        }
    }
    fn alpha(&self) -> f32 {
        match self {
            MyElement::Wayland(e) => e.alpha(),
            MyElement::Custom(e) => e.alpha(),
        }
    }
    fn kind(&self) -> smithay::backend::renderer::element::Kind {
        match self {
            MyElement::Wayland(e) => e.kind(),
            MyElement::Custom(e) => e.kind(),
        }
    }
}

impl smithay::backend::renderer::element::RenderElement<GlesRenderer> for MyElement {
    fn draw(
        &self,
        frame: &mut smithay::backend::renderer::gles::GlesFrame<'_, '_>,
        src: smithay::utils::Rectangle<f64, smithay::utils::Buffer>,
        dst: smithay::utils::Rectangle<i32, smithay::utils::Physical>,
        damage: &[smithay::utils::Rectangle<i32, smithay::utils::Physical>],
        opaque_regions: &[smithay::utils::Rectangle<i32, smithay::utils::Physical>],
    ) -> Result<(), smithay::backend::renderer::gles::GlesError> {
        match self {
            MyElement::Wayland(e) => e.draw(frame, src, dst, damage, opaque_regions),
            MyElement::Custom(e) => e.draw(frame, src, dst, damage, opaque_regions),
        }
    }
}

type GbmDrmCompositor = DrmCompositor<
    GbmAllocator<Arc<OwnedFd>>,
    GbmFramebufferExporter<Arc<OwnedFd>>,
    (),
    Arc<OwnedFd>,
>;

/// 每个输出的渲染运行时（与 `DrmBackend::outputs` 按下标一一对应）
struct DrmOutputRuntime {
    compositor: GbmDrmCompositor,
    needs_vblank: bool,
    /// 上屏元素的持久 ID。每帧新建 `Id::new()` 会让 DrmCompositor 的
    /// damage 状态无法跨帧匹配，从而每帧都按全新元素全量重绘
    element_id: smithay::backend::renderer::element::Id,
}

pub struct DrmBackend {
    width: u32,
    height: u32,
    outputs: Vec<DrmOutputData>,
    gbm: Option<GbmDevice<Arc<OwnedFd>>>,
    renderer: Option<GlesRenderer>,
    compositors: Vec<DrmOutputRuntime>,
    start_time: Instant,
    frame_count: u64,
    /// VBlank 事件通道，携带发生翻页的 crtc
    rx: Option<std::sync::mpsc::Receiver<crtc::Handle>>,
    tx: Option<std::sync::mpsc::Sender<crtc::Handle>>,
    pub rotate_shader: Option<smithay::backend::renderer::gles::GlesTexProgram>,
    /// 画布离屏纹理（随画布尺寸变化重建）
    pub offscreen_texture: Option<smithay::backend::renderer::gles::GlesTexture>,
    offscreen_size: Option<(u32, u32)>,
    /// 上次上屏时的客户端内容代数（见 `App::content_generation`）
    last_content_generation: u64,
    /// 上次上屏时的屏幕配置代数
    last_config_generation: u64,
    /// 上次实际下发的屏幕电源状态（true = 开）
    last_screen_power: Vec<bool>,
    /// 启动前的显示状态（fbcon），退出时恢复
    saved_crtcs: Vec<SavedCrtc>,
    // device/device_fd 放在最后：字段按声明顺序 drop，必须等 compositor（surface）
    // 先 clear_state 关掉我们设置的 CRTC，再由 device 恢复启动前状态；
    // 反过来会被 surface 的 Drop 再次关掉，退出后就是黑屏
    device_fd: Option<DrmDeviceFd>,
    device: Option<DrmDevice>,
}

// SAFETY: GlesRenderer contains raw pointers that are not Send, but it's safe to send
// across threads because the OpenGL context is managed by the EGL display and we only
// use the renderer in the render loop which runs on a single thread.
unsafe impl Send for DrmBackend {}

impl DrmBackend {
    pub fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::channel();
        Self {
            width: 1920,
            height: 1080,
            outputs: Vec::new(),
            device: None,
            device_fd: None,
            gbm: None,
            renderer: None,
            compositors: Vec::new(),
            start_time: Instant::now(),
            frame_count: 0,
            rx: Some(rx),
            tx: Some(tx),
            rotate_shader: None,
            offscreen_texture: None,
            offscreen_size: None,
            last_content_generation: 0,
            last_config_generation: 0,
            last_screen_power: Vec::new(),
            saved_crtcs: Vec::new(),
        }
    }

    /// 用启动前记录的 (crtc, fb, mode, connectors) 把显示恢复成 fbcon。
    /// 必须还在 DRM master 状态下调用。
    fn restore_saved_state(&self) -> bool {
        let Some(fd) = self.device_fd.as_ref() else {
            return false;
        };
        if self.saved_crtcs.is_empty() {
            return false;
        }
        let mut all_ok = true;
        for saved in &self.saved_crtcs {
            match fd.set_crtc(
                saved.crtc,
                Some(saved.fb),
                saved.position,
                &saved.connectors,
                Some(saved.mode),
            ) {
                Ok(()) => info!(
                    "显示已恢复到启动前状态：crtc {:?} fb {:?} mode {}",
                    saved.crtc,
                    saved.fb,
                    saved.mode.name().to_string_lossy()
                ),
                Err(e) => {
                    all_ok = false;
                    error!("恢复 crtc {:?} 的显示状态失败: {}", saved.crtc, e);
                }
            }
        }
        all_ok
    }

    /// 按配置设置各输出的 DPMS，返回是否有关掉的屏幕被重新打开（需要强制重绘）。
    fn apply_screen_power(&mut self, screen_power: &[bool]) -> bool {
        let Some(fd) = self.device_fd.clone() else {
            return false;
        };
        let mut woke = false;
        for (index, output) in self.outputs.iter().enumerate() {
            let on = screen_power.get(index).copied().unwrap_or(true);
            let last = self.last_screen_power.get(index).copied().unwrap_or(true);
            if on == last {
                continue;
            }
            match set_dpms(&fd, output.connector, on) {
                Ok(()) => {
                    if self.last_screen_power.len() <= index {
                        self.last_screen_power.resize(index + 1, true);
                    }
                    self.last_screen_power[index] = on;
                    if on {
                        woke = true;
                    }
                }
                Err(e) => warn!(
                    "屏幕 {} 设置 DPMS {} 失败: {}",
                    index,
                    if on { "on" } else { "off" },
                    e
                ),
            }
        }
        woke
    }

    /// 退出前把所有 connector 的 DPMS 打开，避免恢复 fbcon 后仍是黑屏。
    fn wake_all_displays(&self) {
        let Some(fd) = self.device_fd.as_ref() else {
            return;
        };
        for output in &self.outputs {
            if let Err(e) = set_dpms(fd, output.connector, true) {
                warn!("退出时打开屏幕 {:?} 失败: {}", output.connector, e);
            }
        }
    }
}

impl RenderBackend for DrmBackend {
    fn name(&self) -> &str {
        "drm"
    }

    fn init(
        &mut self,
        _event_loop: &mut EventLoop<App>,
        state: &mut App,
    ) -> Result<(), Box<dyn std::error::Error>> {
        info!("Initializing DRM display backend");

        let drm_paths = ["/dev/dri/card0", "/dev/dri/card1", "/dev/dri/renderD128"];
        let mut device: Option<DrmDevice> = None;
        let mut device_fd: Option<DrmDeviceFd> = None;
        let mut initial_crtcs: Vec<SavedCrtc> = Vec::new();

        for path in &drm_paths {
            match OpenOptions::new().read(true).write(true).open(path) {
                Ok(file) => {
                    info!("Opened DRM device: {}", path);

                    let fd: OwnedFd = file.as_fd().try_clone_to_owned()?;
                    let fd = DrmDeviceFd::new(fd.into());

                    // 必须在 DrmDevice::new（会 reset_state）之前记录控制台/前一个
                    // 显示状态的 CRTC，否则退出时无法把 fbcon 恢复回来
                    let saved_crtcs = capture_crtc_state(&fd);

                    let (dev, drm_event) = DrmDevice::new(fd.clone(), true)?;

                    let tx = self.tx.as_ref().unwrap().clone();
                    _event_loop
                        .handle()
                        .insert_source(drm_event, move |event, _meta, state| {
                            if let smithay::backend::drm::DrmEvent::VBlank(handle) = event {
                                let _ = tx.send(handle);
                                // vblank 立刻处理：完成帧提交、发 frame 回调、渲染下一帧。
                                // 不再等下个定时器 tick，避免 needs_vblank 卡掉整轮渲染
                                state.on_vblank();
                            }
                        })
                        .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;

                    let res = dev.resource_handles()?;

                    // Find all available connectors
                    for &conn in res.connectors() {
                        let info = dev.get_connector(conn, false)?;
                        if info.state() == connector::State::Connected && !info.modes().is_empty() {
                            let mode = pick_startup_mode(info.modes())
                                .expect("connector 已确认至少有一个模式");
                            info!(
                                "Found connector: {:?}, mode: {:?} ({}x{}@{}Hz, {} 个可用模式)",
                                conn,
                                mode,
                                mode.size().0,
                                mode.size().1,
                                mode.vrefresh(),
                                info.modes().len()
                            );

                            for &enc in info.encoders() {
                                let enc_info = dev.get_encoder(enc)?;
                                let filter = enc_info.possible_crtcs();

                                // 取第一个可用的 crtc
                                if let Some(c) = res.filter_crtcs(filter).into_iter().next() {
                                    let smithay_mode = smithay::output::Mode {
                                        size: (mode.size().0 as i32, mode.size().1 as i32).into(),
                                        refresh: (mode.vrefresh() * 1000) as i32,
                                    };

                                    let smithay_output = Output::new(
                                        format!("DRM-{:?}", c),
                                        PhysicalProperties {
                                            size: (0, 0).into(),
                                            subpixel: Subpixel::Unknown,
                                            make: "DRM".into(),
                                            model: "Output".into(),
                                        },
                                    );

                                    smithay_output.create_global::<App>(&state.display_handle);
                                    smithay_output.change_current_state(
                                        Some(smithay_mode),
                                        Some(SmithayTransform::Normal),
                                        None,
                                        Some((0, 0).into()),
                                    );
                                    smithay_output.set_preferred(smithay_mode);

                                    let output_data = DrmOutputData {
                                        crtc: c,
                                        connector: conn,
                                        mode,
                                        all_modes: info.modes().to_vec(),
                                        width: mode.size().0 as u32,
                                        height: mode.size().1 as u32,
                                        smithay_output,
                                    };
                                    self.outputs.push(output_data);
                                    info!("Added output: CRTC {:?}, connector {:?}", c, conn);
                                }
                                if !self.outputs.is_empty() {
                                    break;
                                }
                            }
                        }
                    }

                    if !self.outputs.is_empty() {
                        device = Some(dev);
                        device_fd = Some(fd);
                        initial_crtcs = saved_crtcs;
                        break;
                    }
                }
                Err(e) => {
                    debug!("Cannot open {}: {}", path, e);
                }
            }
        }

        let mut device = device.ok_or_else(|| -> Box<dyn std::error::Error> {
            "No available DRM device found".into()
        })?;
        let device_fd = device_fd.unwrap();

        if self.outputs.is_empty() {
            return Err("No available outputs found".into());
        }

        // Use first output as default size
        if let Some(output) = self.outputs.first() {
            self.width = output.width;
            self.height = output.height;
        }

        // Create GBM device from DRM fd
        let gbm_fd = device_fd.as_fd().try_clone_to_owned()?;
        let gbm: GbmDevice<Arc<OwnedFd>> = GbmDevice::new(Arc::new(gbm_fd))?;

        // Create EGL display from GBM device
        let egl_display = unsafe { EGLDisplay::new(gbm.clone())? };
        let egl_context = EGLContext::new(&egl_display)?;
        let mut renderer = unsafe { GlesRenderer::new(egl_context)? };

        // dmabuf：把渲染器支持的格式注册给客户端。带 feedback（v4），
        // 主设备号使用当前 DRM 设备，客户端才能按正确格式分配。
        let dmabuf_formats: Vec<smithay::backend::allocator::Format> =
            renderer.dmabuf_formats().iter().copied().collect();
        match smithay::wayland::dmabuf::DmabufFeedbackBuilder::new(
            device.device_id(),
            dmabuf_formats.iter().copied(),
        )
        .build()
        {
            Ok(feedback) => state.setup_dmabuf_feedback(&feedback),
            Err(err) => {
                tracing::warn!("构建 dmabuf feedback 失败: {err}，回退到 v3");
                state.setup_dmabuf(dmabuf_formats);
            }
        }

        let shader = renderer.compile_custom_texture_shader(
            r#"
#version 100

//_DEFINES_

#if defined(EXTERNAL)
#extension GL_OES_EGL_image_external : require
#endif

precision mediump float;
#if defined(EXTERNAL)
uniform samplerExternalOES tex;
#else
uniform sampler2D tex;
#endif

uniform float alpha;
varying vec2 v_coords;

// 截取区域（内容坐标）：左上角 (x, y)、长宽 (w, h)
uniform vec4 u_region;
// 截取区域绕锚点 (x, y) 的旋转角（弧度）
uniform float u_rotation;
// 画布离屏纹理矩形（内容坐标）：原点 (x, y)、尺寸 (w, h)
uniform vec4 u_offscreen;

#if defined(DEBUG_FLAGS)
uniform float tint;
#endif

void main() {
    // v_coords 为满屏四边形的归一化坐标 [0,1]^2：
    // 屏幕坐标 -> 截取区域坐标（拉伸填充，隐式缩放）
    vec2 region = vec2(v_coords.x * u_region.z, v_coords.y * u_region.w);

    // 区域以 (x, y) 为锚点、绕锚点旋转，采样画布内容坐标：
    // 等价于把画布绕 (x, y) 旋转 -u_rotation 后截取 (0, 0, w, h) 拉伸上屏，
    // 旋转作用在截取阶段，直角得以保持
    float c = cos(u_rotation);
    float s = sin(u_rotation);
    vec2 content = u_region.xy + vec2(region.x * c - region.y * s, region.x * s + region.y * c);

    // 内容坐标 -> 离屏纹理坐标；范围之外（应用绘制范围之外）为透明
    vec2 uv = (content - u_offscreen.xy) / u_offscreen.zw;

    vec4 color;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        color = vec4(0.0);
    } else {
        color = texture2D(tex, uv);
    }

#if defined(NO_ALPHA)
    color = vec4(color.rgb, 1.0) * alpha;
#else
    color = color * alpha;
#endif

#if defined(DEBUG_FLAGS)
    if (tint == 1.0)
        color = vec4(0.0, 0.2, 0.0, 0.2) + color * 0.8;
#endif

    gl_FragColor = color;
}
"#,
            &[
                smithay::backend::renderer::gles::UniformName::new(
                    "u_region",
                    smithay::backend::renderer::gles::UniformType::_4f,
                ),
                smithay::backend::renderer::gles::UniformName::new(
                    "u_rotation",
                    smithay::backend::renderer::gles::UniformType::_1f,
                ),
                smithay::backend::renderer::gles::UniformName::new(
                    "u_offscreen",
                    smithay::backend::renderer::gles::UniformType::_4f,
                ),
            ],
        )?;

        // 为每个输出创建独立的 DRM compositor（多屏支持）
        for output_data in &self.outputs {
            let surface = device.create_surface(
                output_data.crtc,
                output_data.mode,
                &[output_data.connector],
            )?;

            let output_mode_source = OutputModeSource::from(&output_data.smithay_output);

            let allocator = GbmAllocator::new(
                gbm.clone(),
                GbmBufferFlags::SCANOUT | GbmBufferFlags::RENDERING,
            );
            let framebuffer_exporter = GbmFramebufferExporter::new(gbm.clone(), None);

            // Get renderer formats
            let color_formats = [DrmFourcc::Argb8888];
            let renderer_formats = [DrmFormat {
                code: DrmFourcc::Argb8888,
                modifier: DrmModifier::Invalid,
            }];

            let compositor = DrmCompositor::new(
                output_mode_source,
                surface,
                None,
                allocator,
                framebuffer_exporter,
                color_formats,
                renderer_formats,
                device.cursor_size(),
                Some(gbm.clone()),
            )?;

            self.compositors.push(DrmOutputRuntime {
                compositor,
                needs_vblank: false,
                element_id: smithay::backend::renderer::element::Id::new(),
            });
        }

        // Register outputs to space
        for output_data in &self.outputs {
            state.space.map_output(&output_data.smithay_output, (0, 0));
        }

        self.device = Some(device);
        self.device_fd = Some(device_fd);
        self.gbm = Some(gbm);
        self.renderer = Some(renderer);
        self.rotate_shader = Some(shader);
        self.saved_crtcs = initial_crtcs;
        self.last_screen_power = vec![true; self.outputs.len()];
        info!(
            "已记录启动前显示状态（{} 个 CRTC），退出时用于恢复文本控制台",
            self.saved_crtcs.len()
        );

        info!(
            "DRM backend initialized, found {} outputs",
            self.outputs.len()
        );

        Ok(())
    }

    fn import_dmabuf(&mut self, dmabuf: &smithay::backend::allocator::dmabuf::Dmabuf) -> bool {
        match self.renderer.as_mut() {
            Some(renderer) => renderer.import_dmabuf(dmabuf, None).is_ok(),
            None => false,
        }
    }

    fn shutdown(&mut self) {
        info!("退出：正在恢复启动前的显示状态");
        // 如果之前关过屏，先把 DPMS 打开，否则恢复 fbcon 后仍然是黑的
        self.wake_all_displays();
        // 顺序很重要：先丢 compositor/surface，其 Drop 会 clear_state 关掉我们
        // 设置的 CRTC；再恢复 fbcon。反过来的话恢复会被随后的 clear_state 覆盖
        self.compositors.clear();
        self.offscreen_texture = None;
        self.rotate_shader = None;

        let restored = self.restore_saved_state();
        if restored {
            if let Some(device) = self.device.as_mut() {
                // 释放 DRM master，并让 smithay 的 Drop 跳过它那套属性快照恢复
                //（reset_state 已销毁原 MODE_ID blob，部分驱动会 EINVAL）
                device.pause();
            }
        } else {
            warn!("未能恢复启动前的显示状态，交给 smithay 释放时再试一次");
        }

        self.renderer = None;
        self.gbm = None;
    }

    fn dispatch(&mut self) -> bool {
        // Handle DRM events sent via channel from the calloop source.
        // VBlank 按 crtc 路由到对应输出的 compositor 完成翻页。
        // 返回本次是否有帧真正完成上屏（用于决定何时发 frame 回调）。
        let mut presented = false;
        if let Some(rx) = self.rx.as_ref() {
            while let Ok(handle) = rx.try_recv() {
                if let Some(index) = self.outputs.iter().position(|o| o.crtc == handle) {
                    if let Some(runtime) = self.compositors.get_mut(index) {
                        if runtime.needs_vblank {
                            runtime.needs_vblank = false;
                            let _ = runtime.compositor.frame_submitted();
                            presented = true;
                        }
                    }
                }
            }
        }
        presented
    }

    fn has_frame_in_flight(&self) -> bool {
        self.compositors.iter().any(|r| r.needs_vblank)
    }

    /// 帧上屏（或确定无帧可等）后给客户端发 frame 回调。
    /// 以前每 16ms 定时器无条件发、且 presentation time 恒为 0，客户端与真实呈现完全脱钩。
    fn send_frame_callbacks(&self, state: &mut App) {
        let Some(output_data) = self.outputs.first() else {
            return;
        };
        let output = &output_data.smithay_output;
        let time = self.start_time.elapsed();
        // 节流间隔 = 刷新周期（mode.refresh 为毫赫兹）
        let throttle = output
            .current_mode()
            .map(|mode| Duration::from_secs_f64(1000.0 / f64::from(mode.refresh).max(1.0)));
        for window in state.space.elements() {
            window.send_frame(output, time, throttle, |_, _| Some(output.clone()));
        }
        state.send_presentation_feedbacks(output, crate::wayland::monotonic_now(), throttle);
    }

    fn get_screens(&self) -> Vec<ScreenInfo> {
        self.outputs
            .iter()
            .map(|output| ScreenInfo {
                name: format!("DRM-{:?}", output.crtc),
                width: output.width,
                height: output.height,
                refresh_rate: output.mode.vrefresh(),
                modes: mode_list(&output.all_modes),
            })
            .collect()
    }

    fn set_screen_mode(
        &mut self,
        screen_index: usize,
        mode: ModeInfo,
    ) -> anyhow::Result<ScreenInfo> {
        let output = self
            .outputs
            .get(screen_index)
            .ok_or_else(|| anyhow::anyhow!("Invalid screen index: {}", screen_index))?;
        let drm_mode = output
            .all_modes
            .iter()
            .find(|m| {
                m.size().0 as u32 == mode.width
                    && m.size().1 as u32 == mode.height
                    && m.vrefresh() == mode.refresh_rate
            })
            .copied()
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "屏幕 {} 不支持模式 {}x{}@{}Hz",
                    screen_index,
                    mode.width,
                    mode.height,
                    mode.refresh_rate
                )
            })?;

        let runtime = self
            .compositors
            .get_mut(screen_index)
            .ok_or_else(|| anyhow::anyhow!("屏幕 {} 没有 DRM compositor", screen_index))?;
        runtime
            .compositor
            .use_mode(drm_mode)
            .map_err(|e| anyhow::anyhow!("设置 DRM 模式失败: {:?}", e))?;

        let smithay_mode = smithay::output::Mode {
            size: (mode.width as i32, mode.height as i32).into(),
            refresh: (mode.refresh_rate * 1000) as i32,
        };
        let output = &mut self.outputs[screen_index];
        output.mode = drm_mode;
        output.width = mode.width;
        output.height = mode.height;
        output
            .smithay_output
            .change_current_state(Some(smithay_mode), None, None, None);
        if screen_index == 0 {
            self.width = mode.width;
            self.height = mode.height;
        }

        info!(
            "屏幕 {} 已切换到 {}x{}@{}Hz",
            screen_index, mode.width, mode.height, mode.refresh_rate
        );
        Ok(ScreenInfo {
            name: format!("DRM-{:?}", output.crtc),
            width: output.width,
            height: output.height,
            refresh_rate: output.mode.vrefresh(),
            modes: mode_list(&output.all_modes),
        })
    }

    fn get_output_count(&self) -> usize {
        self.outputs.len()
    }

    fn render_space(
        &mut self,
        state: &mut App,
        configs: &[crate::renderer::ScreenConfig],
        canvas_size: Option<(u32, u32)>,
        config_generation: u64,
        screen_power: &[bool],
    ) {
        self.frame_count += 1;

        // 先把电源状态下发到硬件；从关到开时强制重绘一帧
        let woke = self.apply_screen_power(screen_power);
        let any_on = screen_power.is_empty() || screen_power.iter().any(|&on| on);
        if !any_on {
            // 全部关屏：不渲染、不发 frame 回调，客户端自然停在等待上；
            // 打开屏幕时 woke 会触发一次完整重绘
            return;
        }

        // 内容坐标系原点 = 窗口内容（xdg window geometry）左上角（协议 rect 坐标系）。
        // offscreen_rect 为离屏画布矩形，app_rect 为应用内容范围（默认显示区域）
        let (offscreen_rect, app_rect) = canvas_rects(state, canvas_size);
        let canvas_valid = offscreen_rect.width > 0 && offscreen_rect.height > 0;
        let canvas_now = (offscreen_rect.width, offscreen_rect.height);

        // 相对上一次上屏：客户端内容、屏幕配置、画布尺寸是否变化
        let offscreen_size_matches = !canvas_valid || self.offscreen_size == Some(canvas_now);
        let content_changed = woke
            || state.content_generation != self.last_content_generation
            || !offscreen_size_matches;
        let config_changed = config_generation != self.last_config_generation;
        let offscreen_ready = !canvas_valid || self.offscreen_texture.is_some();

        if self.renderer.is_none() || (!content_changed && !config_changed && offscreen_ready) {
            // 画面没有变化：跳过离屏 pass、上屏与 page flip（静止画面零 GPU 开销），
            // 只补发 frame 回调，客户端不会因为等不到回调而饿死
            self.send_frame_callbacks(state);
            return;
        }

        // 本次决定上屏，记录代数；此后只有新的 commit / 配置变更才会再渲
        self.last_content_generation = state.content_generation;
        self.last_config_generation = config_generation;
        tracing::trace!(
            "Frame {}: content_changed={} config_changed={} canvas={}x{}",
            self.frame_count,
            content_changed,
            config_changed,
            offscreen_rect.width,
            offscreen_rect.height
        );

        let renderer = match self.renderer.as_mut() {
            Some(r) => r,
            None => return,
        };

        // Collect render elements from all windows in the space.
        // 与 smithay 的 Space 渲染保持一致：窗口原点对应 xdg window geometry 的
        // 原点，而 surface tree 的原点相对窗口原点偏移 geometry().loc
        //（CSD 阴影/边距）。渲染 surface tree 时减去该偏移，
        // 把窗口内容原点放在画布 (0, 0)。画布 1:1 渲染（scale = 1）。
        let elements: Vec<WaylandSurfaceRenderElement<GlesRenderer>> = state
            .space
            .elements()
            .flat_map(|window| {
                let surface = window.toplevel().unwrap().wl_surface().clone();
                let geometry_loc = window.geometry().loc;
                render_elements_from_surface_tree(
                    renderer,
                    &surface,
                    (
                        -geometry_loc.x - offscreen_rect.x,
                        -geometry_loc.y - offscreen_rect.y,
                    ),
                    smithay::utils::Scale::from(1.0),
                    1.0,
                    smithay::backend::renderer::element::Kind::Unspecified,
                )
            })
            .collect();

        // —— 第一遍：把画布内容 1:1 渲入离屏纹理（随画布尺寸变化重建）——
        // 仅在客户端内容变化或纹理尺寸不匹配时重绘；只改屏幕配置时直接复用上一帧画布
        let mut offscreen_texture: Option<smithay::backend::renderer::gles::GlesTexture> = None;
        let mut crop_shader: Option<smithay::backend::renderer::gles::GlesTexProgram> = None;

        if canvas_valid && self.rotate_shader.is_some() {
            let need_recreate = match (&self.offscreen_texture, self.offscreen_size) {
                (Some(_), Some(sz)) => sz != (offscreen_rect.width, offscreen_rect.height),
                _ => true,
            };
            if need_recreate {
                self.offscreen_texture = None;
                self.offscreen_size = None;
                let size = smithay::utils::Size::from((
                    offscreen_rect.width as i32,
                    offscreen_rect.height as i32,
                ));
                use smithay::backend::renderer::Offscreen;
                self.offscreen_texture = renderer
                    .create_buffer(smithay::backend::allocator::Fourcc::Argb8888, size)
                    .ok();
                if self.offscreen_texture.is_some() {
                    self.offscreen_size = Some((offscreen_rect.width, offscreen_rect.height));
                }
            }

            let repaint_offscreen = content_changed || need_recreate;

            if let (Some(tex), Some(shader)) =
                (self.offscreen_texture.as_mut(), self.rotate_shader.as_ref())
            {
                if repaint_offscreen {
                    use smithay::backend::renderer::{Bind, Frame, Renderer};
                    let size = smithay::utils::Size::from((
                        offscreen_rect.width as i32,
                        offscreen_rect.height as i32,
                    ));
                    let mut target = renderer.bind(tex).unwrap();
                    let mut frame = renderer
                        .render(&mut target, size, smithay::utils::Transform::Normal)
                        .unwrap();

                    let damage = [smithay::utils::Rectangle::from_size(size)];
                    let _ = frame.clear(
                        smithay::backend::renderer::Color32F::new(0.0, 0.0, 0.0, 0.0),
                        &damage,
                    );

                    for element in &elements {
                        use smithay::backend::renderer::element::{Element, RenderElement};
                        let _ = element.draw(
                            &mut frame,
                            element.src(),
                            element.geometry(smithay::utils::Scale::from(1.0)),
                            &damage,
                            &[],
                        );
                    }
                }

                offscreen_texture = Some(tex.clone());
                crop_shader = Some(shader.clone());
            }
        }

        // —— 第二遍：每个屏幕把（截取区域 → 屏幕）的映射渲上屏 ——
        for (index, (output_data, runtime)) in self
            .outputs
            .iter()
            .zip(self.compositors.iter_mut())
            .enumerate()
        {
            // 关掉的屏幕不渲染；该输出还在等上一帧翻页也跳过
            if !screen_power.get(index).copied().unwrap_or(true) || runtime.needs_vblank {
                continue;
            }

            let config = configs.iter().find(|c| c.screen_index == index);

            // 一个屏幕一个截取区域：rect 缺省（或无配置）= 应用内容范围（默认行为），
            // transform 缺省 = 不旋转
            let rect = config
                .and_then(|c| c.rect.as_ref())
                .cloned()
                .unwrap_or_else(|| app_rect.clone());
            let rotation = config
                .and_then(|c| c.transform.as_ref())
                .map(|t| t.rotation)
                .unwrap_or(0.0);

            let screen_size =
                smithay::utils::Size::from((output_data.width as i32, output_data.height as i32));
            let mut final_elements: Vec<MyElement> = Vec::new();

            if let (Some(tex), Some(shader)) = (offscreen_texture.as_ref(), crop_shader.as_ref()) {
                // 旋转截取 + 拉伸填充元素
                final_elements.push(MyElement::Custom(
                    crate::custom_element::CropStretchElement {
                        // 每屏持久 ID：让 DrmCompositor 的 damage 状态能跨帧匹配
                        id: runtime.element_id.clone(),
                        texture: tex.clone(),
                        src: smithay::utils::Rectangle::from_size(smithay::utils::Size::from((
                            offscreen_rect.width as f64,
                            offscreen_rect.height as f64,
                        ))),
                        region: rect.clone(),
                        offscreen: offscreen_rect.clone(),
                        rotation,
                        dst: smithay::utils::Rectangle::from_size(screen_size),
                        shader: shader.clone(),
                    },
                ));
            } else {
                // 回退：离屏纹理不可用时按拉伸逻辑直接渲 surface tree（无旋转）
                let scale_x = output_data.width as f64 / (rect.width as f64).max(1.0);
                let scale_y = output_data.height as f64 / (rect.height as f64).max(1.0);
                let scale = smithay::utils::Scale::from((scale_x, scale_y));
                let loc_x = -(rect.x as f64 * scale_x).round() as i32;
                let loc_y = -(rect.y as f64 * scale_y).round() as i32;

                for window in state.space.elements() {
                    let surface = window.toplevel().unwrap().wl_surface().clone();
                    let geometry_offset: smithay::utils::Point<i32, smithay::utils::Physical> =
                        window.geometry().loc.to_physical_precise_round(scale);
                    let elems: Vec<WaylandSurfaceRenderElement<GlesRenderer>> =
                        render_elements_from_surface_tree(
                            renderer,
                            &surface,
                            (loc_x - geometry_offset.x, loc_y - geometry_offset.y),
                            scale,
                            1.0,
                            smithay::backend::renderer::element::Kind::Unspecified,
                        );
                    final_elements.extend(elems.into_iter().map(MyElement::Wayland));
                }
            }

            // Render frame
            match runtime.compositor.render_frame::<_, MyElement>(
                renderer,
                &final_elements,
                [0.1, 0.1, 0.1, 1.0],
                FrameFlags::DEFAULT,
            ) {
                Ok(render_frame_result) => {
                    if !render_frame_result.is_empty {
                        // Queue the frame for display
                        if let Err(e) = runtime.compositor.queue_frame(()) {
                            error!(
                                "Frame {}: Failed to queue DRM frame for output {}: {}",
                                self.frame_count, index, e
                            );
                            continue;
                        }
                        runtime.needs_vblank = true;
                    }
                }
                Err(e) => {
                    error!(
                        "Frame {}: DRM render_frame failed for output {}: {:?}",
                        self.frame_count, index, e
                    );
                }
            }
        }

        // 有帧在飞 → 等 vblank 上屏后再发 frame 回调，客户端按真实呈现节奏提交；
        // 没有帧在飞（本次没产生 damage）→ 立即补发，避免客户端等不到回调而饿死
        if !self.compositors.iter().any(|r| r.needs_vblank) {
            self.send_frame_callbacks(state);
        }

        state.space.refresh();
        state.popups.cleanup();
        let _ = state.display_handle.flush_clients();
    }
}
