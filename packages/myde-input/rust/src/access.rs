//! 输入设备的打开方式。
//!
//! - `auto`（默认）：先尝试直接打开 `/dev/input/event*`（input 组 / udev uaccess /
//!   root 可用时最省事，也不影响 TTY），失败再走 systemd-logind。
//! - `logind`：通过 logind `TakeDevice` 取 fd。只有“前台会话的控制器”才能取设备，
//!   所以会调用 `TakeControl`（需要会话所有者）；这会把 VT 切到图形模式并关掉
//!   TTY 键盘（Ctrl+C 不再送到启动 myde-wrap 的那个 shell）。
//! - `direct`：只直接打开。
//!
//! logind 模式在 VT 切走/切回时通过 `PauseDevice` / `ResumeDevice` 暂停读取并换 fd。

use std::collections::HashMap;
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::OwnedObjectPath;

/// 设备打开方式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessMode {
    /// 直接打开优先，失败回退 logind
    Auto,
    /// 只走 logind（会话所有者 + TakeControl）
    Logind,
    /// 只直接打开（需要权限）
    Direct,
}

impl AccessMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "logind" => Some(Self::Logind),
            "direct" => Some(Self::Direct),
            _ => None,
        }
    }
}

/// 已打开的输入设备
pub struct TakenDevice {
    pub fd: OwnedFd,
    pub major: u32,
    pub minor: u32,
    /// 会话不在前台：fd 短暂不可读，等 ResumeDevice 再读
    pub paused: bool,
    /// "logind" 或 "direct"，用于诊断/展示
    pub access: &'static str,
}

/// logind 的会话事件（由后台线程转发）
pub enum AccessEvent {
    /// VT 切走：暂停读取（fd 已被 logind 撤销）
    Paused(PathBuf),
    /// VT 切回：用新 fd 继续读
    Resumed(PathBuf, OwnedFd),
    /// 设备被拔出/强制释放
    Gone(PathBuf),
}

struct LogindSession {
    proxy: Proxy<'static>,
    paths: Arc<Mutex<HashMap<(u32, u32), PathBuf>>>,
}

enum Backend {
    Direct,
    Logind(LogindSession),
}

pub struct DeviceAccess {
    mode: AccessMode,
    backend: Backend,
    /// auto 在第一次 open 时确定后端，之后不再切换（避免偶发一两个设备失败就
    /// 触发 TakeControl，把 TTY 键盘关掉）
    decided: bool,
    logind_error: Option<String>,
    events: Receiver<AccessEvent>,
    events_tx: Sender<AccessEvent>,
    access_mode: &'static str,
}

impl DeviceAccess {
    pub fn new(mode: AccessMode) -> Self {
        let (tx, rx) = channel();
        let mut access = Self {
            mode,
            backend: Backend::Direct,
            decided: false,
            logind_error: None,
            events: rx,
            events_tx: tx,
            access_mode: "direct",
        };
        if mode == AccessMode::Logind {
            if let Err(e) = access.ensure_logind() {
                eprintln!("logind 不可用: {e}");
                access.access_mode = "none";
            }
            access.decided = true;
        }
        access
    }

