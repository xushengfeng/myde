use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::backend::RenderBackend;
use smithay::{
    backend::allocator::Format,
    delegate_presentation,
    desktop::{PopupManager, Space, Window},
    input::{Seat, SeatState},
    output::Output,
    reexports::{
        calloop::{
            generic::Generic, EventLoop, Interest, LoopSignal, Mode as CalloopMode, PostAction,
        },
        wayland_protocols::wp::presentation_time::server::wp_presentation_feedback,
        wayland_server::{
            backend::{ClientData, ClientId, DisconnectReason},
            Display, DisplayHandle,
        },
    },
    wayland::{
        compositor::{
            with_surface_tree_downward, CompositorClientState, CompositorState, TraversalAction,
        },
        dmabuf::{DmabufFeedback, DmabufGlobal, DmabufState},
        output::OutputManagerState,
        presentation::{PresentationFeedbackCachedState, PresentationState, Refresh},
        selection::data_device::DataDeviceState,
        shell::xdg::XdgShellState,
        shm::ShmState,
        socket::ListeningSocketSource,
    },
};
use std::time::Duration;

pub struct App {
    pub start_time: std::time::Instant,
    pub socket_name: std::ffi::OsString,
    pub display_handle: DisplayHandle,
    pub space: Space<Window>,
    pub loop_signal: LoopSignal,

    // Smithay State
    pub compositor_state: CompositorState,
    pub xdg_shell_state: XdgShellState,
    pub shm_state: ShmState,
    pub dmabuf_state: DmabufState,
    /// dmabuf 全局必须保活，否则客户端创建的 buffer 会失效
    pub dmabuf_global: Option<DmabufGlobal>,
    // 协议状态句柄：即使当前无读取点也需随 App 保活（xdg-output 全局、seat 句柄）
    #[allow(dead_code)]
    pub output_manager_state: OutputManagerState,
    pub seat_state: SeatState<App>,
    pub data_device_state: DataDeviceState,
    pub popups: PopupManager,
    #[allow(dead_code)]
    pub seat: Seat<Self>,
    /// wp_presentation 全局；保留 State 以维持 global
    #[allow(dead_code)]
    presentation_state: PresentationState,
    /// presented 事件里的单调递增序号
    presentation_seq: u64,

    // —— 渲染调度状态 ——
    /// 渲染后端。由事件循环线程独占：渲染时先 `take` 出来再调用，
    /// 避免 `render_space(&mut self, &mut App)` 的自引用借用冲突。
    pub backend: Option<Box<dyn crate::backend::RenderBackend>>,
    /// 屏幕配置（socket 线程写，渲染线程读）
    pub renderer_cfg: Option<Arc<Mutex<crate::renderer::Renderer>>>,
    /// 有脏内容需要上屏（socket 线程会跨线程置位）
    pub redraw: Arc<AtomicBool>,
    /// 客户端内容代数：窗口 surface tree 的每次 commit 递增。
    /// 渲染线程据此判断离屏画布是否需要重绘（静止画面零 GPU 开销）
    pub content_generation: u64,
    /// 上次渲染时的窗口数量，用于发现"窗口关闭"这类无 commit 的场景变化
    pub last_window_count: usize,
    /// 帧进入"在飞"状态的时刻（防御 vblank 事件丢失）
    in_flight_since: Option<std::time::Instant>,
}

