/**
 * InputDevice - 单个输入设备封装
 */

import { EventEmitter } from "node:events";
import type { Result } from "./result.ts";
import { ErrorCode, err, okVoid } from "./result.ts";
import type { DeviceInfo, InputDeviceEvents, InputEvent } from "./types.ts";

/** Linux 事件类型常量 */
const EV_KEY = 1;
const EV_REL = 2;
const EV_ABS = 3;
const EV_SYN = 0;

/** 输入设备 */
export class InputDevice extends EventEmitter {
  readonly info: DeviceInfo;
  private sendCommand: (cmd: import("./protocol.ts").TsCommand) => Result<void>;
  private reading = false;

  constructor(
    info: DeviceInfo,
    sendCommand: (cmd: import("./protocol.ts").TsCommand) => Result<void>,
  ) {
    super();
    this.info = info;
    this.sendCommand = sendCommand;
  }

  /**
   * 开始读取此设备的事件
   */
  startReading(): Result<void> {
    if (this.reading) {
      return okVoid();
    }

    const result = this.sendCommand({
      type: "start_reading",
      paths: [this.info.path],
    });

    if (result.ok) {
      this.reading = true;
    }

    return result;
  }

  /**
   * 停止读取
   */
  stopReading(): Result<void> {
    if (!this.reading) {
      return okVoid();
    }

    const result = this.sendCommand({
      type: "stop_reading",
      paths: [this.info.path],
    });

    if (result.ok) {
      this.reading = false;
    }

    return result;
  }

  /**
   * 处理从 Rust 收到的原始事件
   */
  handleRawEvent(event: InputEvent) {
    // 分发原始事件
    this.emit("raw", event);

    // 根据事件类型分发
    switch (event.type) {
      case EV_KEY:
        this.emit("key", event.code, event.value, event.timestamp);
        if (event.value === 1) {
          this.emit("keyDown", event.code);
        } else if (event.value === 0) {
          this.emit("keyUp", event.code);
        } else if (event.value === 2) {
          this.emit("keyRepeat", event.code);
        }
        break;

      case EV_REL:
        this.emit("relative", event.code, event.value);
        break;

      case EV_ABS:
        this.emit("absolute", event.code, event.value);
        break;

      case EV_SYN:
        this.emit("sync");
        break;
    }
  }

  /**
   * 是否正在读取
   */
  isReading(): boolean {
    return this.reading;
  }

  /**
   * 销毁设备
   */
  destroy() {
    if (this.reading) {
      this.stopReading();
    }
    this.removeAllListeners();
  }

  // 类型安全的事件监听
  on<K extends keyof InputDeviceEvents>(event: K, handler: InputDeviceEvents[K]): this {
    return super.on(event, handler);
  }

  emit<K extends keyof InputDeviceEvents>(
    event: K,
    ...args: Parameters<InputDeviceEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
