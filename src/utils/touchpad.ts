// 触摸板事件工具：把 input api 的原始设备事件封装成移动/滚动/按键事件
//
// 只有这个工具接触 BTN_TOUCH/ABS_MT_* 等键码，桌面只订阅语义事件；
// 轻触、双指滚动/捏合、按住、多指滑动、双指/三指按键和拖拽都在这里转换成统一动作。
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
/** 双指距离相对 begin 变化超过这个比例才算捏合，避免滚动时两指轻微张合误触 */
export const PINCH_SCALE_THRESHOLD = 0.1;
/** 双指距离相对 begin 至少变化这么多毫米才算捏合（两指靠得近时 10% 的绝对量太小） */
export const PINCH_MIN_DISTANCE_CHANGE_MM = 2.5;
/** 双指夹角相对 begin 变化超过这个角度（度）才算旋转 */
export const PINCH_ROTATE_THRESHOLD = 15;
/** 两指距离太近时 scale 不稳定，不启动捏合 */
const PINCH_MIN_DISTANCE_MM = 0.5;
/** 判定为双指滚动前，质心至少移动这么多毫米 */
export const TWO_FINGER_SCROLL_START_MM = 1.5;
/** 手指保持不动多久算 hold */
export const HOLD_TIMEOUT = 300;
/** hold 允许的最大位移（毫米），超过后转成滚动/滑动并取消 hold */
export const HOLD_MOVE_MM = 2;

