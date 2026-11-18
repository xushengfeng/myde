//! 输入设备热插拔监听（udev）。
//!
//! udev monitor 在 udev 规则执行完后才投递事件，因此新增设备的权限/ACL 已经就绪；
//! 监听 socket 默认非阻塞，主循环每次 drain 一次即可。

use std::io;
use std::path::PathBuf;

use udev::{EventType, MonitorBuilder, MonitorSocket};

/// 热插拔事件类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotplugAction {
    /// 设备接入（或出现变化，可能从未知变为可读）
    Added,
    /// 设备移除
    Removed,
}

/// 一个输入节点（/dev/input/eventN）的热插拔事件
#[derive(Debug, Clone)]
pub struct HotplugEvent {
    pub action: HotplugAction,
    pub path: String,
}

/// udev 输入子系统监听器
pub struct HotplugMonitor {
    socket: Option<MonitorSocket>,
}

impl HotplugMonitor {
    pub fn new() -> Self {
        let socket = (|| -> io::Result<MonitorSocket> {
            MonitorBuilder::new()?.match_subsystem("input")?.listen()
        })();

        match socket {
            Ok(socket) => Self {
                socket: Some(socket),
            },
            Err(e) => {
                // 没有 udev 时仍可读设备，只是没有热插拔推送
                eprintln!("创建 udev 热插拔监听失败: {e}");
                Self { socket: None }
            }
        }
    }

    /// 取出已到达的事件（非阻塞）
    pub fn drain(&self) -> Vec<HotplugEvent> {
        let Some(socket) = &self.socket else {
            return Vec::new();
        };

        let mut events = Vec::new();
        for event in socket.iter() {
            let action = match event.event_type() {
                EventType::Add => HotplugAction::Added,
                // Change 可能是权限/属性就绪；对未知设备按新增再试一次
                EventType::Change => HotplugAction::Added,
                EventType::Remove => HotplugAction::Removed,
                _ => continue,
            };
            let device = event.device();
            // Remove 事件的 uevent 不一定带 DEVNAME，用 sysname 拼出 eventN
            let path = device
                .devnode()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from("/dev/input").join(device.sysname()));
            let is_event_node = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("event"));
            if !is_event_node {
                continue;
            }
            let Some(path) = path.to_str() else {
                continue;
            };
            events.push(HotplugEvent {
                action,
                path: path.to_string(),
            });
        }
        events
    }
}
