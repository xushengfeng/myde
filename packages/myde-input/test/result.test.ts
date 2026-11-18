import { describe, expect, it } from "vitest";
import { ErrorCode, err, errFromUnknown, ok, okVoid } from "../src/result.ts";

describe("Result", () => {
  describe("ok", () => {
    it("should create success result with value", () => {
      const result = ok(42);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    it("should create success result with void", () => {
      const result = okVoid();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
    });

    it("should create success result with null", () => {
      const result = ok(null);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it("should create success result with object", () => {
      const data = { name: "test", value: 123 };
      const result = ok(data);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(data);
      }
    });
  });

  describe("err", () => {
    it("should create error result", () => {
      const result = err(ErrorCode.DeviceNotFound, "设备未找到");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.DeviceNotFound);
        expect(result.error.message).toBe("设备未找到");
      }
    });

    it("should create error result with detail", () => {
      const detail = { path: "/dev/input/event0" };
      const result = err(ErrorCode.DevicePermissionDenied, "权限不足", detail);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.DevicePermissionDenied);
        expect(result.error.message).toBe("权限不足");
        expect(result.error.detail).toEqual(detail);
      }
    });
  });

  describe("errFromUnknown", () => {
    it("should handle Error instance", () => {
      const error = new Error("测试错误");
      const result = errFromUnknown(error);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.Unknown);
        expect(result.error.message).toBe("测试错误");
        expect(result.error.detail).toBe(error);
      }
    });

    it("should handle string", () => {
      const result = errFromUnknown("字符串错误");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.Unknown);
        expect(result.error.message).toBe("字符串错误");
      }
    });

    it("should handle number", () => {
      const result = errFromUnknown(42);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.Unknown);
        expect(result.error.message).toBe("42");
      }
    });
  });
});
