import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testRunnerApp } from "../../test_runner/test_runner";

/**
 * dmabuf 每帧资源泄漏压力测试。
 *
 * `test/simple_app/src/bin/dmabuf_flood.rs` 以服务端能消费的最快速度提交 2 段
 * dmabuf 帧（普通 + wp_viewport.source），每 500ms 打印一次 `/proc/meminfo`
 * 的 GPUActive。这里收集那串采样，看合成器每帧是否留下没释放的 GPU 内存。
 *
 * GPUActive 是内核 7.x 在 xe/ttm 上才有的字段；没有它的机器直接跳过。
 */

type MemSample = { phase: string; gpuActiveMb: number; frames: number };

function readGpuActiveMb(): number | undefined {
    try {
        const text = readFileSync("/proc/meminfo", "utf8");
        const m = text.match(/^GPUActive:\s+(\d+) kB/m);
        return m ? Math.round(Number(m[1]) / 1024) : undefined;
    } catch {
        return undefined;
    }
}

function parseMemLines(out: unknown[]): MemSample[] {
    const samples: MemSample[] = [];
    for (const item of out) {
        const applog = (item as { applog?: unknown } | undefined)?.applog;
        if (typeof applog !== "string") continue;
        for (const line of applog.split("\n")) {
            const m = line.match(/^MEM phase=(\S+) gpu_active_mb=(\d+|NA) frames=(\d+)/);
            if (!m || m[2] === "NA") continue;
            samples.push({ phase: m[1], gpuActiveMb: Number(m[2]), frames: Number(m[3]) });
        }
    }
    return samples;
}

const baseline = readGpuActiveMb();

describe("dma-buf flood", () => {
    it.skipIf(baseline === undefined)("每帧不留下未释放的 GPU 内存", { timeout: 45000 }, async () => {
        // 模拟 60fps 视频：每帧 14.7MB 的 GPU 拷贝，泄漏会按 880MB/s 累积
        process.env.FLOOD_INTERVAL_MS = "16";
        const before = readGpuActiveMb() as number;
        const { waitExit } = testRunnerApp("test/simple_app/target/debug/dmabuf_flood", ({ server, runner }) => {
            server.on("window.created", (info) => {
                server.notify("window.focus", info.handle);
            });
            server.on("window.closed", () => {
                setTimeout(() => runner.kill(), 300);
            });
        });
        const out = await waitExit();
        const samples = parseMemLines(out);
        const after = readGpuActiveMb();

        // 方便现场排查：把每段的高低点打出来
        const byPhase = new Map<string, number[]>();
        for (const s of samples) {
            const arr = byPhase.get(s.phase) ?? [];
            arr.push(s.gpuActiveMb);
            byPhase.set(s.phase, arr);
        }
        for (const [phase, values] of byPhase) {
            console.log(
                `GPUActive ${phase}: min=${Math.min(...values)} max=${Math.max(...values)} n=${values.length} (MB)`,
            );
        }
        console.log(samples.map((s) => `  ${s.phase} frames=${s.frames} GPUActive=${s.gpuActiveMb}MB`).join("\n"));
        const peak = samples.length ? Math.max(...samples.map((s) => s.gpuActiveMb)) : before;
        console.log(`GPUActive before=${before} peak=${peak} after=${after} MB`);
        if (!samples.length) console.log(JSON.stringify(out).slice(0, 1000));

        expect(samples.length, "没有收到 dmabuf_flood 的内存采样").toBeGreaterThan(4);
        // 两段各 1.5s、60fps 的 dmabuf 提交。如果每帧泄漏一份 GPU 拷贝（4K ~33MB、
        // 2.5K ~14.7MB），增量会是 GB 级；留 1.5GB 给 Electron/画布/读数的正常开销和噪声。
        expect(peak - before, `GPUActive 从 ${before}MB 涨到 ${peak}MB`).toBeLessThan(1536);
    });
});
