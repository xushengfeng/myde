use std::cell::RefCell;
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::os::fd::{AsRawFd, IntoRawFd, OwnedFd, RawFd};
use std::time::{Duration, Instant};

use gbm::AsRaw;
use glow::HasContext;
use khronos_egl as egl;

use crate::{
    DRM_FORMAT_ABGR8888, DRM_FORMAT_ARGB8888, DRM_FORMAT_BGRA8888, DRM_FORMAT_BGRX8888,
    DRM_FORMAT_RGBA8888, DRM_FORMAT_RGBX8888, DRM_FORMAT_XBGR8888, DRM_FORMAT_XRGB8888,
};

const EGL_PLATFORM_GBM_KHR: egl::Enum = 0x31D7;
const EGL_LINUX_DMA_BUF_EXT: egl::Enum = 0x3270;
const EGL_LINUX_DRM_FOURCC_EXT: egl::Attrib = 0x3271;
const EGL_DMA_BUF_PLANE0_FD_EXT: egl::Attrib = 0x3272;
const EGL_DMA_BUF_PLANE0_OFFSET_EXT: egl::Attrib = 0x3273;
const EGL_DMA_BUF_PLANE0_PITCH_EXT: egl::Attrib = 0x3274;
const EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT: egl::Attrib = 0x3443;
const EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT: egl::Attrib = 0x3444;

type EglImageTargetTexture = unsafe extern "C" fn(u32, *const c_void);

const VERTEX_SHADER: &str = r#"#version 100
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    gl_Position = vec4(a_pos, 0.0, 1.0);
    v_uv = a_pos * 0.5 + 0.5;
}"#;

const FRAGMENT_OPAQUE: &str = r#"#version 100
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main() {
    gl_FragColor = vec4(texture2D(u_tex, v_uv).rgb, 1.0);
}"#;

const FRAGMENT_SAME_ALPHA: &str = r#"#version 100
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main() {
    gl_FragColor = texture2D(u_tex, v_uv);
}"#;

const FRAGMENT_OTHER_ALPHA: &str = r#"#version 100
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_alpha;
void main() {
    vec4 color = texture2D(u_tex, v_uv);
    color.a = texture2D(u_alpha, v_uv).r;
    gl_FragColor = color;
}"#;

struct ProgramInfo {
    program: glow::Program,
    u_tex: Option<glow::UniformLocation>,
    u_alpha: Option<glow::UniformLocation>,
}

struct Programs {
    opaque: ProgramInfo,
    same_alpha: ProgramInfo,
    other_alpha: ProgramInfo,
}

#[derive(Clone, Copy)]
enum AlphaMode {
    /// The source has no usable alpha; write 255.
    Opaque,
    /// The source EGL texture already carries alpha.
    Same,
    /// Alpha lives in the first byte; sample it through a second ABGR image.
    Other,
}

#[derive(Clone, Copy)]
struct SourceSpec {
    fourcc: u32,
    shift: u32,
    alpha: AlphaMode,
}

fn source_spec(format: u32) -> Option<SourceSpec> {
    let spec = match format {
        DRM_FORMAT_ARGB8888 => SourceSpec {
            fourcc: DRM_FORMAT_ARGB8888,
            shift: 0,
            alpha: AlphaMode::Same,
        },
        DRM_FORMAT_ABGR8888 => SourceSpec {
            fourcc: DRM_FORMAT_ABGR8888,
            shift: 0,
            alpha: AlphaMode::Same,
        },
        // Memory B G R X. The exact fourcc is importable and X is ignored.
        DRM_FORMAT_XRGB8888 => SourceSpec {
            fourcc: DRM_FORMAT_XRGB8888,
            shift: 0,
            alpha: AlphaMode::Opaque,
        },
        // Memory R G B X.
        DRM_FORMAT_XBGR8888 => SourceSpec {
            fourcc: DRM_FORMAT_XBGR8888,
            shift: 0,
            alpha: AlphaMode::Opaque,
        },
        // X/A B G R: skip the first byte and read it as ARGB, alpha comes from
        // a second ABGR image for A formats.
        DRM_FORMAT_RGBX8888 => SourceSpec {
            fourcc: DRM_FORMAT_ARGB8888,
            shift: 1,
            alpha: AlphaMode::Opaque,
        },
        DRM_FORMAT_RGBA8888 => SourceSpec {
            fourcc: DRM_FORMAT_ARGB8888,
            shift: 1,
            alpha: AlphaMode::Other,
        },
        // X/A R G B: skip the first byte and read it as ABGR.
        DRM_FORMAT_BGRX8888 => SourceSpec {
            fourcc: DRM_FORMAT_ABGR8888,
            shift: 1,
            alpha: AlphaMode::Opaque,
        },
        DRM_FORMAT_BGRA8888 => SourceSpec {
            fourcc: DRM_FORMAT_ABGR8888,
            shift: 1,
            alpha: AlphaMode::Other,
        },
        _ => return None,
    };
    Some(spec)
}

