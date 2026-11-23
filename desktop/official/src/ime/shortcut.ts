/** 桌面侧输入法快捷键：序列化、匹配和展示。按键用 KeyboardEvent.code，避免布局差异。 */

export type ImeModifier = "ctrl" | "shift" | "alt" | "meta";

export interface KeyBinding {
    /** KeyboardEvent.code，如 "Space"、"KeyE"；省略表示只按修饰键组合（如 Ctrl+Shift） */
    code?: string;
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
    // 单独按下再松开 Ctrl+Shift 激活/停用合成，和 Windows 的输入法切换一致
    toggle: [{ ctrl: true, shift: true }],
    nextIM: [{ code: "Space", meta: true }],
    prevIM: [{ code: "Space", meta: true, shift: true }],
};

const MODIFIER_CODES: Record<string, ImeModifier> = {
    ControlLeft: "ctrl",
    ControlRight: "ctrl",
    ShiftLeft: "shift",
    ShiftRight: "shift",
    AltLeft: "alt",
    AltRight: "alt",
    MetaLeft: "meta",
    MetaRight: "meta",
    OSLeft: "meta",
    OSRight: "meta",
};

export function modifierOfCode(code: string): ImeModifier | undefined {
    return MODIFIER_CODES[code];
}

function hasModifier(b: KeyBinding): boolean {
    return !!(b.ctrl || b.shift || b.alt || b.meta);
}

/** 带 code 的快捷键；纯修饰键组合不在这里匹配 */
export function matchBindings(e: KeyboardEvent, bindings: KeyBinding[]): boolean {
    return bindings.some(
        (b) =>
            !!b.code &&
            e.code === b.code &&
            !!e.ctrlKey === !!b.ctrl &&
            !!e.shiftKey === !!b.shift &&
            !!e.altKey === !!b.alt &&
            !!e.metaKey === !!b.meta,
    );
}

/** 当前按住的修饰键正好等于某个纯修饰键组合时返回该组合 */
export function matchModifierBinding(
    modifiers: ReadonlySet<ImeModifier>,
    bindings: KeyBinding[],
): KeyBinding | undefined {
    if (modifiers.size === 0) return undefined;
    return bindings.find(
        (b) =>
            !b.code &&
            hasModifier(b) &&
            !!b.ctrl === modifiers.has("ctrl") &&
            !!b.shift === modifiers.has("shift") &&
            !!b.alt === modifiers.has("alt") &&
            !!b.meta === modifiers.has("meta"),
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
    if (b.code) parts.push(CODE_LABELS[b.code] ?? b.code.replace(/^Key/, ""));
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
        const code = typeof b.code === "string" && b.code.length > 0 ? b.code : undefined;
        const binding: KeyBinding = {
            ctrl: !!b.ctrl,
            shift: !!b.shift,
            alt: !!b.alt,
            meta: !!b.meta,
        };
        if (code) binding.code = code;
        if (!code && !hasModifier(binding)) continue;
        out.push(binding);
    }
    return out.length > 0 ? out : fallback;
}
