/**
 * 虚拟键盘的按键布局（美式 ASCII）。
 *
 * 这里只描述键帽和按键值，不涉及 UI 与输入路由；`code` 是 DOM `KeyboardEvent.code`，
 * `key` / `shiftKey` 是按键产生的字符。修饰键用 `mod` 标记，特殊键用 `action` 标记。
 */

export type VkbModifier = "shift" | "caps" | "ctrl" | "alt" | "meta" | "fn";

/** 键盘布局：极简（手机键盘） / 完整（物理键盘） */
export type VkbLayoutId = "minimal" | "full";
/** 完整键盘的物理配列 */
export type VkbFullVariant = "68" | "75" | "87" | "98" | "104";

export interface VkbKeyDef {
    /** DOM KeyboardEvent.code */
    code: string;
    /** 键帽基础文字 */
    label: string;
    /** 按住 Shift 后的键帽文字 */
    shiftLabel?: string;
    /** 基础按键值，缺省取 label */
    key?: string;
    /** 按住 Shift 后的按键值，缺省取 shiftLabel */
    shiftKey?: string;
    /** 行内伸缩权重 */
    flex?: number;
    /** 修饰键 */
    mod?: VkbModifier;
    /** Fn 层：键帽、按键值和 DOM code */
    fnLabel?: string;
    fnKey?: string;
    fnCode?: string;
    /** 切到数字/符号/字母层，不产生按键 */
    layer?: "letters" | "numbers" | "symbols";
    /** 没有对应美式键码的字符，直接走文本插入 */
    text?: string;
    /** 强制使用/忽略 Shift（固定符号层用） */
    forceShift?: boolean;
    /** 特殊动作（不产生字符） */
    action?: "backspace" | "enter" | "tab" | "escape" | "delete" | "left" | "up" | "down" | "right";
}

export interface VkbKeyPress {
    code: string;
    key: string;
    /** 本次按键是否带 Shift（含临时 Shift 与 Caps 对字母的处理） */
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
    meta: boolean;
}

function letter(l: string): VkbKeyDef {
    return {
        code: `Key${l.toUpperCase()}`,
        label: l,
        shiftLabel: l.toUpperCase(),
    };
}

function digit(d: string, shifted: string): VkbKeyDef {
    return {
        code: `Digit${d}`,
        label: d,
        shiftLabel: shifted,
        shiftKey: shifted,
    };
}

function symbol(code: string, label: string, shifted: string): VkbKeyDef {
    return {
        code,
        label,
        shiftLabel: shifted,
        shiftKey: shifted,
    };
}

const BACKSPACE: VkbKeyDef = {
    code: "Backspace",
    label: "退格",
    key: "Backspace",
    flex: 2,
    action: "backspace",
};

const TAB: VkbKeyDef = {
    code: "Tab",
    label: "Tab",
    key: "Tab",
    flex: 1.6,
    action: "tab",
};

const ENTER: VkbKeyDef = {
    code: "Enter",
    label: "Enter",
    key: "Enter",
    flex: 2.2,
    action: "enter",
};

const SHIFT_LEFT: VkbKeyDef = {
    code: "ShiftLeft",
    label: "Shift",
    flex: 2.2,
    mod: "shift",
};

const SHIFT_RIGHT: VkbKeyDef = {
    code: "ShiftRight",
    label: "Shift",
    flex: 2.6,
    mod: "shift",
};

const SPACE: VkbKeyDef = {
    code: "Space",
    label: "空格",
    key: " ",
    flex: 6,
};

const ARROW_LEFT: VkbKeyDef = {
    code: "ArrowLeft",
    label: "←",
    key: "ArrowLeft",
    action: "left",
};

const ARROW_UP: VkbKeyDef = {
    code: "ArrowUp",
    label: "↑",
    key: "ArrowUp",
    action: "up",
};

const ARROW_DOWN: VkbKeyDef = {
    code: "ArrowDown",
    label: "↓",
    key: "ArrowDown",
    action: "down",
};

const ARROW_RIGHT: VkbKeyDef = {
    code: "ArrowRight",
    label: "→",
    key: "ArrowRight",
    action: "right",
};

