mod backend;
mod compositor;
mod custom_element;
mod drm;
mod handlers;
mod protocol;
mod renderer;
mod socket;
mod wayland;
mod winit;

use clap::Parser;
use signal_hook::{
    consts::{SIGHUP, SIGINT, SIGTERM},
    iterator::Signals,
};
use smithay::reexports::{
    calloop::{
        timer::{TimeoutAction, Timer},
        EventLoop,
    },
    wayland_server::Display,
};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use crate::backend::RenderBackend;
use crate::compositor::Compositor;
use crate::drm::DrmBackend;
use crate::protocol::{ClientMessage, ServerResponse};
use crate::renderer::Renderer as MyRenderer;
use crate::socket::SocketServer;
use crate::wayland::App;
use crate::winit::WinitBackend;

/// 向页面发送 Ping 的间隔
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(3);
/// 页面就绪后，多久没有任何控制消息就判定卡死
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(10);
/// 控制连接建立后，等待桌面入口执行到末尾（首次 Pong）的最长时间
const HEARTBEAT_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Parser)]
#[command(name = "myde-wrap")]
#[command(about = "轻量级 Wayland 桌面合成器")]
struct Args {
    /// 要渲染的程序命令
    #[arg(trailing_var_arg = true)]
    command: Vec<String>,

    /// 渲染后端 (auto|winit|drm)；auto 先尝试 winit，初始化失败（如无宿主显示
    /// 环境 WAYLAND_DISPLAY/DISPLAY）时回退 drm
    #[arg(short, long, default_value = "auto", value_parser = ["auto", "winit", "drm"])]
    backend: String,

    /// 本程序日志级别 (error|warn|info|debug|trace|off)，默认 info；
    /// 显式指定时优先于 RUST_LOG 环境变量
    #[arg(long, value_name = "LEVEL")]
    log_level: Option<String>,

    /// 子进程 stdout/stderr 处理方式 (inherit|null)，默认 inherit
    #[arg(long, value_name = "MODE", default_value = "inherit")]
    child_output: String,
}

/// 查找相对程序名时可用的目录：当前目录（从解包目录运行 `myde-wrap`），
/// 然后是本程序所在目录（安装包里 `myde-wrap` 与 `myde` 同级）。
fn program_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
        }
    }
    dirs
}

