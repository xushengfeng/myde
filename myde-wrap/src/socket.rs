use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use tracing::{error, info};

use crate::protocol::{ClientMessage, ServerResponse};

pub struct SocketServer {
    listener: UnixListener,
    socket_path: PathBuf,
}

impl SocketServer {
    pub fn new(socket_path: PathBuf) -> anyhow::Result<Self> {
        if socket_path.exists() {
            std::fs::remove_file(&socket_path)?;
        }
        let listener = UnixListener::bind(&socket_path)?;
        listener.set_nonblocking(true)?;
        info!("Socket server listening on: {:?}", socket_path);
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
