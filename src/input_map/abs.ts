// abs 轴相关转换：abs 值统一为小数（abs值比上 abs 范围），需要目标坐标时再映射
// 与 web2x（web 键码 → evdev 键码）同为输入相关转换，经 MInputMap 暴露给桌面
import type { AxisInfo, DeviceInfo } from "myde-input";
import { InputEventCodes } from "../input_codes/types";

/** abs 轴量程（absInfo，旧固件/读取失败时 MT 定位轴可回退 touchInfo），缺失返回 undefined */
export function absRange(info: DeviceInfo, code: number): AxisInfo | undefined {
    return (
        info.absInfo[code] ??
        (code === InputEventCodes.ABS_MT_POSITION_X
            ? info.touchInfo?.positionX
            : code === InputEventCodes.ABS_MT_POSITION_Y
              ? info.touchInfo?.positionY
              : undefined)
    );
}

/**
 * abs 值归一化为小数（abs值比上 abs 范围）：小数 = (值 - min) / (max - min)
 * min=0 时即 值 ÷ 量程；超出量程可能越出 0~1，需要目标坐标时再映射并截断
 * 无量程信息返回 undefined
 */
export function absRatio(info: DeviceInfo, code: number, value: number): number | undefined {
    const range = absRange(info, code);
    if (!range || range.max <= range.min) return undefined;
    return (value - range.min) / (range.max - range.min);
}

/** 绝对定位设备（触屏、数位板）的 X/Y 轴小数转换 */
export interface AbsRatioMapping {
    /** 使用的轴码（单点 ABS_X/ABS_Y 优先，其次多点 ABS_MT_POSITION_*） */
    xCode: number;
    yCode: number;
    /** X 轴 abs 值 → 小数 */
    ratioX(value: number): number;
    /** Y 轴 abs 值 → 小数 */
    ratioY(value: number): number;
}

/** 解析绝对定位设备的 X/Y 轴及其小数转换，需要坐标时再乘宽高映射；不可用返回 undefined */
export function absPosMapping(info: DeviceInfo): AbsRatioMapping | undefined {
    const absAxes = info.capabilities.absAxes;
    const xCode = absAxes.includes(InputEventCodes.ABS_X)
        ? InputEventCodes.ABS_X
        : absAxes.includes(InputEventCodes.ABS_MT_POSITION_X)
          ? InputEventCodes.ABS_MT_POSITION_X
          : undefined;
    const yCode = absAxes.includes(InputEventCodes.ABS_Y)
        ? InputEventCodes.ABS_Y
        : absAxes.includes(InputEventCodes.ABS_MT_POSITION_Y)
          ? InputEventCodes.ABS_MT_POSITION_Y
          : undefined;
    if (xCode === undefined || yCode === undefined) return undefined;
    const rangeX = absRange(info, xCode);
    const rangeY = absRange(info, yCode);
    if (!rangeX || !rangeY || rangeX.max <= rangeX.min || rangeY.max <= rangeY.min) return undefined;
    return {
        xCode,
        yCode,
        ratioX: (value: number) => (value - rangeX.min) / (rangeX.max - rangeX.min),
        ratioY: (value: number) => (value - rangeY.min) / (rangeY.max - rangeY.min),
    };
}