#[derive(Clone, Copy)]
struct ImageDesc {
    width: u32,
    height: u32,
    fourcc: u32,
    fd: RawFd,
    offset: u32,
    stride: u32,
    modifier: u64,
}

pub struct ConvertedTexture {
    pub fd: RawFd,
    pub offset: u32,
    pub stride: u32,
    pub size: u64,
    pub modifier: u64,
    /// Buffer pool slot; release the slot after the consumer is done with the
    /// imported texture so the next frame can reuse the same GBM buffer.
    pub slot: u64,
}

/// The pool is budgeted in bytes, not in frame count: a slot is created only
/// when an in-flight frame needs one, and reuse is free. This makes the memory
/// ceiling independent of window size: 4K frames use ~33MB each, 1080p ~8MB.
const DEFAULT_POOL_BUDGET_BYTES: u64 = 256 * 1024 * 1024;
const MIN_POOL_BUDGET_BYTES: u64 = 16 * 1024 * 1024;
const MAX_POOL_BUDGET_BYTES: u64 = 2048 * 1024 * 1024;
/// 一个 owner（窗口 surface）的槽位只有空闲这么久后，才允许被别的 owner 回收。
/// 没有 presented 回调时，这是避免 A 窗口旧内容出现在 B 窗口里的下限。
const DEFAULT_STEAL_IDLE_MS: u64 = 1000;
/// 大量极小窗口时的槽位数量上限（预算已经限制了总字节数）
const MAX_POOL_SLOTS: usize = 64;

struct PooledBuffer {
    id: u64,
    /// client + surface；同一 owner 内复用是安全的，跨 owner 复用必须等旧内容
    /// 肯定已经离开屏幕，否则 A 窗口会闪出 B 窗口的内容。
    owner: String,
    width: u32,
    height: u32,
    in_use: bool,
    free_since: Option<Instant>,
    buffer: gbm::BufferObject<()>,
}

const GPU_STAGE_COUNT: usize = 9;
const GPU_STAGE_NAMES: [&str; GPU_STAGE_COUNT] = [
    "current",
    "gbm_create",
    "gbm_fd",
    "images",
    "bind",
    "fbo",
    "draw",
    "unbind",
    "recycle",
];
/// Print a per-frame breakdown when one conversion takes at least this long.
const GPU_TRACE_SLOW_MS: f64 = 4.0;

#[derive(Default)]
struct StageStats {
    sum: Duration,
    max: Duration,
}

/// Timing summary. By default it aggregates every 60 frames and prints each
/// frame that takes at least [`GPU_TRACE_SLOW_MS`]. `MYDE_DRM_GPU_TRACE` can
/// override the period (`1` = every frame, `0` = disabled).
struct GpuTrace {
    period: u32,
    frames: u32,
    total_sum: Duration,
    total_max: Duration,
    stages: [StageStats; GPU_STAGE_COUNT],
}

impl GpuTrace {
    fn default_period() -> u32 {
        60
    }

    fn from_env() -> Option<Self> {
        let period = match std::env::var_os("MYDE_DRM_GPU_TRACE") {
            Some(value) => {
                let value = value.to_string_lossy();
                let value = value.trim();
                if value.is_empty() || value == "0" {
                    return None;
                }
                value
                    .parse::<u32>()
                    .ok()
                    .filter(|period| *period > 0)
                    .unwrap_or(1)
            }
            None => Self::default_period(),
        };
        Some(Self::new(period))
    }

    fn new(period: u32) -> Self {
        Self {
            period,
            frames: 0,
            total_sum: Duration::ZERO,
            total_max: Duration::ZERO,
            stages: std::array::from_fn(|_| StageStats::default()),
        }
    }

    fn record(
        &mut self,
        width: u32,
        height: u32,
        total: Duration,
        stages: [Duration; GPU_STAGE_COUNT],
    ) {
        self.frames += 1;
        self.total_sum += total;
        self.total_max = self.total_max.max(total);
        for (index, duration) in stages.into_iter().enumerate() {
            self.stages[index].sum += duration;
            self.stages[index].max = self.stages[index].max.max(duration);
        }

        let total_ms = total.as_secs_f64() * 1000.0;
        if self.period > 1 && total_ms >= GPU_TRACE_SLOW_MS {
            eprintln!(
                "myde-drm gpu slow frame {width}x{height} total={total_ms:.3}ms {}",
                format_stages(&stages)
            );
        }

        if self.frames < self.period {
            return;
        }
        let frames = self.frames as f64;
        let total_avg = self.total_sum.as_secs_f64() * 1000.0 / frames;
        let total_max = self.total_max.as_secs_f64() * 1000.0;
        let mut text = String::new();
        for (index, stats) in self.stages.iter().enumerate() {
            let avg = stats.sum.as_secs_f64() * 1000.0 / frames;
            let max = stats.max.as_secs_f64() * 1000.0;
            text.push_str(&format!(" {} {avg:.3}/{max:.3}", GPU_STAGE_NAMES[index]));
        }
        eprintln!(
            "myde-drm gpu trace {width}x{height} x{}: total avg={total_avg:.3} max={total_max:.3} |{text} (avg/max ms)",
            self.frames
        );
        self.frames = 0;
        self.total_sum = Duration::ZERO;
        self.total_max = Duration::ZERO;
        for stats in &mut self.stages {
            *stats = StageStats::default();
        }
    }
}