/** 把角度归一化到 [-180, 180)，用于捏合旋转。 */
function normalizeAngle(deg: number): number {
    return ((((deg + 180) % 360) + 360) % 360) - 180;
}

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
    /** 双指捏合开始（缩放/旋转），与双指滚动互斥 */
    pinchStart: [fingers: number];
    /** 双指捏合更新：质心位移、相对 begin 的缩放、相对上一次的顺时针角度 */
    pinchUpdate: [deltaX: number, deltaY: number, scale: number, rotation: number];
    /** 双指捏合结束 */
    pinchEnd: [cancelled: boolean];
    /** 手指按住不动达到 HOLD_TIMEOUT；1 指及以上检测 */
    holdStart: [fingers: number];
    /** hold 结束；cancelled 表示变成滚动/滑动或手指数量变化 */
    holdEnd: [cancelled: boolean];
    /** 三指及以上开始移动；官方桌面用它做切屏/总览，其他桌面也可当 swipe 使用 */
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
    /** 调试双指分类；显式传入时每帧调用，生产环境不要设置 */
    debugGesture?(info: {
        count: number;
        dx: number;
        dy: number;
        distance: number;
        scale: number;
        rotation: number;
        mode: "undecided" | "scroll" | "pinch";
    }): void;
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
    | { type: "pinchStart"; fingers: number }
    | { type: "pinchUpdate"; deltaX: number; deltaY: number; scale: number; rotation: number }
    | { type: "pinchEnd"; cancelled: boolean }
    | { type: "holdStart"; fingers: number }
    | { type: "holdEnd"; cancelled: boolean }
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
    /** touch/second 判定期间先不移动光标，攒下的位移在确认是移动/拖拽时一次补上 */
    private suppressedMoveX = 0;
    private suppressedMoveY = 0;
    /** 当前三指及以上手势的手指数，0 表示没有 */
    private multiFingers = 0;
    /** 本轮接触出现过多指：之后残留的两指/单指不再产生滚动、捏合、hold 或光标移动 */
    private multiRound = false;
    /** 是否正在双指滚动，手指数量变化时补一次 scrollEnd */
    private scrolling = false;
    /** 双指捏合状态；存在但 active=false 表示还在等阈值 */
    private pinch:
        | {
              active: boolean;
              /** 已经判定为滚动，本轮接触不再尝试 pinch */
              scrollMode: boolean;
              startDistance: number;
              startAngle: number;
              lastAngle: number;
              lastScale: number;
              startCenterX: number;
              startCenterY: number;
              /** 判定前暂存的滚动量（已按自然滚动取反） */
              pendingScrollX: number;
              pendingScrollY: number;
          }
        | undefined;
    /** 按住状态；active=false 表示计时中 */
    private hold: { active: boolean; fingers: number; x: number; y: number } | undefined;
    private holdTimer: ReturnType<typeof setTimeout> | undefined;
    /** 本轮接触已经取消过 hold（移动或手指数变化），不再重新计时 */
    private holdBlocked = false;

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
        const rangeX = absRange(info, xCode);
        const rangeY = absRange(info, yCode);
        // libinput：没有分辨率时按 69x50mm 的触摸板估算（不是默认鼠标 DPI）
        // 有些设备只在 ABS_X/ABS_Y 上报分辨率，或者反过来；任一有效就用
        const resX =
            (rangeX && rangeX.resolution > 1 ? rangeX.resolution : 0) ||
            (absRange(info, InputEventCodes.ABS_X)?.resolution ?? 0);
        const resY =
            (rangeY && rangeY.resolution > 1 ? rangeY.resolution : 0) ||
            (absRange(info, InputEventCodes.ABS_Y)?.resolution ?? 0);
        this.unitsPerMmX =
            resX > 0 ? resX : rangeX && rangeX.max > rangeX.min ? (rangeX.max - rangeX.min) / 69 : DEFAULT_UNITS_PER_MM;
        this.unitsPerMmY =
            resY > 0 ? resY : rangeY && rangeY.max > rangeY.min ? (rangeY.max - rangeY.min) / 50 : DEFAULT_UNITS_PER_MM;
        dev.on("absolute", (code, value) => this.absolute(code, value));
        dev.on("key", (code, value) => this.key(code, value));
        dev.on("sync", () => this.flush());
    }

    /**
     * 设备移除/停止使用时收尾：结束进行中的滚动和多指手势，抬起还按着的键，清掉判定定时器与接触点。
     * 事件在这里同步发出，调用方要保证此时仍能分发。
     */
    dispose(): void {
        this.cancelTimer();
        this.endHold(false);
        if (this.pinch?.active) this.emit("pinchEnd", true);
        this.pinch = undefined;
        this.holdBlocked = false;
        // 已按下但还没抬起的物理键：等状态机的按下已经发过 down，这里补 up
        const pendingDowns = new Set<number>();
        for (const action of this.pending) {
            if (action.type === "button" && action.action === "down") pendingDowns.add(action.button);
        }
        if (this.scrolling) {
            this.scrolling = false;
            this.emit("scrollEnd");
        }
        if (this.multiFingers > 0) {
            const fingers = this.multiFingers;
            this.multiFingers = 0;
            this.emit("multiEnd", fingers);
        }
        const pressed = this.pressedButton;
        this.pressedButton = undefined;
        if (pressed !== undefined && !this.physicalDown.has(pressed)) this.emit("button", "up", pressed);
        for (const button of this.physicalDown) {
            // 还没随 sync 发出的 down 没有对应的 up
            if (!pendingDowns.has(button)) this.emit("button", "up", button);
        }
        this.physicalDown.clear();
        this.pending = [];
        this.contacts.clear();
        this.fallback = undefined;
        this.lastX = undefined;
        this.lastY = undefined;
        this.lastRawX = undefined;
        this.lastRawY = undefined;
        this.btnTouch = false;
        this.toolFingers = 0;
        this.phase = "idle";
        this.roundActive = false;
        this.roundMaxFingers = 0;
        this.multiRound = false;
        this.suppressedMoveX = 0;
        this.suppressedMoveY = 0;
    }

    private flush(): void {
        const actions = this.pending.splice(0);
        // 抬起的那一帧也可能带着最后一小段位移，位移要用包含已抬起的全部接触点算
        const { active: contacts, all } = this.activeContacts();
        const count = this.fingerCount(contacts);

        if (!this.roundActive && count > 0) this.startRound(count);
        if (this.roundActive) this.roundMaxFingers = Math.max(this.roundMaxFingers, count);
        // 本轮已经出现过多指：之后即使只抬起一部分，也不再从残留手指开始滚动/捏合
        if (count >= 3) this.multiRound = true;

        // 双指滚动在手指数量变化（抬手、加入第三根）时结束
        if (this.scrolling && count !== 2) {
            this.scrolling = false;
            actions.push({ type: "scrollEnd" });
        }

        // 捏合也只在恰好两指时有效；手指数变化就结束
        if (this.pinch && count !== 2) {
            if (this.pinch.active) actions.push({ type: "pinchEnd", cancelled: count >= 3 });
            this.pinch = undefined;
        }

        // 按住不动：计时/取消/结束都在这里维护，事件直接发出（定时器不进 actions）
        this.updateHold(contacts, count);

        // 按住左键时落下第二根手指：结束按键，交给多指手势（避免左键卡住）
        if (this.roundActive && count >= 2 && this.pressedButton !== undefined) {
            this.unpress(actions);
            this.phase = "moving";
        }

        let { dx, dy } = this.consumeMove(all);
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

            // 双指分类器优先：判定前暂存滚动，避免先发滚动导致客户端忽略随后的 pinch
            const twoFingerHandled = this.updatePinch(contacts, count, dx, dy, actions);

            // 判定期间先别移动光标：轻触的按下点要落在最初接触的位置，不能带上抖动位移
            const decidingMotion = this.phase === "touch" || this.phase === "second";
            const single = count === 1 || (count === 0 && all.length === 1);
            if (single && decidingMotion) {
                this.suppressedMoveX += dx;
                this.suppressedMoveY += dy;
                dx = 0;
                dy = 0;
            } else if (single && (this.suppressedMoveX !== 0 || this.suppressedMoveY !== 0)) {
                // 确认是移动/拖拽：把判定期间攒下的位移一次补上
                dx += this.suppressedMoveX;
                dy += this.suppressedMoveY;
                this.suppressedMoveX = 0;
                this.suppressedMoveY = 0;
            }

            if (dx !== 0 || dy !== 0) {
                // 抬起的那一帧也可能带着最后一小段位移：单指接触（含本帧抬起）照发 move
                if (single) {
                    // 多指手势之后残留的单指不再移动光标；两指降为单指是允许的例外
                    if (!ignoreAbs && !this.multiRound) actions.push({ type: "move", dx, dy });
                } else if (count === 2 && !twoFingerHandled) {
                    // 自然滚动：内容跟随手指，手指上移对应内容向下滚
                    this.scrolling = true;
                    actions.push({
                        type: "scroll",
                        deltaX: dx === 0 ? 0 : -dx * SCROLL_GAIN,
                        deltaY: dy === 0 ? 0 : -dy * SCROLL_GAIN,
                    });
                }
            }

            // 三指及以上单独封装成多指移动事件（桌面按 swipe 使用），不参与光标/双指滚动
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
            else if (action.type === "pinchStart") this.emit("pinchStart", action.fingers);
            else if (action.type === "pinchUpdate")
                this.emit("pinchUpdate", action.deltaX, action.deltaY, action.scale, action.rotation);
            else if (action.type === "pinchEnd") this.emit("pinchEnd", action.cancelled);
            else if (action.type === "holdStart") this.emit("holdStart", action.fingers);
            else if (action.type === "holdEnd") this.emit("holdEnd", action.cancelled);
            else if (action.type === "multiStart") this.emit("multiStart", action.fingers);
            else if (action.type === "multiMove") this.emit("multiMove", action.fingers, action.dx, action.dy);
            else if (action.type === "multiEnd") this.emit("multiEnd", action.fingers);
            else this.emit("move", action.dx, action.dy);
        }
    }

    /** 接触点位置：优先用设备原始值换算成毫米，没有原始值时退回视口像素。 */
    private contactPoint(contact: TouchContact): { x: number; y: number } | undefined {
        if (contact.rawX !== undefined && contact.rawY !== undefined) {
            return { x: contact.rawX / this.unitsPerMmX, y: contact.rawY / this.unitsPerMmY };
        }
        if (contact.hasX && contact.hasY) return { x: contact.x, y: contact.y };
        return undefined;
    }

    /** 两指距离、连线角度（度，屏幕坐标顺时针为正）与质心。 */
    private pairGeometry(
        contacts: TouchContact[],
    ): { distance: number; angle: number; centerX: number; centerY: number } | undefined {
        if (contacts.length !== 2) return undefined;
        const a = this.contactPoint(contacts[0]);
        const b = this.contactPoint(contacts[1]);
        if (!a || !b) return undefined;
        return {
            distance: Math.hypot(b.x - a.x, b.y - a.y),
            angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
            centerX: (a.x + b.x) / 2,
            centerY: (a.y + b.y) / 2,
        };
    }

    /** 接触点质心，用于判断 hold 的位移。 */
    private contactCenter(contacts: TouchContact[]): { x: number; y: number } | undefined {
        if (contacts.length === 0) return undefined;
        let x = 0;
        let y = 0;
        for (const contact of contacts) {
            const point = this.contactPoint(contact);
            if (!point) return undefined;
            x += point.x;
            y += point.y;
        }
        return { x: x / contacts.length, y: y / contacts.length };
    }

    /**
     * 双指分类器：先判断是 pinch 还是滚动，判定前暂存滚动量。
     *
     * 不先发滚动再切 pinch：客户端一旦收到 axis 就可能进入滚动状态，后续 pinch 会被忽略。
     * 质心移动达到阈值且两指距离基本不变时判为滚动；距离变化达到 pinch 阈值时判为 pinch。
     * 返回 true 表示这两指已经由本函数处理，调用方不能再发 scroll。
     */
    private updatePinch(
        contacts: TouchContact[],
        count: number,
        dx: number,
        dy: number,
        actions: TouchpadAction[],
    ): boolean {
        // 多指手势之后残留的两指不再判 pinch/滚动
        if (this.multiRound) return true;
        if (count !== 2) return false;
        const pair = this.pairGeometry(contacts);
        if (!pair) return false;
        if (!this.pinch) {
            this.pinch = {
                active: false,
                scrollMode: false,
                startDistance: pair.distance,
                startAngle: pair.angle,
                lastAngle: pair.angle,
                lastScale: 1,
                startCenterX: pair.centerX,
                startCenterY: pair.centerY,
                pendingScrollX: 0,
                pendingScrollY: 0,
            };
        }
        const pinch = this.pinch;
        const scale = pinch.startDistance > 0 ? pair.distance / pinch.startDistance : 1;
        const startRotation = normalizeAngle(pair.angle - pinch.startAngle);
        const distanceChange = Math.abs(pair.distance - pinch.startDistance);
        const centerMove = Math.hypot(pair.centerX - pinch.startCenterX, pair.centerY - pinch.startCenterY);
        // 两指张合要明显大于质心平移才像捏合：滚动是两指同向平移，距离基本不变，
        // 只是收拢时距离变化会和质心位移同数量级，必须让滚动赢，否则容易误判
        const scaled =
            distanceChange >= PINCH_MIN_DISTANCE_CHANGE_MM &&
            Math.abs(scale - 1) >= PINCH_SCALE_THRESHOLD &&
            distanceChange > centerMove;
        // 质心基本不动的原地扭转也算捏合，滚动时质心一定在移动，不会走到这里
        const rotated = Math.abs(startRotation) >= PINCH_ROTATE_THRESHOLD && centerMove < TWO_FINGER_SCROLL_START_MM;
        const shouldPinch = scaled || rotated;
        this.options.debugGesture?.({
            count,
            dx,
            dy,
            distance: pair.distance,
            scale,
            rotation: startRotation,
            mode: pinch.active ? "pinch" : pinch.scrollMode ? "scroll" : "undecided",
        });

        // 一旦判为滚动，本轮接触就不再改判 pinch，避免滚动中两指轻微张合误触。
        if (pinch.scrollMode) {
            const scrollX = dx === 0 ? 0 : -dx * SCROLL_GAIN;
            const scrollY = dy === 0 ? 0 : -dy * SCROLL_GAIN;
            if (scrollX !== 0 || scrollY !== 0) {
                this.scrolling = true;
                actions.push({ type: "scroll", deltaX: scrollX, deltaY: scrollY });
            }
            return true;
        }

        if (!pinch.active) {
            if (pinch.startDistance < PINCH_MIN_DISTANCE_MM) {
                // 起点太近（两指几乎重合），等下一次 flush 用新的距离重新开始
                this.pinch = undefined;
                return false;
            }
            if (shouldPinch) {
                this.beginPinch(pair.distance, pair.angle, dx, dy, actions);
                return true;
            }

            // 还没到 pinch 阈值：先把滚动攒着，等分类结果
            pinch.pendingScrollX += dx === 0 ? 0 : -dx * SCROLL_GAIN;
            pinch.pendingScrollY += dy === 0 ? 0 : -dy * SCROLL_GAIN;
            // 质心移动大于两指距离变化才像滚动；两指相互张合更像 pinch，继续等阈值
            if (centerMove >= TWO_FINGER_SCROLL_START_MM && centerMove > distanceChange) {
                pinch.scrollMode = true;
                const pendingX = pinch.pendingScrollX;
                const pendingY = pinch.pendingScrollY;
                pinch.pendingScrollX = 0;
                pinch.pendingScrollY = 0;
                if (pendingX !== 0 || pendingY !== 0) {
                    this.scrolling = true;
                    actions.push({ type: "scroll", deltaX: pendingX, deltaY: pendingY });
                }
                return true;
            }
            // 分类中：本帧不发滚动
            return true;
        }

        // pinch 期间保留滚动：质心移动照样发 scroll，双方互不取消
        const scrollX = dx === 0 ? 0 : -dx * SCROLL_GAIN;
        const scrollY = dy === 0 ? 0 : -dy * SCROLL_GAIN;
        if (scrollX !== 0 || scrollY !== 0) {
            this.scrolling = true;
            actions.push({ type: "scroll", deltaX: scrollX, deltaY: scrollY });
        }
        const rotation = normalizeAngle(pair.angle - pinch.lastAngle);
        const changed = dx !== 0 || dy !== 0 || Math.abs(scale - pinch.lastScale) > 0.001 || Math.abs(rotation) > 0.001;
        pinch.lastAngle = pair.angle;
        pinch.lastScale = scale;
        if (changed) actions.push({ type: "pinchUpdate", deltaX: dx, deltaY: dy, scale, rotation });
        return true;
    }

    /**
     * 进入 pinch：以触发时的两指位置作为起点（scale=1、rotation=0），
     * 越过阈值之前的张合量不再补发，避免客户端一开始就跳一下。
     * 分类期间攒下的滚动照常放出去。
     */
    private beginPinch(distance: number, angle: number, dx: number, dy: number, actions: TouchpadAction[]): void {
        const pinch = this.pinch;
        if (!pinch) return;
        pinch.active = true;
        pinch.scrollMode = false;
        pinch.startDistance = distance;
        pinch.startAngle = angle;
        pinch.lastAngle = angle;
        pinch.lastScale = 1;
        // 进入捏合后不能再合成两指右键
        this.cancelTimer();
        if (this.phase === "touch" || this.phase === "hold" || this.phase === "second") {
            this.phase = "moving";
        }
        this.endHold(true);
        // pinch 不取消滚动：把分类期间攒下的滚动和本帧位移一起放出去
        const scrollX = pinch.pendingScrollX + (dx === 0 ? 0 : -dx * SCROLL_GAIN);
        const scrollY = pinch.pendingScrollY + (dy === 0 ? 0 : -dy * SCROLL_GAIN);
        pinch.pendingScrollX = 0;
        pinch.pendingScrollY = 0;
        if (scrollX !== 0 || scrollY !== 0) {
            this.scrolling = true;
            actions.push({ type: "scroll", deltaX: scrollX, deltaY: scrollY });
        }
        actions.push({ type: "pinchStart", fingers: 2 });
    }

    /** 维护按住手势：手指不动达到 HOLD_TIMEOUT 后开始；移动或手指数变化取消。 */
    private updateHold(contacts: TouchContact[], count: number): void {
        if (count === 0) {
            this.endHold(false);
            return;
        }
        // 多指手势中途只剩 1-2 指时不再开始 hold；三指按住本身仍算 hold
        if (this.multiRound && count < 3) {
            this.endHold(true);
            return;
        }
        if (this.pinch?.active) {
            this.endHold(true);
            return;
        }
        const hold = this.hold;
        if (hold) {
            if (hold.fingers !== count) {
                this.stopHold(true);
                return;
            }
            const center = this.contactCenter(contacts);
            if (center && Math.hypot(center.x - hold.x, center.y - hold.y) > HOLD_MOVE_MM) {
                this.stopHold(true);
            }
            return;
        }
        this.startHoldTimer(contacts, count);
    }

    private startHoldTimer(contacts: TouchContact[], count: number): void {
        if (this.holdBlocked || this.hold || count === 0 || this.pinch?.active) return;
        const center = this.contactCenter(contacts);
        if (!center) return;
        const hold = { active: false, fingers: count, x: center.x, y: center.y };
        this.hold = hold;
        const timer = setTimeout(() => {
            this.holdTimer = undefined;
            if (this.hold !== hold || !this.roundActive || this.pinch?.active) {
                if (this.hold === hold) this.hold = undefined;
                return;
            }
            hold.active = true;
            this.emit("holdStart", hold.fingers);
        }, HOLD_TIMEOUT);
        (timer as { unref?: () => void }).unref?.();
        this.holdTimer = timer;
    }

    /** 结束 hold；只有已经发过 begin 才补 end。 */
    private endHold(cancelled: boolean): void {
        this.cancelHoldTimer();
        const hold = this.hold;
        this.hold = undefined;
        if (hold?.active) this.emit("holdEnd", cancelled);
    }

    /** 本轮接触已经进入移动/换指，不再尝试 hold。 */
    private stopHold(cancelled: boolean): void {
        this.endHold(cancelled);
        this.holdBlocked = true;
    }

    private cancelHoldTimer(): void {
        if (this.holdTimer === undefined) return;
        clearTimeout(this.holdTimer);
        this.holdTimer = undefined;
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
        this.pinch = undefined;
        this.holdBlocked = false;
        this.multiRound = false;
        switch (this.phase) {
            case "tapped":
                // 轻触后的第二下：按下保持，忽略这一下的 down，等移动/超时决定拖拽或双击
                this.cancelTimer();
                this.phase = "second";
                this.schedule(TAP_TIMEOUT, () => {
                    if (this.phase !== "second") return;
                    this.phase = "dragging";
                    // 第二下被判成拖拽后，把判定期间攒的位移补出去，客户端才不会把按下+抬起当成点击
                    this.flushSuppressedMove();
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
                // 手指抬起，结束拖拽；先补上还没发出的位移
                this.flushSuppressedMove();
                this.release(actions);
                break;
            default:
                this.phase = "idle";
                break;
        }

        this.roundActive = false;
        this.roundMaxFingers = 0;
        this.multiFingers = 0;
        this.multiRound = false;
        this.scrolling = false;
        this.pinch = undefined;
        this.endHold(false);
        this.holdBlocked = false;
        this.suppressedMoveX = 0;
        this.suppressedMoveY = 0;
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

    /** 把判定期间攒下的位移直接补发（定时器/结束拖拽时用，没有 actions 上下文） */
    private flushSuppressedMove(): void {
        if (this.suppressedMoveX === 0 && this.suppressedMoveY === 0) return;
        const dx = this.suppressedMoveX;
        const dy = this.suppressedMoveY;
        this.suppressedMoveX = 0;
        this.suppressedMoveY = 0;
        this.emit("move", dx, dy);
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
