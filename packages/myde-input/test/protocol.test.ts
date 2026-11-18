import { describe, expect, it } from "vitest";
import { type RustDeviceInfo, convertDeviceInfo } from "../src/protocol.ts";

describe("Protocol", () => {
  describe("convertDeviceInfo", () => {
    it("should convert basic device info", () => {
      const rustDevice: RustDeviceInfo = {
        path: "/dev/input/event0",
        name: "Test Keyboard",
        device_type: "keyboard",
        phys: "usb-0000:00:14.0-1/input0",
        vendor: 0x1234,
        product: 0x5678,
        version: 0x0100,
        capabilities: {
          event_types: [1, 0],
          key_codes: [30, 31, 32],
          rel_axes: [],
          abs_axes: [],
          has_keyboard: true,
          has_mouse: false,
          has_touchpad: false,
          has_touchscreen: false,
        },
        errors: [],
      };

      const result = convertDeviceInfo(rustDevice);

      expect(result.path).toBe("/dev/input/event0");
      expect(result.name).toBe("Test Keyboard");
      expect(result.type).toBe("keyboard");
      expect(result.phys).toBe("usb-0000:00:14.0-1/input0");
      expect(result.vendor).toBe(0x1234);
      expect(result.product).toBe(0x5678);
      expect(result.version).toBe(0x0100);
      expect(result.capabilities.hasKeyboard).toBe(true);
      expect(result.capabilities.hasMouse).toBe(false);
      expect(result.capabilities.keyCodes).toEqual([30, 31, 32]);
      expect(result.errors).toEqual([]);
    });

    it("should convert touchscreen device with touch info", () => {
      const rustDevice: RustDeviceInfo = {
        path: "/dev/input/event5",
        name: "ELAN Touchscreen",
        device_type: "touchscreen",
        phys: "",
        vendor: 0x04f3,
        product: 0x2b2c,
        version: 0x0100,
        capabilities: {
          event_types: [1, 3, 0],
          key_codes: [330],
          rel_axes: [],
          abs_axes: [47, 53, 54, 57, 58, 0],
          max_touch_slots: 10,
          has_keyboard: false,
          has_mouse: false,
          has_touchpad: false,
          has_touchscreen: true,
        },
        touch_info: {
          position_x: { min: 0, max: 32767, fuzz: 0, flat: 0, resolution: 32 },
          position_y: { min: 0, max: 32767, fuzz: 0, flat: 0, resolution: 32 },
          pressure: { min: 0, max: 255, fuzz: 0, flat: 0, resolution: 0 },
          tracking_id: { min: 0, max: 65535, fuzz: 0, flat: 0, resolution: 0 },
          slot: { min: 0, max: 9, fuzz: 0, flat: 0, resolution: 0 },
          mt_protocol: "B",
        },
        errors: [],
      };

      const result = convertDeviceInfo(rustDevice);

      expect(result.type).toBe("touchscreen");
      expect(result.capabilities.hasTouchscreen).toBe(true);
      expect(result.capabilities.maxTouchSlots).toBe(10);
      expect(result.touchInfo).toBeDefined();
      expect(result.touchInfo?.positionX.max).toBe(32767);
      expect(result.touchInfo?.pressure?.max).toBe(255);
      expect(result.touchInfo?.mtProtocol).toBe("B");
    });

    it("should convert mouse device", () => {
      const rustDevice: RustDeviceInfo = {
        path: "/dev/input/event3",
        name: "Logitech Mouse",
        device_type: "mouse",
        phys: "usb-0000:00:14.0-1/input1",
        vendor: 0x046d,
        product: 0xc52b,
        version: 0x0111,
        capabilities: {
          event_types: [1, 2, 0],
          key_codes: [272, 273, 274],
          rel_axes: [0, 1, 8],
          abs_axes: [],
          has_keyboard: false,
          has_mouse: true,
          has_touchpad: false,
          has_touchscreen: false,
        },
        errors: [],
      };

      const result = convertDeviceInfo(rustDevice);

      expect(result.type).toBe("mouse");
      expect(result.capabilities.hasMouse).toBe(true);
      expect(result.capabilities.relAxes).toEqual([0, 1, 8]);
      expect(result.capabilities.keyCodes).toEqual([272, 273, 274]);
    });

    it("should handle errors in device info", () => {
      const rustDevice: RustDeviceInfo = {
        path: "/dev/input/event10",
        name: "Error Device",
        device_type: "unknown",
        phys: undefined,
        vendor: 0,
        product: 0,
        version: 0,
        capabilities: {
          event_types: [],
          key_codes: [],
          rel_axes: [],
          abs_axes: [],
          has_keyboard: false,
          has_mouse: false,
          has_touchpad: false,
          has_touchscreen: false,
        },
        touch_info: undefined,
        errors: [
          { field: "capabilities", message: "读取能力失败" },
          { field: "name", message: "读取名称超时" },
        ],
      };

      const result = convertDeviceInfo(rustDevice);

      expect(result.type).toBe("unknown");
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].field).toBe("capabilities");
      expect(result.errors[0].message).toBe("读取能力失败");
    });
  });
});
