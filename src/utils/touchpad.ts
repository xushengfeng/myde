// 触摸板事件工具：把 input api 的原始设备事件封装成移动/滚动/按键事件
//
// 只有这个工具接触 BTN_TOUCH/ABS_MT_* 等键码，桌面只订阅语义事件；
// 轻触、双指滚动、双指/三指按键和拖拽都在这里转换成统一的按钮/滚动动作。
import type { DeviceInfo, InputDevice } from "myde-input";
import { EventEmitter } from "../event-emitter/event-emitter";
import { InputEventCodes } from "../input_codes/types";
import { absRange } from "../input_map/abs";

// 与 libinput 的触摸板轻触/拖拽一致（COSMIC、KWin 都直接交给 libinput）：
// 接触后 180ms 内抬起且位移不超过 1.3mm 才算轻触；轻触在抬起时只发按下，
// 等拖拽窗口过去再发抬起；随后第二下按住移动就是拖拽。
/** 轻触允许的最长接触时间 */
export const TAP_TIMEOUT = 180;
/** 轻触允许的最大位移（毫米，按设备分辨率换算） */
export const TAP_MOVE_MM = 1.3;
/** 轻触后第二下按住，在这个时间窗内移动/保持都进入拖拽 */
export const DRAG_TIMEOUT = 180;
/** 设备没报分辨率时按 libinput 的默认 DPI 折算（单位/毫米） */
const DEFAULT_UNITS_PER_MM = 1000 / 25.4;
/** 双指滚动量相对手指位移的比例（自然滚动：内容跟随手指） */
export const SCROLL_GAIN = 1;

// BTN_TOOL_* 是内核上报的触摸板手指数（没有 MT tracking id 的旧设备只能靠它）
const TOOL_FINGERS: Record<number, number> = {
    [InputEventCodes.BTN_TOOL_FINGER]: 1,
    [InputEventCodes.BTN_TOOL_DOUBLETAP]: 2,
    [InputEventCodes.BTN_TOOL_TRIPLETAP]: 3,
    [InputEventCodes.BTN_TOOL_QUADTAP]: 4,
    [InputEventCodes.BTN_TOOL_QUINTTAP]: 5,
};

/** 触摸板对外的语义事件（坐标为视口像素） */
export type TouchpadEvents = {
    /** 光标位移 */
    move: [dx: number, dy: number];
    /** 双指滚动量 */
    scroll: [deltaX: number, deltaY: number];
    /** 双指滚动结束（抬手或手指数量变化），用于给客户端补 axis_stop */
    scrollEnd: [];
    /** 三指及以上开始移动（官方桌面未订阅，留给其他桌面做多指手势） */
    multiStart: [fingers: number];
    /** 三指及以上移动量 */
    multiMove: [fingers: number, dx: number, dy: number];
    /** 三指及以上移动结束 */
    multiEnd: [fingers: number];
    /** 按键（含轻触合成的点击与物理按键） */
    button: [action: "down" | "up", button: number];
};

export interface TouchpadInputOptions {
    /** abs 轴 → 视口像素；量程缺失返回 undefined */
    mapX(code: number, value: number): number | undefined;
    mapY(code: number, value: number): number | undefined;
    /** 伴随鼠标节点在出事件时，绝对坐标不能再用（避免双倍移动；滚动仍用触摸板 ABS） */
    ignoreAbs?(): boolean;
    now?(): number;
}

/** 一个接触点，坐标为视口像素；raw 是设备原始值，用于按毫米判断轻触位移 */
interface TouchContact {
    x: number;
    y: number;
    /** X/Y 是否都收到过坐标（MT 的 X、Y 分两个事件到达） */
    hasX: boolean;
    hasY: boolean;
    /** 上一帧坐标，用于计算位移 */
    prevX?: number;
    prevY?: number;
    rawX?: number;
    rawY?: number;
    startRawX?: number;
    startRawY?: number;
    /** 本帧抬起，sync 后删除 */
    released: boolean;
}

