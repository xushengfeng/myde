export interface ThrottleOptions {
    /** 首次调用是否立即执行，默认 true */
    leading?: boolean;
    /** 静默前是否补发最后一次调用，默认 true */
    trailing?: boolean;
}

export interface Throttled<A extends unknown[]> {
    (...args: A): void;
    /** 立即执行尚未补发的最后一次调用 */
    flush(): void;
    /** 丢弃挂起的调用，并重置计时 */
    cancel(): void;
}

/**
 * 节流：连续调用时最多每 `interval` 毫秒执行一次，默认第一次立即执行、结束时补发最后一次。
 *
 * 高频输入（拖动音量条等）应该在桌面实现里用这个限制频率，系统 API 不做节流。
 * 使用 `performance.now()` 计时，不依赖 DOM。
 */
export function throttle<A extends unknown[]>(
    fn: (...args: A) => unknown,
    interval: number,
    options: ThrottleOptions = {},
): Throttled<A> {
    const leading = options.leading ?? true;
    const trailing = options.trailing ?? true;

    let last: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: A | undefined;

    const invoke = (args: A) => {
        last = performance.now();
        fn(...args);
    };

    const throttled: Throttled<A> = Object.assign(
        (...args: A) => {
            const now = performance.now();
            if (leading && (last === undefined || now - last >= interval)) {
                invoke(args);
                return;
            }

            pending = args;
            if (timer) return;

            const wait = last === undefined ? interval : Math.max(0, interval - (now - last));
            timer = setTimeout(() => {
                timer = undefined;
                if (!pending) return;
                const lastArgs = pending;
                pending = undefined;
                if (trailing) invoke(lastArgs);
            }, wait);
        },
        {
            flush() {
                if (timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                if (!pending) return;
                const lastArgs = pending;
                pending = undefined;
                invoke(lastArgs);
            },
            cancel() {
                if (timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                pending = undefined;
                last = undefined;
            },
        },
    );

    return throttled;
}