    /// 实际生效的打开方式："logind" 或 "direct"
    pub fn access_mode(&self) -> &'static str {
        self.access_mode
    }

    /// logind 初始化/TakeDevice 失败原因（回退或报错时用于诊断）
    pub fn logind_error(&self) -> Option<&str> {
        self.logind_error.as_deref()
    }

    /// 打开设备，返回 fd（可能处于 paused 状态，此时不应注册到 epoll）
    pub fn open(&mut self, path: &Path) -> Result<TakenDevice, String> {
        match self.mode {
            AccessMode::Direct => self.open_direct(path),
            AccessMode::Logind => {
                self.ensure_logind()?;
                self.take_logind(path)
            }
            AccessMode::Auto => {
                if self.decided {
                    if matches!(self.backend, Backend::Direct) {
                        return self.open_direct(path);
                    }
                    return self.take_logind_or_direct(path);
                }
                // 第一次 open：先试 direct，失败再启用 logind 并锁定
                match self.open_direct(path) {
                    Ok(device) => {
                        self.decided = true;
                        Ok(device)
                    }
                    Err(e) => {
                        self.decided = true;
                        if let Err(logind_err) = self.ensure_logind() {
                            self.access_mode = "none";
                            return Err(format!(
                                "直接打开 {} 失败: {e}；logind: {logind_err}",
                                path.display()
                            ));
                        }
                        self.take_logind_or_direct(path)
                    }
                }
            }
        }
    }

    /// 释放设备（停止读取后调用；fd 由调用方 drop）
    pub fn release(&mut self, major: u32, minor: u32) {
        if let Backend::Logind(session) = &self.backend {
            session.release_device(major, minor);
        }
    }

    /// 取出 logind 后台线程转发的事件（非阻塞）
    pub fn drain_events(&self) -> Vec<AccessEvent> {
        let mut events = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            events.push(event);
        }
        events
    }

    fn ensure_logind(&mut self) -> Result<(), String> {
        if matches!(self.backend, Backend::Logind(_)) {
            return Ok(());
        }
        match LogindSession::connect(self.events_tx.clone()) {
            Ok(session) => {
                self.backend = Backend::Logind(session);
                self.access_mode = "logind";
                Ok(())
            }
            Err(e) => {
                self.logind_error = Some(e.clone());
                Err(e)
            }
        }
    }

    fn open_direct(&self, path: &Path) -> Result<TakenDevice, String> {
        let (fd, major, minor) = open_direct(path)?;
        Ok(TakenDevice {
            fd,
            major,
            minor,
            paused: false,
            access: "direct",
        })
    }

    fn take_logind(&mut self, path: &Path) -> Result<TakenDevice, String> {
        let (major, minor) = device_numbers(path)?;
        let taken = {
            let Backend::Logind(session) = &self.backend else {
                return Err("logind 会话未初始化".to_string());
            };
            session.take_device(path, major, minor)
        };
        match taken {
            Ok((fd, paused)) => Ok(TakenDevice {
                fd,
                major,
                minor,
                paused,
                access: "logind",
            }),
            Err(e) => {
                self.logind_error = Some(e.clone());
                Err(format!("logind TakeDevice({major}:{minor}) 失败: {e}"))
            }
        }
    }

    /// auto 模式下 logind 取设备失败时，再试一次直接打开
    fn take_logind_or_direct(&mut self, path: &Path) -> Result<TakenDevice, String> {
        match self.take_logind(path) {
            Ok(device) => Ok(device),
            Err(logind_err) => match self.open_direct(path) {
                Ok(device) => Ok(device),
                Err(direct_err) => Err(format!("{direct_err}；{logind_err}")),
            },
        }
    }
}

fn open_direct(path: &Path) -> Result<(OwnedFd, u32, u32), String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let metadata = std::fs::metadata(path).map_err(|e| format!("stat {} 失败: {e}", path.display()))?;
    let dev = metadata.rdev();
    let major = nix::sys::stat::major(dev) as u32;
    let minor = nix::sys::stat::minor(dev) as u32;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_RDONLY | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| format!("打开 {} 失败: {e}", path.display()))?;
    Ok((file.into(), major, minor))
}

fn device_numbers(path: &Path) -> Result<(u32, u32), String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path).map_err(|e| format!("stat {} 失败: {e}", path.display()))?;
    Ok((
        nix::sys::stat::major(metadata.rdev()) as u32,
        nix::sys::stat::minor(metadata.rdev()) as u32,
    ))
}

impl Drop for LogindSession {
    fn drop(&mut self) {
        let _ = self.proxy.call_method("ReleaseControl", &());
    }
}

/// 解析要控制的 logind 会话。
///
/// 优先按进程所在的会话查（GetSessionByPID）。Chromium/Electron 会把浏览器
/// 进程搬进自己创建的 `app-*.scope`（用于 portal 识别应用），该 cgroup 不在
/// 任何 `session-*.scope` 下，logind 会返回 NoSessionForPID；此时退回启动
/// 环境里的 XDG_SESSION_ID（pam_systemd 设置，仍指向用户的登录会话）。
fn find_session(conn: &Connection) -> Result<OwnedObjectPath, String> {
    let by_pid = conn.call_method(
        Some("org.freedesktop.login1"),
        "/org/freedesktop/login1",
        Some("org.freedesktop.login1.Manager"),
        "GetSessionByPID",
        &(std::process::id(),),
    );
    let pid_error = match by_pid {
        Ok(reply) => {
            return reply
                .body()
                .deserialize::<OwnedObjectPath>()
                .map_err(|e| format!("解析会话路径失败: {e}"))
        }
        Err(e) => e,
    };

    let Ok(session_id) = std::env::var("XDG_SESSION_ID") else {
        return Err(format!("GetSessionByPID 失败: {pid_error}；XDG_SESSION_ID 未设置"));
    };
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err(format!("GetSessionByPID 失败: {pid_error}；XDG_SESSION_ID 为空"));
    }

    let reply = conn
        .call_method(
            Some("org.freedesktop.login1"),
            "/org/freedesktop/login1",
            Some("org.freedesktop.login1.Manager"),
            "GetSession",
            &(session_id,),
        )
        .map_err(|e| {
            format!("GetSessionByPID 失败: {pid_error}；GetSession({session_id}) 失败: {e}")
        })?;
    reply
        .body()
        .deserialize::<OwnedObjectPath>()
        .map_err(|e| format!("解析会话路径失败: {e}"))
}

