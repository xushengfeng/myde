/** 桌面侧输入法快捷键：序列化、匹配和展示。按键用 KeyboardEvent.code，避免布局差异。 */

export interface KeyBinding {
    /** KeyboardEvent.code，如 "Space"、"KeyE" */
    code: string;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean;
}

export interface ImeBindings {
    /** 激活/停用合成 */
    toggle: KeyBinding[];
    /** 下一个/上一个输入法 */
    nextIM: KeyBinding[];
    prevIM: KeyBinding[];
}

export const DEFAULT_IME_BINDINGS: ImeBindings = {
    toggle: [{ code: "Space", ctrl: true }],
    nextIM: [{ code: "Space", meta: true }],
    prevIM: [{ code: "Space", meta: true, shift: true }],
};

export function matchBindings(e: KeyboardEvent, bindings: KeyBinding[]): boolean {
    return bindings.some(
        (b) =>
            e.code === b.code &&
            !!e.ctrlKey === !!b.ctrl &&
            !!e.shiftKey === !!b.shift &&
            !!e.altKey === !!b.alt &&
            !!e.metaKey === !!b.meta,
    );
}

const CODE_LABELS: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Escape: "Esc",
    Backspace: "Backspace",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Home: "Home",
    End: "End",
    Delete: "Delete",
};

export function formatBinding(b: KeyBinding): string {
    const parts: string[] = [];
    if (b.ctrl) parts.push("Ctrl");
    if (b.alt) parts.push("Alt");
    if (b.shift) parts.push("Shift");
    if (b.meta) parts.push("Super");
    parts.push(CODE_LABELS[b.code] ?? b.code.replace(/^Key/, ""));
    return parts.join("+");
}

export function formatBindings(bindings: KeyBinding[]): string {
    return bindings.map(formatBinding).join(" / ");
}

/** 合并用户配置与默认值；非法项丢弃，避免手改 settings.json 后整个功能失效 */
export function normalizeBindings(value: unknown, fallback: KeyBinding[]): KeyBinding[] {
    if (!Array.isArray(value)) return fallback;
    const out: KeyBinding[] = [];
    for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const b = item as Partial<KeyBinding>;
        if (typeof b.code !== "string" || b.code.length === 0) continue;
        out.push({
            code: b.code,
            ctrl: !!b.ctrl,
            shift: !!b.shift,
            alt: !!b.alt,
            meta: !!b.meta,
        });
    }
    return out.length > 0 ? out : fallback;
}
