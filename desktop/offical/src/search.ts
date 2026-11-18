import { normalizeLatin } from "./latin";

/** 搜索栏里的一行；`run` 在用户确认时执行，可以是异步的 */
export type SearchResult = {
    /** 同一 provider 内唯一，用于调试和去重 */
    id: string;
    title: string;
    subtitle?: string;
    /** 右侧来源标签，例如「应用」「窗口」「虚拟屏」 */
    badge?: string;
    /** 匹配得分；引擎用它做跨处理器混排，缺省时排在已评分结果之后 */
    score?: number;
    /** 结果行图标；异步加载，返回 undefined 时显示首字母 */
    icon?: () => Promise<string | undefined>;
    run: () => void | Promise<void>;
};

/**
 * 一个搜索处理器。内置处理器（应用/窗口/虚拟屏）和后续接入的处理器都走这个接口。
 *
 * `search` 可以是同步或异步；`signal` 在输入变化或搜索栏关闭时 abort。
 * 处理器应尽快返回，重 IO 自己缓存；被 abort 后可以继续完成，但引擎会丢弃结果。
 */
export type SearchProvider = {
    id: string;
    /** 同分时的展示顺序；内置为应用 10、窗口 20、虚拟屏 30 */
    order?: number;
    /** 该处理器最多返回几条，默认 8 */
    limit?: number;
    search(query: string, signal: AbortSignal): SearchResult[] | Promise<SearchResult[]>;
};

/** 交给 AI 的内容；后续接入 AI 面板时只需要注册一个 handler */
export type SearchAiRequest = {
    text: string;
};

export type SearchAiHandler = (request: SearchAiRequest) => void | Promise<void>;

export type SearchResponse = {
    /** 本次搜索序号，调用方可用它丢弃过期结果 */
    id: number;
    query: string;
    results: SearchResult[];
};

const DEFAULT_PROVIDER_LIMIT = 8;

function compact(text: string) {
    return text.replace(/ /g, "");
}

/**
 * 模糊匹配得分；不匹配返回 -Infinity。
 *
 * 顺序：完全相同 > 前缀 > 单词前缀 > 子串 > 子序列。
 * 候选里同时保留带空格和不带空格的拉丁形式，所以 `huo hu` 和 `huohu` 都能命中。
 */
export function scoreLatin(query: string, candidates: readonly string[]): number {
    const normalizedQuery = normalizeLatin(query);
    if (!normalizedQuery) return -Infinity;
    const compactQuery = compact(normalizedQuery);

    let best = -Infinity;
    for (const candidate of candidates) {
        const normalizedCandidate = normalizeLatin(candidate);
        if (!normalizedCandidate) continue;
        best = Math.max(
            best,
            scoreOne(normalizedQuery, normalizedCandidate),
            scoreOne(compactQuery, compact(normalizedCandidate)),
        );
    }
    return best;
}

function scoreOne(query: string, candidate: string): number {
    if (!query) return -Infinity;
    if (candidate === query) return 1200;

    if (candidate.startsWith(query)) {
        return 1000 - Math.min(200, (candidate.length - query.length) * 0.5);
    }

    const wordStart = ` ${candidate}`.indexOf(` ${query}`);
    if (wordStart >= 0) {
        return 900 - Math.min(200, wordStart * 2 + (candidate.length - query.length) * 0.2);
    }

    const index = candidate.indexOf(query);
    if (index >= 0) {
        return 800 - Math.min(250, index * 3 + (candidate.length - query.length) * 0.1);
    }

    // 子序列：允许 wjglq 命中 wenjianguanliqi，按间隔和起始位置扣分
    let queryIndex = 0;
    let firstMatch = -1;
    let lastMatch = -1;
    let gaps = 0;
    for (let i = 0; i < candidate.length && queryIndex < query.length; i++) {
        if (candidate[i] !== query[queryIndex]) continue;
        if (firstMatch < 0) firstMatch = i;
        else gaps += i - lastMatch - 1;
        lastMatch = i;
        queryIndex++;
    }
    if (queryIndex !== query.length) return -Infinity;
    return 600 - gaps - firstMatch * 2 - Math.max(0, candidate.length - query.length) * 0.05;
}

/**
 * 搜索收敛层。
 *
 * 处理器并发执行，结果按 `order` 拼起来；新搜索会 abort 上一次。
 * 返回 null 表示这次搜索已经被更新的输入取代，调用方不要渲染。
 */
export class SearchEngine {
    private providers: SearchProvider[] = [];
    private aiHandler?: SearchAiHandler;
    private seq = 0;
    private abort?: AbortController;

    register(provider: SearchProvider): () => void {
        this.providers = [...this.providers.filter((p) => p.id !== provider.id), provider].sort(
            (a, b) => (a.order ?? 100) - (b.order ?? 100),
        );
        return () => {
            this.providers = this.providers.filter((p) => p !== provider);
        };
    }

    /** 注册 AI 处理器；参数为 undefined 时撤销 */
    setAiHandler(handler: SearchAiHandler | undefined) {
        this.aiHandler = handler;
    }

    /** 取消当前搜索（关闭搜索栏时调用） */
    cancel() {
        this.seq++;
        this.abort?.abort();
        this.abort = undefined;
    }

    async search(query: string): Promise<SearchResponse | null> {
        this.abort?.abort();
        const abort = new AbortController();
        this.abort = abort;
        const id = ++this.seq;
        const trimmed = query.trim();

        if (!trimmed) return { id, query: trimmed, results: [] };

        const providers = this.providers;
        const batches = await Promise.all(
            providers.map(async (provider, providerIndex) => {
                if (abort.signal.aborted) return [];
                try {
                    const results = await provider.search(trimmed, abort.signal);
                    return results
                        .slice(0, provider.limit ?? DEFAULT_PROVIDER_LIMIT)
                        .map((result, resultIndex) => ({ providerIndex, resultIndex, result }));
                } catch (error) {
                    if (!abort.signal.aborted) console.warn(`[search] ${provider.id} 搜索失败:`, error);
                    return [];
                }
            }),
        );

        if (abort.signal.aborted || id !== this.seq) return null;

        // 跨处理器按得分混排；同分再按 provider.order 和处理器内部顺序
        const merged = batches.flat().sort((a, b) => {
            const scoreA = a.result.score;
            const scoreB = b.result.score;
            if (scoreA !== undefined || scoreB !== undefined) {
                const diff = (scoreB ?? -Infinity) - (scoreA ?? -Infinity);
                if (diff !== 0) return diff;
            }
            if (a.providerIndex !== b.providerIndex) return a.providerIndex - b.providerIndex;
            return a.resultIndex - b.resultIndex;
        });
        return { id, query: trimmed, results: merged.map((item) => item.result) };
    }

    /**
     * 把搜索文字交给 AI。没有注册 handler 时返回 false，交给调用方提示“未接入”。
     */
    async askAi(text: string): Promise<boolean> {
        const handler = this.aiHandler;
        if (!handler) return false;
        try {
            await handler({ text });
            return true;
        } catch (error) {
            console.warn("[search] AI 处理失败:", error);
            return true;
        }
    }
}