impl LogindSession {
    fn connect(events: Sender<AccessEvent>) -> Result<Self, String> {
        let conn = Connection::system().map_err(|e| format!("连接系统总线失败: {e}"))?;
        let path = find_session(&conn)?;

        let proxy = Proxy::new_owned(
            conn.clone(),
            "org.freedesktop.login1",
            path.clone().into_inner(),
            "org.freedesktop.login1.Session",
        )
        .map_err(|e| format!("创建 Session 代理失败: {e}"))?;

        // TakeDevice 要求调用者是会话控制器。会话所有者可以 TakeControl(false)，
        // 但如果已有控制器（例如窗口模式下的 KWin）会 EBUSY。
        // 注意：TakeControl 会把该 VT 切到 KD_GRAPHICS 并关掉 TTY 键盘，
        // 所以 auto 模式只在直接打开失败时才走这里。
        proxy
            .call_method("TakeControl", &(false,))
            .map_err(|e| format!("TakeControl 失败（会话已有控制器？）: {e}"))?;

        let paths: Arc<Mutex<HashMap<(u32, u32), PathBuf>>> = Arc::new(Mutex::new(HashMap::new()));

        // PauseDevice: (major, minor, type)；type = pause | force | gone
        {
            let proxy = proxy.clone();
            let conn = conn.clone();
            let paths = paths.clone();
            let events = events.clone();
            std::thread::spawn(move || {
                let _ = conn; // 保持连接
                let Ok(iter) = proxy.receive_signal("PauseDevice") else {
                    return;
                };
                for message in iter {
                    let Ok((major, minor, kind)) = message.body().deserialize::<(u32, u32, String)>()
                    else {
                        continue;
                    };
                    let Some(path) = lookup(&paths, major, minor) else {
                        continue;
                    };
                    match kind.as_str() {
                        // 会话切走：fd 已被撤销，停止读取，等 ResumeDevice 换新 fd。
                        // "pause"/"force" 都走这条路（VT 切换用的是 force）。
                        "pause" | "force" => {
                            let _ = events.send(AccessEvent::Paused(path));
                            // 非 VT seat 的协商式暂停需要回执；VT 切换（force）不需要
                            if kind == "pause" {
                                let _ = proxy.call_method("PauseDeviceComplete", &(major, minor));
                            }
                        }
                        // 设备被拔出/强制释放，不会再 resume
                        _ => {
                            paths.lock().unwrap().remove(&(major, minor));
                            let _ = events.send(AccessEvent::Gone(path));
                        }
                    }
                }
            });
        }

        // ResumeDevice: (major, minor, fd)
        {
            let proxy = proxy.clone();
            let conn = conn.clone();
            let paths = paths.clone();
            let events = events.clone();
            std::thread::spawn(move || {
                let _ = conn;
                let Ok(iter) = proxy.receive_signal("ResumeDevice") else {
                    return;
                };
                for message in iter {
                    let Ok((major, minor, fd)) =
                        message.body().deserialize::<(u32, u32, zbus::zvariant::OwnedFd)>()
                    else {
                        continue;
                    };
                    let Some(path) = lookup(&paths, major, minor) else {
                        continue;
                    };
                    let _ = events.send(AccessEvent::Resumed(path, fd.into()));
                }
            });
        }

        Ok(Self { proxy, paths })
    }

    fn take_device(&self, path: &Path, major: u32, minor: u32) -> Result<(OwnedFd, bool), String> {
        let reply = self
            .proxy
            .call_method("TakeDevice", &(major, minor))
            .map_err(|e| format!("{e}"))?;
        let (fd, paused): (zbus::zvariant::OwnedFd, bool) = reply
            .body()
            .deserialize()
            .map_err(|e| format!("解析 TakeDevice 返回失败: {e}"))?;
        self.paths
            .lock()
            .unwrap()
            .insert((major, minor), path.to_path_buf());
        Ok((fd.into(), paused))
    }

    fn release_device(&self, major: u32, minor: u32) {
        self.paths.lock().unwrap().remove(&(major, minor));
        let _ = self.proxy.call_method("ReleaseDevice", &(major, minor));
    }
}

fn lookup(
    paths: &Arc<Mutex<HashMap<(u32, u32), PathBuf>>>,
    major: u32,
    minor: u32,
) -> Option<PathBuf> {
    paths.lock().unwrap().get(&(major, minor)).cloned()
}

/// 供设备信息展示：记录 fd 的原始编号（调试用）
#[allow(dead_code)]
pub fn raw_fd(device: &TakenDevice) -> i32 {
    device.fd.as_raw_fd()
}
