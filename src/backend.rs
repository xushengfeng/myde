use crate::protocol::ScreenInfo;
use crate::renderer::ScreenConfig;
use crate::wayland::App;
use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::reexports::calloop::EventLoop;

pub trait RenderBackend: Send {
    fn name(&self) -> &str;

    /// 返回真实输出屏幕信息（供 GetScreens 使用）
    fn get_screens(&self) -> Vec<ScreenInfo>;
    fn init(
        &mut self,
        event_loop: &mut EventLoop<App>,
        state: &mut App,
    ) -> Result<(), Box<dyn std::error::Error>>;

    /// 退出前清理后端资源。DRM 后端的顺序很关键：
    /// 先释放 surface（其 Drop 会关掉我们设置的 CRTC），再把启动前的显示状态恢复回来。
    fn shutdown(&mut self) {}

    /// 处理后端事件（DRM：消费 vblank 并完成帧提交、归还 swapchain 槽位）。
    ///
    /// 返回本次是否有帧完成上屏——渲染线程据此在正确的时机给客户端发 frame 回调。
    fn dispatch(&mut self) -> bool {
        false
    }

    fn get_output_count(&self) -> usize;

    /// 把客户端 dmabuf 导入渲染器。默认返回 true，表示接受该 buffer：
    /// winit 后端的渲染器在事件循环闭包里，无法在这里访问，渲染时会惰性导入。
    fn import_dmabuf(&mut self, _dmabuf: &Dmabuf) -> bool {
        true
    }

    /// 是否还有帧在等 vblank（帧在飞）。
    ///
    /// 有帧在飞时不应再渲染：既浪费，又会把 vblank 门控打乱造成掉帧。
    fn has_frame_in_flight(&self) -> bool {
        false
    }

    /// 帧真正扫描上屏之后给客户端发 frame 回调，让客户端按实际呈现节奏提交。
    ///
    /// 没有帧在飞时（画面无变化）也由渲染循环调用，避免客户端等不到回调而饿死。
    fn send_frame_callbacks(&self, _state: &mut App) {}

    /// Render the Wayland space contents to the screen.
    ///
    /// `canvas_size` 为 SetWindowSize 声明的虚拟画布尺寸（可为 None）。
    /// 实际画布 = max(声明尺寸, 应用窗口尺寸)；配置中 rects 留空（或无配置）时，
    /// 默认把整个画布拉伸铺满目标屏幕。
    ///
    /// `config_generation` 为屏幕配置代数（见 [`crate::renderer::Renderer::config_generation`]），
    /// 用于区分"内容变了"与"仅配置变了"，从而跳过无谓的离屏重绘。
    ///
    /// `screen_power` 为每个输出是否开机（true = 开）；长度不足时按开处理。
    fn render_space(
        &mut self,
        _state: &mut App,
        _configs: &[ScreenConfig],
        _canvas_size: Option<(u32, u32)>,
        _config_generation: u64,
        _screen_power: &[bool],
    ) {
        // Default implementation does nothing
    }
}
