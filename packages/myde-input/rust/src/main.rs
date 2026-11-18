mod access;
mod device_info;
mod hotplug;
mod protocol;
mod reader;
mod scanner;

use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

use access::{AccessEvent, AccessMode, DeviceAccess};
use hotplug::{HotplugAction, HotplugMonitor};
use protocol::*;
use reader::EventReader;

/// 热插拔新增设备打开失败后的重试间隔与总时限
const HOTPLUG_RETRY_INTERVAL: Duration = Duration::from_millis(200);
const HOTPLUG_RETRY_TIMEOUT: Duration = Duration::from_secs(2);

/// 等待权限/设备节点就绪的新设备
struct PendingAdd {
    deadline: Instant,
    next_try: Instant,
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    // 设置 stdin 为非阻塞模式，避免主循环卡在 stdin.read()
    {
        use std::os::unix::io::AsRawFd;
        let fd = stdin.as_raw_fd();
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
    }

    // 设备打开方式由 TS 侧通过 --access= 指定，默认 auto（logind 优先，失败回退 direct）
    let access_mode = parse_access_mode();
    let mut access = DeviceAccess::new(access_mode);

    // 创建事件读取器
    let mut event_reader = match EventReader::new() {
        Ok(r) => r,
        Err(e) => {
            let msg = RustMessage::Error {
                code: "INIT_FAILED".to_string(),
                message: e,
                detail: None,
            };
            send_message(&mut stdout, &msg);
            return;
        }
    };

    // 先创建 udev 监听，再扫描，避免两者之间插入的设备丢失（重复的设备会去重）
    let hotplug = HotplugMonitor::new();

    // 初始扫描设备
    let devices = scanner::scan_devices(&mut access);
    let device_infos: Vec<DeviceFullInfo> = devices.into_iter().map(|(info, _)| info).collect();
    let mut known: HashSet<String> = device_infos
        .iter()
        .filter(|info| !info.path.is_empty())
        .map(|info| info.path.clone())
        .collect();
    let msg = RustMessage::DeviceList {
        devices: device_infos,
        access_mode: access.access_mode().to_string(),
        access_error: access.logind_error().map(|e| e.to_string()),
    };
    send_message(&mut stdout, &msg);

    // 主循环：读取命令 + 读取事件
    let mut stdin_buf = vec![0u8; 64 * 1024];
    let mut stdin_pos = 0;
    let mut should_exit = false;
    // 已经发现但暂时打不开的设备（权限/设备节点尚未就绪）
    let mut pending: HashMap<String, PendingAdd> = HashMap::new();