type TouchpadAction =
    | { type: "move"; dx: number; dy: number }
    | { type: "scroll"; deltaX: number; deltaY: number }
    | { type: "scrollEnd" }
    | { type: "multiStart"; fingers: number }
    | { type: "multiMove"; fingers: number; dx: number; dy: number }
    | { type: "multiEnd"; fingers: number }
    | { type: "button"; action: "down" | "up"; button: number };

/** 把一台触摸板设备的 input api 事件封装成 TouchpadEvents */
export class TouchpadInput extends EventEmitter<TouchpadEvents> {
    private readonly options: TouchpadInputOptions;
    private readonly hasTrackingId: boolean;
    private readonly alwaysTouching: boolean;

    /** MT slot → 接触点 */
    private contacts = new Map<number, TouchContact>();
    /** 没有 MT tracking id 时，用 BTN_TOUCH/ABS_X 的单一接触点 */
    private fallback: TouchContact | undefined;
    /** fallback 建立前先记住最近一次坐标 */
    private lastX: number | undefined;
    private lastY: number | undefined;
    private lastRawX: number | undefined;
    private lastRawY: number | undefined;
    /** 设备原始单位 / 毫米，没有分辨率时用 libinput 的默认 DPI */
    private readonly unitsPerMmX: number;
    private readonly unitsPerMmY: number;

    private slot = 0;
    private btnTouch = false;
    private toolFingers = 0;
    private readonly physicalDown = new Set<number>();

    private roundActive = false;
    private roundMaxFingers = 0;
    /**
     * libinput 触摸板轻触状态机：
     * idle → touch（接触，等抬手/超时）
     * touch → hold（超时未抬起，不点击）/ moving（超过位移阈值，移动光标）
     * touch 抬起 → tapped（已按下，等第二下或拖拽窗口结束）
     * tapped 第二下 → second（等移动/超时），移动/超时 → dragging
     * second 快速抬起 → 双击；dragging 抬起 → 抬起按键
     */
    private phase: "idle" | "touch" | "hold" | "moving" | "tapped" | "second" | "dragging" = "idle";
    /** 已经按下、还没抬起的键 */
    private pressedButton: number | undefined;
    /** touch 超时 / tapped 窗口 / second 判断 / dragWait 锁定 */
    private timer: ReturnType<typeof setTimeout> | undefined;
    /** 当前三指及以上手势的手指数，0 表示没有 */
    private multiFingers = 0;
    /** 是否正在双指滚动，手指数量变化时补一次 scrollEnd */
    private scrolling = false;

    /** 物理按键在帧末统一发出 */
    private pending: TouchpadAction[] = [];

    constructor(dev: InputDevice, info: DeviceInfo, options: TouchpadInputOptions) {
        super();
        this.options = options;
        this.hasTrackingId = info.capabilities.absAxes.includes(InputEventCodes.ABS_MT_TRACKING_ID);
        this.alwaysTouching = !hasTouchpadTouchSignal(info.capabilities.keyCodes);
        const xCode = info.capabilities.absAxes.includes(InputEventCodes.ABS_MT_POSITION_X)
            ? InputEventCodes.ABS_MT_POSITION_X
            : InputEventCodes.ABS_X;
        const yCode = info.capabilities.absAxes.includes(InputEventCodes.ABS_MT_POSITION_Y)
            ? InputEventCodes.ABS_MT_POSITION_Y
            : InputEventCodes.ABS_Y;
        const resX = absRange(info, xCode)?.resolution ?? 0;
        const resY = absRange(info, yCode)?.resolution ?? 0;
        this.unitsPerMmX = resX > 0 ? resX : DEFAULT_UNITS_PER_MM;
        this.unitsPerMmY = resY > 0 ? resY : DEFAULT_UNITS_PER_MM;
        dev.on("absolute", (code, value) => this.absolute(code, value));
        dev.on("key", (code, value) => this.key(code, value));
        dev.on("sync", () => this.flush());
    }