const DELETE: VkbKeyDef = {
    code: "Delete",
    label: "Del",
    key: "Delete",
    flex: 1.4,
    action: "delete",
};

const ROW_NUMBER: VkbKeyDef[] = [
    {
        code: "Escape",
        label: "Esc",
        key: "Escape",
        flex: 1.2,
        action: "escape",
    },
    symbol("Backquote", "`", "~"),
    digit("1", "!"),
    digit("2", "@"),
    digit("3", "#"),
    digit("4", "$"),
    digit("5", "%"),
    digit("6", "^"),
    digit("7", "&"),
    digit("8", "*"),
    digit("9", "("),
    digit("0", ")"),
    symbol("Minus", "-", "_"),
    symbol("Equal", "=", "+"),
    BACKSPACE,
];

const ROW_TOP: VkbKeyDef[] = [
    TAB,
    letter("q"),
    letter("w"),
    letter("e"),
    letter("r"),
    letter("t"),
    letter("y"),
    letter("u"),
    letter("i"),
    letter("o"),
    letter("p"),
    symbol("BracketLeft", "[", "{"),
    symbol("BracketRight", "]", "}"),
    { ...symbol("Backslash", "\\", "|"), flex: 1.5 },
];

const ROW_HOME: VkbKeyDef[] = [
    { code: "CapsLock", label: "Caps", flex: 1.8, mod: "caps" },
    letter("a"),
    letter("s"),
    letter("d"),
    letter("f"),
    letter("g"),
    letter("h"),
    letter("j"),
    letter("k"),
    letter("l"),
    symbol("Semicolon", ";", ":"),
    symbol("Quote", "'", '"'),
    ENTER,
];

const ROW_BOTTOM: VkbKeyDef[] = [
    SHIFT_LEFT,
    letter("z"),
    letter("x"),
    letter("c"),
    letter("v"),
    letter("b"),
    letter("n"),
    letter("m"),
    symbol("Comma", ",", "<"),
    symbol("Period", ".", ">"),
    symbol("Slash", "/", "?"),
    SHIFT_RIGHT,
];

const ROW_LAST: VkbKeyDef[] = [
    { code: "ControlLeft", label: "Ctrl", flex: 1.4, mod: "ctrl" },
    { code: "AltLeft", label: "Alt", flex: 1.4, mod: "alt" },
    { code: "MetaLeft", label: "Meta", flex: 1.4, mod: "meta" },
    SPACE,
    ARROW_LEFT,
    ARROW_UP,
    ARROW_DOWN,
    ARROW_RIGHT,
    DELETE,
];

/** 完整键盘（桌面内的虚拟键盘） */
export const FULL_KEY_ROWS: VkbKeyDef[][] = [ROW_NUMBER, ROW_TOP, ROW_HOME, ROW_BOTTOM, ROW_LAST];

/** 锁屏密码键盘：保留字符与编辑键，不需要 Ctrl / 方向键 */
export const ASCII_KEY_ROWS: VkbKeyDef[][] = [ROW_NUMBER, ROW_TOP, ROW_HOME, ROW_BOTTOM, [{ ...SPACE, flex: 10 }]];

/** 取键在给定修饰状态下的实际字符 */
export function keyValueOf(def: VkbKeyDef, shift: boolean): string {
    if (def.key !== undefined) return shift && def.shiftKey !== undefined ? def.shiftKey : def.key;
    if (shift && def.shiftKey !== undefined) return def.shiftKey;
    if (shift && def.shiftLabel !== undefined) return def.shiftLabel;
    return def.label;
}

/** 取键帽文字 */
export function keyLabelOf(def: VkbKeyDef, shift: boolean): string {
    if (shift && def.shiftLabel !== undefined) return def.shiftLabel;
    return def.label;
}

