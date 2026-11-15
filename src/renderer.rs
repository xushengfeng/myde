use crate::protocol::{ModeInfo, Rect, ScreenInfo, Transform};
use tracing::info;

pub struct Renderer {
    /// SetWindowSize 声明的虚拟画布尺寸（可突破物理屏幕）
    canvas_size: Option<(u32, u32)>,
    captured_rects: Vec<Rect>,
    transforms: Vec<Transform>,
    screens: Vec<ScreenInfo>,
    input_enabled: bool,
    /// 每个屏幕的电源状态（true = 开）。只在 DRM 后端真正生效
    screen_power: Vec<bool>,
    /// 后端是否支持屏幕电源控制（winit 为 false）
    screen_power_supported: bool,
    screen_configs: Vec<ScreenConfig>,
    /// 屏幕配置代数：任何影响上屏结果的配置变更都会递增。
    /// 渲染线程据此判断"仅配置变了"（只需重做上屏那一遍，离屏画布可复用）
    config_generation: u64,
    /// 等待渲染线程应用到后端的屏幕模式（每屏一个）
    pending_modes: Vec<Option<ModeInfo>>,
}

#[derive(Clone, Debug)]
pub struct ScreenConfig {
    pub screen_index: usize,
    /// 截取区域（内容坐标）；None = 应用内容范围（拉伸铺满）
    pub rect: Option<Rect>,
    /// 截取变换；None = 不旋转
    pub transform: Option<Transform>,
}

impl Renderer {
    /// `screens` 应传入渲染后端的真实输出信息；
    /// `screen_power_supported` 由后端决定（DRM 为 true，winit 为 false）
    pub fn new(screens: Vec<ScreenInfo>, screen_power_supported: bool) -> Self {
        info!("screens: {:?}", screens);
        if screens.is_empty() {
            info!("no output detected, using auto canvas");
        }
        let screen_count = screens.len();

        Self {
            canvas_size: None,
            captured_rects: Vec::new(),
            transforms: vec![Transform { rotation: 0.0 }],
            screen_power: vec![true; screen_count],
            screen_power_supported,
            screens,
            input_enabled: true,
            screen_configs: Vec::new(),
            config_generation: 0,
            pending_modes: vec![None; screen_count],
        }
    }

    /// 屏幕配置代数（渲染线程读取，用于判断配置是否变化）
    pub fn config_generation(&self) -> u64 {
        self.config_generation
    }

    /// SetWindowSize：声明虚拟画布尺寸（不强制修改应用窗口大小，
    /// 应用窗口由应用自行控制）。实际画布 = max(声明尺寸, 应用窗口尺寸)，
    /// 保证虚拟画布不裁切应用。
    pub fn set_window_size(&mut self, width: u32, height: u32) {
        self.canvas_size = Some((width, height));
        self.config_generation = self.config_generation.wrapping_add(1);
    }

    /// 获取 SetWindowSize 声明的虚拟画布尺寸（None 表示未声明，自动跟随应用窗口）
    pub fn get_canvas_size(&self) -> Option<(u32, u32)> {
        self.canvas_size
    }

    pub fn capture_rects(&mut self, rects: Vec<Rect>) -> Vec<Rect> {
        self.captured_rects = rects.clone();
        self.config_generation = self.config_generation.wrapping_add(1);
        rects
    }

    pub fn transform_rects(&mut self, transforms: Vec<Transform>) {
        self.transforms = transforms;
        self.config_generation = self.config_generation.wrapping_add(1);
    }

    /// 将画布截取区域渲染到屏幕（一个屏幕一个截取区域）
    ///
    /// `rect` 缺省 = 应用内容范围（拉伸铺满）；`transform` 缺省 = 不旋转
    pub fn render_to_screen(
        &mut self,
        screen_index: usize,
        rect: Option<Rect>,
        transform: Option<Transform>,
    ) -> anyhow::Result<()> {
        if screen_index >= self.screens.len() {
            return Err(anyhow::anyhow!("Invalid screen index: {}", screen_index));
        }

        // 保存屏幕配置
        let config = ScreenConfig {
            screen_index,
            rect: rect.clone(),
            transform: transform.clone(),
        };

        // 更新或添加屏幕配置
        if let Some(existing) = self
            .screen_configs
            .iter_mut()
            .find(|c| c.screen_index == screen_index)
        {
            *existing = config;
        } else {
            self.screen_configs.push(config);
        }

        self.captured_rects = rect.into_iter().collect();
        self.transforms = transform.into_iter().collect();
        self.config_generation = self.config_generation.wrapping_add(1);
        Ok(())
    }