    private flush(): void {
        const actions = this.pending.splice(0);
        // 抬起的那一帧也可能带着最后一小段位移，位移要用包含已抬起的全部接触点算
        const { active: contacts, all } = this.activeContacts();
        const count = this.fingerCount(contacts);

        if (!this.roundActive && count > 0) this.startRound(count);
        if (this.roundActive) this.roundMaxFingers = Math.max(this.roundMaxFingers, count);

        // 双指滚动在手指数量变化（抬手、加入第三根）时结束
        if (this.scrolling && count !== 2) {
            this.scrolling = false;
            actions.push({ type: "scrollEnd" });
        }

        // 按住左键时落下第二根手指：结束按键，交给多指手势（避免左键卡住）
        if (this.roundActive && count >= 2 && this.pressedButton !== undefined) {
            this.unpress(actions);
            this.phase = "moving";
        }

        const { dx, dy } = this.consumeMove(all);
        const ignoreAbs = this.options.ignoreAbs?.() ?? false;
        const movedBeyondTap = this.exceedsTapMove(all);

        if (this.roundActive) {
            if (movedBeyondTap) {
                if (this.phase === "touch" || this.phase === "hold") {
                    this.cancelTimer();
                    this.phase = "moving";
                } else if (this.phase === "second") {
                    // 第二下移动超过阈值：接上按住的左键进入拖拽
                    this.cancelTimer();
                    this.phase = "dragging";
                }
            }

            if (dx !== 0 || dy !== 0) {
                // 抬起的那一帧也可能带着最后一小段位移：单指接触（含本帧抬起）照发 move
                if (count === 1 || (count === 0 && all.length === 1)) {
                    if (!ignoreAbs) actions.push({ type: "move", dx, dy });
                } else if (count === 2) {
                    // 自然滚动：内容跟随手指，手指上移对应内容向下滚
                    this.scrolling = true;
                    actions.push({
                        type: "scroll",
                        deltaX: dx === 0 ? 0 : -dx * SCROLL_GAIN,
                        deltaY: dy === 0 ? 0 : -dy * SCROLL_GAIN,
                    });
                }
            }

            // 三指及以上单独封装成多指移动事件，不参与光标/双指滚动；官方桌面不订阅
            if (count >= 3) {
                if (this.multiFingers === 0) actions.push({ type: "multiStart", fingers: count });
                this.multiFingers = count;
                if (!ignoreAbs && (dx !== 0 || dy !== 0)) {
                    actions.push({ type: "multiMove", fingers: count, dx, dy });
                }
            } else if (this.multiFingers > 0) {
                actions.push({ type: "multiEnd", fingers: this.multiFingers });
                this.multiFingers = 0;
            }
        }

        if (this.roundActive && count === 0) this.finishRound(actions);

        for (const action of actions) {
            if (action.type === "button") this.emit("button", action.action, action.button);
            else if (action.type === "scroll") this.emit("scroll", action.deltaX, action.deltaY);
            else if (action.type === "scrollEnd") this.emit("scrollEnd");
            else if (action.type === "multiStart") this.emit("multiStart", action.fingers);
            else if (action.type === "multiMove") this.emit("multiMove", action.fingers, action.dx, action.dy);
            else if (action.type === "multiEnd") this.emit("multiEnd", action.fingers);
            else this.emit("move", action.dx, action.dy);
        }
    }

