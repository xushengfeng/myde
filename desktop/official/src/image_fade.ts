/**
 * 旧内容快照（ghost）和新内容交叉淡化时，新内容该用多大的 opacity。
 *
 * ghost 在上、新内容在下。两层自身 alpha 分别是 `alphaFrom` / `alphaTo`，
 * ghost opacity 为 `a`、内容 opacity 为 `b` 时，合成 alpha 是：
 *
 *   α = alphaFrom·a + alphaTo·b·(1 − alphaFrom·a)
 *
 * 让 α 全程等于新内容的 alphaTo，解出：
 *
 *   b = (alphaTo − alphaFrom·a) / (alphaTo·(1 − alphaFrom·a))
 *
 * 前后透明度相同（alphaFrom === alphaTo === A）时就是常见形式：
 *
 *   b = (1 − a) / (1 − A·a)
 *
 * A = 1 时退化成 b = 1：内容保持不透明，只淡出 ghost，合成 alpha 不下降。
 */
export function contentOpacityForGhost(a: number, alphaFrom: number, alphaTo: number): number {
    const ghost = clamp01(a);
    const from = clamp01(alphaFrom);
    const to = clamp01(alphaTo);
    // 新内容完全透明：内容层显示与否不影响合成
    if (to <= 0.001) return 1;
    // 旧内容完全透明：没有可淡出的东西
    if (from <= 0.001) return 1;
    const denominator = to * (1 - from * ghost);
    // from = to = 1 且 a = 1：分子分母同时为 0，不透明窗口此时内容应保持 1
    if (denominator <= 1e-6) return 1;
    return clamp01((to - from * ghost) / denominator);
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.max(0, Math.min(1, value));
}
