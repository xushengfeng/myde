mod access;
mod device_info;
mod protocol;
mod reader;
mod scanner;

use std::io::{self, Read, Write};

use access::{AccessEvent, AccessMode, DeviceAccess};
use protocol::*;
use reader::EventReader;

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

    // 初始扫描设备
    let devices = scanner::scan_devices(&mut access);
    let device_infos: Vec<DeviceFullInfo> = devices.into_iter().map(|(info, _)| info).collect();
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
                    event_reader.remove_device(&mut access, &path.to_string_lossy());
                    send_message(
                        &mut stdout,
                        &RustMessage::DeviceRemoved {
                            path: path.to_string_lossy().into_owned(),
                        },
                    );
                }
            }
        }

        // 处理所有已到达的命令
        while let Some(cmd) = read_command(&stdin, &mut stdin_buf, &mut stdin_pos) {
            match cmd {
                TsCommand::ListDevices => {
                    let devices = scanner::scan_devices(&mut access);
                    let device_infos: Vec<DeviceFullInfo> =
                        devices.into_iter().map(|(info, _)| info).collect();
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
            Ok(events) => {
                for event in events {
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
