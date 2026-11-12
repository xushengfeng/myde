// 触摸板事件工具：把 input api 的原始设备事件封装成移动/滚动/按键事件
//
// 只有这个工具接触 BTN_TOUCH/ABS_MT_* 等键码，桌面只订阅语义事件；
// 轻触、双指滚动、双指/三指按键和拖拽都在这里转换成统一的按钮/滚动动作。
import type { DeviceInfo, InputDevice } from "myde-input";
import { EventEmitter } from "../event-emitter/event-emitter";
import { InputEventCodes } from "../input_codes/types";

/** 轻触（tap）允许的最长接触时间 */
export const TAP_TIMEOUT = 300;
/** 轻触允许的最大位移，超过就当成移动/滚动 */
export const TAP_MOVE = 16;
/** 轻触后再次按下，在这个时间窗内移动会进入拖拽 */
export const DRAG_TIMEOUT = 300;
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
    /** 伴随鼠标节点在出事件时，绝对坐标不能再用（避免双倍移动） */
    ignoreAbs?(): boolean;
    now?(): number;
}

/** 一个接触点，坐标为视口像素 */
interface TouchContact {
    x: number;
    y: number;
    /** X/Y 是否都收到过坐标（MT 的 X、Y 分两个事件到达） */
    hasX: boolean;
    hasY: boolean;
    /** 本轮接触的起点，用于判断轻触 */
    startX: number;
    startY: number;
    /** 上一帧坐标，用于计算位移 */
    prevX?: number;
    prevY?: number;
    /** 本帧抬起，sync 后删除 */
    released: boolean;
}

type TouchpadAction =
    | { type: "move"; dx: number; dy: number }
    | { type: "scroll"; deltaX: number; deltaY: number }
    | { type: "multiStart"; fingers: number }
    | { type: "multiMove"; fingers: number; dx: number; dy: number }
    | { type: "multiEnd"; fingers: number }
    | { type: "button"; action: "down" | "up"; button: number };

/** 把一台触摸板设备的 input api 事件封装成 TouchpadEvents */
export class TouchpadInput extends EventEmitter<TouchpadEvents> {
    private readonly options: TouchpadInputOptions;
    private readonly now: () => number;
    private readonly hasTrackingId: boolean;
    private readonly alwaysTouching: boolean;

    /** MT slot → 接触点 */
    private contacts = new Map<number, TouchContact>();
    /** 没有 MT tracking id 时，用 BTN_TOUCH/ABS_X 的单一接触点 */
    private fallback: TouchContact | undefined;
    /** fallback 建立前先记住最近一次坐标 */
    private lastX: number | undefined;
    private lastY: number | undefined;

    private slot = 0;
    private btnTouch = false;
    private toolFingers = 0;
    private readonly physicalDown = new Set<number>();

    private roundActive = false;
    private roundStart = 0;
    private roundMaxFingers = 0;
    private roundMoved = 0;
    private roundHadButton = false;
    /** 这一轮是上一次轻触后的第二下，移动超过阈值就变成拖拽 */
    private roundCanDrag = false;
    private dragging = false;
    /** 上一次单指轻触的时间，用于开启拖拽窗口 */
    private tapArmedAt: number | undefined;
    /** 当前三指及以上手势的手指数，0 表示没有 */
    private multiFingers = 0;

    /** 物理按键在帧末统一发出 */
    private pending: TouchpadAction[] = [];

    constructor(dev: InputDevice, info: DeviceInfo, options: TouchpadInputOptions) {
        super();
        this.options = options;
        this.now = options.now ?? (() => performance.now());
        this.hasTrackingId = info.capabilities.absAxes.includes(InputEventCodes.ABS_MT_TRACKING_ID);
        this.alwaysTouching = !hasTouchpadTouchSignal(info.capabilities.keyCodes);
        dev.on("absolute", (code, value) => this.absolute(code, value));
        dev.on("key", (code, value) => this.key(code, value));
        dev.on("sync", () => this.flush());
    }

