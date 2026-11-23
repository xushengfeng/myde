import type { UniInputEvent, UniPointerEvent, WinHandle } from "../../../../src/desktop-api";
import type { GestureCommand } from "../../../../src/wayland";

export interface TouchpadModeDeps {
    /** 走桌面的统一输入分发，保证 Wayland 客户端、光标和桌面 UI 同步 */
    dispatch(event: UniInputEvent): void;
    /** 触摸点是否落在键盘自己的 UI 上（触控板表面不算） */
    isKeyboardUiAt(x: number, y: number): boolean;
    getPointer(): { x: number; y: number };
    /** 与物理触摸板共用滚动方向和速度 */
    getScrollConfig(): { naturalScroll: boolean; scrollGain: number };
    startDesktopGesture(): void;
    moveDesktopGesture(dx: number, dy: number): void;
    endDesktopGesture(): void;
    /** 手指捏合/滑动发给指针下的客户端 */
    gesture(event: GestureCommand, x: number, y: number): WinHandle | undefined;
    notifyGesture(handle: WinHandle, event: GestureCommand): void;
}

interface Contact {
    id: number;
    x: number;
    y: number;
    /** 从本次接触开始到现在的累计位移 */
    moved: number;
}

type Mode = "idle" | "cursor" | "drag" | "two" | "three" | "four";

const TAP_MAX_MOVE = 10;
const HOLD_DELAY = 220;
const TWO_FINGER_DECIDE_MOVE = 6;
const PINCH_MIN_CHANGE = 14;
const SWIPE_START_MOVE = 10;
/** 面板内单指从手指位移到指针位移的固定倍率 */
const POINTER_GAIN = 1.6;

function pointDistance(contacts: Contact[]): { distance: number; angle: number; cx: number; cy: number } {
    if (contacts.length !== 2) return { distance: 0, angle: 0, cx: 0, cy: 0 };
    const [a, b] = contacts as [Contact, Contact];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return {
        distance: Math.hypot(dx, dy),
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
    };
}

