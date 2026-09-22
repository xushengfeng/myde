// evdev 原生输入（MSysApi.input / myde-input）→ DOM 指针事件注入
// 存在可用的指针设备时接管指针：硬件事件驱动自绘光标、wayland 窗口转发、窗口拖拽和 UI 点击，
// 同时屏蔽真实 DOM 指针事件避免重复输入；不可用时保持 DOM 指针事件工作
// 相对设备（鼠标、触控板）用位移积分，绝对设备（触屏、数位板）用轴量程映射到视口坐标
import type { DeviceInfo, InputManager } from "../../../src/desktop-api";
import { InputEventCodes } from "../../../src/input_codes/types";

// evdev 键码 -> DOM button（0=左 1=中 2=右），BTN_TOUCH（触屏/笔接触）视为左键
const BTN_TO_BUTTON: Record<number, number> = {
    [InputEventCodes.BTN_LEFT]: 0,
    [InputEventCodes.BTN_MIDDLE]: 1,
    [InputEventCodes.BTN_RIGHT]: 2,
    [InputEventCodes.BTN_TOUCH]: 0,
};

// DOM buttons 位掩码（1=左 2=右 4=中）
const BUTTONS_BIT = [1, 4, 2];

// DOM 滚动一行约 100px，scroll-list 也用 |delta|>=100 识别鼠标滚轮
const WHEEL_STEP = 100;
// 高精度滚轮每格 120 单位
const HI_RES_SCALE = WHEEL_STEP / 120;

// 接管期间需要屏蔽的真实指针事件（click 由浏览器根据真实 down/up 生成，也要屏蔽）
const SWALLOWED_EVENTS = [
    "pointerdown",
    "pointerup",
    "pointermove",
    "pointerover",
    "pointerout",
    "pointerenter",
    "pointerleave",
    "mousedown",
    "mouseup",
    "mousemove",
    "wheel",
    "click",
    "auxclick",
    "dblclick",
    "contextmenu",
];

type PointerKind = "mouse" | "touch" | "pen";

interface AbsMapping {
    xCode: number;
    yCode: number;
    mapX: (value: number) => number;
    mapY: (value: number) => number;
}

function axisRange(info: DeviceInfo, code: number) {
    // absInfo 是通用量程；旧固件/读取失败时 MT 定位轴可回退 touchInfo
    return (
        info.absInfo[code] ??
        (code === InputEventCodes.ABS_MT_POSITION_X
            ? info.touchInfo?.positionX
            : code === InputEventCodes.ABS_MT_POSITION_Y
              ? info.touchInfo?.positionY
              : undefined)
    );
}

/** 解析绝对定位轴（优先单点 ABS_X/ABS_Y，其次多点 ABS_MT_POSITION_*）及其到视口的映射 */
function absMapping(info: DeviceInfo): AbsMapping | undefined {
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
    const rangeX = axisRange(info, xCode);
    const rangeY = axisRange(info, yCode);
    if (!rangeX || !rangeY || rangeX.max <= rangeX.min || rangeY.max <= rangeY.min) return undefined;
    return {
        xCode,
        yCode,
        mapX: (value: number) =>
            Math.min(
                Math.max(((value - rangeX.min) / (rangeX.max - rangeX.min)) * (window.innerWidth - 1), 0),
                window.innerWidth - 1,
            ),
        mapY: (value: number) =>
            Math.min(
                Math.max(((value - rangeY.min) / (rangeY.max - rangeY.min)) * (window.innerHeight - 1), 0),
                window.innerHeight - 1,
            ),
    };
}

function hasRelativeXY(info: DeviceInfo) {
    const relAxes = info.capabilities.relAxes;
    return relAxes.includes(InputEventCodes.REL_X) && relAxes.includes(InputEventCodes.REL_Y);
}

function pointerKindOf(info: DeviceInfo): PointerKind {
    if (info.type === "tablet") return "pen";
    if (info.type === "touchscreen" || info.capabilities.hasTouchscreen) return "touch";
    return "mouse";
}

/**
 * 用 evdev 输入接管鼠标指针
 * @returns 当前是否存在可用的指针设备（设备热插拔会自动激活/停用）
 */
