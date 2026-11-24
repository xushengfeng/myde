// 触摸板指针加速：曲线和速度设置参照 libinput 的 filter-touchpad.c。
//
// libinput 的自适应曲线在 7~130 mm/s 之间保持 1:1（平台段），更慢时减速到约 1/3，
// 更快时最高到约 5.3 倍。libinput 还会乘一个固定的触摸板减速系数（0.2968），
// 使指针比手指慢很多；这里把平台段归一化为 1，保留原桌面的 1:1 手感，
// 只按速度改变比例。速度设置使用 libinput 的 [-1, 1] 映射。

/** 平台段上界（mm/s），对应 libinput 的 130 */
export const TOUCHPAD_ACCEL_THRESHOLD = 130;
/** 最慢时的相对倍率：libinput 曲线的 0.3 / 平台段 0.9 */
export const TOUCHPAD_ACCEL_MIN = 0.3 / 0.9;
/** 自适应曲线在 4 倍阈值处的相对倍率 */
export const TOUCHPAD_ACCEL_MAX = (0.0025 * 4 * (TOUCHPAD_ACCEL_THRESHOLD * 3) + 0.9) / 0.9;
/** 速度设置的有效范围 */
export const POINTER_SPEED_MIN = -1;
export const POINTER_SPEED_MAX = 1;

/** 把速度设置限制在 libinput 的 [-1, 1] 内；非法值按 0（标准）处理 */
export function normalizePointerSpeed(value: unknown): number {
    const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
    return Math.min(POINTER_SPEED_MAX, Math.max(POINTER_SPEED_MIN, n));
}

/** libinput 的速度设置映射，0 为标准速度 */
export function pointerSpeedFactor(speed: number): number {
    const s = normalizePointerSpeed(speed);
    return (s + 1) ** 2.38 * 0.95 + 0.05;
}

/**
 * libinput touchpad_accel_profile_linear，返回值相对平台段归一化。
 * enabled=false 时使用 flat 曲线，只应用速度设置。
 */
export function touchpadAccelFactor(speedMmS: number, speed = 0, enabled = true): number {
    const speedFactor = pointerSpeedFactor(speed);
    if (!enabled) return speedFactor;

    const threshold = TOUCHPAD_ACCEL_THRESHOLD;
    const baseline = 0.9;
    let factor: number;
    if (speedMmS < 7) {
        // 慢速线性减速，最低到 0.3（约为平台段的三分之一）
        factor = Math.min(baseline, 0.1 * speedMmS + 0.3);
    } else if (speedMmS < threshold) {
        factor = baseline;
    } else {
        // 超过阈值后按 libinput 的试验曲线加速，到 4 倍阈值封顶
        const upper = threshold * 4;
        const v = Math.min(speedMmS, upper);
        factor = 0.0025 * (v / threshold) * (v - threshold) + baseline;
    }
    return (factor / baseline) * speedFactor;
}

/** 8 个方向，用于 libinput 式速度平均时判断方向是否一致 */
const DIR_ALL = 0xff;

function direction(dx: number, dy: number): number {
    if (dx === 0 && dy === 0) return 0;
    const angle = Math.atan2(dy, dx);
    const sector = Math.round(angle / (Math.PI / 4)) & 7;
    return 1 << sector;
}

type VelocitySample = {
    time: number;
    /** 从这个采样点累计到最新的位移（毫米） */
    x: number;
    y: number;
    direction: number;
};

/** 与 libinput 相同的滑动窗口速度平均帧数 */
const VELOCITY_SAMPLES = 16;
/** 超过这个间隔的位移不再和更早的采样合并（毫秒） */
const MOTION_TIMEOUT_MS = 1000;
/** 速度变化超过这个值时停止向前平均（mm/s） */
const MAX_VELOCITY_DIFF = 25.4;

/** 按 libinput trackers 的方式，从最近若干帧的位移估算速度（mm/s） */
export class PointerVelocityTracker {
    private samples: VelocitySample[] = [];

    /** 开始新一轮接触；time 之后的第一帧按这段间隔计算速度 */
    reset(time: number): void {
        this.samples = [{ time, x: 0, y: 0, direction: DIR_ALL }];
    }

    feed(dx: number, dy: number, time: number): void {
        for (const sample of this.samples) {
            sample.x += dx;
            sample.y += dy;
        }
        this.samples.push({ time, x: 0, y: 0, direction: direction(dx, dy) });
        if (this.samples.length > VELOCITY_SAMPLES) this.samples.shift();
    }

    velocity(time: number): number {
        const count = this.samples.length;
        if (count === 0) return 0;

        let dir = this.samples[count - 1].direction;
        let result = 0;
        let initial = 0;
        for (let offset = 1; offset < count; offset++) {
            const sample = this.samples[count - 1 - offset];
            if (sample.time > time) break;
            const age = time - sample.time;
            if (age > MOTION_TIMEOUT_MS) {
                // 停顿后的第一次移动：用超时本身计算，避免速度过低
                if (offset === 1) result = (Math.hypot(sample.x, sample.y) / MOTION_TIMEOUT_MS) * 1000;
                break;
            }
            const velocity = (Math.hypot(sample.x, sample.y) / Math.max(age, 1)) * 1000;
            dir &= sample.direction;
            if (dir === 0) {
                // 方向改变：只用上一帧的速度
                if (offset === 1) result = velocity;
                break;
            }
            if (initial === 0 || offset <= 2) {
                result = initial = velocity;
            } else if (Math.abs(initial - velocity) > MAX_VELOCITY_DIFF) {
                break;
            } else {
                result = velocity;
            }
        }
        return result;
    }
}

/** 触摸板单指移动的加速状态：速度估算 + libinput 的 Simpson 平均 */
export class TouchpadAccelerator {
    private readonly tracker = new PointerVelocityTracker();
    private lastVelocity = 0;

    reset(time: number): void {
        this.tracker.reset(time);
        this.lastVelocity = 0;
    }

    /** 返回本帧位移要乘的倍率；dx/dy 是设备原始位移换算成的毫米 */
    factor(dx: number, dy: number, time: number, enabled: boolean, speed: number): number {
        if (dx === 0 && dy === 0) return pointerSpeedFactor(speed);
        this.tracker.feed(dx, dy, time);
        const velocity = this.tracker.velocity(time);
        const profile = (v: number) => touchpadAccelFactor(v, speed, enabled);
        // libinput 用 Simpson 规则平滑当前速度和上一帧速度之间的加速倍率
        const factor =
            (profile(velocity) + profile(this.lastVelocity) + 4 * profile((velocity + this.lastVelocity) / 2)) / 6;
        this.lastVelocity = velocity;
        return factor;
    }
}