impl App {
    pub fn new(event_loop: &mut EventLoop<Self>, display: Display<Self>) -> Self {
        let start_time = std::time::Instant::now();
        let dh = display.handle();

        // Here we initialize implementations of some wayland protocols
        // Some of them require us to implement traits on the App state,
        // you can find those implementations in the `crate::handlers` module

        // Initialize protocols needed for displaying windows
        let compositor_state = CompositorState::new::<Self>(&dh);
        let xdg_shell_state = XdgShellState::new::<Self>(&dh);
        let shm_state = ShmState::new::<Self>(&dh, vec![]);
        let dmabuf_state = DmabufState::new();
        let popups = PopupManager::default();
        let output_manager_state = OutputManagerState::new_with_xdg_output::<Self>(&dh);

        // Data device is responsible for clipboard and drag-and-drop
        let data_device_state = DataDeviceState::new::<Self>(&dh);

        // A seat is a group of keyboards, pointer and touch devices.
        // A seat typically has a pointer and maintains a keyboard focus and a pointer focus.
        let mut seat_state = SeatState::new();
        let mut seat: Seat<Self> = seat_state.new_wl_seat(&dh, "myde-wrap");

        // Notify clients that we have a keyboard, for the sake of the example we assume that keyboard is always present.
        // You may want to track keyboard hot-plug in real compositor.
        seat.add_keyboard(Default::default(), 200, 25).unwrap();

        // Notify clients that we have a pointer (mouse)
        // Here we assume that there is always pointer plugged in
        seat.add_pointer();

        // A space represents a two-dimensional plane. Windows and Outputs can be mapped onto it.
        //
        // Windows get a position and stacking order through mapping.
        // Outputs become views of a part of the Space and can be rendered via Space::render_output.
        let space = Space::default();

        // Setup a wayland socket that will be used to accept clients
        let socket_name = Self::init_wayland_listener(display, event_loop);

        // Get the loop signal, used to stop the event loop
        let loop_signal = event_loop.get_signal();

        // presentation-time：Chromium 用 presented.refresh 估算刷新率；
        // 没有该协议时即使 wl_output.mode 是 120Hz 也会退回 60Hz。
        // CLOCK_MONOTONIC = 1。
        let presentation_state = PresentationState::new::<Self>(&dh, 1);

        Self {
            start_time,
            display_handle: dh,
            space,
            loop_signal,
            socket_name,
            compositor_state,
            xdg_shell_state,
            shm_state,
            dmabuf_state,
            dmabuf_global: None,
            output_manager_state,
            seat_state,
            data_device_state,
            popups,
            seat,
            presentation_state,
            presentation_seq: 0,
            backend: None,
            renderer_cfg: None,
            redraw: Arc::new(AtomicBool::new(false)),
            content_generation: 0,
            last_window_count: 0,
            in_flight_since: None,
        }
    }

    /// 注册 dmabuf v3 全局（无 feedback）。适合拿不到主设备号的 winit 后端。
    pub fn setup_dmabuf(&mut self, formats: impl IntoIterator<Item = Format>) {
        let formats: Vec<Format> = formats.into_iter().collect();
        if formats.is_empty() {
            tracing::warn!("渲染器未报告 dmabuf 格式，跳过 dmabuf global");
            return;
        }
        let count = formats.len();
        self.dmabuf_global = Some(
            self.dmabuf_state
                .create_global::<App>(&self.display_handle, formats),
        );
        tracing::info!("已注册 dmabuf global（v3），{} 个格式", count);
    }

    /// 注册带 feedback 的 dmabuf v4 全局；需要渲染器所在 DRM 设备的主设备号。
    pub fn setup_dmabuf_feedback(&mut self, feedback: &DmabufFeedback) {
        self.dmabuf_global = Some(
            self.dmabuf_state
                .create_global_with_default_feedback::<App>(&self.display_handle, feedback),
        );
        tracing::info!("已注册 dmabuf global（v4 feedback）");
    }

    fn init_wayland_listener(
        display: Display<App>,
        event_loop: &mut EventLoop<Self>,
    ) -> std::ffi::OsString {
        // Creates a new listening socket, automatically choosing the next available `wayland` socket name.
        let listening_socket = ListeningSocketSource::new_auto().unwrap();

        // Get the name of the listening socket.
        // Clients will connect to this socket.
        let socket_name = listening_socket.socket_name().to_os_string();

        let loop_handle = event_loop.handle();
        loop_handle
            .insert_source(listening_socket, move |client_stream, _, state| {
                // Inside the callback, you should insert the client into the display.
                //
                // You may also associate some data with the client when inserting the client.
                tracing::info!("New Wayland client connecting");
                match state
                    .display_handle
                    .insert_client(client_stream, Arc::new(ClientState::default()))
                {
                    Ok(_) => tracing::info!("Wayland client connected successfully"),
                    Err(e) => tracing::error!("Failed to connect Wayland client: {}", e),
                }
            })
            .expect("Failed to init the wayland event source.");

        // You also need to add the display itself to the event loop, so that client events will be processed by wayland-server.
        loop_handle
            .insert_source(
                Generic::new(display, Interest::READ, CalloopMode::Level),
                |_, display, state| {
                    // Safety: we don't drop the display
                    unsafe {
                        let _ = display.get_mut().dispatch_clients(state);
                    }
                    // 本批次的 commit 已处理完：刷新 space 并按需立即渲染。
                    // 渲染跟着客户端提交走，不必再等下一个定时器 tick（省最多一帧延迟）
                    state.refresh_and_render();
                    Ok(PostAction::Continue)
                },
            )
            .unwrap();

        socket_name
    }

