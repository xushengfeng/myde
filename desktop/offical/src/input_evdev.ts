// evdev（input api）相关工具：设备判定、按键/滚轮/坐标换算
// 事件流解码（useEvdevDevice/useEvdevInput）在主文件 main.ts，与 DOM 聚合、分发在一起
import type { DeviceInfo } from "../../../src/desktop-api";
import { InputEventCodes } from "../../../src/input_codes/types";

const { MInputMap } = myde;

/** 聚合层的指针位置（视口坐标），相对设备位移积分、绝对设备小数映射都写这里 */
export interface InputPointerPos {
    x: number;
    y: number;
}

// evdev 键码 → DOM 按键（0左 1中 2右），BTN_TOUCH（触屏/笔接触）视为左键
export const BTN_TO_BUTTON: Record<number, number> = {
    [InputEventCodes.BTN_LEFT]: 0,
    [InputEventCodes.BTN_MIDDLE]: 1,
    [InputEventCodes.BTN_RIGHT]: 2,
    [InputEventCodes.BTN_TOUCH]: 0,
};

// DOM 滚动一行约 100px，scroll-list 也用 |delta|>=100 识别鼠标滚轮
export const WHEEL_STEP = 100;
// 高精度滚轮每格 120 单位
export const HI_RES_SCALE = WHEEL_STEP / 120;

// abs 值统一为小数（MInputMap.absPosMapping），这里按视口映射（需要坐标时再映射）
export function ratioToView(ratio: number, size: number) {
    return Math.min(Math.max(ratio * (size - 1), 0), size - 1);
}

export function hasRelativeXY(info: DeviceInfo) {
    const relAxes = info.capabilities.relAxes;
    return relAxes.includes(InputEventCodes.REL_X) && relAxes.includes(InputEventCodes.REL_Y);
}

export function pointerKindOf(info: DeviceInfo): "mouse" | "touch" | "pen" {
    if (info.type === "tablet") return "pen";
    if (info.type === "touchscreen" || info.capabilities.hasTouchscreen) return "touch";
    return "mouse";
}

export function canPoint(info: DeviceInfo) {
    return hasRelativeXY(info) || MInputMap.absPosMapping(info) !== undefined;
}

export function canKey(info: DeviceInfo) {
    // 仅纯键盘设备产生键盘事件，排除带按键的鼠标/触控板等复合设备
    return (
        info.type === "keyboard" ||
        (info.capabilities.hasKeyboard &&
            !info.capabilities.hasMouse &&
            !info.capabilities.hasTouchpad &&
            !info.capabilities.hasTouchscreen &&
            !canPoint(info))
    );
}
