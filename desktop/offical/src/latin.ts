import { pinyin } from "pinyin-pro";

const COMBINING_MARKS = /[\u0300-\u036f]/g;
const NON_LATIN = /[^a-z0-9]+/g;
const HAN = /[\u3400-\u9fff]/;

/** 把文本转成用于匹配的小写拉丁形式：去重音、非字母数字变空格 */
export function normalizeLatin(text: string): string {
    return text.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase().replace(NON_LATIN, " ").trim();
}

/**
 * 一个名字的可搜索形式。
 *
 * 搜索框只接受拉丁输入，所以 nameLocal 里的中文要先转成拼音：
 * 全拼（`huohu`）、带空格的拼音（`huo hu`）和首字母（`hhllq`）都放进候选，
 * 原始拉丁名保持原样。返回的候选都已规范化。
 */
export function latinVariants(...texts: (string | null | undefined)[]): string[] {
    const out = new Set<string>();
    const add = (value: string) => {
        const normalized = normalizeLatin(value);
        if (!normalized) return;
        out.add(normalized);
        out.add(normalized.replace(/ /g, ""));
    };

    for (const text of texts) {
        if (!text) continue;
        add(text);
        if (!HAN.test(text)) continue;

        const full = pinyin(text, { toneType: "none", type: "array", nonZh: "consecutive" });
        add(full.join(" "));

        const initials = pinyin(text, {
            pattern: "first",
            toneType: "none",
            type: "array",
            nonZh: "consecutive",
        });
        add(initials.join(""));
    }
    return [...out];
}
