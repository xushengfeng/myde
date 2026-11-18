use std::collections::HashMap;
use std::fs;
use std::os::unix::io::AsRawFd;

use crate::access::DeviceAccess;
use crate::device_info;
use crate::protocol::*;

/// 扫描所有输入设备
pub fn scan_devices(access: &mut DeviceAccess) -> Vec<(DeviceFullInfo, Option<String>)> {
    let mut results = Vec::new();

    // 解析 /proc/bus/input/devices 获取设备列表
    let proc_devices = match parse_proc_devices() {
        Ok(d) => d,
        Err(e) => {
            let info = DeviceFullInfo {
                path: String::new(),
                name: String::new(),
                device_type: "unknown".to_string(),
                phys: None,
                vendor: 0,
                product: 0,
                version: 0,
                capabilities: empty_capabilities(),
                touch_info: None,
                abs_info: HashMap::new(),
                access: None,
                errors: vec![DeviceError {
                    field: "proc_devices".to_string(),
                    message: e.clone(),
                }],
            };
            results.push((info, Some(e)));
            return results;
        }
    };

    for (event_name, proc_info) in proc_devices {
        let path = format!("/dev/input/{}", event_name);
        let (info, error) = scan_single_device(&path, &proc_info, access);
        results.push((info, error));
    }

    results
}

/// 扫描单个设备
fn scan_single_device(
    path: &str,
    proc_info: &ProcDeviceInfo,
    access: &mut DeviceAccess,
) -> (DeviceFullInfo, Option<String>) {
    let mut errors = Vec::new();

    // 打开设备（logind 优先，失败回退直接打开）。fd 必须保持存活，
    // 后面所有能力/量程 ioctl 都在这上面做。
    let taken = match access.open(std::path::Path::new(path)) {
        Ok(t) => t,
        Err(e) => {
            errors.push(DeviceError {
                field: "open".to_string(),
                message: e.clone(),
            });
            return (
                DeviceFullInfo {
                    path: path.to_string(),
                    name: proc_info.name.clone(),
                    device_type: "unknown".to_string(),
                    phys: proc_info.phys.clone(),
                    vendor: proc_info.vendor,
                    product: proc_info.product,
                    version: proc_info.version,
                    capabilities: empty_capabilities(),
                    touch_info: None,
                    abs_info: HashMap::new(),
                    access: None,
                    errors,
                },
                Some(e),
            );
        }
    };
    let fd = taken.fd.as_raw_fd();
    let access_kind = taken.access;

    // 读取设备能力
    let capabilities = match device_info::read_capabilities(fd) {
        Ok(caps) => caps,
        Err(e) => {
            errors.push(DeviceError {
                field: "capabilities".to_string(),
                message: e.clone(),
            });
            empty_capabilities()
        }
    };

    // 读取触屏物理信息
    let touch_info = if capabilities.has_touchscreen {
        match device_info::read_touch_info(fd, &capabilities.abs_axes) {
            Ok(info) => info,
            Err(errs) => {
                errors.extend(errs);
                None
            }
        }
    } else {
        None
    };

    // 读取所有绝对轴的量程信息（用于绝对定位设备的坐标校准）
    let mut abs_info = HashMap::new();
    for &axis in &capabilities.abs_axes {
        if let Ok(info) = device_info::read_abs_info(fd, axis) {
            abs_info.insert(axis.to_string(), info);
        }
    };

    // 读取设备名称（如果 proc 中没有）
    let name = if proc_info.name.is_empty() {
        device_info::read_name(fd).unwrap_or_else(|e| {
            errors.push(DeviceError {
                field: "name".to_string(),
                message: e,
            });
            "Unknown Device".to_string()
        })
    } else {
        proc_info.name.clone()
    };

    // 检测设备类型
    let device_type = detect_device_type_from_caps(&capabilities, &name);

    // 读取多点触控槽位数
    let mut caps_with_slots = capabilities;
    if caps_with_slots.has_touchscreen {
        match device_info::read_max_touch_slots(fd) {
            Ok(slots) => caps_with_slots.max_touch_slots = Some(slots),
            Err(e) => {
                errors.push(DeviceError {
                    field: "max_touch_slots".to_string(),
                    message: e,
                });
            }
        }
    }

    // 设备只借用一次用于读取能力/量程，随后归还（logind 会收到 ReleaseDevice）
    access.release(taken.major, taken.minor);
    drop(taken);

    let error_msg = if errors.is_empty() {
        None
    } else {
        Some(format!("{} 个错误", errors.len()))
    };

    (
        DeviceFullInfo {
            path: path.to_string(),
            name,
            device_type,
            phys: proc_info.phys.clone(),
            vendor: proc_info.vendor,
            product: proc_info.product,
            version: proc_info.version,
            capabilities: caps_with_slots,
            touch_info,
            abs_info,
            access: Some(access_kind.to_string()),
            errors,
        },
        error_msg,
    )
}

