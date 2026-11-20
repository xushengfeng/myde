use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use tracing::{error, info, warn};

use crate::protocol::{ClientMessage, ServerResponse};

pub struct SocketServer {
    listener: UnixListener,
    socket_path: PathBuf,
}

impl SocketServer {
    /// 控制 socket 只给本用户：文件名由调用方保证唯一（不和多实例互踩），
    /// 建好后收紧到 0600；所在目录是 0700 的私有运行目录。
    pub fn new(socket_path: PathBuf) -> anyhow::Result<Self> {
        let listener = UnixListener::bind(&socket_path)?;
        listener.set_nonblocking(true)?;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;
        info!("Socket server listening on: {:?} (mode 0600)", socket_path);
        Ok(Self {
            listener,
            socket_path,
        })
    }

    #[allow(dead_code)]
    pub fn get_socket_path(&self) -> &PathBuf {
        &self.socket_path
    }

    pub fn accept(&self) -> Option<UnixStream> {
        match self.listener.accept() {
            Ok((stream, _)) => {
                if !peer_is_same_user(&stream) {
                    warn!("拒绝来自其他用户的控制连接");
                    return None;
                }
                stream.set_nonblocking(false).ok();
                Some(stream)
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => None,
            Err(e) => {
                error!("Accept error: {}", e);
                None
            }
        }
    }
}

/// 只接受与 wrap 同一用户的连接；文件权限之外再兜一层，避免 socket 所在
/// 目录权限异常时其他用户也能控制合成器。
fn peer_is_same_user(stream: &UnixStream) -> bool {
    match nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials) {
        Ok(creds) => creds.uid() == nix::unistd::geteuid().as_raw(),
        Err(e) => {
            warn!("读取控制连接凭据失败: {}", e);
            false
        }
    }
}

impl Drop for SocketServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

pub fn read_message(stream: &mut UnixStream) -> anyhow::Result<ClientMessage> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf)?;
    let len = u32::from_be_bytes(len_buf) as usize;

    if len > 10 * 1024 * 1024 {
        return Err(anyhow::anyhow!("Message too large: {} bytes", len));
    }

    let mut msg_buf = vec![0u8; len];
    stream.read_exact(&mut msg_buf)?;

    let msg: ClientMessage = match serde_json::from_slice(&msg_buf) {
        Ok(msg) => msg,
        Err(e) => {
            let raw_str = String::from_utf8_lossy(&msg_buf);
            tracing::error!("数据解析错误: {}. 原始数据: {}", e, raw_str);
            return Err(anyhow::anyhow!("数据解析错误: {}", e));
        }
    };
    Ok(msg)
}

pub fn write_message(stream: &mut UnixStream, response: &ServerResponse) -> anyhow::Result<()> {
    let json = serde_json::to_vec(response)?;
    let len = json.len() as u32;
    stream.write_all(&len.to_be_bytes())?;
    stream.write_all(&json)?;
    stream.flush()?;
    Ok(())
}
