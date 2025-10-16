import { InputEventCodes } from "../input_codes/types";

export function mapKeyCode(code: string): number {
    const codeMap: Record<string, number> = {
        Space: InputEventCodes.KEY_SPACE,
        Enter: InputEventCodes.KEY_ENTER,
        Backspace: InputEventCodes.KEY_BACKSPACE,
        Tab: InputEventCodes.KEY_TAB,
        Escape: InputEventCodes.KEY_ESC,
        ShiftLeft: InputEventCodes.KEY_LEFTSHIFT,
        ShiftRight: InputEventCodes.KEY_RIGHTSHIFT,
        ControlLeft: InputEventCodes.KEY_LEFTCTRL,
        ControlRight: InputEventCodes.KEY_RIGHTCTRL,
        AltLeft: InputEventCodes.KEY_LEFTALT,
        AltRight: InputEventCodes.KEY_RIGHTALT,
        MetaLeft: InputEventCodes.KEY_LEFTMETA,
        MetaRight: InputEventCodes.KEY_RIGHTMETA,
        Minus: InputEventCodes.KEY_MINUS,
        Equal: InputEventCodes.KEY_EQUAL,
        BracketLeft: InputEventCodes.KEY_LEFTBRACE,
        BracketRight: InputEventCodes.KEY_RIGHTBRACE,
        Backslash: InputEventCodes.KEY_BACKSLASH,
        Semicolon: InputEventCodes.KEY_SEMICOLON,
        Quote: InputEventCodes.KEY_APOSTROPHE,
        Backquote: InputEventCodes.KEY_GRAVE,
        Comma: InputEventCodes.KEY_COMMA,
        Period: InputEventCodes.KEY_DOT,
        Slash: InputEventCodes.KEY_SLASH,
        CapsLock: InputEventCodes.KEY_CAPSLOCK,
        Delete: InputEventCodes.KEY_DELETE,
        End: InputEventCodes.KEY_END,
        Home: InputEventCodes.KEY_HOME,
        Insert: InputEventCodes.KEY_INSERT,
        PageDown: InputEventCodes.KEY_PAGEDOWN,
        PageUp: InputEventCodes.KEY_PAGEUP,
        ScrollLock: InputEventCodes.KEY_SCROLLLOCK,
        Pause: InputEventCodes.KEY_PAUSE,
        PrintScreen: InputEventCodes.KEY_PRINT,
        NumLock: InputEventCodes.KEY_NUMLOCK,
    };
    if (code in codeMap) return codeMap[code];

    if (code.startsWith("Key")) {
        return InputEventCodes[`KEY_${code.at(-1)}`] || 0;
    }
    if (code.startsWith("Digit")) {
        return InputEventCodes[`KEY_${code.slice(5)}`] || 0;
    }
    if (code.startsWith("Arrow")) {
        return InputEventCodes[`KEY_${code.slice(5).toUpperCase()}`] || 0;
    }
    if (code.startsWith("Numpad")) {
        const numpadKey = code.slice(6);
        if (!Number.isNaN(Number(numpadKey))) {
            return InputEventCodes[`KEY_KP_${numpadKey}`] || 0;
        } else if (numpadKey === "Add") {
            return InputEventCodes.KEY_KPPLUS;
        } else if (numpadKey === "Subtract") {
            return InputEventCodes.KEY_KPMINUS;
        } else if (numpadKey === "Multiply") {
            return InputEventCodes.KEY_KPASTERISK;
        } else if (numpadKey === "Divide") {
            return InputEventCodes.KEY_KPSLASH;
        } else if (numpadKey === "Decimal") {
            return InputEventCodes.KEY_KPDOT;
        } else if (numpadKey === "Enter") {
            return InputEventCodes.KEY_KPENTER;
        }
    }
    if (code.startsWith("F")) {
        const fnNumber = Number(code.slice(1));
        if (!Number.isNaN(fnNumber) && fnNumber >= 1 && fnNumber <= 24) {
            return InputEventCodes[`KEY_F${fnNumber}`] || 0;
        }
    }

    return 0;
}