export function useEvdevPointer(input: InputManager): boolean {
    const pointer = { x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2) };
    let buttonsMask = 0;
    let active = false;
    // 注入事件的 pointerType 由最后产生输入的设备决定（正常场景同一时刻只用一个设备）
    let pointerType: PointerKind = "mouse";

    // 帧缓冲：一帧（EV_SYN 前）内的位移/滚轮/按键合并，保持事件顺序
    let dx = 0;
    let dy = 0;
    let absMoved = false;
    let wheelX = 0;
    let wheelY = 0;
    let frameButtons: { code: number; value: number }[] = [];

    const swallow = (e: Event) => {
        if (active && e.isTrusted) {
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    };
    for (const type of SWALLOWED_EVENTS) {
        window.addEventListener(type, swallow, true);
    }

    function targetAt(): Element {
        return document.elementFromPoint(pointer.x, pointer.y) ?? document.body;
    }

    function pointerInit(extra: PointerEventInit): PointerEventInit {
        return {
            view: window,
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: pointer.x,
            clientY: pointer.y,
            pointerId: 1,
            pointerType,
            isPrimary: true,
            buttons: buttonsMask,
            ...extra,
        };
    }

    // 注入的 click 不会触发聚焦，手动补齐，保证锁屏密码框等可输入
    function focusAt(target: Element) {
        const el = target.closest("input, textarea, select, [tabindex]") as HTMLElement | null;
        el?.focus();
    }

    function flushFrame() {
        if (dx || dy) {
            pointer.x = Math.min(Math.max(pointer.x + dx, 0), window.innerWidth - 1);
            pointer.y = Math.min(Math.max(pointer.y + dy, 0), window.innerHeight - 1);
            dx = 0;
            dy = 0;
            absMoved = true;
        }
        if (absMoved) {
            absMoved = false;
            targetAt().dispatchEvent(new PointerEvent("pointermove", pointerInit({})));
        }
        if (wheelX || wheelY) {
            const deltaX = wheelX;
            const deltaY = wheelY;
            wheelX = 0;
            wheelY = 0;
            targetAt().dispatchEvent(
                new WheelEvent("wheel", {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    clientX: pointer.x,
                    clientY: pointer.y,
                    deltaX,
                    deltaY,
                }),
            );
        }
        const buttons = frameButtons;
        frameButtons = [];
        for (const { code, value } of buttons) {
            // biome-ignore lint/style/noNonNullAssertion: 调用前已过滤
            const button = BTN_TO_BUTTON[code]!;
            const down = value === 1;
            if (down) buttonsMask |= BUTTONS_BIT[button];
            else buttonsMask &= ~BUTTONS_BIT[button];
            const target = targetAt();
            target.dispatchEvent(
                new PointerEvent(down ? "pointerdown" : "pointerup", pointerInit({ button, buttons: buttonsMask })),
            );
            if (!down && button === 0) {
                focusAt(target);
                target.dispatchEvent(
                    new MouseEvent("click", {
                        view: window,
                        bubbles: true,
                        cancelable: true,
                        composed: true,
                        clientX: pointer.x,
                        clientY: pointer.y,
                        button: 0,
                    }),
                );
            }
        }
    }

    function useDevice(path: string) {
        const dev = input.getDevice(path);
        if (!dev) return;
        const info = dev.info;
        const kind = pointerKindOf(info);
        const rel = hasRelativeXY(info);
        const abs = absMapping(info);
        if (!rel && !abs) return;
        active = true;
        // 高精度滚轮与普通滚轮会同时上报，优先高精度避免重复滚动
        const hiResWheel = info.capabilities.relAxes.includes(InputEventCodes.REL_WHEEL_HI_RES);
        // MT-B 设备多指会交替上报各 slot 坐标，只跟随第一根手指
        let slot = 0;
        let sawSlot = false;
        dev.startReading();
        dev.on("relative", (code, value) => {
            pointerType = kind;
            if (code === InputEventCodes.REL_X) dx += value;
            else if (code === InputEventCodes.REL_Y) dy += value;
            else if (code === InputEventCodes.REL_WHEEL_HI_RES) wheelY += -value * HI_RES_SCALE;
            else if (code === InputEventCodes.REL_HWHEEL_HI_RES) wheelX += value * HI_RES_SCALE;
            else if (code === InputEventCodes.REL_WHEEL && !hiResWheel) wheelY += -value * WHEEL_STEP;
            else if (code === InputEventCodes.REL_HWHEEL && !hiResWheel) wheelX += value * WHEEL_STEP;
        });
        dev.on("absolute", (code, value) => {
            if (!abs) return;
            pointerType = kind;
            if (code === InputEventCodes.ABS_MT_SLOT) {
                sawSlot = true;
                slot = value;
                return;
            }
            if (sawSlot && slot !== 0) return;
            if (code === abs.xCode) {
                pointer.x = abs.mapX(value);
                absMoved = true;
            } else if (code === abs.yCode) {
                pointer.y = abs.mapY(value);
                absMoved = true;
            }
        });
        dev.on("key", (code, value) => {
            if (BTN_TO_BUTTON[code] !== undefined && (value === 0 || value === 1)) {
                pointerType = kind;
                frameButtons.push({ code, value });
            }
        });
        dev.on("sync", flushFrame);
    }

    function canPoint(info: DeviceInfo) {
        return hasRelativeXY(info) || absMapping(info) !== undefined;
    }

    for (const info of input.getDevices()) {
        useDevice(info.path);
    }
    input.on("deviceAdded", (info) => {
        useDevice(info.path);
    });
    input.on("deviceRemoved", () => {
        active = input.getDevices().some(canPoint);
    });

    return active;
}
