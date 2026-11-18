use std::os::unix::io::RawFd;

use crate::protocol::*;

// Linux ioctl 常量
const EVIOCGNAME: u64 = 0x82004506; // _IOC(_IOC_READ, 'E', 0x06, 256)
const EVIOCGBIT_EV_MAX: usize = 32;
const EVIOCGABS: u64 = 0x80184540; // _IOC(_IOC_READ, 'E', 0x40, sizeof(input_absinfo))

// 事件类型常量
const EV_SYN: u16 = 0;
const EV_KEY: u16 = 1;
const EV_REL: u16 = 2;
const EV_ABS: u16 = 3;

// 绝对轴常量
const ABS_X: u16 = 0;
const ABS_Y: u16 = 1;
const ABS_MT_SLOT: u16 = 0x2f; // 47
const ABS_MT_TOUCH_MAJOR: u16 = 0x30; // 48
const ABS_MT_TOUCH_MINOR: u16 = 0x31; // 49
const ABS_MT_WIDTH_MAJOR: u16 = 0x32; // 50
const ABS_MT_WIDTH_MINOR: u16 = 0x33; // 51
const ABS_MT_ORIENTATION: u16 = 0x34; // 52
const ABS_MT_POSITION_X: u16 = 0x35; // 53
const ABS_MT_POSITION_Y: u16 = 0x36; // 54
const ABS_MT_TOOL_TYPE: u16 = 0x37; // 55
const ABS_MT_BLOB_ID: u16 = 0x38; // 56
const ABS_MT_TRACKING_ID: u16 = 0x39; // 57
const ABS_MT_PRESSURE: u16 = 0x3a; // 58

// input_absinfo 结构体大小 (6 * i32 = 24 bytes)
const ABSINFO_SIZE: usize = 24;

/// input_absinfo 结构体（Linux 内核定义）
#[repr(C)]
struct InputAbsInfo {
    value: i32,
    minimum: i32,
    maximum: i32,
    fuzz: i32,
    flat: i32,
    resolution: i32,
}

/// 读取设备名称
pub fn read_name(fd: RawFd) -> Result<String, String> {
    let mut buf = [0u8; 256];
    let ret = unsafe { libc::ioctl(fd, EVIOCGNAME, buf.as_mut_ptr()) };
    if ret < 0 {
        return Err(format!("ioctl EVIOCGNAME 失败: {}", ret));
    }
    // 找到字符串结尾
    let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8(buf[..len].to_vec()).map_err(|e| format!("名称编码错误: {}", e))
}

/// 读取设备能力
pub fn read_capabilities(fd: RawFd) -> Result<DeviceCapabilities, String> {
    let mut ev_bits = [0u8; EVIOCGBIT_EV_MAX];
    let ret = unsafe { libc::ioctl(fd, 0x80204520u64, ev_bits.as_mut_ptr()) }; // EVIOCGBIT(0, EV_MAX)
    if ret < 0 {
        return Err(format!("ioctl EVIOCGBIT 失败: {}", ret));
    }

    let event_types = bytes_to_bits(&ev_bits);
    let mut key_codes = Vec::new();
    let mut rel_axes = Vec::new();
    let mut abs_axes = Vec::new();

    // 读取各个事件类型的详细能力
    for &ev_type in &event_types {
        match ev_type {
            EV_KEY => {
                key_codes = read_event_bits(fd, EV_KEY)?;
            }
            EV_REL => {
                rel_axes = read_event_bits(fd, EV_REL)?;
            }
            EV_ABS => {
                abs_axes = read_event_bits(fd, EV_ABS)?;
            }
            _ => {}
        }
    }

    // 检测设备特性
    let has_keyboard = has_keyboard_keys(&key_codes);
    let has_mouse = has_mouse_axes(&rel_axes) || has_mouse_buttons(&key_codes);
    let has_touchpad = has_touchpad_axes(&abs_axes);
    let has_touchscreen = has_touchscreen_axes(&abs_axes);

    Ok(DeviceCapabilities {
        event_types,
        key_codes,
        rel_axes,
        abs_axes,
        max_touch_slots: None, // 后续单独读取
        has_keyboard,
        has_mouse,
        has_touchpad,
        has_touchscreen,
    })
}

/// 读取指定事件类型的位图
fn read_event_bits(fd: RawFd, ev_type: u16) -> Result<Vec<u16>, String> {
    let mut bits = [0u8; EVIOCGBIT_EV_MAX];
    // EVIOCGBIT(ev_type, EV_MAX)
    let request = 0x80204520u64 + (ev_type as u64);
    let ret = unsafe { libc::ioctl(fd, request, bits.as_mut_ptr()) };
    if ret < 0 {
        return Err(format!("ioctl EVIOCGBIT({}) 失败: {}", ev_type, ret));
    }
    Ok(bytes_to_bits(&bits))
}

/// 将字节数组转换为位索引列表
fn bytes_to_bits(bytes: &[u8]) -> Vec<u16> {
    let mut bits = Vec::new();
    for (i, &byte) in bytes.iter().enumerate() {
        for bit in 0..8 {
            if byte & (1 << bit) != 0 {
                bits.push((i * 8 + bit) as u16);
            }
        }
    }
    bits
}

/// 检测是否有键盘按键
fn has_keyboard_keys(keys: &[u16]) -> bool {
    // 检查是否有字母键、数字键、功能键等
    keys.iter().any(|&k| {
        (k >= 1 && k <= 53) // ESC, 数字键, 字母键, 符号键
            || (k >= 59 && k <= 88) // F1-F12, 功能键
            || (k >= 96 && k <= 111) // 小键盘
            || (k >= 112 && k <= 127) // 多媒体键
    })
}