    while !should_exit {
        // 处理 logind 的 Pause/Resume/Gone（VT 切换、设备拔出）
        for event in access.drain_events() {
            match event {
                AccessEvent::Paused(path) => {
                    event_reader.pause_device(&path.to_string_lossy());
                }
                AccessEvent::Resumed(path, fd) => {
                    event_reader.resume_device(&mut access, &path.to_string_lossy(), fd);
                }
                AccessEvent::Gone(path) => {
                    let path = path.to_string_lossy().into_owned();
                    event_reader.remove_device(&mut access, &path);
                    pending.remove(&path);
                    if known.remove(&path) {
                        send_message(&mut stdout, &RustMessage::DeviceRemoved { path });
                    }
                }
            }
        }

        // 处理 udev 热插拔（新增设备打开失败会进入 pending 重试）
        for event in hotplug.drain() {
            match event.action {
                HotplugAction::Added => {
                    if !known.contains(&event.path) && !pending.contains_key(&event.path) {
                        try_add_device(
                            &event.path,
                            &mut stdout,
                            &mut access,
                            &mut known,
                            &mut pending,
                        );
                    }
                }
                HotplugAction::Removed => {
                    pending.remove(&event.path);
                    // 已通过读取出错或 logind Gone 处理过的不再重复通知
                    if known.remove(&event.path) {
                        event_reader.remove_device(&mut access, &event.path);
                        send_message(
                            &mut stdout,
                            &RustMessage::DeviceRemoved { path: event.path },
                        );
                    }
                }
            }
        }

        // 重试暂时打不开的新设备
        retry_pending(&mut stdout, &mut access, &mut known, &mut pending);

        // 处理所有已到达的命令
        while let Some(cmd) = read_command(&stdin, &mut stdin_buf, &mut stdin_pos) {
            match cmd {
                TsCommand::ListDevices => {
                    let devices = scanner::scan_devices(&mut access);
                    let device_infos: Vec<DeviceFullInfo> =
                        devices.into_iter().map(|(info, _)| info).collect();
                    // /proc 解析失败会返回一个 path 为空的错误项，此时不要动 known
                    if device_infos.iter().all(|info| !info.path.is_empty()) {
                        let paths: HashSet<String> =
                            device_infos.iter().map(|info| info.path.clone()).collect();
                        known.retain(|path| paths.contains(path));
                        known.extend(paths);
                    }
                    let msg = RustMessage::DeviceList {
                        devices: device_infos,
                        access_mode: access.access_mode().to_string(),
                        access_error: access.logind_error().map(|e| e.to_string()),
                    };
                    send_message(&mut stdout, &msg);
                }
                TsCommand::StartReading { paths } => {
                    let mut errors = Vec::new();
                    for path in &paths {
                        if let Err(e) = event_reader.add_device(&mut access, path) {
                            errors.push(e);
                        }
                    }
                    if errors.is_empty() {
                        send_message(&mut stdout, &RustMessage::Ok);
                    } else {
                        send_message(
                            &mut stdout,
                            &RustMessage::Error {
                                code: "START_READING_FAILED".to_string(),
                                message: errors.join("; "),
                                detail: None,
                            },
                        );
                    }
                }
                TsCommand::StopReading { paths } => {
                    for path in &paths {
                        event_reader.remove_device(&mut access, path);
                    }
                    send_message(&mut stdout, &RustMessage::Ok);
                }
                TsCommand::Exit => {
                    should_exit = true;
                    break;
                }
            }
        }

        if should_exit {
            break;
        }

        // 批量读取输入事件（非阻塞，超时 10ms）
        match event_reader.wait_events(10) {
            Ok(outcome) => {
                for removed in outcome.removed {
                    access.release(removed.major, removed.minor);
                    pending.remove(&removed.path);
                    if known.remove(&removed.path) {
                        send_message(
                            &mut stdout,
                            &RustMessage::DeviceRemoved {
                                path: removed.path,
                            },
                        );
                    }
                }
                for message in outcome.errors {
                    send_message(
                        &mut stdout,
                        &RustMessage::Error {
                            code: "EVENT_READ_ERROR".to_string(),
                            message,
                            detail: None,
                        },
                    );
                }
                for event in outcome.events {
                    let msg = RustMessage::InputEvent {
                        path: event.path,
                        event_type: event.event_type,
                        code: event.code,
                        value: event.value,
                        timestamp_sec: event.timestamp_sec,
                        timestamp_usec: event.timestamp_usec,
                    };
                    send_message(&mut stdout, &msg);
                }
            }
            Err(e) => {
                send_message(
                    &mut stdout,
                    &RustMessage::Error {
                        code: "EVENT_READ_ERROR".to_string(),
                        message: e,
                        detail: None,
                    },
                );
            }
        }
    }

    event_reader.close(&mut access);
}

/// 扫描并上报一个新设备；暂时打不开时放进 pending 等权限/设备节点就绪
fn try_add_device(
    path: &str,
    stdout: &mut io::StdoutLock<'_>,
    access: &mut DeviceAccess,
    known: &mut HashSet<String>,
    pending: &mut HashMap<String, PendingAdd>,
) {
    if known.contains(path) {
        pending.remove(path);
        return;
    }

    let (info, _) = scanner::scan_device(path, access);
    if info.errors.iter().any(|error| error.field == "open") {
        let now = Instant::now();
        let entry = pending.entry(path.to_string()).or_insert(PendingAdd {
            deadline: now + HOTPLUG_RETRY_TIMEOUT,
            next_try: now + HOTPLUG_RETRY_INTERVAL,
        });
        entry.next_try = now + HOTPLUG_RETRY_INTERVAL;
        return;
    }

    pending.remove(path);
    if known.insert(path.to_string()) {
        send_message(stdout, &RustMessage::DeviceAdded { device: info });
    }
}