fn format_stages(stages: &[Duration; GPU_STAGE_COUNT]) -> String {
    let mut text = String::new();
    for (index, duration) in stages.iter().enumerate() {
        text.push_str(&format!(
            " {}={:.3}",
            GPU_STAGE_NAMES[index],
            duration.as_secs_f64() * 1000.0
        ));
    }
    text
}

struct StageTimer {
    start: Option<Instant>,
    last: Option<Instant>,
}

impl StageTimer {
    fn new(enabled: bool) -> Self {
        let now = enabled.then(Instant::now);
        Self {
            start: now,
            last: now,
        }
    }

    #[inline]
    fn mark(&mut self) -> Duration {
        match self.last {
            Some(last) => {
                let now = Instant::now();
                self.last = Some(now);
                now.saturating_duration_since(last)
            }
            None => Duration::ZERO,
        }
    }

    fn total(&self) -> Duration {
        self.start.map(|start| start.elapsed()).unwrap_or_default()
    }
}

struct GpuContext {
    egl: egl::DynamicInstance<egl::EGL1_5>,
    display: egl::Display,
    context: egl::Context,
    gl: glow::Context,
    gbm: gbm::Device<File>,
    image_target: EglImageTargetTexture,
    programs: Programs,
    vao: glow::VertexArray,
    _vbo: glow::Buffer,
    fbo: glow::Framebuffer,
    /// Textures are reused across frames; each frame re-binds a fresh EGLImage.
    dst_texture: glow::Texture,
    src_texture: glow::Texture,
    alpha_texture: glow::Texture,
    /// Images from the previous frame. They stay alive until the textures have
    /// been re-bound, so an in-flight frame never loses its EGLImage.
    previous_images: Vec<egl::Image>,
    /// Images from two frames ago. Destroyed only after a full frame has
    /// passed since their textures were re-specified.
    older_images: Vec<egl::Image>,
    /// Whether `alpha_texture` still points at an EGLImage. Cleared by
    /// replacing its storage when a frame has no separate alpha plane.
    alpha_has_image: bool,
    /// `MYDE_DRM_GPU_FINISH=1` waits for the GPU in the converter, for drivers
    /// where implicit dma-buf fences are not reliable.
    wait_for_completion: bool,
    trace: Option<GpuTrace>,
    /// Reused output buffers. Creating a new GBM buffer per frame triggers
    /// high-order allocations and xe's fragmentation reclaim loop; reusing a
    /// small pool keeps memory flat and lets the caller release a copy.
    pool: Vec<PooledBuffer>,
    next_slot: u64,
    /// 输出 buffer 的总内存预算；超过后不再新建，需要时回收空闲槽或回退零拷贝
    pool_budget: u64,
    /// 跨 owner 回收一个空闲槽前，至少要空闲多久
    steal_idle: Duration,
}

