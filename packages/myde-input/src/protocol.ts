/**
 * 协议层 - 与 Rust 子进程的消息定义
 */

import type {
  AxisInfo,
  DeviceCapabilities,
  DeviceError,
  DeviceInfo,
  DeviceType,
  TouchInfo,
} from "./types.ts";

/** Rust -> TypeScript 消息 */
export type RustMessage =
  | {
      type: "device_list";
      devices: RustDeviceInfo[];
      /** 实际使用的设备打开方式 */
      access_mode: "logind" | "direct" | "none";
      /** 回退到 direct 时 logind 不可用的原因 */
      access_error?: string;
    }
  | { type: "device_added"; device: RustDeviceInfo }
  | { type: "device_removed"; path: string }
  | {
      type: "input_event";
      path: string;
      event_type: number;
      code: number;
      value: number;
      timestamp_sec: number;
      timestamp_usec: number;
    }
  | { type: "error"; code: string; message: string; detail?: string }
  | { type: "ok" };

/** Rust 发送的设备信息格式 */
export interface RustDeviceInfo {
  path: string;
  name: string;
  device_type: string;
  phys?: string;
  vendor: number;
  product: number;
  version: number;
  capabilities: {
    event_types: number[];
    key_codes: number[];
    rel_axes: number[];
    abs_axes: number[];
    max_touch_slots?: number;
    has_keyboard: boolean;
    has_mouse: boolean;
    has_touchpad: boolean;
    has_touchscreen: boolean;
  };
  touch_info?: {
    position_x: { min: number; max: number; fuzz: number; flat: number; resolution: number };
    position_y: { min: number; max: number; fuzz: number; flat: number; resolution: number };
    pressure?: { min: number; max: number; fuzz: number; flat: number; resolution: number };
    touch_major?: { min: number; max: number; fuzz: number; flat: number; resolution: number };
    touch_minor?: { min: number; max: number; fuzz: number; flat: number; resolution: number };
    width_major?: { min: number; max: number; fuzz: number; flat: number; resolution: number };
    width_minor?: { min: number; max: number; fuzz: number; flat: number; resolution: number };
    orientation?: { min: number; max: number; fuzz: number; flat: number; resolution: number };
    tracking_id?: { min: number; max: number; fuzz: number; flat: number; resolution: number };
    slot?: { min: number; max: number; fuzz: number; flat: number; resolution: number };
    mt_protocol?: string;
  };
  abs_info?: Record<
    string,
    { min: number; max: number; fuzz: number; flat: number; resolution: number }
  >;
  /** 这个设备的打开方式："logind" / "direct" */
  access?: string;
  errors: { field: string; message: string }[];
}

/** TypeScript -> Rust 命令 */
export type TsCommand =
  | { type: "list_devices" }
  | { type: "start_reading"; paths: string[] }
  | { type: "stop_reading"; paths: string[] }
  | { type: "exit" };

/** 将 Rust 设备信息转换为 TypeScript 设备信息 */
export function convertDeviceInfo(rust: RustDeviceInfo): DeviceInfo {
  return {
    path: rust.path,
    name: rust.name,
    type: rust.device_type as DeviceType,
    phys: rust.phys,
    vendor: rust.vendor,
    product: rust.product,
    version: rust.version,
    capabilities: convertCapabilities(rust.capabilities),
    touchInfo: rust.touch_info ? convertTouchInfo(rust.touch_info) : undefined,
    absInfo: convertAbsInfo(rust.abs_info),
    access: rust.access === "logind" || rust.access === "direct" ? rust.access : undefined,
    errors: rust.errors,
  };
}

function convertAbsInfo(absInfo: RustDeviceInfo["abs_info"]): Partial<Record<number, AxisInfo>> {
  const result: Partial<Record<number, AxisInfo>> = {};
  for (const [code, axis] of Object.entries(absInfo ?? {})) {
    result[Number(code)] = {
      min: axis.min,
      max: axis.max,
      fuzz: axis.fuzz,
      flat: axis.flat,
      resolution: axis.resolution,
    };
  }
  return result;
}

function convertCapabilities(caps: RustDeviceInfo["capabilities"]): DeviceCapabilities {
  return {
    eventTypes: caps.event_types,
    keyCodes: caps.key_codes,
    relAxes: caps.rel_axes,
    absAxes: caps.abs_axes,
    maxTouchSlots: caps.max_touch_slots,
    hasKeyboard: caps.has_keyboard,
    hasMouse: caps.has_mouse,
    hasTouchpad: caps.has_touchpad,
    hasTouchscreen: caps.has_touchscreen,
  };
}

function convertTouchInfo(info: NonNullable<RustDeviceInfo["touch_info"]>): TouchInfo {
  const convertAxis = (axis: {
    min: number;
    max: number;
    fuzz: number;
    flat: number;
    resolution: number;
  }) => ({
    min: axis.min,
    max: axis.max,
    fuzz: axis.fuzz,
    flat: axis.flat,
    resolution: axis.resolution,
  });

  return {
    positionX: convertAxis(info.position_x),
    positionY: convertAxis(info.position_y),
    pressure: info.pressure ? convertAxis(info.pressure) : undefined,
    touchMajor: info.touch_major ? convertAxis(info.touch_major) : undefined,
    touchMinor: info.touch_minor ? convertAxis(info.touch_minor) : undefined,
    widthMajor: info.width_major ? convertAxis(info.width_major) : undefined,
    widthMinor: info.width_minor ? convertAxis(info.width_minor) : undefined,
    orientation: info.orientation ? convertAxis(info.orientation) : undefined,
    trackingId: info.tracking_id ? convertAxis(info.tracking_id) : undefined,
    slot: info.slot ? convertAxis(info.slot) : undefined,
    mtProtocol: info.mt_protocol === "A" || info.mt_protocol === "B" ? info.mt_protocol : undefined,
  };
}
