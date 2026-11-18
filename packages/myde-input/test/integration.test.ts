import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { platform } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RustMessage } from "../src/protocol.ts";
import { RustBridge } from "../src/subprocess.ts";

const isLinux = platform() === "linux";

describe.skipIf(!isLinux)("Integration (Non-privileged)", () => {
  let bridge: RustBridge;
  const fifoPath = path.join("/tmp", `test_input_fifo_${Date.now()}_${process.pid}`);

  beforeEach(() => {
    bridge = new RustBridge();
    try {
      fs.unlinkSync(fifoPath);
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    if (bridge?.isRunning()) {
      bridge.destroy();
    }
    try {
      fs.unlinkSync(fifoPath);
    } catch {
      // ignore
    }
  });

  it("should spawn Rust process and receive initial device_list", async () => {
    const received: RustMessage[] = [];

    await new Promise<void>((resolve, reject) => {
      bridge.onMessage((msg) => {
        received.push(msg);
        if (msg.type === "device_list") {
          resolve();
        }
      });

      const res = bridge.spawn();
      if (!res.ok) {
        reject(new Error(res.error.message));
      }
    });

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].type).toBe("device_list");
  });

  it("should handle error messages correctly without MessagePack decode errors", async () => {
    let errorReceived: RustMessage | null = null;

    await new Promise<void>((resolve, reject) => {
      bridge.onMessage((msg) => {
        if (msg.type === "device_list") {
          // 尝试监听一个不存在的路径，触发 Rust 端返回 Error (START_READING_FAILED)
          bridge.send({
            type: "start_reading",
            paths: ["/nonexistent_device_test_12345"],
          });
        } else if (msg.type === "error") {
          errorReceived = msg;
          resolve();
        }
      });

      const res = bridge.spawn();
      if (!res.ok) {
        reject(new Error(res.error.message));
      }
    });

    expect(errorReceived).not.toBeNull();
    expect(errorReceived?.type).toBe("error");
    if (errorReceived && errorReceived.type === "error") {
      expect(errorReceived.code).toBe("START_READING_FAILED");
      expect(errorReceived.message).toContain("/nonexistent_device_test_12345");
    }
  });

  it("should read Linux input_events from a FIFO without root/input privileges", async () => {
    // 1. 创建普通用户无权限限制的 FIFO 虚拟设备
    execSync(`mkfifo ${fifoPath}`);

    const receivedEvents: RustMessage[] = [];

    await new Promise<void>((resolve, reject) => {
      bridge.onMessage((msg) => {
        if (msg.type === "device_list") {
          // 开始监听 FIFO 设备
          bridge.send({
            type: "start_reading",
            paths: [fifoPath],
          });
        } else if (msg.type === "ok") {
          // 2. 模拟触控板上报 ABS_MT_POSITION_X 事件（24 字节 Linux input_event）
          // struct input_event { timeval(16B), type(2B), code(2B), value(4B) }
          const buf = Buffer.alloc(24);
          buf.writeBigInt64LE(123456n, 0); // sec
          buf.writeBigInt64LE(654321n, 8); // usec
          buf.writeUInt16LE(3, 16); // type: EV_ABS
          buf.writeUInt16LE(0x35, 18); // code: ABS_MT_POSITION_X (53)
          buf.writeInt32LE(2048, 20); // value: 2048

          const fd = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
          fs.writeSync(fd, buf);
          fs.closeSync(fd);
        } else if (msg.type === "input_event") {
          receivedEvents.push(msg);
          resolve();
        }
      });

      const res = bridge.spawn();
      if (!res.ok) {
        reject(new Error(res.error.message));
      }
    });

    expect(receivedEvents.length).toBe(1);
    const ev = receivedEvents[0];
    if (ev.type === "input_event") {
      expect(ev.path).toBe(fifoPath);
      expect(ev.event_type).toBe(3); // EV_ABS
      expect(ev.code).toBe(0x35); // ABS_MT_POSITION_X
      expect(ev.value).toBe(2048);
      expect(ev.timestamp_sec).toBe(123456);
      expect(ev.timestamp_usec).toBe(654321);
    }
  });

  it("should read batched input_events (simulating touchpad multi-event swipe)", async () => {
    execSync(`mkfifo ${fifoPath}`);

    const receivedEvents: RustMessage[] = [];

    await new Promise<void>((resolve, reject) => {
      bridge.onMessage((msg) => {
        if (msg.type === "device_list") {
          bridge.send({
            type: "start_reading",
            paths: [fifoPath],
          });
        } else if (msg.type === "ok") {
          // 模拟触控板连续上报 3 个事件：ABS_MT_POSITION_X, ABS_MT_POSITION_Y, SYN_REPORT
          const totalBytes = 24 * 3;
          const buf = Buffer.alloc(totalBytes);

          // Event 1: ABS_MT_POSITION_X (53)
          buf.writeBigInt64LE(100n, 0);
          buf.writeBigInt64LE(1n, 8);
          buf.writeUInt16LE(3, 16);
          buf.writeUInt16LE(53, 18);
          buf.writeInt32LE(500, 20);

          // Event 2: ABS_MT_POSITION_Y (54)
          buf.writeBigInt64LE(100n, 24);
          buf.writeBigInt64LE(2n, 32);
          buf.writeUInt16LE(3, 40);
          buf.writeUInt16LE(54, 42);
          buf.writeInt32LE(800, 44);

          // Event 3: SYN_REPORT (0, 0, 0)
          buf.writeBigInt64LE(100n, 48);
          buf.writeBigInt64LE(3n, 56);
          buf.writeUInt16LE(0, 64);
          buf.writeUInt16LE(0, 66);
          buf.writeInt32LE(0, 68);

          const fd = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
          fs.writeSync(fd, buf);
          fs.closeSync(fd);
        } else if (msg.type === "input_event") {
          receivedEvents.push(msg);
          if (receivedEvents.length === 3) {
            resolve();
          }
        }
      });

      const res = bridge.spawn();
      if (!res.ok) {
        reject(new Error(res.error.message));
      }
    });

    expect(receivedEvents.length).toBe(3);
    const [e1, e2, e3] = receivedEvents;
    if (e1.type === "input_event" && e2.type === "input_event" && e3.type === "input_event") {
      expect(e1.code).toBe(53);
      expect(e1.value).toBe(500);
      expect(e2.code).toBe(54);
      expect(e2.value).toBe(800);
      expect(e3.event_type).toBe(0);
      expect(e3.code).toBe(0);
    }
  });
});
