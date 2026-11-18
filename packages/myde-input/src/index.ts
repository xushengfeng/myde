/**
 * myde-input - 高性能 Linux 输入设备读取库
 */

export { InputDevice } from "./device.ts";
export { InputManager } from "./manager.ts";
export type { AppError, Result } from "./result.ts";
export { ErrorCode, err, ok, okVoid } from "./result.ts";
export type {
  AxisInfo,
  DeviceAccess,
  DeviceCapabilities,
  DeviceError,
  DeviceInfo,
  DeviceType,
  InputDeviceEvents,
  InputEvent,
  InputManagerEvents,
  InputManagerOptions,
  TouchInfo,
} from "./types.ts";