impl GpuContext {
    fn new() -> Result<Self, String> {
        let gbm = open_gbm_device()?;
        let egl = unsafe { egl::DynamicInstance::<egl::EGL1_5>::load_required() }
            .map_err(|error| format!("failed to load EGL: {error:?}"))?;
        let display = unsafe {
            egl.get_platform_display(
                EGL_PLATFORM_GBM_KHR,
                gbm.as_raw() as *mut c_void,
                &[egl::ATTRIB_NONE],
            )
        }
        .map_err(|error| format!("eglGetPlatformDisplay failed: {error:?}"))?;

        egl.initialize(display)
            .map_err(|error| format!("eglInitialize failed: {error:?}"))?;
        egl.bind_api(egl::OPENGL_ES_API)
            .map_err(|error| format!("eglBindAPI failed: {error:?}"))?;

        let config = egl
            .choose_first_config(
                display,
                &[
                    egl::RENDERABLE_TYPE,
                    egl::OPENGL_ES2_BIT,
                    egl::RED_SIZE,
                    8,
                    egl::GREEN_SIZE,
                    8,
                    egl::BLUE_SIZE,
                    8,
                    egl::ALPHA_SIZE,
                    8,
                    egl::NONE,
                ],
            )
            .map_err(|error| format!("eglChooseConfig failed: {error:?}"))?
            .ok_or_else(|| "no EGL config for OpenGL ES2".to_string())?;

        let context = egl
            .create_context(
                display,
                config,
                None,
                &[egl::CONTEXT_CLIENT_VERSION, 2, egl::NONE],
            )
            .map_err(|error| format!("eglCreateContext failed: {error:?}"))?;

        egl.make_current(display, None, None, Some(context))
            .map_err(|error| format!("eglMakeCurrent failed: {error:?}"))?;

        let gl = unsafe {
            glow::Context::from_loader_function(|name| {
                egl.get_proc_address(name)
                    .map(|function| function as *const c_void)
                    .unwrap_or(std::ptr::null())
            })
        };

        let address = egl
            .get_proc_address("glEGLImageTargetTexture2DOES")
            .ok_or_else(|| "glEGLImageTargetTexture2DOES is unavailable".to_string())?;
        // SAFETY: the EGL implementation just reported this symbol.
        let image_target: EglImageTargetTexture = unsafe { std::mem::transmute(address) };

        let programs = unsafe {
            let make = |fragment_source: &str| {
                let program = link_program(&gl, fragment_source)?;
                Ok::<ProgramInfo, String>(ProgramInfo {
                    program,
                    u_tex: gl.get_uniform_location(program, "u_tex"),
                    u_alpha: gl.get_uniform_location(program, "u_alpha"),
                })
            };
            Programs {
                opaque: make(FRAGMENT_OPAQUE)?,
                same_alpha: make(FRAGMENT_SAME_ALPHA)?,
                other_alpha: make(FRAGMENT_OTHER_ALPHA)?,
            }
        };

        let (vao, vbo) = unsafe {
            let vao = gl
                .create_vertex_array()
                .map_err(|error| format!("create VAO failed: {error:?}"))?;
            let vbo = gl
                .create_buffer()
                .map_err(|error| format!("create VBO failed: {error:?}"))?;
            let vertices: [f32; 8] = [-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0];
            gl.bind_vertex_array(Some(vao));
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(vbo));
            gl.buffer_data_u8_slice(
                glow::ARRAY_BUFFER,
                std::slice::from_raw_parts(
                    vertices.as_ptr() as *const u8,
                    std::mem::size_of_val(&vertices),
                ),
                glow::STATIC_DRAW,
            );
            gl.enable_vertex_attrib_array(0);
            gl.vertex_attrib_pointer_f32(0, 2, glow::FLOAT, false, 8, 0);
            (vao, vbo)
        };

        let fbo = unsafe {
            gl.create_framebuffer()
                .map_err(|error| format!("create FBO failed: {error:?}"))?
        };

        let (dst_texture, src_texture, alpha_texture) = unsafe {
            (
                create_empty_texture(&gl)?,
                create_empty_texture(&gl)?,
                create_empty_texture(&gl)?,
            )
        };

        eprintln!("myde-drm: GPU path ready ({})", unsafe {
            gl.get_parameter_string(glow::RENDERER)
        });

        Ok(Self {
            egl,
            display,
            context,
            gl,
            gbm,
            image_target,
            programs,
            vao,
            _vbo: vbo,
            fbo,
            dst_texture,
            src_texture,
            alpha_texture,
            previous_images: Vec::new(),
            older_images: Vec::new(),
            alpha_has_image: false,
            wait_for_completion: std::env::var_os("MYDE_DRM_GPU_FINISH")
                .is_some_and(|value| value != "0" && !value.is_empty()),
            trace: GpuTrace::from_env(),
            pool: Vec::new(),
            next_slot: 1,
            pool_budget: std::env::var("MYDE_DRM_POOL_MB")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .map(|mb| mb.saturating_mul(1024 * 1024))
                .unwrap_or(DEFAULT_POOL_BUDGET_BYTES)
                .clamp(MIN_POOL_BUDGET_BYTES, MAX_POOL_BUDGET_BYTES),
            steal_idle: std::env::var("MYDE_DRM_STEAL_IDLE_MS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .map(Duration::from_millis)
                .unwrap_or(Duration::from_millis(DEFAULT_STEAL_IDLE_MS)),
        })
    }

