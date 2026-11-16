use std::time::Duration;

use smithay::{
    backend::{
        renderer::{
            damage::OutputDamageTracker, element::surface::WaylandSurfaceRenderElement,
            gles::GlesRenderer, ImportDma,
        },
        winit::{self, WinitEvent},
    },
    output::{Mode, Output, PhysicalProperties, Subpixel},
    reexports::calloop::EventLoop,
    utils::{Rectangle, Transform as SmithayTransform},
};

use crate::backend::RenderBackend;
use crate::protocol::{ModeInfo, ScreenInfo};
use crate::wayland::App;

pub struct WinitBackend {
    width: u32,
    height: u32,
    output: Option<Output>,
}

impl WinitBackend {
    pub fn new() -> Self {
        Self {
            width: 800,
            height: 600,
            output: None,
        }
    }
}

impl RenderBackend for WinitBackend {
    fn name(&self) -> &str {
        "winit"
    }

    fn init(
        &mut self,
        event_loop: &mut EventLoop<App>,
        state: &mut App,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (mut backend, winit) = winit::init::<GlesRenderer>()?;

        // 从 winit 渲染器拿真实支持的 dmabuf 格式，注册 v3 全局。
        // 这里不导入 buffer（渲染器在事件循环闭包里），渲染时惰性导入。
        let dmabuf_formats: Vec<smithay::backend::allocator::Format> = backend
            .renderer()
            .dmabuf_formats()
            .iter()
            .copied()
            .collect();
        state.setup_dmabuf(dmabuf_formats);

        let mode = Mode {
            size: backend.window_size(),
            refresh: 60_000,
        };

        self.width = mode.size.w as u32;
        self.height = mode.size.h as u32;

        let output = Output::new(
            "winit".to_string(),
            PhysicalProperties {
                size: (0, 0).into(),
                subpixel: Subpixel::Unknown,
                make: "Smithay".into(),
                model: "Winit".into(),
            },
        );
        let _global = output.create_global::<App>(&state.display_handle);

        output.change_current_state(
            Some(mode),
            Some(SmithayTransform::Flipped180),
            None,
            Some((0, 0).into()),
        );
        output.set_preferred(mode);

        state.space.map_output(&output, (0, 0));

        self.output = Some(output.clone());

        let mut damage_tracker = OutputDamageTracker::from_output(&output);

        event_loop
            .handle()
            .insert_source(winit, move |event, _, state| {
                match event {
                    WinitEvent::Resized { size, .. } => {
                        output.change_current_state(
                            Some(Mode {
                                size,
                                refresh: 60_000,
                            }),
                            None,
                            None,
                            None,
                        );
                    }
                    WinitEvent::Input(event) => state.process_input_event(event),
                    WinitEvent::Redraw => {
                        let size = backend.window_size();
                        let damage = Rectangle::from_size(size);

                        {
                            let (renderer, mut framebuffer) = backend.bind().unwrap();
                            smithay::desktop::space::render_output::<
                                _,
                                WaylandSurfaceRenderElement<GlesRenderer>,
                                _,
                                _,
                            >(
                                &output,
                                renderer,
                                &mut framebuffer,
                                1.0,
                                0,
                                [&state.space],
                                &[],
                                &mut damage_tracker,
                                [0.1, 0.1, 0.1, 1.0],
                            )
                            .unwrap();
                        }

                        backend.submit(Some(&[damage])).unwrap();

                        let time = crate::wayland::monotonic_now();
                        let refresh = output.current_mode().map(|mode| {
                            Duration::from_secs_f64(1_000.0 / f64::from(mode.refresh).max(1.0))
                        });
                        state.space.elements().for_each(|window| {
                            window.send_frame(&output, time, Some(Duration::ZERO), |_, _| {
                                Some(output.clone())
                            })
                        });
                        state.send_presentation_feedbacks(
                            &output,
                            crate::wayland::monotonic_now(),
                            refresh,
                        );

                        state.space.refresh();
                        state.popups.cleanup();

                        let _ = state.display_handle.flush_clients();

                        // Ask for redraw to schedule new frame.
                        backend.window().request_redraw();
                    }
                    WinitEvent::CloseRequested => {
                        state.loop_signal.stop();
                    }
                    _ => (),
                };
            })?;

        Ok(())
    }

    fn dispatch(&mut self) -> bool {
        false
    }

    fn get_screens(&self) -> Vec<ScreenInfo> {
        let (width, height, refresh_rate) =
            match self.output.as_ref().and_then(|o| o.current_mode()) {
                Some(mode) => (
                    mode.size.w.max(0) as u32,
                    mode.size.h.max(0) as u32,
                    (mode.refresh / 1000).max(0) as u32,
                ),
                None => (self.width, self.height, 60),
            };
        vec![ScreenInfo {
            name: "winit".to_string(),
            width,
            height,
            refresh_rate,
            modes: vec![ModeInfo {
                width,
                height,
                refresh_rate,
            }],
        }]
    }

    fn get_output_count(&self) -> usize {
        if self.output.is_some() {
            1
        } else {
            0
        }
    }

    fn render_space(
        &mut self,
        _state: &mut App,
        _configs: &[crate::renderer::ScreenConfig],
        _canvas_size: Option<(u32, u32)>,
        _config_generation: u64,
        _screen_power: &[bool],
    ) {
        // Winit backend handles rendering through its own event loop (WinitEvent::Redraw)
        // so this is a no-op here. 屏幕电源也不支持：物理屏幕属于宿主桌面。
    }
}