    private flush(): void {
        const actions = this.pending.splice(0);
        const now = this.now();
        const contacts = this.activeContacts();
        const count = this.fingerCount(contacts);

        if (!this.roundActive && count > 0) this.startRound(count, now);
        if (this.roundActive) {
            this.roundMaxFingers = Math.max(this.roundMaxFingers, count);
            this.roundMoved = Math.max(this.roundMoved, this.maxMove(contacts));
        }

        const { dx, dy } = this.consumeMove(contacts);
        const ignoreAbs = this.options.ignoreAbs?.() ?? false;

        if (this.roundActive) {
            // 第二下按住后移动，进入拖拽（先按下左键再走位移）
            if (this.roundCanDrag && !this.dragging && count === 1 && this.roundMoved > TAP_MOVE) {
                this.roundCanDrag = false;
                this.dragging = true;
                actions.push({ type: "button", action: "down", button: 0 });
            }
            // 拖拽中又落下第二根手指：结束拖拽，避免左键卡住
            if (this.dragging && count !== 1) {
                this.dragging = false;
                actions.push({ type: "button", action: "up", button: 0 });
            }

            if (!ignoreAbs && (dx !== 0 || dy !== 0)) {
                if (count === 1) {
                    actions.push({ type: "move", dx, dy });
                } else if (count === 2) {
                    // 自然滚动：内容跟随手指，手指上移对应内容向下滚
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

        if (this.roundActive && count === 0) this.finishRound(now, actions);

        for (const action of actions) {
            if (action.type === "button") this.emit("button", action.action, action.button);
            else if (action.type === "scroll") this.emit("scroll", action.deltaX, action.deltaY);
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
            if (this.roundActive) this.roundHadButton = true;
            this.pending.push({ type: "button", action: "down", button });
        } else if (value === 0) {
            this.physicalDown.delete(button);
            this.pending.push({ type: "button", action: "up", button });
        }
    }

    private newContact(): TouchContact {
        return { x: 0, y: 0, hasX: false, hasY: false, startX: 0, startY: 0, released: false };
    }

    /** 当前按下的接触点（含本帧已抬起但还没清理的） */
    private activeContacts(): TouchContact[] {
        const list: TouchContact[] = [];
        for (const c of this.contacts.values()) if (!c.released) list.push(c);

        if (!this.hasTrackingId) {
            if (!this.touching()) {
                if (this.fallback) this.fallback.released = true;
            } else if (!this.fallback) {
                this.fallback = this.newContact();
                if (this.lastX !== undefined && this.lastY !== undefined) {
                    this.placeFallback(this.lastX, this.lastY);
                }
            }
        }
        if (this.fallback) {
            if (this.fallback.released) this.fallback = undefined;
            else list.push(this.fallback);
        }
        return list;
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
        if (isX && x !== undefined) this.lastX = x;
        if (!isX && y !== undefined) this.lastY = y;
        if (this.fallback) this.setPos(this.fallback, isX, code, value);
    }

    private placeFallback(x: number, y: number): void {
        if (!this.fallback) return;
        this.fallback.hasX = true;
        this.fallback.hasY = true;
        this.fallback.x = x;
        this.fallback.y = y;
        this.fallback.startX = x;
        this.fallback.startY = y;
        this.fallback.prevX = x;
        this.fallback.prevY = y;
    }

    private setPos(contact: TouchContact, isX: boolean, code: number, value: number): void {
        const pos = isX ? this.options.mapX(code, value) : this.options.mapY(code, value);
        if (pos === undefined) return;
        if (isX) {
            contact.x = pos;
            if (!contact.hasX) {
                contact.hasX = true;
                contact.startX = pos;
                // 第一个坐标不作为位移，避免从 0 跳到真实位置
                contact.prevX = pos;
            }
        } else {
            contact.y = pos;
            if (!contact.hasY) {
                contact.hasY = true;
                contact.startY = pos;
                contact.prevY = pos;
            }
        }
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

    private maxMove(contacts: TouchContact[]): number {
        let max = 0;
        for (const c of contacts) {
            if (!c.hasX || !c.hasY) continue;
            max = Math.max(max, Math.hypot(c.x - c.startX, c.y - c.startY));
        }
        return max;
    }

    private startRound(count: number, now: number): void {
        this.roundActive = true;
        this.roundStart = now;
        this.roundMaxFingers = count;
        this.roundMoved = 0;
        this.roundHadButton = this.physicalDown.size > 0;
        this.roundCanDrag = count === 1 && this.tapArmedAt !== undefined && now - this.tapArmedAt <= DRAG_TIMEOUT;
        this.tapArmedAt = undefined;
    }

    private finishRound(now: number, actions: TouchpadAction[]): void {
        if (this.dragging) {
            this.dragging = false;
            actions.push({ type: "button", action: "up", button: 0 });
        } else if (!this.roundHadButton && now - this.roundStart <= TAP_TIMEOUT && this.roundMoved <= TAP_MOVE) {
            const button = this.tapButton(this.roundMaxFingers);
            if (button !== undefined) {
                actions.push({ type: "button", action: "down", button });
                actions.push({ type: "button", action: "up", button });
                // 单指轻触后短时间再按住并移动 → 拖拽
                if (button === 0) this.tapArmedAt = now;
            }
        }

        this.roundActive = false;
        this.roundCanDrag = false;
        this.roundMoved = 0;
        this.roundMaxFingers = 0;
        this.multiFingers = 0;
        this.contacts.clear();
        this.fallback = undefined;
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
