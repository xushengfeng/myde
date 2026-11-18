import type { PortalFilter, PortalFilterRule } from "./types";

/** org.freedesktop.portal.FileChooser 的 a(sa(us)) 中单个过滤器 */
export type WireFilter = [name: string, rules: [type: number, pattern: string][]];

const regexCache = new Map<string, RegExp>();

function escapeRegExp(text: string): string {
    return text.replace(/[\\^$.|+()[\]{}*?]/g, "\\$&");
}

/**
 * 解析 `[...]` 字符类。portal 文档用 '*.[iI][cC][oO]' 表示大小写不敏感，
 * Chromium 的 `<input accept>` 过滤器就是这样下发规则的。
 * 返回 undefined 表示没有闭合的 `]`，按普通字符处理。
 */
function parseCharacterClass(glob: string, start: number): { source: string; end: number } | undefined {
    let index = start + 1;
    let negated = false;
    if (glob[index] === "!" || glob[index] === "^") {
        negated = true;
        index++;
    }
    let body = "";
    let first = true;
    while (index < glob.length) {
        const ch = glob[index];
        if (ch === "]" && !first) {
            return { source: `[${negated ? "^" : ""}${body}]`, end: index };
        }
        first = false;
        if (ch === "]" || ch === "\\" || ch === "^" || ch === "[") {
            body += `\\${ch}`;
        } else {
            body += ch;
        }
        index++;
    }
    return undefined;
}

function globToRegExp(glob: string): RegExp {
    const cached = regexCache.get(glob);
    if (cached) return cached;
    let source = "^";
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === "*") {
            source += ".*";
        } else if (ch === "?") {
            source += ".";
        } else if (ch === "[") {
            const charClass = parseCharacterClass(glob, i);
            if (charClass) {
                source += charClass.source;
                i = charClass.end;
            } else {
                source += "\\[";
            }
        } else {
            source += escapeRegExp(ch);
        }
    }
    source += "$";
    const regex = new RegExp(source);
    regexCache.set(glob, regex);
    return regex;
}

export function matchMime(pattern: string, mime: string): boolean {
    if (pattern === "*" || pattern === "*/*") return true;
    if (pattern.endsWith("/*")) return mime.startsWith(pattern.slice(0, -1));
    return mime === pattern;
}

export function matchFilter(name: string, mime: string, filter: PortalFilter): boolean {
    return filter.rules.some((rule) =>
        rule.kind === "glob" ? globToRegExp(rule.pattern).test(name) : matchMime(rule.pattern, mime),
    );
}

export function fromWireFilter(filter: WireFilter): PortalFilter {
    return {
        name: filter[0],
        rules: filter[1].map(
            ([type, pattern]): PortalFilterRule => ({
                kind: type === 1 ? "mime" : "glob",
                pattern,
            }),
        ),
    };
}

export function toWireFilter(filter: PortalFilter): WireFilter {
    return [filter.name, filter.rules.map((rule): [number, string] => [rule.kind === "mime" ? 1 : 0, rule.pattern])];
}