    fn convert(
        &mut self,
        owner: &str,
        width: u32,
        height: u32,
        format: u32,
        fd: RawFd,
        offset: u32,
        stride: u32,
    ) -> Result<Option<ConvertedTexture>, String> {
        let spec =
            source_spec(format).ok_or_else(|| format!("unsupported DRM format 0x{format:08x}"))?;
        if stride < width.saturating_mul(4) {
            return Err(format!("stride {stride} is smaller than width * 4"));
        }
        let mut timer = StageTimer::new(self.trace.is_some());
        let current = self.egl.get_current_context() == Some(self.context)
            && self.egl.get_current_display() == Some(self.display);
        if !current {
            self.egl
                .make_current(self.display, None, None, Some(self.context))
                .map_err(|error| format!("eglMakeCurrent failed: {error:?}"))?;
        }
        let stage_current = timer.mark();

        let Some((slot_id, dst_fd, dst_stride, dst_offset, dst_modifier)) =
            self.acquire_buffer(owner, width, height)?
        else {
            // 池里的 buffer 都还被上一帧的导入占着：回退到零拷贝导入，
            // 不能无限新建（那正是显存按帧上涨的原因）。
            return Ok(None);
        };
        let stage_gbm_create = timer.mark();
        let stage_gbm_fd = timer.mark();

        let mut images: Vec<egl::Image> = Vec::with_capacity(3);
        let mut stage_images = Duration::ZERO;
        let mut stage_bind = Duration::ZERO;
        let mut stage_fbo = Duration::ZERO;
        let mut stage_draw = Duration::ZERO;
        let mut stage_unbind = Duration::ZERO;
        let mut bound = false;
        let mut alpha_has_image = self.alpha_has_image;
        let detach_alpha = !matches!(spec.alpha, AlphaMode::Other) && self.alpha_has_image;
        let outcome: Result<(), String> = (|| {
            let dst_image = self.create_image(ImageDesc {
                width,
                height,
                fourcc: DRM_FORMAT_ARGB8888,
                fd: dst_fd.as_raw_fd(),
                offset: dst_offset,
                stride: dst_stride,
                modifier: dst_modifier,
            })?;
            images.push(dst_image);
            let src_image = self.create_image(ImageDesc {
                width,
                height,
                fourcc: spec.fourcc,
                fd,
                offset: offset
                    .checked_add(spec.shift)
                    .ok_or_else(|| "source offset overflows".to_string())?,
                stride,
                modifier: 0,
            })?;
            images.push(src_image);
            let alpha_image = if matches!(spec.alpha, AlphaMode::Other) {
                let image = self.create_image(ImageDesc {
                    width,
                    height,
                    fourcc: DRM_FORMAT_ABGR8888,
                    fd,
                    offset,
                    stride,
                    modifier: 0,
                })?;
                images.push(image);
                Some(image)
            } else {
                None
            };
            stage_images = timer.mark();

            unsafe {
                self.gl.active_texture(glow::TEXTURE0);
                self.gl
                    .bind_texture(glow::TEXTURE_2D, Some(self.dst_texture));
                (self.image_target)(glow::TEXTURE_2D, dst_image.as_ptr() as *const c_void);
                self.gl
                    .bind_texture(glow::TEXTURE_2D, Some(self.src_texture));
                (self.image_target)(glow::TEXTURE_2D, src_image.as_ptr() as *const c_void);
                if let Some(alpha_image) = alpha_image {
                    self.gl
                        .bind_texture(glow::TEXTURE_2D, Some(self.alpha_texture));
                    (self.image_target)(glow::TEXTURE_2D, alpha_image.as_ptr() as *const c_void);
                    alpha_has_image = true;
                } else if detach_alpha {
                    // Drop the last alpha image reference so it can be
                    // destroyed two frames later.
                    self.gl
                        .bind_texture(glow::TEXTURE_2D, Some(self.alpha_texture));
                    self.gl.tex_image_2d(
                        glow::TEXTURE_2D,
                        0,
                        glow::RGBA as i32,
                        1,
                        1,
                        0,
                        glow::RGBA,
                        glow::UNSIGNED_BYTE,
                        glow::PixelUnpackData::Slice(Some(&[0, 0, 0, 0])),
                    );
                    alpha_has_image = false;
                }
                bound = true;
                stage_bind = timer.mark();

                self.gl.bind_vertex_array(Some(self.vao));
                self.gl.viewport(0, 0, width as i32, height as i32);
                self.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.fbo));
                self.gl.framebuffer_texture_2d(
                    glow::FRAMEBUFFER,
                    glow::COLOR_ATTACHMENT0,
                    glow::TEXTURE_2D,
                    Some(self.dst_texture),
                    0,
                );
                let status = self.gl.check_framebuffer_status(glow::FRAMEBUFFER);
                if status != glow::FRAMEBUFFER_COMPLETE {
                    return Err(format!("incomplete framebuffer: 0x{status:x}"));
                }
                stage_fbo = timer.mark();

                let program = match spec.alpha {
                    AlphaMode::Opaque => &self.programs.opaque,
                    AlphaMode::Same => &self.programs.same_alpha,
                    AlphaMode::Other => &self.programs.other_alpha,
                };
                self.gl.use_program(Some(program.program));
                self.gl.active_texture(glow::TEXTURE0);
                self.gl
                    .bind_texture(glow::TEXTURE_2D, Some(self.src_texture));
                self.gl.uniform_1_i32(program.u_tex.as_ref(), 0);

                if alpha_image.is_some() {
                    self.gl.active_texture(glow::TEXTURE1);
                    self.gl
                        .bind_texture(glow::TEXTURE_2D, Some(self.alpha_texture));
                    self.gl.uniform_1_i32(program.u_alpha.as_ref(), 1);
                }

                self.gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);
                // Submit the draw now. Electron imports the dmabuf right after
                // this returns, and the kernel fence attached on flush carries
                // the dependency; glFinish would only stall the compositor.
                if self.wait_for_completion {
                    self.gl.finish();
                } else {
                    self.gl.flush();
                }
                #[cfg(test)]
                self.gl.finish();
                stage_draw = timer.mark();

                self.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
                self.gl.bind_texture(glow::TEXTURE_2D, None);
                self.gl.use_program(None);
                stage_unbind = timer.mark();
            }
            Ok(())
        })();

        if let Err(error) = outcome {
            if bound {
                self.alpha_has_image = alpha_has_image;
                destroy_images(&self.egl, self.display, &mut self.older_images);
                self.older_images = std::mem::replace(&mut self.previous_images, images);
            } else {
                destroy_images(&self.egl, self.display, &mut images);
            }
            self.release_buffer(slot_id);
            return Err(error);
        }
        self.alpha_has_image = alpha_has_image;

        // The textures now reference `images`; images from two frames ago are
        // no longer referenced by any texture.
        destroy_images(&self.egl, self.display, &mut self.older_images);
        self.older_images = std::mem::replace(&mut self.previous_images, images);
        let stage_recycle = timer.mark();

        let raw_fd = dst_fd.into_raw_fd();

        if let Some(trace) = self.trace.as_mut() {
            trace.record(
                width,
                height,
                timer.total(),
                [
                    stage_current,
                    stage_gbm_create,
                    stage_gbm_fd,
                    stage_images,
                    stage_bind,
                    stage_fbo,
                    stage_draw,
                    stage_unbind,
                    stage_recycle,
                ],
            );
        }

        Ok(Some(ConvertedTexture {
            fd: raw_fd,
            offset: dst_offset,
            stride: dst_stride,
            size: dst_stride as u64 * height as u64,
            modifier: dst_modifier,
            slot: slot_id,
        }))
    }

    fn slot_bytes(slot: &PooledBuffer) -> u64 {
        slot.buffer.stride() as u64 * slot.height as u64
    }

    fn pool_bytes(&self) -> u64 {
        self.pool.iter().map(Self::slot_bytes).sum()
    }

    fn create_slot(
        &mut self,
        owner: &str,
        width: u32,
        height: u32,
    ) -> Result<PooledBuffer, String> {
        let buffer = self
            .gbm
            .create_buffer_object::<()>(
                width,
                height,
                gbm::Format::Argb8888,
                gbm::BufferObjectFlags::LINEAR | gbm::BufferObjectFlags::RENDERING,
            )
            .map_err(|error| format!("gbm_bo_create failed: {error}"))?;
        let id = self.next_slot;
        self.next_slot += 1;
        Ok(PooledBuffer {
            id,
            owner: owner.to_string(),
            width,
            height,
            in_use: true,
            free_since: None,
            buffer,
        })
    }

    /// Take a free pooled buffer for (owner, width, height), creating one while
    /// the byte budget allows. Returns the exported fd plus the buffer's
    /// geometry. `None` means every slot is busy and the caller should fall
    /// back to a zero-copy import instead of allocating more memory.
    fn acquire_buffer(
        &mut self,
        owner: &str,
        width: u32,
        height: u32,
    ) -> Result<Option<(u64, OwnedFd, u32, u32, u64)>, String> {
        // 1. 同一 owner 同尺寸的空闲槽位：直接复用，旧内容也是这个窗口自己的
        if let Some(index) = self.pool.iter().position(|slot| {
            !slot.in_use && slot.owner == owner && slot.width == width && slot.height == height
        }) {
            self.pool[index].in_use = true;
            return self.export_slot(index);
        }

        // 2. 同一 owner 其它尺寸的空闲槽位：换一块尺寸继续用（还是自己的内存）
        if let Some(index) = self
            .pool
            .iter()
            .position(|slot| !slot.in_use && slot.owner == owner)
        {
            let slot = self.create_slot(owner, width, height)?;
            self.pool[index] = slot;
            return self.export_slot(index);
        }

        let needed = width as u64 * 4 * height as u64;

        // 3. 预算/槽位够就新建；空池至少建一块，避免预算比单帧还小时用不了拷贝
        let fits_budget = self.pool_bytes() + needed <= self.pool_budget;
        let has_room = self.pool.len() < MAX_POOL_SLOTS;
        if self.pool.is_empty() || (fits_budget && has_room) {
            let slot = self.create_slot(owner, width, height)?;
            self.pool.push(slot);
            return self.export_slot(self.pool.len() - 1);
        }

        // 4. 预算满了：只能回收别的 owner、且已经空闲足够久的槽位。没有
        // presented 回调，不能更快地复用别人的 buffer，否则会闪出别的窗口内容。
        if let Some(index) = self.pool.iter().position(|slot| {
            if slot.in_use || slot.owner == owner {
                return false;
            }
            slot.free_since
                .is_some_and(|since| since.elapsed() >= self.steal_idle)
        }) {
            let slot = self.create_slot(owner, width, height)?;
            self.pool[index] = slot;
            return self.export_slot(index);
        }

        Ok(None)
    }

    fn export_slot(
        &self,
        index: usize,
    ) -> Result<Option<(u64, OwnedFd, u32, u32, u64)>, String> {
        let slot = &self.pool[index];
        let fd = slot
            .buffer
            .fd()
            .map_err(|error| format!("gbm_bo_get_fd failed: {error}"))?;
        Ok(Some((
            slot.id,
            fd,
            slot.buffer.stride(),
            slot.buffer.offset(0),
            u64::from(slot.buffer.modifier()),
        )))
    }

    fn release_buffer(&mut self, id: u64) {
        if let Some(slot) = self.pool.iter_mut().find(|slot| slot.id == id) {
            slot.in_use = false;
            slot.free_since = Some(Instant::now());
        }
    }

    fn create_image(&self, desc: ImageDesc) -> Result<egl::Image, String> {
        let mut attributes = vec![
            egl::WIDTH as egl::Attrib,
            desc.width as egl::Attrib,
            egl::HEIGHT as egl::Attrib,
            desc.height as egl::Attrib,
            EGL_LINUX_DRM_FOURCC_EXT,
            desc.fourcc as egl::Attrib,
            EGL_DMA_BUF_PLANE0_FD_EXT,
            desc.fd as egl::Attrib,
            EGL_DMA_BUF_PLANE0_OFFSET_EXT,
            desc.offset as egl::Attrib,
            EGL_DMA_BUF_PLANE0_PITCH_EXT,
            desc.stride as egl::Attrib,
        ];
        if desc.modifier != 0 {
            attributes.extend_from_slice(&[
                EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT,
                (desc.modifier & 0xffff_ffff) as egl::Attrib,
                EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT,
                (desc.modifier >> 32) as egl::Attrib,
            ]);
        }
        attributes.push(egl::ATTRIB_NONE);

        unsafe {
            self.egl
                .create_image(
                    self.display,
                    egl::Context::from_ptr(egl::NO_CONTEXT),
                    EGL_LINUX_DMA_BUF_EXT,
                    egl::ClientBuffer::from_ptr(std::ptr::null_mut()),
                    &attributes,
                )
                .map_err(|error| format!("eglCreateImage failed: {error:?}"))
        }
    }
}