    pub fn process_input_event(
        &mut self,
        event: smithay::backend::input::InputEvent<smithay::backend::winit::WinitInput>,
    ) {
        // Handle input events
        match event {
            smithay::backend::input::InputEvent::Keyboard { event } => {
                // Handle keyboard events
                let _ = event;
            }
            smithay::backend::input::InputEvent::PointerMotion { event } => {
                // Handle pointer motion
                let _ = event;
            }
            smithay::backend::input::InputEvent::PointerButton { event } => {
                // Handle pointer button
                let _ = event;
            }
            _ => {}
        }
    }
}

/// CLOCK_MONOTONIC（wp_presentation.clock_id = 1）的绝对时间。
pub(crate) fn monotonic_now() -> Duration {
    match nix::time::clock_gettime(nix::time::ClockId::CLOCK_MONOTONIC) {
        Ok(time) => Duration::new(time.tv_sec().max(0) as u64, time.tv_nsec().max(0) as u32),
        Err(_) => Duration::ZERO,
    }
}

// —— 渲染调度 ——
//
// DRM 后端不再由固定 16ms 定时器盲渲，而是事件驱动：
//   1. 客户端 commit（display 事件批次结束）→ 有新内容且无在飞帧则立即渲染；
//   2. vblank（帧真正上屏）→ 完成帧提交、发 frame 回调，再渲染排队的内容；
//   3. 定时器兜底 → 处理 socket 配置变更、窗口关闭等无 Wayland 事件的场景。
// 帧在飞时（等 vblank）只置脏不渲染，渲染节奏天然与 vblank 对齐，不会掉帧。
impl App {
    /// 注入渲染后端与屏幕配置（必须在 backend.init 之后调用）
    pub fn set_backend(
        &mut self,
        backend: Box<dyn RenderBackend>,
        renderer_cfg: Arc<Mutex<crate::renderer::Renderer>>,
    ) {
        self.backend = Some(backend);
        self.renderer_cfg = Some(renderer_cfg);
        // 启动时先渲一帧，保证 scanout 缓冲有确定内容
        self.request_redraw();
    }

    /// 退出前让后端恢复显示（DRM：恢复启动前的 fbcon 状态）
    pub fn shutdown_backend(&mut self) {
        if let Some(mut backend) = self.backend.take() {
            backend.shutdown();
        }
    }

    /// 标记有内容需要上屏（可跨线程调用）
    pub fn request_redraw(&self) {
        self.redraw.store(true, Ordering::Release);
    }

    /// 客户端提交了新内容：递增内容代数并请求重绘
    pub fn invalidate_content(&mut self) {
        self.content_generation = self.content_generation.wrapping_add(1);
        self.request_redraw();
    }

    /// 在帧上屏（或确认无帧可等）后回 wp_presentation feedback。
    ///
    /// `refresh` 传当前输出的刷新周期；时间基准与 frame callback 一致，
    /// 都是 `App::start_time` 起的时长（CLOCK_MONOTONIC 等价）。
    pub fn send_presentation_feedbacks(
        &mut self,
        output: &Output,
        time: Duration,
        refresh: Option<Duration>,
    ) {
        let mut callbacks = Vec::new();
        let roots: Vec<_> = self
            .space
            .elements()
            .filter_map(|window| window.toplevel().map(|t| t.wl_surface().clone()))
            .collect();
        for root in roots {
            with_surface_tree_downward(
                &root,
                (),
                |_, _, _| TraversalAction::DoChildren(()),
                |_, states, _| {
                    let mut cached = states.cached_state.get::<PresentationFeedbackCachedState>();
                    callbacks.append(&mut cached.current().callbacks);
                },
                |_, _, _| true,
            );
        }

        let refresh = refresh.map(Refresh::fixed).unwrap_or(Refresh::Unknown);
        for callback in callbacks {
            self.presentation_seq = self.presentation_seq.wrapping_add(1);
            callback.presented(
                output,
                time,
                refresh,
                self.presentation_seq,
                wp_presentation_feedback::Kind::Vsync,
            );
        }
    }

