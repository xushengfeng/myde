import { AnimationGear, type Time } from "myde-ui";

/** 动画时钟默认跟随真实时间；测试里只加速 AnimationGear，不改变 setTimeout/事件时间 */
let speed = 1;
let realBase = Date.now();
let virtualBase = realBase;

const now = () => (speed === 1 ? Date.now() : virtualBase + (Date.now() - realBase) * speed);

const time: Time = {
    getTimeMs: now,
    setTimeOut: (ms, callback) => setTimeout(callback, ms) as unknown as ReturnType<Time["setTimeOut"]>,
    clearTimeOut: (handler) => clearTimeout(handler),
    reqNextFrame: (callback) => requestAnimationFrame(callback),
};

/** 测试加速：倍率作用于 AnimationGear 的时间轴，保持当前虚拟时间连续 */
export function setAnimationSpeed(next: number) {
    const value = Number.isFinite(next) && next >= 1 ? next : 1;
    virtualBase = now();
    realBase = Date.now();
    speed = value;
}

type GearOptions = NonNullable<ConstructorParameters<typeof AnimationGear>[1]>;

/**
 * 始终使用共享时钟；测试设置倍率后所有齿轮一起加速。
 *
 * 注意：`AnimationGear.moveTo` 会把 `onComplete` 直接写到传入的 transition 对象上。
 * 共享的 transition 常量要传克隆（`{ ...TRANSITION, onComplete }`），否则下一次
 * 无回调的 moveTo 会继承上一次的完成回调。
 */
export function createAnimationGear<T extends Record<string, number> = Record<string, number>>(
    initial: T,
    op?: Omit<GearOptions, "time">,
) {
    return new AnimationGear(initial, { ...op, time });
}
