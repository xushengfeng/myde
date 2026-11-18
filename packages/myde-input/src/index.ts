/**
 * myde-input - 高性能 Linux 输入设备读取库
 */

export { InputManager } from "./manager.ts";
export { InputDevice } from "./device.ts";
export type {
  DeviceType,
  AxisInfo,
  TouchInfo,
  DeviceCapabilities,
  DeviceError,
  DeviceInfo,
  InputEvent,
  InputManagerEvents,
  InputDeviceEvents,
  DeviceAccess,
  InputManagerOptions,
} from "./types.ts";
export type { Result, AppError } from "./result.ts";
export { ErrorCode, ok, okVoid, err } from "./result.ts";