/// 从能力检测设备类型
fn detect_device_type_from_caps(caps: &DeviceCapabilities, name: &str) -> String {
    let name_lower = name.to_lowercase();

    if name_lower.contains("touchpad") || (caps.has_touchpad && !name_lower.contains("touchscreen")) {
        "touchpad".to_string()
    } else if caps.has_touchscreen || (name_lower.contains("touch") && !name_lower.contains("pad")) {
        "touchscreen".to_string()
    } else if caps.has_keyboard {
        "keyboard".to_string()
    } else if caps.has_mouse {
        "mouse".to_string()
    } else if name_lower.contains("gamepad") || name_lower.contains("joystick") {
        "gamepad".to_string()
    } else if name_lower.contains("tablet") || name_lower.contains("pen") {
        "tablet".to_string()
    } else {
        "unknown".to_string()
    }
}

fn empty_capabilities() -> DeviceCapabilities {
    DeviceCapabilities {
        event_types: Vec::new(),
        key_codes: Vec::new(),
        rel_axes: Vec::new(),
        abs_axes: Vec::new(),
        max_touch_slots: None,
        has_keyboard: false,
        has_mouse: false,
        has_touchpad: false,
        has_touchscreen: false,
    }
}

/// /proc/bus/input/devices 中的设备信息
struct ProcDeviceInfo {
    name: String,
    phys: Option<String>,
    vendor: u16,
    product: u16,
    version: u16,
}

/// 解析 /proc/bus/input/devices 文件
fn parse_proc_devices() -> Result<HashMap<String, ProcDeviceInfo>, String> {
    let content =
        fs::read_to_string("/proc/bus/input/devices").map_err(|e| format!("读取 proc 失败: {}", e))?;

    let mut devices = HashMap::new();
    let mut current_event: Option<String> = None;
    let mut current_name = String::new();
    let mut current_phys: Option<String> = None;
    let mut current_vendor: u16 = 0;
    let mut current_product: u16 = 0;
    let mut current_version: u16 = 0;

    for line in content.lines() {
        if line.starts_with('I') {
            // 解析 ID 行: I: Bus=... Vendor=... Product=... Version=...
            for part in line.split_whitespace() {
                if let Some(val) = part.strip_prefix("Vendor=") {
                    current_vendor = u16::from_str_radix(val, 16).unwrap_or(0);
                } else if let Some(val) = part.strip_prefix("Product=") {
                    current_product = u16::from_str_radix(val, 16).unwrap_or(0);
                } else if let Some(val) = part.strip_prefix("Version=") {
                    current_version = u16::from_str_radix(val, 16).unwrap_or(0);
                }
            }
        } else if line.starts_with('N') {
            // 解析名称: N: Name="..."
            if let Some(start) = line.find('"') {
                if let Some(end) = line.rfind('"') {
                    current_name = line[start + 1..end].to_string();
                }
            }
        } else if line.starts_with('P') {
            // 解析物理路径: P: Phys=...
            if let Some(val) = line.strip_prefix("P: Phys=") {
                current_phys = Some(val.to_string());
            }
        } else if line.starts_with('H') {
            // 解析 Handlers: H: ... eventN ...
            // 格式可能是 "Handlers=event5"（无空格）或 "Handlers=kbd event5"（有空格）
            if let Some(pos) = line.find("event") {
                let rest = &line[pos..]; // "event5 mouse0 ..." 或 "event 5"
                // 提取 "event" 后面的数字（可能紧跟或有空格）
                let after_event = &rest[5..]; // 跳过 "event"
                if after_event.starts_with(|c: char| c.is_ascii_digit()) {
                    // "event5" 的情况
                    let end = after_event
                        .find(|c: char| !c.is_ascii_digit())
                        .unwrap_or(after_event.len());
                    current_event = Some(format!("event{}", &after_event[..end]));
                } else {
                    // "event 5" 的情况，数字在下一个空白分隔的 token
                    let num = after_event
                        .split_whitespace()
                        .next()
                        .unwrap_or("");
                    if num.chars().all(|c| c.is_ascii_digit()) && !num.is_empty() {
                        current_event = Some(format!("event{}", num));
                    }
                }
            }
        } else if line.is_empty() {
            // 空行表示设备结束
            if let Some(event) = current_event.take() {
                devices.insert(
                    event,
                    ProcDeviceInfo {
                        name: current_name.clone(),
                        phys: current_phys.clone(),
                        vendor: current_vendor,
                        product: current_product,
                        version: current_version,
                    },
                );
            }
            current_name.clear();
            current_phys = None;
        }
    }

    // 处理最后一个设备（如果文件不以空行结尾）
    if let Some(event) = current_event {
        devices.insert(
            event,
            ProcDeviceInfo {
                name: current_name,
                phys: current_phys,
                vendor: current_vendor,
                product: current_product,
                version: current_version,
            },
        );
    }

    Ok(devices)
}