/** 固定字符 → 美式键码；美式布局没有的字符直接走文本 */
const US_CHAR_KEY: Record<string, { code: string; shift: boolean }> = {
    "!": { code: "Digit1", shift: true },
    "@": { code: "Digit2", shift: true },
    "#": { code: "Digit3", shift: true },
    $: { code: "Digit4", shift: true },
    "%": { code: "Digit5", shift: true },
    "^": { code: "Digit6", shift: true },
    "&": { code: "Digit7", shift: true },
    "*": { code: "Digit8", shift: true },
    "(": { code: "Digit9", shift: true },
    ")": { code: "Digit0", shift: true },
    "-": { code: "Minus", shift: false },
    _: { code: "Minus", shift: true },
    "=": { code: "Equal", shift: false },
    "+": { code: "Equal", shift: true },
    "[": { code: "BracketLeft", shift: false },
    "{": { code: "BracketLeft", shift: true },
    "]": { code: "BracketRight", shift: false },
    "}": { code: "BracketRight", shift: true },
    "\\": { code: "Backslash", shift: false },
    "|": { code: "Backslash", shift: true },
    ";": { code: "Semicolon", shift: false },
    ":": { code: "Semicolon", shift: true },
    "'": { code: "Quote", shift: false },
    '"': { code: "Quote", shift: true },
    ",": { code: "Comma", shift: false },
    "<": { code: "Comma", shift: true },
    ".": { code: "Period", shift: false },
    ">": { code: "Period", shift: true },
    "/": { code: "Slash", shift: false },
    "?": { code: "Slash", shift: true },
    "`": { code: "Backquote", shift: false },
    "~": { code: "Backquote", shift: true },
    " ": { code: "Space", shift: false },
    "0": { code: "Digit0", shift: false },
    "1": { code: "Digit1", shift: false },
    "2": { code: "Digit2", shift: false },
    "3": { code: "Digit3", shift: false },
    "4": { code: "Digit4", shift: false },
    "5": { code: "Digit5", shift: false },
    "6": { code: "Digit6", shift: false },
    "7": { code: "Digit7", shift: false },
    "8": { code: "Digit8", shift: false },
    "9": { code: "Digit9", shift: false },
};

/** 一个固定字符键：有美式键码就发按键，否则直接插文字 */
export function charKey(ch: string, flex?: number): VkbKeyDef {
    const mapped = US_CHAR_KEY[ch];
    if (!mapped) return { code: `Text-${ch}`, label: ch, key: ch, text: ch, forceShift: false, flex };
    return {
        code: mapped.code,
        label: ch,
        key: ch,
        forceShift: mapped.shift,
        flex,
    };
}

function shiftedDigit(d: string): string {
    return ")!@#$%^&*(".charAt(Number(d));
}

// ── 紧凑布局 ────────────────────────────────────────────────────────────────

/** 紧凑布局：四行、字母为主，数字和符号放在层里 */
export const COMPACT_LETTER_ROWS: VkbKeyDef[][] = [
    [
        { code: "Escape", label: "Esc", key: "Escape", flex: 0.9, action: "escape" },
        { ...TAB, flex: 1.3 },
        letter("q"),
        letter("w"),
        letter("e"),
        letter("r"),
        letter("t"),
        letter("y"),
        letter("u"),
        letter("i"),
        letter("o"),
        letter("p"),
        { ...BACKSPACE, flex: 1.7 },
    ],
    [
        { code: "CapsLock", label: "Caps", flex: 1.5, mod: "caps" },
        letter("a"),
        letter("s"),
        letter("d"),
        letter("f"),
        letter("g"),
        letter("h"),
        letter("j"),
        letter("k"),
        letter("l"),
        symbol("Semicolon", ";", ":"),
        symbol("Quote", "'", '"'),
        { ...ENTER, flex: 1.9 },
    ],
    [
        SHIFT_LEFT,
        letter("z"),
        letter("x"),
        letter("c"),
        letter("v"),
        letter("b"),
        letter("n"),
        letter("m"),
        symbol("Comma", ",", "<"),
        symbol("Period", ".", ">"),
        symbol("Slash", "/", "?"),
        SHIFT_RIGHT,
    ],
    [
        { code: "ControlLeft", label: "Ctrl", flex: 1.2, mod: "ctrl" },
        { code: "AltLeft", label: "Alt", flex: 1.2, mod: "alt" },
        { code: "MetaLeft", label: "Meta", flex: 1.2, mod: "meta" },
        { code: "LayerNumbers", label: "123", key: "123", flex: 1.3, layer: "numbers" },
        { ...SPACE, flex: 5 },
        ARROW_LEFT,
        ARROW_UP,
        ARROW_DOWN,
        ARROW_RIGHT,
        { ...DELETE, flex: 1.2 },
    ],
];

