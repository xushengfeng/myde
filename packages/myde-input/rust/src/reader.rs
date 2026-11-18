use std::collections::HashMap;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::path::Path;

use nix::sys::epoll::{Epoll, EpollEvent, EpollFlags};

use crate::access::{DeviceAccess, TakenDevice};

/// 输入事件（与 Linux input_event 结构对应）
#[derive(Debug, Clone)]
pub struct RawInputEvent {
    pub path: String,
    pub event_type: u16,
    pub code: u16,
    pub value: i32,
    pub timestamp_sec: i64,
    pub timestamp_usec: i64,
}

struct OpenDevice {
    fd: OwnedFd,
    path: String,
    major: u32,
    minor: u32,
    /// logind 暂停中：fd 还在，但不在 epoll 里，不能读（否则会读走别的会话的输入）
    paused: bool,
}

/// 多设备事件读取器
pub struct EventReader {
    epoll: Epoll,
    devices: HashMap<RawFd, OpenDevice>,
    by_path: HashMap<String, RawFd>,
}

impl EventReader {
    /// 创建新的事件读取器
    pub fn new() -> Result<Self, String> {
        let epoll =
            Epoll::new(nix::sys::epoll::EpollCreateFlags::empty()).map_err(|e| format!("创建 epoll 失败: {}", e))?;

        Ok(EventReader {
            epoll,
            devices: HashMap::new(),
            by_path: HashMap::new(),
        })
    }

    /// 添加设备到监听列表（logind 暂停状态下只持有 fd，不注册 epoll）
    pub fn add_device(&mut self, access: &mut DeviceAccess, path: &str) -> Result<(), String> {
        if self.by_path.contains_key(path) {
            return Ok(());
        }
        let taken: TakenDevice = access.open(Path::new(path))?;
        let raw = taken.fd.as_raw_fd();
        if !taken.paused {
            let event = EpollEvent::new(EpollFlags::EPOLLIN, raw as u64);
            self.epoll
                .add(&taken.fd, event)
                .map_err(|e| format!("epoll_ctl 添加失败: {}", e))?;
        }
        self.devices.insert(
            raw,
            OpenDevice {
                fd: taken.fd,
                path: path.to_string(),
                major: taken.major,
                minor: taken.minor,
                paused: taken.paused,
            },
        );
        self.by_path.insert(path.to_string(), raw);
        Ok(())
    }

    /// 移除设备
    pub fn remove_device(&mut self, access: &mut DeviceAccess, path: &str) {
        let Some(raw) = self.by_path.remove(path) else {
            return;
        };
        if let Some(device) = self.devices.remove(&raw) {
            let _ = self.epoll.delete(&device.fd);
            access.release(device.major, device.minor);
        }
    }

    /// logind: 会话切走，暂停读取（保留 fd，等 ResumeDevice）
    pub fn pause_device(&mut self, path: &str) {
        let Some(raw) = self.by_path.get(path).copied() else {
            return;
        };
        if let Some(device) = self.devices.get_mut(&raw) {
            if !device.paused {
                let _ = self.epoll.delete(&device.fd);
                device.paused = true;
            }
        }
    }

    /// logind: 会话切回，换上新 fd 继续读取
    pub fn resume_device(&mut self, access: &mut DeviceAccess, path: &str, fd: OwnedFd) {
        let Some(raw) = self.by_path.get(path).copied() else {
            // 没有在读取的设备：直接丢弃新 fd（由 logind 收回）
            return;
        };
        let Some(old) = self.devices.remove(&raw) else {
            return;
        };
        let _ = self.epoll.delete(&old.fd);
        let new_raw = fd.as_raw_fd();
        let event = EpollEvent::new(EpollFlags::EPOLLIN, new_raw as u64);
        if let Err(e) = self.epoll.add(&fd, event) {
            // 注册失败就放弃这个设备，避免留下半死状态
            access.release(old.major, old.minor);
            self.by_path.remove(path);
            eprintln!("恢复设备 {path} 失败: {e}");
            return;
        }
        self.by_path.insert(path.to_string(), new_raw);
        self.devices.insert(
            new_raw,
            OpenDevice {
                fd,
                path: path.to_string(),
                major: old.major,
                minor: old.minor,
                paused: false,
            },
        );
    }

    /// 等待事件并批量读取（阻塞，带超时）
    pub fn wait_events(&self, timeout_ms: i32) -> Result<Vec<RawInputEvent>, String> {
        let mut events = [EpollEvent::empty(); 16];

        // timeout: -1 = 无限等待, 0 = 立即返回, >0 = 等待毫秒数
        let timeout: isize = if timeout_ms < 0 { -1 } else { timeout_ms as isize };

        let nfds = self
            .epoll
            .wait(&mut events, timeout)
            .map_err(|e| format!("epoll_wait 失败: {}", e))?;

        if nfds == 0 {
            return Ok(Vec::new());
        }

        let mut collected = Vec::new();
        for ev in &events[..nfds] {
            let fd = ev.data() as RawFd;
            let Some(device) = self.devices.get(&fd) else {
                continue;
            };
            // 批量读取该 fd 当前可用的所有事件（每次最多读 64 个 input_event = 1536 字节）
            let mut buf = [0u8; 24 * 64];
            loop {
                let ret = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
                if ret < 0 {
                    let errno = nix::errno::Errno::last();
                    if errno == nix::errno::Errno::EAGAIN || errno == nix::errno::Errno::EWOULDBLOCK {
                        break;
                    }
                    return Err(format!("读取事件失败: {}", errno));
                }
                if ret == 0 {
                    break;
                }

                let count = (ret as usize) / 24;
                for i in 0..count {
                    let chunk = &buf[i * 24..(i + 1) * 24];
                    let sec = i64::from_ne_bytes(chunk[0..8].try_into().unwrap());
                    let usec = i64::from_ne_bytes(chunk[8..16].try_into().unwrap());
                    let event_type = u16::from_ne_bytes(chunk[16..18].try_into().unwrap());
                    let code = u16::from_ne_bytes(chunk[18..20].try_into().unwrap());
                    let value = i32::from_ne_bytes(chunk[20..24].try_into().unwrap());
                    collected.push(RawInputEvent {
                        path: device.path.clone(),
                        event_type,
                        code,
                        value,
                        timestamp_sec: sec,
                        timestamp_usec: usec,
                    });
                }

                if (ret as usize) < buf.len() {
                    break;
                }
            }
        }

        Ok(collected)
    }

    /// 获取当前监听的设备列表
    #[allow(dead_code)]
    pub fn get_devices(&self) -> Vec<String> {
        self.devices.values().map(|d| d.path.clone()).collect()
    }

    /// 关闭所有设备
    pub fn close(&mut self, access: &mut DeviceAccess) {
        for (_, device) in self.devices.drain() {
            let _ = self.epoll.delete(&device.fd);
            access.release(device.major, device.minor);
        }
        self.by_path.clear();
    }
}