    /// 有脏内容且当前没有帧在飞时，立即渲染一帧；否则等待 vblank。
    fn schedule_render(&mut self) {
        if !self.redraw.load(Ordering::Acquire) {
            return;
        }
        let Some(mut backend) = self.backend.take() else {
            return;
        };
        self.render_if_possible(&mut backend);
        self.backend = Some(backend);
    }

    /// 渲染当前脏内容（要求没有帧在飞）
    fn render_if_possible(&mut self, backend: &mut Box<dyn RenderBackend>) {
        if !self.redraw.load(Ordering::Acquire) || backend.has_frame_in_flight() {
            return;
        }
        let Some(renderer_cfg) = self.renderer_cfg.clone() else {
            return;
        };
        // 先把 socket 线程请求的模式切换应用到后端。模式切换会影响输出尺寸，
        // 必须在取配置快照、渲染这一帧之前完成。
        let pending_modes = {
            let mut guard = renderer_cfg.blocking_lock();
            guard.take_pending_modes()
        };
        for (index, mode) in pending_modes {
            match backend.set_screen_mode(index, mode) {
                Ok(screen) => {
                    renderer_cfg
                        .blocking_lock()
                        .apply_screen_info(index, screen);
                }
                Err(e) => {
                    tracing::warn!("切换屏幕 {} 模式失败: {}", index, e);
                    // 回滚快照到后端实际状态，避免 socket 侧继续报告错误的模式
                    if let Some(screen) = backend.get_screens().into_iter().nth(index) {
                        renderer_cfg
                            .blocking_lock()
                            .apply_screen_info(index, screen);
                    }
                }
            }
        }
        // 取配置快照后立刻释放锁，不让锁跨越整轮 GL 渲染
        let (configs, canvas_size, config_generation, screen_power) = {
            let guard = renderer_cfg.blocking_lock();
            (
                guard.get_screen_configs().to_vec(),
                guard.get_canvas_size(),
                guard.config_generation(),
                guard.screen_power().to_vec(),
            )
        };
        self.redraw.store(false, Ordering::Release);
        backend.render_space(
            self,
            &configs,
            canvas_size,
            config_generation,
            &screen_power,
        );
    }

    /// DRM vblank：帧已扫描上屏。立即完成帧提交（归还 swapchain 槽位）、
    /// 发 frame 回调，并调度下一帧——不再等下一个定时器 tick。
    pub fn on_vblank(&mut self) {
        let Some(mut backend) = self.backend.take() else {
            return;
        };
        // 每个 vblank 都要回 frame callback（dispatch 只负责完成翻页），
        // 否则客户端等 done 时会错过下一拍，120Hz 被压成 60Hz。
        backend.dispatch();
        backend.send_frame_callbacks(self);
        self.render_if_possible(&mut backend);
        self.backend = Some(backend);
    }

    /// 事件批次结束后（display 事件源 / 定时兜底）调用：
    /// 刷新 space、检测窗口增删、按需渲染。
    pub fn refresh_and_render(&mut self) {
        self.space.refresh();
        self.popups.cleanup();

        // 窗口关闭没有 commit 可依，靠窗口数量变化发现
        let count = self.space.elements().count();
        if count != self.last_window_count {
            self.last_window_count = count;
            self.invalidate_content();
        }

        self.watch_frame_stall();
        self.schedule_render();
        let _ = self.display_handle.flush_clients();
    }

    /// 防御：帧在飞却迟迟收不到 vblank（事件丢失/驱动异常）时，
    /// 兜底补发 frame 回调，避免客户端等不到回调而停摆，并留下告警。
    fn watch_frame_stall(&mut self) {
        let in_flight = self
            .backend
            .as_ref()
            .is_some_and(|backend| backend.has_frame_in_flight());
        if !in_flight {
            self.in_flight_since = None;
            return;
        }
        let since = *self
            .in_flight_since
            .get_or_insert_with(std::time::Instant::now);
        if since.elapsed() <= std::time::Duration::from_millis(200) {
            return;
        }
        self.in_flight_since = Some(std::time::Instant::now());
        tracing::warn!("帧在飞超过 200ms 未收到 vblank，补发 frame 回调");
        let Some(backend) = self.backend.take() else {
            return;
        };
        backend.send_frame_callbacks(self);
        self.backend = Some(backend);
    }
}

delegate_presentation!(App);

/// Data associated with a wayland client that connects to myde-wrap.
/// One instance of this type per client.
#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}
    fn disconnected(&self, _client_id: ClientId, _reason: DisconnectReason) {}
}

// Re-export for use in other modules
