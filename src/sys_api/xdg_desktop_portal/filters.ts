import type { PortalFilter, PortalFilterRule } from "./types";

/** org.freedesktop.portal.FileChooser 的 a(sa(us)) 中单个过滤器 */
export type WireFilter = [name: string, rules: [type: number, pattern: string][]];

const regexCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
    const cached = regexCache.get(glob);
    if (cached) return cached;
    let source = "^";
    for (const ch of glob) {
        if (ch === "*") {
            source += ".*";
        } else if (ch === "?") {
            source += ".";
        } else {
            source += ch.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
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
