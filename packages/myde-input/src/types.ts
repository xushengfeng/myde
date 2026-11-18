/**
 * 类型定义
 */

/** 设备类型 */
export type DeviceType =
  | "keyboard"
  | "mouse"
  | "touchpad"
  | "touchscreen"
  | "tablet"
  | "gamepad"
  | "unknown";

/** 轴信息 */
export interface AxisInfo {
  min: number;
  max: number;
  fuzz: number;
  flat: number;
  resolution: number;
}

/** 触屏物理信息 */
export interface TouchInfo {
  positionX: AxisInfo;
  positionY: AxisInfo;
  pressure?: AxisInfo;
  touchMajor?: AxisInfo;
  touchMinor?: AxisInfo;
  widthMajor?: AxisInfo;
  widthMinor?: AxisInfo;
  orientation?: AxisInfo;
  trackingId?: AxisInfo;
  slot?: AxisInfo;
  mtProtocol?: "A" | "B";
}

/** 设备能力 */
export interface DeviceCapabilities {
  eventTypes: number[];
  keyCodes: number[];
  relAxes: number[];
  absAxes: number[];
  maxTouchSlots?: number;
  hasKeyboard: boolean;
  hasMouse: boolean;
  hasTouchpad: boolean;
  hasTouchscreen: boolean;
}

/** 设备错误 */
export interface DeviceError {
  field: string;
  message: string;
}

/** 设备打开方式 */
export type DeviceAccess = "auto" | "logind" | "direct";

/** InputManager 构造选项 */
export interface InputManagerOptions {
  /**
   * 设备打开方式：
   * - auto（默认）：先通过 systemd-logind 取 fd，失败回退直接打开
   * - logind：必须走 logind（需要在前台会话中运行）
   * - direct：直接打开 /dev/input/event*（需要 input 组 / udev uaccess / root）
   */
  deviceAccess?: DeviceAccess;
}

/** 设备信息 */
export interface DeviceInfo {
  path: string;
  name: string;
  type: DeviceType;
  phys?: string;
  vendor: number;
  product: number;
  version: number;
  capabilities: DeviceCapabilities;
  touchInfo?: TouchInfo;
  /** 所有绝对轴的量程信息，key 为轴码（如 ABS_X=0），只有部分轴存在 */
  absInfo: Partial<Record<number, AxisInfo>>;
  /** 这个设备实际使用的打开方式 */
  access?: "logind" | "direct";
  errors: DeviceError[];
}

/** 输入事件 */
export interface InputEvent {
  devicePath: string;
  type: number;
  code: number;
  value: number;
  timestamp: bigint;
}

/** Manager 事件映射 */
export interface InputManagerEvents {
  deviceAdded: (device: DeviceInfo) => void;
  deviceRemoved: (path: string) => void;
  error: (error: import("./result.ts").AppError) => void;
}

/** Device 事件映射 */
export interface InputDeviceEvents {
  key: (code: number, value: number, timestamp: bigint) => void;
  keyDown: (code: number) => void;
  keyUp: (code: number) => void;
  keyRepeat: (code: number) => void;
  relative: (code: number, value: number) => void;
  absolute: (code: number, value: number) => void;
  sync: () => void;
  raw: (event: InputEvent) => void;
  error: (error: import("./result.ts").AppError) => void;
}