function normalizeAngle(deg: number) {
    return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/**
 * 把触屏映射为触控板。
 *
 * 只有触控板页激活时工作；接触点落在键盘 UI 上时整轮交给普通触摸路径，
 * 其余接触点移动系统指针、合成点击/滚轮，并把捏合、四指滑动转发给应用。
 */
export class TouchpadMode {
    private active = false;
    private contacts = new Map<number, Contact>();
    private ignored = false;
    private ignoredContacts = new Set<number>();
    private mode: Mode = "idle";
    private pos = { x: 0, y: 0 };
    private startAt = 0;
    private maxContacts = 0;
    private moved = 0;
    private holdTimer: number | undefined;
    private lastCentroid = { x: 0, y: 0 };
    private startCentroid = { x: 0, y: 0 };

    private twoMode: "undecided" | "scroll" | "pinch" = "undecided";
    private twoStartCentroid = { x: 0, y: 0 };
    private pinchStartDistance = 0;
    private pinchLastAngle = 0;
    private pinchActive = false;

    private threeStarted = false;
    private swipeStarted = false;
    private gestureTarget: WinHandle | undefined;
    private gestureKind: "pinch" | "swipe" | undefined;

    constructor(private readonly deps: TouchpadModeDeps) {}

    setActive(active: boolean) {
        if (this.active === active) return;
        this.active = active;
        this.cancel();
    }

    get isActive() {
        return this.active;
    }

    /** 返回 true 表示这次输入已经由触摸板处理，不再进入普通触摸路径 */
    handle(e: UniInputEvent): boolean {
        if (!this.active) return false;
        if (e.kind !== "pointer" || e.pointerType !== "touch") return false;
        if (e.type === "wheel") return false;

        if (e.type === "down") return this.onDown(e);
        if (this.ignored) {
            if (e.type === "up") {
                this.ignoredContacts.delete(e.pointerId ?? 1);
                if (this.ignoredContacts.size === 0) this.ignored = false;
            }
            return false;
        }
        if (e.type === "move") return this.onMove(e);
        return this.onUp(e);
    }

    // ── 接触点 ────────────────────────────────────────────────

    private onDown(e: UniPointerEvent): boolean {
        if (this.contacts.size === 0) {
            this.ignored = this.deps.isKeyboardUiAt(e.x, e.y);
            if (this.ignored) {
                this.ignoredContacts.add(e.pointerId ?? 1);
                return false;
            }
            this.beginSession(e);
        } else if (this.ignored) {
            this.ignoredContacts.add(e.pointerId ?? 1);
            return false;
        }

        const id = e.pointerId ?? 1;
        this.contacts.set(id, { id, x: e.x, y: e.y, moved: 0 });
        this.maxContacts = Math.max(this.maxContacts, this.contacts.size);
        this.recomputeCentroid();
        this.lastCentroid = { ...this.startCentroid };

        if (this.contacts.size === 2) {
            this.cancelHold();
            this.releaseDrag();
            this.endPinch(false);
            this.endScroll();
            this.mode = "two";
            this.twoMode = "undecided";
            this.twoStartCentroid = { ...this.startCentroid };
            const pair = pointDistance([...this.contacts.values()]);
            this.pinchStartDistance = pair.distance;
            this.pinchLastAngle = pair.angle;
        } else if (this.contacts.size === 3) {
            this.cancelHold();
            this.releaseDrag();
            this.endPinch(false);
            this.endScroll();
            this.mode = "three";
            this.threeStarted = false;
        } else if (this.contacts.size >= 4) {
            this.cancelHold();
            this.releaseDrag();
            this.endPinch(false);
            this.endScroll();
            this.endDesktopGesture();
            this.mode = "four";
            this.swipeStarted = false;
        }
        return true;
    }

    private onMove(e: UniPointerEvent): boolean {
        const id = e.pointerId ?? 1;
        const contact = this.contacts.get(id);
        if (!contact) return true;
        const dx = e.x - contact.x;
        const dy = e.y - contact.y;
        contact.x = e.x;
        contact.y = e.y;
        contact.moved += Math.hypot(dx, dy);
        this.moved += Math.hypot(dx, dy);
        this.recomputeCentroid();

        if (this.contacts.size === 1) {
            // 当前质心与上一帧质心的差就是这一帧的指针位移
            this.moveCursor(this.startCentroid.x - this.lastCentroid.x, this.startCentroid.y - this.lastCentroid.y);
            this.lastCentroid = { ...this.startCentroid };
            return true;
        }

        const cdx = this.startCentroid.x - this.lastCentroid.x;
        const cdy = this.startCentroid.y - this.lastCentroid.y;
        this.lastCentroid = { ...this.startCentroid };

        if (this.contacts.size === 2) {
            this.updateTwo(cdx, cdy);
        } else if (this.contacts.size === 3) {
            this.updateThree(cdx, cdy);
        } else {
            this.updateFour(cdx, cdy);
        }
        return true;
    }

    private onUp(e: UniPointerEvent): boolean {
        const id = e.pointerId ?? 1;
        if (!this.contacts.delete(id)) return true;

        if (this.contacts.size === 0) {
            this.finishSession();
        } else {
            this.recomputeCentroid();
            this.lastCentroid = { ...this.startCentroid };
            if (this.contacts.size === 1) {
                this.endPinch(false);
                this.endScroll();
                this.endDesktopGesture();
                this.endSwipe();
                this.releaseDrag();
                this.mode = "cursor";
            } else if (this.contacts.size === 2) {
                this.endPinch(false);
                this.endScroll();
                this.endDesktopGesture();
                this.endSwipe();
                this.mode = "two";
                this.twoMode = "undecided";
                this.twoStartCentroid = { ...this.startCentroid };
                const pair = pointDistance([...this.contacts.values()]);
                this.pinchStartDistance = pair.distance;
                this.pinchLastAngle = pair.angle;
            } else if (this.contacts.size === 3) {
                this.endPinch(false);
                this.endScroll();
                this.mode = "three";
            }
        }
        return true;
    }

    // ── 单指/双指/多指 ────────────────────────────────────────

    private beginSession(e: UniPointerEvent) {
        this.contacts.clear();
        this.ignored = false;
        this.mode = "cursor";
        this.maxContacts = 0;
        this.moved = 0;
        this.startAt = performance.now();
        this.syncPos();
        this.startCentroid = { x: e.x, y: e.y };
        this.lastCentroid = { x: e.x, y: e.y };
        this.pinchActive = false;
        this.twoMode = "undecided";
        this.gestureTarget = undefined;
        this.gestureKind = undefined;
        this.threeStarted = false;
        this.swipeStarted = false;
        this.startHold();
    }

    private recomputeCentroid() {
        const list = [...this.contacts.values()];
        if (list.length === 0) return;
        let x = 0;
        let y = 0;
        for (const c of list) {
            x += c.x;
            y += c.y;
        }
        this.startCentroid = { x: x / list.length, y: y / list.length };
    }

    private moveCursor(dx: number, dy: number) {
        if (dx === 0 && dy === 0) return;
        this.pos.x = Math.min(Math.max(this.pos.x + dx * POINTER_GAIN, 0), window.innerWidth - 1);
        this.pos.y = Math.min(Math.max(this.pos.y + dy * POINTER_GAIN, 0), window.innerHeight - 1);
        this.emitPointer({ type: "move", x: this.pos.x, y: this.pos.y });
    }

    /** 面板外的按钮/滚动条没有接触点，用当前系统指针位置 */
    private syncPos() {
        const p = this.deps.getPointer();
        this.pos =
            p.x === 0 && p.y === 0 ? { x: window.innerWidth / 2, y: window.innerHeight / 2 } : { x: p.x, y: p.y };
    }

    private updateTwo(cdx: number, cdy: number) {
        const pair = pointDistance([...this.contacts.values()]);
        const config = this.deps.getScrollConfig();
        if (this.twoMode === "undecided") {
            const distanceChange = Math.abs(pair.distance - this.pinchStartDistance);
            const centerMove = Math.hypot(
                this.startCentroid.x - this.twoStartCentroid.x,
                this.startCentroid.y - this.twoStartCentroid.y,
            );
            // 两指距离明显变化且大于质心位移时判为捏合；否则等质心移动达到滚动阈值
            if (
                this.pinchStartDistance > 1 &&
                distanceChange >= PINCH_MIN_CHANGE &&
                distanceChange > centerMove * 0.8
            ) {
                this.beginPinch(pair.distance, pair.angle);
            } else if (centerMove >= TWO_FINGER_DECIDE_MOVE) {
                this.twoMode = "scroll";
                // 分类期间的位移直接丢弃：判为滚动的那一帧只发本帧位移，不补发攒下的量，
                // 否则开始滚动时会跳一下（与物理触摸板和轻触判定一致）
                const sign = config.naturalScroll ? 1 : -1;
                this.emitScroll(-cdx * sign * config.scrollGain, -cdy * sign * config.scrollGain);
            }
            return;
        }

        if (this.twoMode === "pinch") {
            const scale = this.pinchStartDistance > 0 ? pair.distance / this.pinchStartDistance : 1;
            const rotation = normalizeAngle(pair.angle - this.pinchLastAngle);
            this.pinchLastAngle = pair.angle;
            this.emitGesture({ type: "pinch", phase: "update", deltaX: cdx, deltaY: cdy, scale, rotation });
            return;
        }

        if (this.twoMode === "scroll") {
            const sign = config.naturalScroll ? 1 : -1;
            this.emitScroll(-cdx * sign * config.scrollGain, -cdy * sign * config.scrollGain);
        }
    }

    /** 三指滑动和物理触摸板一致：交给桌面的切屏/预览手势 */
    private updateThree(cdx: number, cdy: number) {
        if (!this.threeStarted) {
            this.threeStarted = true;
            this.deps.startDesktopGesture();
        }
        this.deps.moveDesktopGesture(cdx, cdy);
    }

    /** 四指及以上和物理触摸板一致：作为 swipe 发给应用 */
    private updateFour(cdx: number, cdy: number) {
        if (!this.swipeStarted) {
            if (this.moved < SWIPE_START_MOVE) return;
            this.swipeStarted = true;
            this.gestureKind = "swipe";
            this.gestureTarget = this.deps.gesture(
                { type: "swipe", phase: "begin", fingers: 4 },
                this.pos.x,
                this.pos.y,
            );
            return;
        }
        this.emitGesture({ type: "swipe", phase: "update", deltaX: cdx, deltaY: cdy });
    }

    private finishSession() {
        if (this.dragActive()) this.releaseDrag();
        this.endPinch(false);
        this.endScroll();
        this.endDesktopGesture();
        this.endSwipe();
        this.cancelHold();

        const tap = this.moved <= TAP_MAX_MOVE && performance.now() - this.startAt < 600;
        if (tap) {
            if (this.maxContacts === 1) this.clickButton(0);
            else if (this.maxContacts === 2) this.clickButton(2);
            else if (this.maxContacts === 3) this.clickButton(1);
        }

        this.contacts.clear();
        this.ignored = false;
        this.ignoredContacts.clear();
        this.mode = "idle";
        this.maxContacts = 0;
        this.moved = 0;
        this.twoMode = "undecided";
        this.pinchActive = false;
        this.gestureTarget = undefined;
        this.gestureKind = undefined;
        this.threeStarted = false;
        this.swipeStarted = false;
    }

    // ── 按住拖拽 ──────────────────────────────────────────────

    private startHold() {
        this.cancelHold();
        this.holdTimer = window.setTimeout(() => {
            this.holdTimer = undefined;
            if (this.contacts.size !== 1 || this.moved > TAP_MAX_MOVE || this.mode !== "cursor") return;
            this.mode = "drag";
            this.emitPointer({ type: "down", x: this.pos.x, y: this.pos.y, button: 0 });
        }, HOLD_DELAY);
    }

    private cancelHold() {
        if (this.holdTimer === undefined) return;
        clearTimeout(this.holdTimer);
        this.holdTimer = undefined;
    }

    private dragActive() {
        return this.mode === "drag";
    }

    private releaseDrag() {
        if (this.mode !== "drag") return;
        this.mode = "cursor";
        this.emitPointer({ type: "up", x: this.pos.x, y: this.pos.y, button: 0 });
    }

    // ── 手势与滚动 ────────────────────────────────────────────

    private beginPinch(distance: number, angle: number) {
        this.twoMode = "pinch";
        this.pinchActive = true;
        this.pinchStartDistance = distance;
        this.pinchLastAngle = angle;
        this.gestureKind = "pinch";
        this.gestureTarget = this.deps.gesture({ type: "pinch", phase: "begin", fingers: 2 }, this.pos.x, this.pos.y);
    }

    private endPinch(cancelled: boolean) {
        if (!this.pinchActive) return;
        this.pinchActive = false;
        if (this.gestureKind === "pinch" && this.gestureTarget !== undefined) {
            this.emitGesture({ type: "pinch", phase: "end", cancelled });
        }
        if (this.gestureKind === "pinch") {
            this.gestureKind = undefined;
            this.gestureTarget = undefined;
        }
        this.twoMode = "undecided";
    }

    private emitScroll(deltaX: number, deltaY: number) {
        if (deltaX === 0 && deltaY === 0) return;
        this.emitPointer({
            type: "wheel",
            x: this.pos.x,
            y: this.pos.y,
            deltaX,
            deltaY,
            wheelSource: "finger",
        });
    }

    private endScroll() {
        if (this.mode !== "two" || this.twoMode !== "scroll") return;
        this.twoMode = "undecided";
        this.emitPointer({
            type: "wheel",
            x: this.pos.x,
            y: this.pos.y,
            deltaX: 0,
            deltaY: 0,
            wheelSource: "finger",
            scrollEnd: true,
        });
    }

    private endDesktopGesture() {
        if (!this.threeStarted) return;
        this.threeStarted = false;
        this.deps.endDesktopGesture();
    }

    private endSwipe() {
        if (!this.swipeStarted) return;
        this.swipeStarted = false;
        this.emitGesture({ type: "swipe", phase: "end" });
    }

    private emitGesture(event: GestureCommand) {
        if (this.gestureTarget === undefined) return;
        this.deps.notifyGesture(this.gestureTarget, event);
        if (event.phase === "end") {
            this.gestureTarget = undefined;
            this.gestureKind = undefined;
        }
    }

    // ── 输出 ──────────────────────────────────────────────────

    /** 左/中/右键：在系统指针当前位置合成一次点击 */
    clickButton(button: number) {
        this.syncPos();
        this.emitPointer({ type: "down", x: this.pos.x, y: this.pos.y, button });
        this.emitPointer({ type: "up", x: this.pos.x, y: this.pos.y, button });
    }

    /** 触控板页右侧滚动条；0 表示结束这一轮连续滚动 */
    scrollBy(deltaY: number) {
        this.syncPos();
        if (deltaY === 0) {
            this.emitPointer({
                type: "wheel",
                x: this.pos.x,
                y: this.pos.y,
                deltaX: 0,
                deltaY: 0,
                wheelSource: "finger",
                scrollEnd: true,
            });
            return;
        }
        this.emitPointer({
            type: "wheel",
            x: this.pos.x,
            y: this.pos.y,
            deltaY,
            wheelSource: "finger",
        });
    }

    private emitPointer(e: Omit<UniPointerEvent, "kind" | "pointerType" | "source">) {
        this.deps.dispatch({
            kind: "pointer",
            pointerType: "mouse",
            pointerId: 1,
            isPrimary: true,
            ...e,
            source: "evdev",
        } as UniInputEvent);
    }

    cancel() {
        this.cancelHold();
        this.releaseDrag();
        this.endPinch(true);
        this.endScroll();
        this.endDesktopGesture();
        this.endSwipe();
        this.contacts.clear();
        this.ignored = false;
        this.ignoredContacts.clear();
        this.mode = "idle";
        this.maxContacts = 0;
        this.moved = 0;
        this.twoMode = "undecided";
        this.gestureTarget = undefined;
        this.gestureKind = undefined;
    }
}