export const COMPACT_NUMBER_ROWS: VkbKeyDef[][] = [
    [
        digit("1", "!"),
        digit("2", "@"),
        digit("3", "#"),
        digit("4", "$"),
        digit("5", "%"),
        digit("6", "^"),
        digit("7", "&"),
        digit("8", "*"),
        digit("9", "("),
        digit("0", ")"),
        { ...BACKSPACE, flex: 1.6 },
    ],
    [
        symbol("Minus", "-", "_"),
        symbol("Equal", "=", "+"),
        symbol("BracketLeft", "[", "{"),
        symbol("BracketRight", "]", "}"),
        symbol("Backslash", "\\", "|"),
        symbol("Semicolon", ";", ":"),
        symbol("Quote", "'", '"'),
        symbol("Comma", ",", "<"),
        symbol("Period", ".", ">"),
        symbol("Slash", "/", "?"),
    ],
    [
        { code: "LayerLetters", label: "ABC", key: "ABC", flex: 1.4, layer: "letters" },
        charKey("("),
        charKey(")"),
        charKey("~"),
        charKey(":"),
        charKey("@"),
        charKey("#"),
        charKey("$"),
        charKey("%"),
        charKey("&"),
        charKey("*"),
        charKey("`"),
    ],
    [{ ...SPACE, flex: 5 }, charKey(","), charKey("."), charKey("?"), { ...ENTER, flex: 1.8 }],
];

// ── 手机布局 ────────────────────────────────────────────────────────────────

const PHONE_SPACE: VkbKeyDef = { code: "Space", label: "空格", key: " ", flex: 4.5 };
const PHONE_ENTER: VkbKeyDef = { code: "Enter", label: "Enter", key: "Enter", flex: 1.5, action: "enter" };
const PHONE_SHIFT: VkbKeyDef = { code: "ShiftLeft", label: "Shift", flex: 1.4, mod: "shift" };
const PHONE_BACKSPACE: VkbKeyDef = {
    code: "Backspace",
    label: "退格",
    key: "Backspace",
    flex: 1.4,
    action: "backspace",
};

export const PHONE_LETTER_ROWS: VkbKeyDef[][] = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"].map(letter),
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"].map(letter),
    [PHONE_SHIFT, ...["z", "x", "c", "v", "b", "n", "m"].map(letter), PHONE_BACKSPACE],
    [
        { code: "LayerNumbers", label: "123", key: "123", flex: 1.3, layer: "numbers" },
        { code: "Comma", label: ",", key: ",", flex: 0.9 },
        PHONE_SPACE,
        { code: "Period", label: ".", key: ".", flex: 0.9 },
        PHONE_ENTER,
    ],
];

export const PHONE_NUMBER_ROWS: VkbKeyDef[][] = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((ch) => charKey(ch)),
    ["-", "/", ":", ";", "(", ")", "$", "&", "@", '"'].map((ch) => charKey(ch)),
    [
        { code: "LayerSymbols", label: "#+=", key: "#+=", flex: 1.4, layer: "symbols" },
        ...[",", "?", "!", "'", "+", "="].map((ch) => charKey(ch)),
        PHONE_BACKSPACE,
    ],
    [
        { code: "LayerLetters", label: "ABC", key: "ABC", flex: 1.3, layer: "letters" },
        charKey(",", 0.9),
        PHONE_SPACE,
        charKey(".", 0.9),
        PHONE_ENTER,
    ],
];

export const PHONE_SYMBOL_ROWS: VkbKeyDef[][] = [
    ["[", "]", "{", "}", "#", "%", "^", "*", "+", "="].map((ch) => charKey(ch)),
    ["_", "\\", "|", "~", "<", ">", "€", "£", "¥", "•"].map((ch) => charKey(ch)),
    [
        { code: "LayerNumbers", label: "123", key: "123", flex: 1.4, layer: "numbers" },
        ...[",", "?", "!", "'", "°", "±", "§"].map((ch) => charKey(ch)),
        PHONE_BACKSPACE,
    ],
    [
        { code: "LayerLetters", label: "ABC", key: "ABC", flex: 1.3, layer: "letters" },
        charKey(",", 0.9),
        PHONE_SPACE,
        charKey(".", 0.9),
        PHONE_ENTER,
    ],
];

