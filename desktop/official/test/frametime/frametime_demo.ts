import { createFrameChart } from "../../src/frame_chart";

function must<T>(value: T | null, name: string): T {
    if (!value) throw new Error(`frametime demo: 缺少页面元素 ${name}`);
    return value;
}

const chartHost = must(document.querySelector<HTMLDivElement>("#chart"), "#chart");
const windowSelect = must(document.querySelector<HTMLSelectElement>("#window-size"), "#window-size");
const refreshSelect = must(document.querySelector<HTMLSelectElement>("#refresh-rate"), "#refresh-rate");
const measureButton = must(document.querySelector<HTMLButtonElement>("#measure"), "#measure");
const measuredText = must(document.querySelector<HTMLSpanElement>("#measured"), "#measured");
const loadSelect = must(document.querySelector<HTMLSelectElement>("#load"), "#load");
const spike20 = must(document.querySelector<HTMLButtonElement>("#spike-20"), "#spike-20");
const spike50 = must(document.querySelector<HTMLButtonElement>("#spike-50"), "#spike-50");
const spike100 = must(document.querySelector<HTMLButtonElement>("#spike-100"), "#spike-100");

const COMMON_REFRESH_RATES = [24, 25, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240, 360];

/** 实测值有计时噪声，接近常见刷新率时归到整数（与桌面 screen.ts 一致） */
function snapRefreshRate(rate: number) {
    let best = Math.round(rate);
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const candidate of COMMON_REFRESH_RATES) {
        const diff = Math.abs(candidate - rate) / candidate;
        if (diff < bestDiff) {
            best = candidate;
            bestDiff = diff;
        }
    }
    return bestDiff <= 0.05 ? best : Math.round(rate);
}

/** 取 30 帧间隔的中位数，避开首帧与偶发长帧 */
function measureRefreshRate(samples = 30): Promise<number> {
    return new Promise((resolve) => {
        // 页面不可见时 rAF 可能完全不跑，避免一直等下去
        const fallback = window.setTimeout(() => resolve(60), 2500);
        const intervals: number[] = [];
        let last: number | undefined;
        const tick = (now: number) => {
            if (last !== undefined) intervals.push(now - last);
            last = now;
            if (intervals.length < samples) {
                requestAnimationFrame(tick);
                return;
            }
            window.clearTimeout(fallback);
            intervals.sort((a, b) => a - b);
            const median = intervals[Math.floor(intervals.length / 2)];
            resolve(median > 0 ? 1000 / median : 60);
        };
        requestAnimationFrame(tick);
    });
}

function busy(ms: number) {
    const end = performance.now() + ms;
    while (performance.now() < end) {
        // 占住主线程，模拟超预算的一帧
    }
}

// 持续负载：每帧在 rAF 里空转，超过帧预算后图表会出现成倍的长帧
let loadMs = 0;
function loadFrame() {
    if (loadMs > 0) busy(loadMs);
    requestAnimationFrame(loadFrame);
}

async function showMeasuredRate() {
    measuredText.textContent = "测量中…";
    const measured = await measureRefreshRate();
    const snapped = snapRefreshRate(measured);
    refreshSelect.value = String(snapped);
    measuredText.textContent = `实测 ${measured.toFixed(1)} Hz · 按 ${snapped} Hz 计算`;
    return snapped;
}

async function init() {
    chartHost.textContent = "测量刷新率…";
    const snapped = await showMeasuredRate();

    const chart = createFrameChart({
        windowMs: Number(windowSelect.value),
        refreshRate: snapped,
        height: 220,
    });
    chartHost.textContent = "";
    chartHost.append(chart.el);

    windowSelect.addEventListener("change", () => {
        chart.setWindow(Number(windowSelect.value));
    });
    refreshSelect.addEventListener("change", () => {
        chart.setRefreshRate(Number(refreshSelect.value));
        measuredText.textContent = "使用手选刷新率";
    });
    measureButton.addEventListener("click", async () => {
        measureButton.disabled = true;
        const rate = await showMeasuredRate();
        chart.setRefreshRate(rate);
        measureButton.disabled = false;
    });

    loadSelect.addEventListener("change", () => {
        loadMs = Number(loadSelect.value);
    });
    spike20.addEventListener("click", () => busy(20));
    spike50.addEventListener("click", () => busy(50));
    spike100.addEventListener("click", () => busy(100));

    // 图表自己的 rAF 已经先注册，负载回调排在同一帧后面，超预算时同样会推迟到下一帧
    requestAnimationFrame(loadFrame);
}

void init();
