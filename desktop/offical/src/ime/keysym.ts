/**
 * DOM 按键 → fcitx5 ProcessKeyEvent 需要的 X keysym / modifier state / evdev keycode。
 *
 * `KeyboardEvent.key` 已经是当前布局下的字符，可直接当 keysym；只有特殊键和修饰键
 * 需要查表。输入法只消费按键，不负责字符本身的布局转换。
 */

export interface ImeKey {
    /** X keysym */
    keysym: number;
    /** X11 modifier mask：Shift=1、Lock=2、Control=4、Mod1/Alt=8、Mod4/Super=64 */
    state: number;
    /** evdev 键码，fcitx 的部分引擎会用到 */
    keycode: number;
}

/** 不能按字符处理的键；修饰键单独排除，避免一次 Shift 被当成普通按键吞掉 */
const SPECIAL_KEYS: Record<string, number> = {
    Backspace: 0xff08,
    Tab: 0xff09,
    Enter: 0xff0d,
    NumpadEnter: 0xff0d,
    Escape: 0xff1b,
    Delete: 0xffff,
    Insert: 0xff63,
    Home: 0xff50,
    End: 0xff57,
    PageUp: 0xff55,
    PageDown: 0xff56,
    ArrowLeft: 0xff51,
    ArrowUp: 0xff52,
    ArrowRight: 0xff53,
    ArrowDown: 0xff54,
    CapsLock: 0xffe5,
    Pause: 0xff13,
    PrintScreen: 0xff61,
    ContextMenu: 0xff67,
    NumpadAdd: 0xffab,
    NumpadSubtract: 0xffad,
    NumpadMultiply: 0xffaa,
    NumpadDivide: 0xffaf,
    NumpadDecimal: 0xffae,
};

const MODIFIER_KEYS = new Set([
    "ShiftLeft",
    "ShiftRight",
    "ControlLeft",
    "ControlRight",
    "AltLeft",
    "AltRight",
    "MetaLeft",
    "MetaRight",
    "OSLeft",
    "OSRight",
]);

/** 纯修饰键不送输入法：状态通过后续按键的 state 传递，避免 Shift 触发键来回切换 */
export function isModifierKey(code: string): boolean {
    return MODIFIER_KEYS.has(code);
}

export function keyEventToIme(e: KeyboardEvent): ImeKey | undefined {
    if (isModifierKey(e.code)) return undefined;

    const keysym = keySymOf(e);
    if (keysym === undefined) return undefined;

    let state = 0;
    if (e.shiftKey) state |= 1;
    if (e.getModifierState?.("CapsLock")) state |= 2;
    if (e.ctrlKey) state |= 4;
    if (e.altKey) state |= 8;
    if (e.metaKey) state |= 64;

    return { keysym, state, keycode: myde.MInputMap.mapKeyCode(e.code) };
}

function keySymOf(e: KeyboardEvent): number | undefined {
    const special = SPECIAL_KEYS[e.code] ?? SPECIAL_KEYS[e.key];
    if (special !== undefined) return special;

    const f = /^F([1-9]|1\d|2[0-4])$/.exec(e.key);
    if (f) return 0xffbe + Number(f[1]) - 1;

    if ([...e.key].length !== 1) return undefined;
    const cp = e.key.codePointAt(0);
    if (cp === undefined) return undefined;
    // Latin-1 直接使用码位；其余走 Unicode keysym 约定
    return cp <= 0xff ? cp : 0x01000000 | cp;
}