    pub fn get_screens(&self) -> Vec<ScreenInfo> {
        self.screens.clone()
    }

    /// 请求切换屏幕模式。
    ///
    /// 只接受该屏幕 `modes` 里的模式（旧后端没给列表时只允许当前模式），
    /// 校验通过后立即更新快照，等渲染线程调用 [`Self::take_pending_modes`] 应用到后端。
    pub fn set_screen_mode(
        &mut self,
        screen_index: usize,
        mode: ModeInfo,
    ) -> anyhow::Result<ScreenInfo> {
        let screen = self
            .screens
            .get_mut(screen_index)
            .ok_or_else(|| anyhow::anyhow!("Invalid screen index: {}", screen_index))?;
        let supported = if screen.modes.is_empty() {
            screen.width == mode.width
                && screen.height == mode.height
                && screen.refresh_rate == mode.refresh_rate
        } else {
            screen.modes.contains(&mode)
        };
        if !supported {
            return Err(anyhow::anyhow!(
                "屏幕 {} 不支持模式 {}x{}@{}Hz",
                screen_index,
                mode.width,
                mode.height,
                mode.refresh_rate
            ));
        }

        screen.width = mode.width;
        screen.height = mode.height;
        screen.refresh_rate = mode.refresh_rate;
        let screen = screen.clone();

        if let Some(slot) = self.pending_modes.get_mut(screen_index) {
            *slot = Some(mode);
        }
        self.config_generation = self.config_generation.wrapping_add(1);
        Ok(screen)
    }

    /// 取出待应用的屏幕模式（渲染线程在下一帧渲染前调用）
    pub fn take_pending_modes(&mut self) -> Vec<(usize, ModeInfo)> {
        let mut modes = Vec::new();
        for (index, slot) in self.pending_modes.iter_mut().enumerate() {
            if let Some(mode) = slot.take() {
                modes.push((index, mode));
            }
        }
        modes
    }

    /// 后端实际生效后同步快照（模式切换失败时也用它回滚）
    pub fn apply_screen_info(&mut self, screen_index: usize, screen: ScreenInfo) {
        if screen_index < self.screens.len() {
            self.screens[screen_index] = screen;
        }
    }

    pub fn set_input_enabled(&mut self, enabled: bool) {
        self.input_enabled = enabled;
    }

    /// 设置屏幕电源，返回实际接受的屏幕下标。
    /// winit 后端不支持，返回空数组且不改变状态。
    pub fn set_screen_power(
        &mut self,
        screen_index: Option<usize>,
        on: bool,
    ) -> anyhow::Result<Vec<usize>> {
        if !self.screen_power_supported {
            return Ok(Vec::new());
        }
        let targets = match screen_index {
            Some(index) if index < self.screens.len() => vec![index],
            Some(index) => return Err(anyhow::anyhow!("Invalid screen index: {}", index)),
            None => (0..self.screens.len()).collect(),
        };
        for &index in &targets {
            self.screen_power[index] = on;
        }
        Ok(targets)
    }

    pub fn screen_power(&self) -> &[bool] {
        &self.screen_power
    }

    #[allow(dead_code)]
    pub fn is_input_enabled(&self) -> bool {
        self.input_enabled
    }

    #[allow(dead_code)]
    pub fn get_captured_rects(&self) -> &[Rect] {
        &self.captured_rects
    }

    #[allow(dead_code)]
    pub fn get_transforms(&self) -> &[Transform] {
        &self.transforms
    }

    pub fn get_screen_configs(&self) -> &[ScreenConfig] {
        &self.screen_configs
    }

    // 获取默认的全屏配置：rect 缺省 = 应用内容范围，拉伸铺满屏幕；不旋转
    pub fn get_default_fullscreen_config(&self, screen_index: usize) -> ScreenConfig {
        ScreenConfig {
            screen_index,
            rect: None,
            transform: None,
        }
    }

    // 计算变换后的矩形（为了兼容旧接口，这里直接返回原矩形，因为拉伸由渲染器在渲染时负责）
}