// ── 电脑真实键盘 ────────────────────────────────────────────────────────────

function fkey(n: number): VkbKeyDef {
    return { code: `F${n}`, label: `F${n}`, key: `F${n}` };
}

function navKey(code: string, label: string, key: string): VkbKeyDef {
    return { code, label, key };
}

export const DESKTOP_MAIN_ROWS: VkbKeyDef[][] = [
    [
        { code: "Escape", label: "Esc", key: "Escape", action: "escape" },
        fkey(1),
        fkey(2),
        fkey(3),
        fkey(4),
        fkey(5),
        fkey(6),
        fkey(7),
        fkey(8),
        fkey(9),
        fkey(10),
        fkey(11),
        fkey(12),
    ],
    [
        { ...symbol("Backquote", "`", "~"), flex: 0.9 },
        ...["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((d) => digit(d, shiftedDigit(d))),
        symbol("Minus", "-", "_"),
        symbol("Equal", "=", "+"),
        { ...BACKSPACE, flex: 1.8 },
    ],
    [
        { ...TAB, flex: 1.4 },
        ...["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"].map(letter),
        symbol("BracketLeft", "[", "{"),
        symbol("BracketRight", "]", "}"),
        { ...symbol("Backslash", "\\", "|"), flex: 1.4 },
    ],
    [
        { code: "CapsLock", label: "Caps", flex: 1.7, mod: "caps" },
        ...["a", "s", "d", "f", "g", "h", "j", "k", "l"].map(letter),
        symbol("Semicolon", ";", ":"),
        symbol("Quote", "'", '"'),
        { ...ENTER, flex: 2 },
    ],
    [
        { ...SHIFT_LEFT, flex: 2.1 },
        ...["z", "x", "c", "v", "b", "n", "m"].map(letter),
        symbol("Comma", ",", "<"),
        symbol("Period", ".", ">"),
        symbol("Slash", "/", "?"),
        { ...SHIFT_RIGHT, flex: 2.4 },
    ],
    [
        { code: "ControlLeft", label: "Ctrl", flex: 1.2, mod: "ctrl" },
        { code: "MetaLeft", label: "Win", flex: 1.1, mod: "meta" },
        { code: "AltLeft", label: "Alt", flex: 1.1, mod: "alt" },
        { ...SPACE, flex: 5.5 },
        { code: "AltRight", label: "Alt", flex: 1.1, mod: "alt" },
        { code: "ControlRight", label: "Ctrl", flex: 1.2, mod: "ctrl" },
    ],
];

export const DESKTOP_NAV_ROWS: VkbKeyDef[][] = [
    [
        navKey("PrintScreen", "PrtSc", "PrintScreen"),
        navKey("ScrollLock", "ScrLk", "ScrollLock"),
        navKey("Pause", "Pause", "Pause"),
    ],
    [navKey("Insert", "Ins", "Insert"), navKey("Home", "Home", "Home"), navKey("PageUp", "PgUp", "PageUp")],
    [navKey("Delete", "Del", "Delete"), navKey("End", "End", "End"), navKey("PageDown", "PgDn", "PageDown")],
];

/** 98 / 75 配列用的精简导航区；去掉 PrtSc / ScrLk / Pause 一行 */
export const DESKTOP_NAV_COMPACT_ROWS: VkbKeyDef[][] = [
    [navKey("Insert", "Ins", "Insert"), navKey("Home", "Home", "Home"), navKey("PageUp", "PgUp", "PageUp")],
    [navKey("Delete", "Del", "Delete"), navKey("End", "End", "End"), navKey("PageDown", "PgDn", "PageDown")],
];

export interface DesktopNumpadKey {
    key: VkbKeyDef;
    col: number;
    row: number;
    colSpan?: number;
    rowSpan?: number;
}

function np(code: string, label: string, key: string): VkbKeyDef {
    return { code, label, key };
}

export const DESKTOP_NUMPAD: DesktopNumpadKey[] = [
    { key: np("NumLock", "Num", "NumLock"), col: 1, row: 1 },
    { key: np("NumpadDivide", "/", "/"), col: 2, row: 1 },
    { key: np("NumpadMultiply", "*", "*"), col: 3, row: 1 },
    { key: np("NumpadSubtract", "-", "-"), col: 4, row: 1 },
    { key: np("Numpad7", "7", "7"), col: 1, row: 2 },
    { key: np("Numpad8", "8", "8"), col: 2, row: 2 },
    { key: np("Numpad9", "9", "9"), col: 3, row: 2 },
    { key: np("NumpadAdd", "+", "+"), col: 4, row: 2, rowSpan: 2 },
    { key: np("Numpad4", "4", "4"), col: 1, row: 3 },
    { key: np("Numpad5", "5", "5"), col: 2, row: 3 },
    { key: np("Numpad6", "6", "6"), col: 3, row: 3 },
    { key: np("Numpad1", "1", "1"), col: 1, row: 4 },
    { key: np("Numpad2", "2", "2"), col: 2, row: 4 },
    { key: np("Numpad3", "3", "3"), col: 3, row: 4 },
    { key: np("NumpadEnter", "Enter", "Enter"), col: 4, row: 4, rowSpan: 2 },
    { key: np("Numpad0", "0", "0"), col: 1, row: 5, colSpan: 2 },
    { key: np("NumpadDecimal", ".", "."), col: 3, row: 5 },
];

/** 方向键独立放在导航区下方，和真实键盘一致 */
export const DESKTOP_ARROWS: DesktopNumpadKey[] = [
    { key: ARROW_UP, col: 2, row: 1 },
    { key: ARROW_LEFT, col: 1, row: 2 },
    { key: ARROW_DOWN, col: 2, row: 2 },
    { key: ARROW_RIGHT, col: 3, row: 2 },
];

// ── 68 配列 ──────────────────────────────────────────────────────────────────

function withFn(def: VkbKeyDef, fnCode: string, fnKey: string, fnLabel: string): VkbKeyDef {
    return { ...def, fnCode, fnKey, fnLabel };
}

/** 68 键：没有独立 F 行和导航区，用 Fn 取 F1-F12、Home/End/PgUp/PgDn */
export const PHYSICAL_68_ROWS: VkbKeyDef[][] = [
    DESKTOP_MAIN_ROWS[1].map((def) => {
        if (def.code.startsWith("Digit")) {
            const n = def.code.slice(5);
            return withFn(def, `F${n}`, `F${n}`, `F${n}`);
        }
        if (def.code === "Minus") return withFn(def, "F11", "F11", "F11");
        if (def.code === "Equal") return withFn(def, "F12", "F12", "F12");
        if (def.code === "Backquote") return withFn(def, "Escape", "Escape", "Esc");
        if (def.code === "Backspace") return withFn(def, "Delete", "Delete", "Del");
        return def;
    }),
    DESKTOP_MAIN_ROWS[2],
    DESKTOP_MAIN_ROWS[3],
    DESKTOP_MAIN_ROWS[4],
    [
        { code: "ControlLeft", label: "Ctrl", flex: 1.2, mod: "ctrl" },
        { code: "MetaLeft", label: "Win", flex: 1.1, mod: "meta" },
        { code: "AltLeft", label: "Alt", flex: 1.1, mod: "alt" },
        { ...SPACE, flex: 5 },
        { code: "AltRight", label: "Alt", flex: 1.1, mod: "alt" },
        { code: "Fn", label: "Fn", flex: 1.1, mod: "fn" },
        { code: "ControlRight", label: "Ctrl", flex: 1.2, mod: "ctrl" },
        withFn(ARROW_LEFT, "Home", "Home", "Home"),
        withFn(ARROW_UP, "PageUp", "PageUp", "PgUp"),
        withFn(ARROW_DOWN, "PageDown", "PageDown", "PgDn"),
        withFn(ARROW_RIGHT, "End", "End", "End"),
    ],
];