unsafe fn create_empty_texture(gl: &glow::Context) -> Result<glow::Texture, String> {
    let texture = gl
        .create_texture()
        .map_err(|error| format!("create texture failed: {error:?}"))?;
    gl.bind_texture(glow::TEXTURE_2D, Some(texture));
    gl.tex_parameter_i32(
        glow::TEXTURE_2D,
        glow::TEXTURE_MIN_FILTER,
        glow::NEAREST as i32,
    );
    gl.tex_parameter_i32(
        glow::TEXTURE_2D,
        glow::TEXTURE_MAG_FILTER,
        glow::NEAREST as i32,
    );
    gl.tex_parameter_i32(
        glow::TEXTURE_2D,
        glow::TEXTURE_WRAP_S,
        glow::CLAMP_TO_EDGE as i32,
    );
    gl.tex_parameter_i32(
        glow::TEXTURE_2D,
        glow::TEXTURE_WRAP_T,
        glow::CLAMP_TO_EDGE as i32,
    );
    Ok(texture)
}

fn destroy_images(
    egl: &egl::DynamicInstance<egl::EGL1_5>,
    display: egl::Display,
    images: &mut Vec<egl::Image>,
) {
    for image in images.drain(..) {
        let _ = egl.destroy_image(display, image);
    }
}

