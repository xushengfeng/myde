/**
 * wl_region 的矩形列表运算。
 *
 * 协议里的 region 是**有序**的 `+`/`-` 矩形：后面的矩形覆盖前面已填充的部分，
 * 两个重叠的 `+` 矩形取并集而不是异或。直接把这些矩形丢给 CSS `clip-path` 的
 * even-odd 填充会在重叠处挖洞，所以先按扫描线解析成互不重叠的填充矩形。
 */

export type RegionRect = { x: number; y: number; width: number; height: number; type: "+" | "-" };
export type FilledRect = { x: number; y: number; width: number; height: number };

type Box = { x1: number; y1: number; x2: number; y2: number; type: "+" | "-" };

/** 归一化坐标（负宽高按反方向处理）；退化为零面积的矩形没有意义，直接丢掉。 */
function toBox(rect: RegionRect): Box | undefined {
    const x1 = Math.min(rect.x, rect.x + rect.width);
    const x2 = Math.max(rect.x, rect.x + rect.width);
    const y1 = Math.min(rect.y, rect.y + rect.height);
    const y2 = Math.max(rect.y, rect.y + rect.height);
    if (x1 === x2 || y1 === y2) return undefined;
    return { x1, y1, x2, y2, type: rect.type };
}

function uniqueSorted(values: number[]): number[] {
    return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * 把有序 `+`/`-` 矩形解析成互不重叠的填充矩形。
 *
 * `bounds` 是 surface 的逻辑尺寸：协议规定区域会被裁剪到 surface 范围；
 * 先裁剪每个矩形不影响布尔运算（(A∪B)∩S = (A∩S)∪(B∩S)）。
 */
export function resolveRegion(rects: readonly RegionRect[], bounds?: { width: number; height: number }): FilledRect[] {
    const boxes: Box[] = [];
    for (const rect of rects) {
        const box = toBox(rect);
        if (!box) continue;
        // 协议规定区域会被裁剪到 surface 范围；裁剪每个矩形不影响布尔运算
        // （(A∪B)∩S = (A∩S)∪(B∩S)）。
        if (bounds) {
            box.x1 = Math.max(box.x1, 0);
            box.y1 = Math.max(box.y1, 0);
            box.x2 = Math.min(box.x2, bounds.width);
            box.y2 = Math.min(box.y2, bounds.height);
            if (box.x1 >= box.x2 || box.y1 >= box.y2) continue;
        }
        boxes.push(box);
    }
    if (boxes.length === 0) return [];

    const xs = uniqueSorted(boxes.flatMap((b) => [b.x1, b.x2]));
    const ys = uniqueSorted(boxes.flatMap((b) => [b.y1, b.y2]));
    if (xs.length < 2 || ys.length < 2) return [];

    const inside = (x: number, y: number): boolean => {
        // 按顺序应用：一个点最终是否填充，取决于最后一个包含它的矩形。
        let filled = false;
        for (const box of boxes) {
            if (x >= box.x1 && x < box.x2 && y >= box.y1 && y < box.y2) filled = box.type === "+";
        }
        return filled;
    };

    /**
     * 每个 y 带里得到若干 [x1, x2) 的填充区间；把相邻 y 带里完全相同的区间
     * 合并成一个矩形，减少 clip-path 的子路径数量。
     */
    const result: FilledRect[] = [];
    const open = new Map<string, { x1: number; x2: number; y1: number }>();
    for (let j = 0; j < ys.length - 1; j++) {
        const y1 = ys[j];
        const y2 = ys[j + 1];
        if (y2 <= y1) continue;
        const yMid = (y1 + y2) / 2;

        const runs: { x1: number; x2: number }[] = [];
        let runStart: number | undefined;
        for (let i = 0; i < xs.length - 1; i++) {
            const x1 = xs[i];
            const x2 = xs[i + 1];
            if (x2 <= x1) continue;
            const filled = inside((x1 + x2) / 2, yMid);
            if (filled && runStart === undefined) runStart = x1;
            if (!filled && runStart !== undefined) {
                runs.push({ x1: runStart, x2: x1 });
                runStart = undefined;
            }
        }
        if (runStart !== undefined) runs.push({ x1: runStart, x2: xs[xs.length - 1] });

        const seen = new Set<string>();
        for (const run of runs) {
            const key = `${run.x1},${run.x2}`;
            seen.add(key);
            if (!open.has(key)) open.set(key, { ...run, y1 });
        }
        for (const [key, entry] of open) {
            if (seen.has(key)) continue;
            // 这一行已经没有相同区间，截止到本行起点，不能延伸到本行末尾（会盖住下面一行）。
            result.push({ x: entry.x1, y: entry.y1, width: entry.x2 - entry.x1, height: y1 - entry.y1 });
            open.delete(key);
        }
    }
    const lastY = ys[ys.length - 1];
    for (const entry of open.values()) {
        result.push({ x: entry.x1, y: entry.y1, width: entry.x2 - entry.x1, height: lastY - entry.y1 });
    }
    return result;
}

/** 互不重叠的填充矩形 → CSS `clip-path: path()` 的路径数据（每个矩形一个子路径）。 */
export function rectsToClipPath(rects: readonly FilledRect[], scale = 1): string {
    const parts: string[] = [];
    for (const rect of rects) {
        const x1 = rect.x * scale;
        const y1 = rect.y * scale;
        const x2 = (rect.x + rect.width) * scale;
        const y2 = (rect.y + rect.height) * scale;
        parts.push(`M${x1} ${y1}H${x2}V${y2}H${x1}Z`);
    }
    return parts.join("");
}
