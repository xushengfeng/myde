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
// 高精度滚轮每格 120 单位（1/120 格即 Wayland 的 value120），这里换算成像素
export const HI_RES_SCALE = WHEEL_STEP / 120;
// 鼠标滚轮停顿多久算一段结束，用于发 wheelEnd；触摸板抬手有显式结束
export const WHEEL_SEQUENCE_DELAY = 150;

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
    // 触摸板按相对指针处理（绝对坐标在 main.ts 里转成位移）
    if (info.type === "touchpad" || info.capabilities.hasTouchpad) return "mouse";
    if (info.type === "touchscreen" || info.capabilities.hasTouchscreen) return "touch";
    return "mouse";
}

/** 触摸板：绝对坐标只用于算位移，不能直接映射到屏幕 */
export function isTouchpad(info: DeviceInfo) {
    return info.type === "touchpad" || info.capabilities.hasTouchpad;
}

/** 触屏：绝对坐标直接映射到屏幕，按一次接触对应一次指针按下/抬起（数位板按笔处理，不算触屏） */
export function isTouchscreen(info: DeviceInfo) {
    if (info.type === "tablet") return false;
    return info.type === "touchscreen" || info.capabilities.hasTouchscreen;
}

export function canPoint(info: DeviceInfo) {
    return hasRelativeXY(info) || MInputMap.absPosMapping(info) !== undefined;
}

/** 桌面会处理的媒体/亮度/键盘灯等系统键：WMI/hotkey 节点可能只有这些键，没有字母键 */
const SYSTEM_KEY_CODES = new Set([
    InputEventCodes.KEY_MUTE,
    InputEventCodes.KEY_VOLUMEDOWN,
    InputEventCodes.KEY_VOLUMEUP,
    InputEventCodes.KEY_BRIGHTNESSDOWN,
    InputEventCodes.KEY_BRIGHTNESSUP,
    InputEventCodes.KEY_MICMUTE,
    InputEventCodes.KEY_KBDILLUMTOGGLE,
    InputEventCodes.KEY_KBDILLUMDOWN,
    InputEventCodes.KEY_KBDILLUMUP,
    InputEventCodes.KEY_PLAYPAUSE,
    InputEventCodes.KEY_PLAY,
    InputEventCodes.KEY_PLAYCD,
    InputEventCodes.KEY_PAUSECD,
    InputEventCodes.KEY_NEXTSONG,
    InputEventCodes.KEY_PREVIOUSSONG,
    InputEventCodes.KEY_STOPCD,
]);

function hasSystemKeys(info: DeviceInfo) {
    return info.capabilities.keyCodes.some((code) => SYSTEM_KEY_CODES.has(code));
}

export function canKey(info: DeviceInfo) {
    // 仅纯键盘设备产生键盘事件，排除带按键的鼠标/触控板等复合设备
    if (info.type === "keyboard") return true;
    if (
        info.capabilities.hasMouse ||
        info.capabilities.hasTouchpad ||
        info.capabilities.hasTouchscreen ||
        canPoint(info)
    )
        return false;
    return info.capabilities.hasKeyboard || hasSystemKeys(info);
}
