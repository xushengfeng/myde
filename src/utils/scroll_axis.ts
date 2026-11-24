// 双指滚动的方向约束，参照 libinput 的 tp_gesture_apply_scroll_constraints：
// 起手时按累计方向向量判断主方向，只放行主方向；持续足够久或明确斜向滑动后放开两轴。
// 这样双指滚动不会被手指轻微的横向/纵向抖动带出对角线。

const ACTIVE_THRESHOLD = 100;
const INACTIVE_THRESHOLD = 50;
const EVENT_TIMEOUT = 100;
/** 方向判断的最小累计位移（毫米） */
const MIN_VECTOR = 0.15;
/** 明确斜向滑动时直接放开两轴 */
const DIAGONAL_VECTOR = 5;
const DEGREE_75 = 3.73;
const DEGREE_60 = 1.73;
const DEGREE_30 = 0.57;
const DEGREE_15 = 0.27;

export interface ScrollAxisAllow {
    x: boolean;
    y: boolean;
}

/** 根据手指累计位移决定双指滚动当前允许的轴 */
export class ScrollAxisLock {
    private activeH = false;
    private activeV = false;
    private durationH = 0;
    private durationV = 0;
    private vectorX = 0;
    private vectorY = 0;
    private lastTime = 0;

    reset(): void {
        this.activeH = false;
        this.activeV = false;
        this.durationH = 0;
        this.durationV = 0;
        this.vectorX = 0;
        this.vectorY = 0;
        this.lastTime = 0;
    }

    /** dxMm/dyMm 是这一帧的平均手指位移，time 是毫秒时间戳 */
    constrain(dxMm: number, dyMm: number, time: number): ScrollAxisAllow {
        // 两轴都已激活表示自由滚动，本轮不再限制
        if (this.activeH && this.activeV) return { x: true, y: true };

        let tdelta = 0;
        if (this.lastTime !== 0) {
            tdelta = time - this.lastTime;
            if (tdelta > EVENT_TIMEOUT) tdelta = 0;
        }
        this.lastTime = time;

        // 旧方向向量按时间衰减，用两段线性近似指数衰减
        let decay = 0;
        if (tdelta > 0) {
            const recent = (EVENT_TIMEOUT / 2 - tdelta) / (EVENT_TIMEOUT / 2);
            const later = (EVENT_TIMEOUT - tdelta) / (EVENT_TIMEOUT * 2);
            decay = tdelta <= EVENT_TIMEOUT * 0.33 ? recent : later;
        }
        this.vectorX = this.vectorX * decay + dxMm;
        this.vectorY = this.vectorY * decay + dyMm;
        const length = Math.hypot(this.vectorX, this.vectorY);
        const slope = this.vectorX !== 0 ? Math.abs(this.vectorY / this.vectorX) : Infinity;

        // 累计各方向持续的时间，短暂的无抖动不会立刻切换主方向
        if (slope >= DEGREE_30 && length > MIN_VECTOR) {
            this.durationV = Math.min(ACTIVE_THRESHOLD, this.durationV + tdelta);
            if (slope >= DEGREE_75) this.durationH = Math.max(0, this.durationH - tdelta);
        }
        if (slope < DEGREE_60 && length > MIN_VECTOR) {
            this.durationH = Math.min(ACTIVE_THRESHOLD, this.durationH + tdelta);
            if (slope < DEGREE_15) this.durationV = Math.max(0, this.durationV - tdelta);
        }

        if (this.durationH === ACTIVE_THRESHOLD) {
            this.activeH = true;
            if (this.durationV < INACTIVE_THRESHOLD) this.activeV = false;
        }
        if (this.durationV === ACTIVE_THRESHOLD) {
            this.activeV = true;
            if (this.durationH < INACTIVE_THRESHOLD) this.activeH = false;
        }

        // 明确的斜向滑动：本轮直接放开两轴
        if (length > DIAGONAL_VECTOR && slope < DEGREE_60 && slope >= DEGREE_30) {
            this.activeH = true;
            this.activeV = true;
        }

        if (!this.activeH && this.activeV) return { x: false, y: true };
        if (this.activeH && !this.activeV) return { x: true, y: false };
        if (!this.activeH && !this.activeV) {
            // 还没判断出主方向时先按斜率丢弃更小的轴
            return { x: slope < DEGREE_60, y: slope >= DEGREE_30 };
        }
        return { x: true, y: true };
    }
}