unsafe fn link_program(gl: &glow::Context, fragment_source: &str) -> Result<glow::Program, String> {
    let program = gl
        .create_program()
        .map_err(|error| format!("create program failed: {error:?}"))?;
    let mut shaders = Vec::new();
    for (kind, source) in [
        (glow::VERTEX_SHADER, VERTEX_SHADER),
        (glow::FRAGMENT_SHADER, fragment_source),
    ] {
        let shader = gl
            .create_shader(kind)
            .map_err(|error| format!("create shader failed: {error:?}"))?;
        gl.shader_source(shader, source);
        gl.compile_shader(shader);
        if !gl.get_shader_compile_status(shader) {
            return Err(format!(
                "shader compile failed: {}",
                gl.get_shader_info_log(shader)
            ));
        }
        gl.attach_shader(program, shader);
        shaders.push(shader);
    }
    gl.bind_attrib_location(program, 0, "a_pos");
    gl.link_program(program);
    if !gl.get_program_link_status(program) {
        return Err(format!(
            "program link failed: {}",
            gl.get_program_info_log(program)
        ));
    }
    for shader in shaders {
        gl.detach_shader(program, shader);
        gl.delete_shader(shader);
    }
    Ok(program)
}

fn open_gbm_device() -> Result<gbm::Device<File>, String> {
    let mut candidates = vec!["/dev/dri/renderD128".to_string()];
    if let Ok(entries) = std::fs::read_dir("/dev/dri") {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("renderD") {
                let path = format!("/dev/dri/{name}");
                if path != candidates[0] {
                    candidates.push(path);
                }
            }
        }
    }

    let mut last_error = String::from("no DRM render node found");
    for path in candidates {
        match OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => match gbm::Device::new(file) {
                Ok(device) => return Ok(device),
                Err(error) => last_error = format!("{path}: gbm_create_device failed: {error}"),
            },
            Err(error) => last_error = format!("{path}: {error}"),
        }
    }
    Err(last_error)
}