/// 把程序参数解析成可执行路径。
///
/// 裸名字（不含 `/`）不能直接交给 `Command::new`：它只查 PATH，当前目录里的
/// `myde` 会以 NotFound 失败。这里先按 [`program_search_dirs`] 查找普通文件，
/// 命中则用绝对路径；都没命中再原样返回，交给 PATH 查找。
fn resolve_program(program: &str) -> PathBuf {
    if Path::new(program).is_absolute() || program.contains('/') {
        return PathBuf::from(program);
    }
    for dir in program_search_dirs() {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from(program)
}

/// 未指定程序时自动寻找内置的 `myde`（解包目录或其上一级目录）。
fn detect_program() -> Option<PathBuf> {
    ["myde", "linux-unpacked/myde"].iter().find_map(|name| {
        program_search_dirs()
            .into_iter()
            .map(|d| d.join(name))
            .find(|p| p.is_file())
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    let valid_levels = ["error", "warn", "info", "debug", "trace", "off"];
    if let Some(level) = &args.log_level {
        if !valid_levels.contains(&level.as_str()) {
            eprintln!("错误: 无效的日志级别 '{}'", level);
            eprintln!("可选值: {}", valid_levels.join("|"));
            std::process::exit(1);
        }
    }
    if args.child_output != "inherit" && args.child_output != "null" {
        eprintln!("错误: 无效的子进程输出方式 '{}'", args.child_output);
        eprintln!("可选值: inherit|null");
        std::process::exit(1);
    }

    // Initialize logging: 显式 --log-level 优先，其次 RUST_LOG，最后默认 info
    let env_filter = if let Some(level) = &args.log_level {
        tracing_subscriber::EnvFilter::new(level)
    } else if let Ok(env_filter) = tracing_subscriber::EnvFilter::try_from_default_env() {
        env_filter
    } else {
        tracing_subscriber::EnvFilter::new("info")
    };
    tracing_subscriber::fmt().with_env_filter(env_filter).init();

    let socket_path = std::env::temp_dir().join("myde-wrap.sock");
    let socket_server = SocketServer::new(socket_path.clone())?;

    let mut event_loop: EventLoop<App> = EventLoop::try_new()?;

    // Ctrl+C / kill / 终端关闭时走正常退出流程（释放 Drop、恢复显示），
    // 而不是被信号直接终止把 DRM 留在最后一帧（黑屏）
    let shutdown = Arc::new(AtomicBool::new(false));
    {
        let mut signals = Signals::new([SIGINT, SIGTERM, SIGHUP])?;
        let shutdown = shutdown.clone();
        let loop_signal = event_loop.get_signal();
        std::thread::spawn(move || {
            // 保持 handlers 安装（Signals 被 drop 后会恢复默认行为，第二次
            // Ctrl+C 就会直接杀进程、跳过恢复）；只处理第一次
            for signal in signals.forever() {
                if !shutdown.swap(true, Ordering::AcqRel) {
                    info!("收到信号 {}，准备退出", signal);
                    loop_signal.wakeup();
                }
            }
        });
    }

    let display: Display<App> = Display::new()?;
    let mut state = App::new(&mut event_loop, display);

    // 创建并初始化后端
    // 显式 --backend 严格按指定后端初始化；auto 模式先尝试 winit（宿主桌面窗口），
    // 失败（如无 WAYLAND_DISPLAY/DISPLAY）时回退到 drm
    let backend: Box<dyn RenderBackend> = match args.backend.as_str() {
        "winit" => {
            let mut b: Box<dyn RenderBackend> = Box::new(WinitBackend::new());
            b.init(&mut event_loop, &mut state)?;
            b
        }
        "drm" => {
            let mut b: Box<dyn RenderBackend> = Box::new(DrmBackend::new());
            b.init(&mut event_loop, &mut state)?;
            b
        }
        _ => {
            let mut winit: Box<dyn RenderBackend> = Box::new(WinitBackend::new());
            match winit.init(&mut event_loop, &mut state) {
                Ok(()) => winit,
                Err(e) => {
                    warn!("winit backend init failed: {e}, falling back to drm backend");
                    let mut drm: Box<dyn RenderBackend> = Box::new(DrmBackend::new());
                    drm.init(&mut event_loop, &mut state)
                        .map_err(|e2| format!("backends all failed (winit: {e}; drm: {e2})"))?;
                    drm
                }
            }
        }
    };
    let is_drm = backend.name() == "drm";
    info!("backend inited: {}", backend.name());
    let frame_period = backend
        .frame_interval()
        .unwrap_or(Duration::from_millis(16));
    let screen_power_supported = is_drm;
    // 模式切换（分辨率/刷新率）只在 DRM 后端可用；winit 窗口尺寸由宿主决定
    let screen_mode_supported = is_drm;

    // Set WAYLAND_DISPLAY to our socket name, so child processes connect to myde-wrap
    // rather than the host compositor
    unsafe { std::env::set_var("WAYLAND_DISPLAY", &state.socket_name) };
    unsafe { std::env::set_var("XDG_SESSION_TYPE", "wayland") };
    unsafe { std::env::set_var("MYDE_WRAP_SOCKET", socket_path.to_str().unwrap()) };

    info!("MYDE_WRAP_SOCKET={:?}", socket_path);
    info!("WAYLAND_DISPLAY={:?}", state.socket_name);
    info!("XDG_SESSION_TYPE=wayland");

    let program: PathBuf = if let Some(name) = args.command.first() {
        resolve_program(name)
    } else if let Some(found) = detect_program() {
        found
    } else {
        eprintln!("错误: 请指定要渲染的程序");
        eprintln!("用法: myde-wrap [--backend auto|winit|drm] [--log-level LEVEL] [--child-output inherit|null] <command> [args...]");
        std::process::exit(1);
    };

    let program_args = if args.command.len() > 1 {
        &args.command[1..]
    } else {
        &[]
    };

    info!("run program: {} {:?}", program.display(), program_args);

    // 继承所有父进程环境变量
    let mut envs: Vec<(String, String)> = std::env::vars().collect();
    // 确保 socket 环境变量存在
    if !envs.iter().any(|(k, _)| k == "MYDE_WRAP_SOCKET") {
        envs.push((
            "MYDE_WRAP_SOCKET".to_string(),
            socket_path.to_str().unwrap().to_string(),
        ));
    }
    // 确保 Wayland 环境变量存在
    if !envs.iter().any(|(k, _)| k == "WAYLAND_DISPLAY") {
        envs.push((
            "WAYLAND_DISPLAY".to_string(),
            state.socket_name.to_str().unwrap().to_string(),
        ));
    }
    // 确保 XDG_SESSION_TYPE 环境变量存在
    if !envs.iter().any(|(k, _)| k == "XDG_SESSION_TYPE") {
        envs.push(("XDG_SESSION_TYPE".to_string(), "wayland".to_string()));
    }
    // 让myde以桌面运行
    envs.push(("runAsDesktop".to_string(), "true".to_string()));
    // 已注册 dmabuf global 时告知子进程：桌面可以走 GPU shared texture，
    // 否则 myde 会退回 CPU 拷贝（兼容旧版 wrap）
    if state.dmabuf_global.is_some() {
        envs.push(("MYDE_WRAP_DMABUF".to_string(), "1".to_string()));
    }
    // 屏幕电源（DPMS）只在 DRM 后端可用；winit 显式置 0，避免继承到父进程的值
    envs.retain(|(key, _)| key != "MYDE_WRAP_SCREEN_POWER");
    envs.push((
        "MYDE_WRAP_SCREEN_POWER".to_string(),
        if screen_power_supported { "1" } else { "0" }.to_string(),
    ));
    // 屏幕模式（分辨率/刷新率）切换能力
    envs.retain(|(key, _)| key != "MYDE_WRAP_SCREEN_MODE");
    envs.push((
        "MYDE_WRAP_SCREEN_MODE".to_string(),
        if screen_mode_supported { "1" } else { "0" }.to_string(),
    ));

    let child_stdio = || {
        if args.child_output == "null" {
            std::process::Stdio::null()
        } else {
            std::process::Stdio::inherit()
        }
    };

    let mut child = match Command::new(&program)
        .args(program_args)
        .envs(envs)
        .stdout(child_stdio())
        .stderr(child_stdio())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            // 后端已经初始化（可能已 modeset），失败退出前同样要恢复显示
            let mut backend = backend;
            backend.shutdown();
            return Err(format!(
                "无法启动程序 {}: {}\n提示: 裸命令名会先查找当前目录和 myde-wrap 所在目录，再查找 PATH；也可传入 ./myde 这样的路径",
                program.display(),
                e
            )
            .into());
        }
    };
    let child_pid = child.id();
    info!("program started, PID: {}", child_pid);

    // 子进程退出即结束合成器（单应用 kiosk），否则应用崩溃后 myde-wrap
    // 会一直停在黑屏上；退出码在事件循环结束后向外传递
    let loop_signal = event_loop.get_signal();
    let child_exit = Arc::new(std::sync::Mutex::new(None));
    let child_done = Arc::new(AtomicBool::new(false));
    let child_exit_for_thread = child_exit.clone();
    let child_done_for_thread = child_done.clone();
    std::thread::spawn(move || {
        match child.wait() {
            Ok(status) => {
                info!("program exited, status: {}", status);
                *child_exit_for_thread.lock().unwrap() = Some(status);
            }
            Err(e) => error!("failed to wait for program: {}", e),
        }
        child_done_for_thread.store(true, Ordering::Release);
        // 唤醒可能正阻塞在 poll 上的事件循环
        loop_signal.wakeup();
    });

    // 将Socket服务器添加到事件循环中
    let loop_handle = event_loop.handle();
    let socket_server = Arc::new(socket_server);
    let renderer = Arc::new(Mutex::new(MyRenderer::new(
        backend.get_screens(),
        screen_power_supported,
    )));
    // 有脏内容需要上屏：socket 线程与事件循环线程共享
    let redraw = state.redraw.clone();
    let compositor = Arc::new(Compositor::new(renderer.clone(), redraw.clone()));
    let output_count = backend.get_output_count();
    // 渲染后端交给事件循环线程独占（vblank/commit 事件驱动渲染需要直接访问它）
    state.set_backend(backend, renderer.clone());

    // 页面心跳：控制连接建立后，wrap 每 3 秒发 Ping。桌面入口脚本执行到
    // 末尾后才会回 Pong，因此 Pong 同时证明“页面逻辑跑完了”，而不只是
    // socket 层还活着。页面卡死/初始化失败时让主循环退出，避免把最后一帧
    // 一直留在屏幕上（此时也无法再通过输入恢复）。
    let heartbeat_base = Instant::now();
    let heartbeat_last = Arc::new(AtomicU64::new(0));
    let heartbeat_connected_at = Arc::new(AtomicU64::new(0));
    let heartbeat_armed = Arc::new(AtomicBool::new(false));
    let heartbeat_ready = Arc::new(AtomicBool::new(false));
    let heartbeat_lost = Arc::new(AtomicBool::new(false));
    {
        let last = heartbeat_last.clone();
        let connected_at = heartbeat_connected_at.clone();
        let armed = heartbeat_armed.clone();
        let ready = heartbeat_ready.clone();
        let lost = heartbeat_lost.clone();
        let shutdown = shutdown.clone();
        let loop_signal = event_loop.get_signal();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(500));
            if !armed.load(Ordering::Acquire) {
                continue;
            }
            let now = heartbeat_base.elapsed().as_millis();
            let ready = ready.load(Ordering::Acquire);
            // 就绪前按连接建立时间算启动超时；就绪后按最后一条消息算心跳超时。
            // 启动阶段不能用“最后消息”计时，否则初始化时不停发请求的页面永远
            // 等不到 Pong 也不会被判定为启动失败。
            let since = if ready {
                now.saturating_sub(last.load(Ordering::Acquire) as u128)
            } else {
                now.saturating_sub(connected_at.load(Ordering::Acquire) as u128)
            };
            let timeout = if ready {
                HEARTBEAT_TIMEOUT.as_millis()
            } else {
                HEARTBEAT_STARTUP_TIMEOUT.as_millis()
            };
            if since < timeout {
                continue;
            }
            if ready {
                error!(
                    "控制连接心跳超时（{:.1} 秒没有收到页面消息），页面可能已卡死，退出",
                    since as f64 / 1000.0
                );
            } else {
                error!(
                    "等待页面就绪超时（{:.1} 秒没有收到首次 Pong），桌面入口可能没有正常执行，退出",
                    since as f64 / 1000.0
                );
            }
            lost.store(true, Ordering::Release);
            shutdown.store(true, Ordering::Release);
            loop_signal.wakeup();
            break;
        });
    }

    // 克隆socket_server以在事件循环中使用
    let socket_server_clone = socket_server.clone();
    let heartbeat_last_for_accept = heartbeat_last.clone();
    let heartbeat_connected_at_for_accept = heartbeat_connected_at.clone();
    let heartbeat_armed_for_accept = heartbeat_armed.clone();
    let heartbeat_ready_for_accept = heartbeat_ready.clone();

    // 在单独的线程中接受和处理socket连接，完全不阻塞主事件循环
    std::thread::spawn(move || {
        let rt = Arc::new(tokio::runtime::Runtime::new().unwrap());
        loop {
            if let Some(stream) = socket_server_clone.accept() {
                // 新连接先刷新心跳并重新等待桌面就绪，避免页面重载被误判为卡死
                let now = heartbeat_base.elapsed().as_millis() as u64;
                heartbeat_last_for_accept.store(now, Ordering::Release);
                heartbeat_connected_at_for_accept.store(now, Ordering::Release);
                heartbeat_armed_for_accept.store(true, Ordering::Release);
                heartbeat_ready_for_accept.store(false, Ordering::Release);
                let compositor = compositor.clone();
                let rt_clone = rt.clone();
                let last = heartbeat_last_for_accept.clone();
                let ready = heartbeat_ready_for_accept.clone();
                // 为每个连接单独分配一个线程，长连接完全不干扰主循环
                std::thread::spawn(move || {
                    info!("received new socket connection");
                    let mut read_stream = match stream.try_clone() {
                        Ok(stream) => stream,
                        Err(e) => {
                            error!("failed to clone control socket: {}", e);
                            return;
                        }
                    };
                    let write_stream = Arc::new(std::sync::Mutex::new(stream));
                    let alive = Arc::new(AtomicBool::new(true));

                    // 主动 Ping 页面，页面用 Pong 证明桌面入口已经跑完。
                    // 读和写在不同线程，写用同一把锁避免消息交错。
                    {
                        let write_stream = write_stream.clone();
                        let alive = alive.clone();
                        std::thread::spawn(move || loop {
                            std::thread::sleep(HEARTBEAT_INTERVAL);
                            if !alive.load(Ordering::Acquire) {
                                break;
                            }
                            let mut stream = write_stream.lock().unwrap();
                            if let Err(e) =
                                socket::write_message(&mut stream, &ServerResponse::Ping)
                            {
                                error!("failed to send heartbeat: {}", e);
                                break;
                            }
                        });
                    }

                    loop {
                        match socket::read_message(&mut read_stream) {
                            Ok(msg) => {
                                last.store(
                                    heartbeat_base.elapsed().as_millis() as u64,
                                    Ordering::Release,
                                );
                                if matches!(msg, ClientMessage::Pong) {
                                    ready.store(true, Ordering::Release);
                                } else {
                                    // 心跳每 3 秒一次，不刷日志
                                    info!("received message: {:?}", msg);
                                }
                                let response = rt_clone.block_on(compositor.handle_message(msg));
                                if let Some(response) = response {
                                    let mut stream = write_stream.lock().unwrap();
                                    if let Err(e) = socket::write_message(&mut stream, &response) {
                                        error!("failed to send response: {}", e);
                                        break;
                                    }
                                }
                            }
                            Err(e) => {
                                // Socket可能正常断开
                                tracing::debug!("Socket connection closed: {}", e);
                                break;
                            }
                        }
                    }
                    alive.store(false, Ordering::Release);
                });
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    });

    // 兜底定时器：socket 配置变更、窗口关闭等没有 Wayland 事件触发的场景。
    // 常规渲染由客户端 commit 与 DRM vblank 驱动，这里只负责"没有事件也别卡住"，
    // 画面静止时回调只做一次原子读取，几乎零开销。
    if is_drm {
        let timer = Timer::immediate();
        loop_handle.insert_source(timer, move |_event, _, state| {
            // page flip 才产生 vblank；没有帧在飞时也需要按刷新率补 frame callback，
            // 否则客户端错过一拍就永远等不到下一次 done（稳定 60Hz）。
            state.pump_frame_callbacks();
            state.refresh_and_render();
            TimeoutAction::ToDuration(frame_period / 2)
        })?;
    }

    // 设置默认全屏显示
    // 如果没有自定义配置，默认全屏显示应用到所有屏幕
    let renderer_clone = renderer.clone();
    let redraw_for_default = redraw.clone();

    // 在单独的线程中设置默认全屏显示
    std::thread::spawn(move || {
        // 等待一小段时间让应用启动
        std::thread::sleep(std::time::Duration::from_millis(100));

        // 为每个屏幕设置默认全屏配置
        let mut renderer_guard = renderer_clone.blocking_lock();
        for screen_index in 0..output_count {
            let config = renderer_guard.get_default_fullscreen_config(screen_index);
            info!(
                "setting default fullscreen config: screen {}, rect {:?}, transform {:?} (rect 缺省 = 应用内容范围拉伸铺满)",
                screen_index, config.rect, config.transform
            );
            // SAVE IT into the renderer so that DRM backend can actually use it
            let _ = renderer_guard.render_to_screen(
                screen_index,
                config.rect.clone(),
                config.transform.clone(),
            );
        }
        drop(renderer_guard);
        // 通知渲染线程配置已就绪
        redraw_for_default.store(true, std::sync::atomic::Ordering::Release);
    });

    // Run the event loop
    info!("Starting event loop...");
    // 用 dispatch 循环而非 EventLoop::run：run() 进入时会清空 stop 标志，
    // 若子进程在进入循环前就退出，停止信号会丢失
    let mut loop_result: Result<(), Box<dyn std::error::Error>> = Ok(());
    while !child_done.load(Ordering::Acquire) && !shutdown.load(Ordering::Acquire) {
        if let Err(e) = event_loop.dispatch(None, &mut state) {
            loop_result = Err(Box::new(e));
            break;
        }
    }

    let signaled = shutdown.load(Ordering::Acquire);
    let heartbeat_lost = heartbeat_lost.load(Ordering::Acquire);
    let heartbeat_ready = heartbeat_ready.load(Ordering::Acquire);
    if signaled {
        info!("正在退出并恢复显示…");
    }

    // 结束子进程：Ctrl+C 时它一般也收到了 SIGINT，但 SIGTERM/终端关闭时不一定
    let _ = nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child_pid as i32),
        nix::sys::signal::Signal::SIGTERM,
    );
    let deadline = Instant::now() + Duration::from_secs(1);
    while !child_done.load(Ordering::Acquire) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if !child_done.load(Ordering::Acquire) {
        // 等不到就强杀，避免退出后还留着一个看不见的桌面进程
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(child_pid as i32),
            nix::sys::signal::Signal::SIGKILL,
        );
    }

    // 恢复显示放在子进程之后，避免它最后几帧又盖回去
    state.shutdown_backend();
    if signaled && !heartbeat_lost {
        // 信号退出（Ctrl+C）是主动行为，不当作应用异常报错
        eprintln!("myde-wrap: 已退出");
    }
    loop_result?;

    // 页面卡死/未就绪导致的退出要带错误码，方便调用方决定是否重启
    if heartbeat_lost {
        return Err(if heartbeat_ready {
            "控制连接心跳超时，页面可能已卡死".into()
        } else {
            "等待页面就绪超时，桌面入口可能没有正常执行".into()
        });
    }

    // 应用异常退出时以非零退出码结束，方便调用方发现问题
    if !signaled {
        if let Some(status) = *child_exit.lock().unwrap() {
            if !status.success() {
                return Err(format!("程序退出: {}", status).into());
            }
        }
    }

    Ok(())
}