/// 检测是否有鼠标相对轴
fn has_mouse_axes(rels: &[u16]) -> bool {
    rels.contains(&0) && rels.contains(&1) // REL_X, REL_Y
}

/// 检测是否有鼠标按钮
fn has_mouse_buttons(keys: &[u16]) -> bool {
    // BTN_LEFT (0x110), BTN_RIGHT (0x111), BTN_MIDDLE (0x112)
    keys.iter().any(|&k| k >= 0x110 && k <= 0x117)
}

/// 检测是否有触摸板绝对轴
fn has_touchpad_axes(abs: &[u16]) -> bool {
    // 触摸板通常有 ABS_X, ABS_Y 但没有 ABS_MT_POSITION_X
    abs.contains(&ABS_X) && abs.contains(&ABS_Y) && !abs.contains(&ABS_MT_POSITION_X)
}

/// 检测是否有触屏多点触控轴
fn has_touchscreen_axes(abs: &[u16]) -> bool {
    abs.contains(&ABS_MT_POSITION_X) && abs.contains(&ABS_MT_POSITION_Y)
}

/// 读取绝对轴信息
pub fn read_abs_info(fd: RawFd, axis: u16) -> Result<AxisInfo, String> {
    let mut info = InputAbsInfo {
        value: 0,
        minimum: 0,
        maximum: 0,
        fuzz: 0,
        flat: 0,
        resolution: 0,
    };

    // EVIOCGABS(axis)
    let request = 0x80184540u64 + (axis as u64);
    let ret = unsafe { libc::ioctl(fd, request, &mut info as *mut _ as *mut u8) };
    if ret < 0 {
        return Err(format!("ioctl EVIOCGABS({}) 失败: {}", axis, ret));
    }

    Ok(AxisInfo {
        min: info.minimum,
        max: info.maximum,
        fuzz: info.fuzz,
        flat: info.flat,
        resolution: info.resolution,
    })
}

/// 读取触屏物理信息
pub fn read_touch_info(
    fd: RawFd,
    abs_axes: &[u16],
) -> Result<Option<TouchInfo>, Vec<DeviceError>> {
    if !abs_axes.contains(&ABS_MT_POSITION_X) || !abs_axes.contains(&ABS_MT_POSITION_Y) {
        return Ok(None);
    }

    let mut errors = Vec::new();

    // 读取必需的 X/Y 轴
    let position_x = match read_abs_info(fd, ABS_MT_POSITION_X) {
        Ok(info) => info,
        Err(e) => {
            errors.push(DeviceError {
                field: "position_x".to_string(),
                message: e,
            });
            AxisInfo { min: 0, max: 0, fuzz: 0, flat: 0, resolution: 0 }
        }
    };

    let position_y = match read_abs_info(fd, ABS_MT_POSITION_Y) {
        Ok(info) => info,
        Err(e) => {
            errors.push(DeviceError {
                field: "position_y".to_string(),
                message: e,
            });
            AxisInfo { min: 0, max: 0, fuzz: 0, flat: 0, resolution: 0 }
        }
    };

    // 读取可选轴
    let pressure = read_optional_axis(fd, abs_axes, ABS_MT_PRESSURE, "pressure", &mut errors);
    let touch_major = read_optional_axis(fd, abs_axes, ABS_MT_TOUCH_MAJOR, "touch_major", &mut errors);
    let touch_minor = read_optional_axis(fd, abs_axes, ABS_MT_TOUCH_MINOR, "touch_minor", &mut errors);
    let width_major = read_optional_axis(fd, abs_axes, ABS_MT_WIDTH_MAJOR, "width_major", &mut errors);
    let width_minor = read_optional_axis(fd, abs_axes, ABS_MT_WIDTH_MINOR, "width_minor", &mut errors);
    let orientation = read_optional_axis(fd, abs_axes, ABS_MT_ORIENTATION, "orientation", &mut errors);
    let tracking_id = read_optional_axis(fd, abs_axes, ABS_MT_TRACKING_ID, "tracking_id", &mut errors);
    let slot = read_optional_axis(fd, abs_axes, ABS_MT_SLOT, "slot", &mut errors);

    // 检测多点触控协议类型
    let mt_protocol = if abs_axes.contains(&ABS_MT_TRACKING_ID) {
        Some("B".to_string())
    } else if abs_axes.contains(&ABS_MT_SLOT) {
        Some("B".to_string())
    } else {
        Some("A".to_string())
    };

    if errors.is_empty() {
        Ok(Some(TouchInfo {
            position_x,
            position_y,
            pressure,
            touch_major,
            touch_minor,
            width_major,
            width_minor,
            orientation,
            tracking_id,
            slot,
            mt_protocol,
        }))
    } else {
        // 返回部分信息 + 错误
        Ok(Some(TouchInfo {
            position_x,
            position_y,
            pressure,
            touch_major,
            touch_minor,
            width_major,
            width_minor,
            orientation,
            tracking_id,
            slot,
            mt_protocol,
        }))
    }
}

/// 读取可选轴信息
fn read_optional_axis(
    fd: RawFd,
    abs_axes: &[u16],
    axis: u16,
    field_name: &str,
    errors: &mut Vec<DeviceError>,
) -> Option<AxisInfo> {
    if !abs_axes.contains(&axis) {
        return None;
    }

    match read_abs_info(fd, axis) {
        Ok(info) => Some(info),
        Err(e) => {
            errors.push(DeviceError {
                field: field_name.to_string(),
                message: e,
            });
            None
        }
    }
}

/// 读取最大多点触控槽位数
pub fn read_max_touch_slots(fd: RawFd) -> Result<u32, String> {
    // 读取 ABS_MT_SLOT 的最大值
    let slot_info = read_abs_info(fd, ABS_MT_SLOT)?;
    Ok((slot_info.max + 1) as u32)
}