thread_local! {
    static GPU: RefCell<Option<Result<GpuContext, String>>> = const { RefCell::new(None) };
}

/// Convert a LINEAR 32-bit dmabuf into a new ARGB8888 dmabuf on the GPU.
///
/// Returns `Ok(None)` when the GPU path is unavailable; callers should fall
/// back to the CPU converter.
pub fn convert(
    fd: RawFd,
    offset: u64,
    stride: u32,
    width: u32,
    height: u32,
    format: u32,
    owner: &str,
) -> Result<Option<ConvertedTexture>, String> {
    if source_spec(format).is_none() {
        return Ok(None);
    }
    let offset = match u32::try_from(offset) {
        Ok(offset) => offset,
        Err(_) => return Ok(None),
    };

    GPU.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            let context = GpuContext::new();
            if let Err(error) = &context {
                eprintln!("myde-drm: GPU path unavailable, using CPU: {error}");
            }
            *slot = Some(context);
        }
        match slot.as_mut().expect("initialized above") {
            Ok(context) => context.convert(owner, width, height, format, fd, offset, stride),
            Err(_) => Ok(None),
        }
    })
}

/// Release a pooled output buffer after the consumer is done with the imported
/// texture. Until this is called the slot stays busy and a new conversion will
/// fall back to the caller instead of allocating more GPU memory.
pub fn release(slot: u64) {
    GPU.with(|context| {
        if let Some(Ok(context)) = context.borrow_mut().as_mut() {
            context.release_buffer(slot);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;

    #[test]
    fn converts_rgba_offset_one() {
        let gbm = match open_gbm_device() {
            Ok(gbm) => gbm,
            Err(error) => {
                eprintln!("skip: {error}");
                return;
            }
        };
        let width = 8u32;
        let height = 2u32;
        let mut source = gbm
            .create_buffer_object::<()>(
                width,
                height,
                gbm::Format::Argb8888,
                gbm::BufferObjectFlags::LINEAR | gbm::BufferObjectFlags::RENDERING,
            )
            .unwrap();
        let stride = source.stride();
        source
            .map_mut(0, 0, width, height, |mapped| {
                let bytes = mapped.buffer_mut();
                for y in 0..height as usize {
                    for x in 0..width as usize {
                        let offset = y * stride as usize + x * 4;
                        // RGBA8888 memory: A B G R.
                        bytes[offset] = 128;
                        bytes[offset + 1] = (10 + x) as u8;
                        bytes[offset + 2] = (20 + y) as u8;
                        bytes[offset + 3] = (30 + x + y) as u8;
                    }
                }
            })
            .unwrap();
        let source_fd = source.fd().unwrap();

        let converted = match convert(
            source_fd.as_raw_fd(),
            0,
            stride,
            width,
            height,
            crate::DRM_FORMAT_RGBA8888,
            "test",
        )
        .unwrap()
        {
            Some(converted) => converted,
            None => {
                eprintln!("skip: GPU path unavailable");
                return;
            }
        };

        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                converted.size as usize,
                libc::PROT_READ,
                libc::MAP_SHARED,
                converted.fd,
                0,
            )
        };
        assert_ne!(ptr, libc::MAP_FAILED);
        let data = unsafe { std::slice::from_raw_parts(ptr as *const u8, converted.size as usize) };
        for y in 0..height as usize {
            for x in 0..width as usize {
                let offset = y * converted.stride as usize + x * 4;
                assert_eq!(
                    &data[offset..offset + 4],
                    &[(10 + x) as u8, (20 + y) as u8, (30 + x + y) as u8, 128],
                    "pixel ({x}, {y})"
                );
            }
        }
        unsafe {
            libc::munmap(ptr, converted.size as usize);
            libc::close(converted.fd);
        }
        release(converted.slot);

        // Switching away from a format with a separate alpha plane must detach
        // the cached alpha image without crashing.
        let again = convert(
            source_fd.as_raw_fd(),
            0,
            stride,
            width,
            height,
            crate::DRM_FORMAT_ARGB8888,
            "test",
        )
        .unwrap()
        .unwrap();
        unsafe { libc::close(again.fd) };
        release(again.slot);
    }
}