    private absolute(code: number, value: number): void {
        if (code === InputEventCodes.ABS_MT_SLOT) {
            this.slot = value;
            return;
        }

        if (!this.hasTrackingId) {
            if (code === InputEventCodes.ABS_X || code === InputEventCodes.ABS_Y) {
                this.updateFallback(code === InputEventCodes.ABS_X, code, value);
            }
            return;
        }

        if (code === InputEventCodes.ABS_MT_TRACKING_ID) {
            if (value === -1) {
                const c = this.contacts.get(this.slot);
                if (c) c.released = true;
            } else {
                // 同一个 slot 重新按下时直接换新接触点
                this.contacts.set(this.slot, this.newContact());
            }
            return;
        }

        if (code === InputEventCodes.ABS_MT_POSITION_X || code === InputEventCodes.ABS_MT_POSITION_Y) {
            const c = this.contacts.get(this.slot);
            if (c) this.setPos(c, code === InputEventCodes.ABS_MT_POSITION_X, code, value);
            return;
        }

        // ABS_X/ABS_Y 是内核给主手指的合成坐标
        if (code === InputEventCodes.ABS_X || code === InputEventCodes.ABS_Y) {
            const c = this.primaryContact();
            if (c) this.setPos(c, code === InputEventCodes.ABS_X, code, value);
        }
    }

    private key(code: number, value: number): void {
        if (code === InputEventCodes.BTN_TOUCH) {
            this.btnTouch = value === 1;
            return;
        }
        const fingers = TOOL_FINGERS[code];
        if (fingers !== undefined) {
            if (value === 1) this.toolFingers = fingers;
            else if (this.toolFingers === fingers) this.toolFingers = 0;
            return;
        }
        const button = this.buttonOf(code);
        if (button === undefined) return;
        if (value === 1) {
            this.physicalDown.add(button);
            if (this.pressedButton === button) {
                // 轻触/拖拽已经按下这个键，物理按下并入，不重复发送
                this.cancelTimer();
            } else {
                // 物理按下取代正在判断的轻触，避免同一次接触又合成点击
                if (this.phase === "touch" || this.phase === "hold" || this.phase === "moving") {
                    this.cancelTimer();
                    this.phase = "moving";
                }
                this.pending.push({ type: "button", action: "down", button });
            }
        } else if (value === 0) {
            this.physicalDown.delete(button);
            if (this.pressedButton === button) {
                // 这次按下由轻触/拖拽发起，物理抬起负责结束它
                this.cancelTimer();
                this.pressedButton = undefined;
                this.phase = "idle";
            }
            this.pending.push({ type: "button", action: "up", button });
        }
    }

    private newContact(): TouchContact {
        return { x: 0, y: 0, hasX: false, hasY: false, released: false };
    }

    /** 当前接触点：active 不含本帧抬起的，all 含（用于把最后一帧位移也算上） */
    private activeContacts(): { active: TouchContact[]; all: TouchContact[] } {
        if (!this.hasTrackingId) {
            if (!this.touching()) {
                if (this.fallback) this.fallback.released = true;
            } else if (!this.fallback) {
                this.fallback = this.newContact();
                if (this.lastX !== undefined && this.lastY !== undefined) {
                    this.placeFallback(this.lastX, this.lastY, this.lastRawX, this.lastRawY);
                }
            }
        }
        const all = [...this.contacts.values()];
        if (this.fallback) all.push(this.fallback);
        const active = all.filter((c) => !c.released);
        if (this.fallback?.released) this.fallback = undefined;
        return { active, all };
    }

    /** 没有 tracking id 时的接触状态 */
    private touching(): boolean {
        return this.alwaysTouching || this.btnTouch || this.toolFingers > 0;
    }

    /** MT 手指数优先；旧设备只有 BTN_TOOL_* / BTN_TOUCH 时用它们兜底 */
    private fingerCount(contacts: TouchContact[]): number {
        // 有 tracking id 时以接触点为准：BTN_TOOL 的释放可能比 tracking id 晚一帧，
        // 用它会重新开一轮并误判成轻触
        if (this.hasTrackingId) return contacts.length;
        return Math.max(contacts.length, this.toolFingers, this.btnTouch ? 1 : 0);
    }

