/**
 * 客户端日志（applog）解析。
 *
 * 走的链路有两层包装，缺一层都解不出来：
 * 1. renderer 的 `console.log` → `test/electron_app/start.js` 的 `console-message` → `{"data": "<原文>"}`
 * 2. 上面这条经 ipc 到 `main.ts` → `writeLine(JSON.stringify({ applog }))` → `{"applog": "{\"data\": …}"}`
 *
 * 且一个 `applog` chunk 是 stdout 的一次 read，**可能含多行**，必须按行拆。
 * 解析失败的行直接丢掉（Chromium/应用的杂讯不该让断言崩掉）。
 */

/** 一条客户端日志：能解析成对象就给对象，解析不出（如纯字符串日志）就给原文 */
export type AppLog = Record<string, unknown> | string;

/** 从 `waitExit()` 的结果里取出全部客户端日志 */
export function collectAppLogs(results: { applog?: string }[]): AppLog[] {
    const out: AppLog[] = [];
    for (const r of results) {
        for (const line of (r.applog ?? "").split("\n")) {
            const s = line.trim();
            if (!s.startsWith("{")) continue;
            try {
                const outer = JSON.parse(s) as { data?: unknown };
                if (typeof outer.data !== "string") {
                    out.push(outer as Record<string, unknown>);
                    continue;
                }
                try {
                    const inner: unknown = JSON.parse(outer.data);
                    out.push(
                        inner !== null && typeof inner === "object" ? (inner as Record<string, unknown>) : outer.data,
                    );
                } catch {
                    // 原文不是 JSON（比如 `console.log("started")`）：留字符串
                    out.push(outer.data);
                }
            } catch {
                // 非本测试的日志
            }
        }
    }
    return out;
}

/** 取出指定 `type` 的对象日志 */
export function logOfType<T extends Record<string, unknown>>(logs: AppLog[], type: string): T[] {
    const out: T[] = [];
    for (const l of logs) {
        if (typeof l === "object" && l !== null && l.type === type) out.push(l as T);
    }
    return out;
}
