use serde::{Deserialize, Serialize};

/// 矩形区域定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rect {
    /// 左上角 x 坐标（相对于窗口左上角）
    pub x: i32,
    /// 左上角 y 坐标（相对于窗口左上角）
    pub y: i32,
    /// 矩形宽度
    pub width: u32,
    /// 矩形高度
    pub height: u32,
}

/// 变换参数定义
///
/// 旋转作用于**截取**阶段：截取区域以 (rect.x, rect.y) 为锚点、绕锚点旋转 rotation 度，
/// 长宽为 rect.width × rect.height；截取结果转正后拉伸填充到目标屏幕
///（隐式缩放：scale = 屏幕尺寸 / 截取长宽），并保持直角。
///
/// 等价于：把画布绕 (rect.x, rect.y) 旋转 -rotation 度后，
/// 截取以锚点为左上角的 rect.width × rect.height 区域，拉伸铺满目标屏幕。
///
/// 示例（rect = {x: 0, y: 0, width: 800, height: 600}）：
///   - rotation=0: 截取 (0, 0, 800, 600)，拉伸铺满屏幕
///   - rotation=15: 区域绕 (0, 0) 偏转 15° 截取（显示内容逆时针偏转），转正后拉伸铺满屏幕
///   - rotation=90: 截取竖条区域，转正后拉伸铺满屏幕
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transform {
    /// 截取区域相对画布的旋转角度（度）
    pub rotation: f64,
}

impl Default for Transform {
    fn default() -> Self {
        Self { rotation: 0.0 }
    }
}

/// 屏幕模式（分辨率 + 刷新率）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModeInfo {
    /// 模式宽度（像素）
    pub width: u32,
    /// 模式高度（像素）
    pub height: u32,
    /// 刷新率（Hz）
    pub refresh_rate: u32,
}

/// 屏幕信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenInfo {
    /// 屏幕名称（如 "Screen-0"、"eDP-1"、"HDMI-1"）
    pub name: String,
    /// 当前屏幕宽度（像素）
    pub width: u32,
    /// 当前屏幕高度（像素）
    pub height: u32,
    /// 当前刷新率（Hz）
    pub refresh_rate: u32,
    /// 该屏幕支持的全部模式；后端不提供时为当前模式
    #[serde(default)]
    pub modes: Vec<ModeInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    SetWindowSize {
        width: u32,
        height: u32,
    },
    CaptureRects {
        rects: Vec<Rect>,
    },
    TransformRects {
        transforms: Vec<Transform>,
    },
    /// 将画布截取区域渲染到屏幕（一个屏幕一个截取区域）
    ///
    /// - `rect` 为截取区域（内容坐标），以 (x, y) 为锚点旋转 `transform.rotation`
    ///   度截取，转正后拉伸填充到 `screen_index` 屏幕
    /// - `rect` 缺省（null 或不传）表示应用内容范围（拉伸铺满）
    /// - `transform` 缺省（null 或不传）表示不旋转
    RenderToScreen {
        screen_index: usize,
        #[serde(default)]
        rect: Option<Rect>,
        #[serde(default)]
        transform: Option<Transform>,
    },
    GetScreens,
    /// 切换屏幕模式（分辨率 + 刷新率）
    ///
    /// 只接受 `GetScreens` 返回的 `modes` 中存在的模式。DRM 后端立即切换，
    /// winit 后端的窗口尺寸由宿主决定，不支持切换。
    SetScreenMode {
        screen_index: usize,
        width: u32,
        height: u32,
        refresh_rate: u32,
    },
    SetInputEnabled {
        enabled: bool,
    },
    /// 设置屏幕电源（DPMS）。`screen_index` 缺省或为 null 表示所有屏幕。
    /// 只在 DRM 后端生效，winit 后端忽略。
    SetScreenPower {
        on: bool,
        #[serde(default)]
        screen_index: Option<usize>,
    },
    /// 回应 wrap 的 Ping：证明页面事件循环仍在运行
    Pong,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerResponse {
    WindowSizeSet {
        width: u32,
        height: u32,
    },
    RectsCaptured {
        rects: Vec<Rect>,
    },
    RectsTransformed,
    RenderedToScreen {
        screen_index: usize,
    },
    Screens {
        screens: Vec<ScreenInfo>,
    },
    /// 屏幕已切换到新模式（字段为实际生效的模式）
    ScreenMode {
        screen_index: usize,
        width: u32,
        height: u32,
        refresh_rate: u32,
    },
    InputState {
        enabled: bool,
    },
    /// `screens` 为实际被接受的屏幕下标；winit 后端返回空数组
    ScreenPower {
        on: bool,
        screens: Vec<usize>,
    },
    /// 页面存活检测：客户端收到后应立即回 Pong
    Ping,
    Error {
        message: String,
    },
}
