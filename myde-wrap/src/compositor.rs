use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::protocol::{ClientMessage, ServerResponse};
use crate::renderer::Renderer;

pub struct Compositor {
    renderer: Arc<Mutex<Renderer>>,
    /// 配置变化后置位，通知渲染线程（calloop）重新上屏
    redraw: Arc<AtomicBool>,
}

impl Compositor {
    pub fn new(renderer: Arc<Mutex<Renderer>>, redraw: Arc<AtomicBool>) -> Self {
        Self { renderer, redraw }
    }

    fn invalidate(&self) {
        self.redraw.store(true, Ordering::Release);
    }

    pub async fn handle_message(&self, msg: ClientMessage) -> Option<ServerResponse> {
        let mut renderer = self.renderer.lock().await;

        let response = match msg {
            ClientMessage::SetWindowSize { width, height } => {
                renderer.set_window_size(width, height);
                self.invalidate();
                ServerResponse::WindowSizeSet { width, height }
            }
            ClientMessage::CaptureRects { rects } => {
                let captured = renderer.capture_rects(rects);
                self.invalidate();
                ServerResponse::RectsCaptured { rects: captured }
            }
            ClientMessage::TransformRects { transforms } => {
                renderer.transform_rects(transforms);
                self.invalidate();
                ServerResponse::RectsTransformed
            }
            ClientMessage::RenderToScreen {
                screen_index,
                rect,
                transform,
            } => match renderer.render_to_screen(screen_index, rect, transform) {
                Ok(()) => {
                    self.invalidate();
                    ServerResponse::RenderedToScreen { screen_index }
                }
                Err(e) => ServerResponse::Error {
                    message: e.to_string(),
                },
            },
            ClientMessage::GetScreens => {
                let screens = renderer.get_screens();
                ServerResponse::Screens { screens }
            }
            ClientMessage::SetScreenMode {
                screen_index,
                width,
                height,
                refresh_rate,
            } => match renderer.set_screen_mode(
                screen_index,
                crate::protocol::ModeInfo {
                    width,
                    height,
                    refresh_rate,
                },
            ) {
                Ok(screen) => {
                    self.invalidate();
                    ServerResponse::ScreenMode {
                        screen_index,
                        width: screen.width,
                        height: screen.height,
                        refresh_rate: screen.refresh_rate,
                    }
                }
                Err(e) => ServerResponse::Error {
                    message: e.to_string(),
                },
            },
            ClientMessage::SetInputEnabled { enabled } => {
                renderer.set_input_enabled(enabled);
                ServerResponse::InputState { enabled }
            }
            ClientMessage::SetScreenPower { on, screen_index } => {
                match renderer.set_screen_power(screen_index, on) {
                    Ok(screens) => {
                        // 有些后端（winit）不接受；有实际变化时请求下一帧上屏
                        if !screens.is_empty() {
                            self.invalidate();
                        }
                        ServerResponse::ScreenPower { on, screens }
                    }
                    Err(e) => ServerResponse::Error {
                        message: e.to_string(),
                    },
                }
            }
            // 认证由连接线程处理，不会走到这里
            ClientMessage::Auth { .. } => return None,
            // 心跳回包没有响应
            ClientMessage::Pong => return None,
        };

        Some(response)
    }
}
