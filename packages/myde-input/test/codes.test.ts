import { describe, expect, it } from "vitest";
import {
  ABS_MT_POSITION_X,
  BTN_LEFT,
  EV_ABS,
  EV_KEY,
  EV_REL,
  KEY_A,
  KEY_SPACE,
  LINUX_TO_WEB_KEY,
  REL_X,
  WEB_TO_LINUX_KEY,
} from "../src/codes.ts";

describe("Codes", () => {
  describe("Event Types", () => {
    it("should define correct event type values", () => {
      expect(EV_KEY).toBe(1);
      expect(EV_REL).toBe(2);
      expect(EV_ABS).toBe(3);
    });
  });

  describe("Key Codes", () => {
    it("should define correct key values", () => {
      expect(KEY_A).toBe(30);
      expect(KEY_SPACE).toBe(57);
    });

    it("should define correct button values", () => {
      expect(BTN_LEFT).toBe(0x110);
    });
  });

  describe("Axis Codes", () => {
    it("should define correct relative axis values", () => {
      expect(REL_X).toBe(0);
    });

    it("should define correct absolute axis values", () => {
      expect(ABS_MT_POSITION_X).toBe(0x35);
    });
  });

  describe("Key Mapping", () => {
    it("should map web key codes to linux key codes", () => {
      expect(WEB_TO_LINUX_KEY.KeyA).toBe(KEY_A);
      expect(WEB_TO_LINUX_KEY.Space).toBe(KEY_SPACE);
      expect(WEB_TO_LINUX_KEY.ArrowUp).toBe(103);
    });

    it("should map linux key codes to web key codes", () => {
      expect(LINUX_TO_WEB_KEY[KEY_A]).toBe("KeyA");
      expect(LINUX_TO_WEB_KEY[KEY_SPACE]).toBe("Space");
      expect(LINUX_TO_WEB_KEY[103]).toBe("ArrowUp");
    });

    it("should have consistent bidirectional mapping", () => {
      for (const [web, linux] of Object.entries(WEB_TO_LINUX_KEY)) {
        expect(LINUX_TO_WEB_KEY[linux]).toBe(web);
      }
    });
  });
});