/// 重试 pending 中到期的设备
fn retry_pending(
    stdout: &mut io::StdoutLock<'_>,
    access: &mut DeviceAccess,
    known: &mut HashSet<String>,
    pending: &mut HashMap<String, PendingAdd>,
) {
    if pending.is_empty() {
        return;
    }

    let now = Instant::now();
    let due: Vec<String> = pending
        .iter()
        .filter(|(_, entry)| now >= entry.next_try)
        .map(|(path, _)| path.clone())
        .collect();

    for path in due {
        if !std::path::Path::new(&path).exists() {
            pending.remove(&path);
            continue;
        }
        let expired = pending
            .get(&path)
            .is_some_and(|entry| now >= entry.deadline);
        if expired {
            pending.remove(&path);
            // 一直打不开（通常是权限）：仍然上报，和初始 device_list 的行为一致
            let (info, _) = scanner::scan_device(&path, access);
            if known.insert(path.clone()) {
                send_message(stdout, &RustMessage::DeviceAdded { device: info });
            }
            eprintln!("设备 {path} 打开失败，已按不可用设备上报");
            continue;
        }
        try_add_device(&path, stdout, access, known, pending);
    }
}

/// 解析 `--access=auto|logind|direct`
fn parse_access_mode() -> AccessMode {
    let mut mode = AccessMode::Auto;
    for arg in std::env::args().skip(1) {
        if let Some(value) = arg.strip_prefix("--access=") {
            match AccessMode::parse(value) {
                Some(parsed) => mode = parsed,
                None => eprintln!("未知的 --access 值: {value}，使用 auto"),
            }
        }
    }
    mode
}

/// 读取命令（非阻塞）
///
/// TS 侧发送的帧格式: [4字节小端长度][MessagePack 数据]
fn read_command(stdin: &io::Stdin, buf: &mut Vec<u8>, pos: &mut usize) -> Option<TsCommand> {
    // 尝试读取 stdin
    let mut stdin = stdin.lock();
    let mut tmp = [0u8; 4096];

    match stdin.read(&mut tmp) {
        Ok(0) => {
            // EOF: 父进程已关闭 stdin，退出
            return Some(TsCommand::Exit);
        }
        Ok(n) => {
            // 追加到缓冲区
            if *pos + n > buf.len() {
                buf.resize(*pos + n, 0);
            }
            buf[*pos..*pos + n].copy_from_slice(&tmp[..n]);
            *pos += n;
        }
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
            // 没有数据，继续检查现有缓冲区
        }
        Err(_) => {
            // 管道损坏或其他错误，退出
            return Some(TsCommand::Exit);
        }
    }

    // 需要至少 4 字节读取长度前缀
    if *pos < 4 {
        return None;
    }

    let msg_len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;

    // 检查是否有完整消息
    if *pos < 4 + msg_len {
        return None;
    }

    // 提取消息体
    let msg_data = &buf[4..4 + msg_len];

    // 解析 MessagePack
    match TsCommand::from_msgpack(msg_data) {
        Ok(cmd) => {
            // 移除已消费的数据
            let consumed = 4 + msg_len;
            buf.copy_within(consumed.., 0);
            *pos -= consumed;
            Some(cmd)
        }
        Err(e) => {
            // 解析失败，丢弃这条消息
            let consumed = 4 + msg_len;
            buf.copy_within(consumed.., 0);
            *pos -= consumed;
            let _ = e; // 可选: 记录错误
            None
        }
    }
}

/// 发送消息到 stdout
fn send_message(stdout: &mut io::StdoutLock, msg: &RustMessage) {
    match msg.to_msgpack() {
        Ok(data) => {
            // 写入长度前缀 + 数据
            let len = (data.len() as u32).to_le_bytes();
            let _ = stdout.write_all(&len);
            let _ = stdout.write_all(&data);
            let _ = stdout.flush();
        }
        Err(e) => {
            // 序列化失败，发送错误消息
            let err_msg = RustMessage::Error {
                code: "ENCODE_ERROR".to_string(),
                message: e,
                detail: None,
            };
            if let Ok(err_data) = err_msg.to_msgpack() {
                let len = (err_data.len() as u32).to_le_bytes();
                let _ = stdout.write_all(&len);
                let _ = stdout.write_all(&err_data);
                let _ = stdout.flush();
            }
        }
    }
}