    private primaryContact(): TouchContact | undefined {
        for (const c of this.contacts.values()) if (!c.released) return c;
        return undefined;
    }

    private updateFallback(isX: boolean, code: number, value: number): void {
        const x = this.options.mapX(code, value);
        const y = this.options.mapY(code, value);
        if (isX) {
            if (x !== undefined) this.lastX = x;
            this.lastRawX = value;
        } else {
            if (y !== undefined) this.lastY = y;
            this.lastRawY = value;
        }
        if (this.fallback) this.setPos(this.fallback, isX, code, value);
    }

    private placeFallback(x: number, y: number, rawX?: number, rawY?: number): void {
        if (!this.fallback) return;
        this.fallback.hasX = true;
        this.fallback.hasY = true;
        this.fallback.x = x;
        this.fallback.y = y;
        this.fallback.prevX = x;
        this.fallback.prevY = y;
        this.fallback.rawX = rawX;
        this.fallback.rawY = rawY;
        this.fallback.startRawX = rawX;
        this.fallback.startRawY = rawY;
    }

    private setPos(contact: TouchContact, isX: boolean, code: number, value: number): void {
        const pos = isX ? this.options.mapX(code, value) : this.options.mapY(code, value);
        if (pos === undefined) return;
        if (isX) {
            contact.x = pos;
            contact.rawX = value;
            if (!contact.hasX) {
                contact.hasX = true;
                contact.startRawX = value;
                // 第一个坐标不作为位移，避免从 0 跳到真实位置
                contact.prevX = pos;
            }
        } else {
            contact.y = pos;
            contact.rawY = value;
            if (!contact.hasY) {
                contact.hasY = true;
                contact.startRawY = value;
                contact.prevY = pos;
            }
        }
    }

    /** 任一接触点从按下处移动超过 1.3mm（按设备分辨率折算） */
    private exceedsTapMove(contacts: TouchContact[]): boolean {
        for (const c of contacts) {
            if (c.rawX === undefined || c.startRawX === undefined) continue;
            const dx = (c.rawX - c.startRawX) / this.unitsPerMmX;
            const dy =
                c.rawY !== undefined && c.startRawY !== undefined ? (c.rawY - c.startRawY) / this.unitsPerMmY : 0;
            if (Math.hypot(dx, dy) > TAP_MOVE_MM) return true;
        }
        return false;
    }

    /** 所有接触点相对上一帧的位移之和；返回平均到每个接触点的位移 */
    private consumeMove(contacts: TouchContact[]): { dx: number; dy: number } {
        let dx = 0;
        let dy = 0;
        let n = 0;
        for (const c of contacts) {
            if (c.prevX === undefined || c.prevY === undefined) {
                // 两轴分帧到达时先记住已到的那一轴，避免下一帧补另一轴时算成大位移
                if (c.hasX) c.prevX = c.x;
                if (c.hasY) c.prevY = c.y;
                continue;
            }
            const ddx = c.x - c.prevX;
            const ddy = c.y - c.prevY;
            if (ddx !== 0 || ddy !== 0) {
                dx += ddx;
                dy += ddy;
                n++;
            }
            c.prevX = c.x;
            c.prevY = c.y;
        }
        if (n === 0) return { dx: 0, dy: 0 };
        // 多指时用质心位移（各指平均），单指时就是它自己的位移
        return { dx: dx / n, dy: dy / n };
    }

    private startRound(count: number): void {
        this.roundActive = true;
        this.roundMaxFingers = count;
        switch (this.phase) {
            case "tapped":
                // 轻触后的第二下：按下保持，忽略这一下的 down，等移动/超时决定拖拽或双击
                this.cancelTimer();
                this.phase = "second";
                this.schedule(TAP_TIMEOUT, () => {
                    if (this.phase === "second") this.phase = "dragging";
                });
                break;
            default:
                this.phase = "touch";
                this.schedule(TAP_TIMEOUT, () => {
                    if (this.phase === "touch") this.phase = "hold";
                });
                break;
        }
    }

    private finishRound(actions: TouchpadAction[]): void {
        switch (this.phase) {
            case "touch": {
                const button = this.tapButton(this.roundMaxFingers);
                if (button === 0) {
                    // 单指轻触：按下，等第二下拖拽或拖拽窗口结束
                    this.press(actions);
                    this.phase = "tapped";
                    this.schedule(DRAG_TIMEOUT, () => {
                        if (this.phase === "tapped") this.releaseDirect();
                    });
                } else if (button !== undefined) {
                    // 双指/三指轻触直接点击
                    actions.push({ type: "button", action: "down", button });
                    actions.push({ type: "button", action: "up", button });
                    this.phase = "idle";
                } else {
                    this.phase = "idle";
                }
                break;
            }
            case "second":
                // 第二下快速抬起：双击，先结束上一次点击再按下本次
                this.unpress(actions);
                this.press(actions);
                this.phase = "tapped";
                this.schedule(DRAG_TIMEOUT, () => {
                    if (this.phase === "tapped") this.releaseDirect();
                });
                break;
            case "dragging":
                // 手指抬起，结束拖拽
                this.release(actions);
                break;
            default:
                this.phase = "idle";
                break;
        }

        this.roundActive = false;
        this.roundMaxFingers = 0;
        this.multiFingers = 0;
        this.scrolling = false;
        this.contacts.clear();
        this.fallback = undefined;
    }

    /** 按下左键 */
    private press(actions: TouchpadAction[]): void {
        actions.push({ type: "button", action: "down", button: 0 });
        this.pressedButton = 0;
    }

    /** 抬起按键并回到 idle */
    private release(actions: TouchpadAction[]): void {
        this.cancelTimer();
        const button = this.pressedButton;
        this.pressedButton = undefined;
        this.phase = "idle";
        if (button !== undefined && !this.physicalDown.has(button)) {
            actions.push({ type: "button", action: "up", button });
        }
    }

    /** 只在没有物理按键接管时抬起 */
    private releaseDirect(): void {
        this.cancelTimer();
        const button = this.pressedButton;
        this.pressedButton = undefined;
        this.phase = "idle";
        if (button !== undefined && !this.physicalDown.has(button)) {
            this.emit("button", "up", button);
        }
    }

    /** 只清按键，调用方决定下一个 phase（双击/多指切换） */
    private unpress(actions: TouchpadAction[]): void {
        this.cancelTimer();
        const button = this.pressedButton;
        this.pressedButton = undefined;
        if (button !== undefined && !this.physicalDown.has(button)) {
            actions.push({ type: "button", action: "up", button });
        }
    }

    private schedule(delay: number, fn: () => void): void {
        this.cancelTimer();
        const timer = setTimeout(() => {
            this.timer = undefined;
            fn();
        }, delay);
        (timer as { unref?: () => void }).unref?.();
        this.timer = timer;
    }

    private cancelTimer(): void {
        if (this.timer === undefined) return;
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    private tapButton(fingers: number): number | undefined {
        if (fingers === 1) return 0;
        if (fingers === 2) return 2;
        if (fingers === 3) return 1;
        return undefined;
    }

    private buttonOf(code: number): number | undefined {
        if (code === InputEventCodes.BTN_LEFT) return 0;
        if (code === InputEventCodes.BTN_MIDDLE) return 1;
        if (code === InputEventCodes.BTN_RIGHT) return 2;
        return undefined;
    }
}

/** 设备是否提供手指接触/手指数信号（BTN_TOUCH 或 BTN_TOOL_*） */
function hasTouchpadTouchSignal(keyCodes: number[]): boolean {
    return keyCodes.includes(InputEventCodes.BTN_TOUCH) || keyCodes.some((c) => TOOL_FINGERS[c] !== undefined);
}
