// 统一输入事件 → 模拟 DOM 事件
//
// 桌面主文件把 DOM 原生事件与 input api（evdev）聚合（区分来源、融合坐标/帧/按键）成统一输入事件后传入本 api，
// 当前行为是模拟对应的 DOM 事件（Pointer/Wheel/Mouse/Keyboard），
// UI 组件与 wayland 窗口转发照旧消费 DOM 事件
//
// 合成事件没有浏览器默认行为，这里补齐常用默认行为：
// - 左键抬起合成 click 并补齐聚焦（最近的 input/textarea/select/[tabindex]）
// - 按键派发后未被 preventDefault 时补齐文本输入（插入/Backspace/Delete）
//
// DOM 操作通过可注入的宿主接口 InputSimHost 访问，默认实现 domInputSimHost 操作真实 DOM，
// 纯 node 环境可 new inputSim(host) 注入自定义宿主
import { mapKeyCode } from "../input_map/web2x";

/** 输入来源，聚合层用于区分/去重 */
export type InputSource = "dom" | "evdev";

/** 统一指针事件 */
export interface UniPointerEvent {
    kind: "pointer";
    type: "move" | "down" | "up" | "wheel";
    /** 视口坐标 */
    x: number;
    y: number;
    /** down/up 的 DOM 按键（0左 1中 2右） */
    button?: number;
    pointerType?: "mouse" | "touch" | "pen";
    pointerId?: number;
    /** wheel 滚动量 */
    deltaX?: number;
    deltaY?: number;
    /** wheel 单位（0像素 1行 2页），默认像素 */
    deltaMode?: number;
    /** 指定派发目标，缺省按坐标命中测试 */
    target?: unknown;
}

/** 统一键盘事件 */
export interface UniKeyEvent {
    kind: "key";
    type: "down" | "up";
    /** evdev 键码 */
    code: number;
    /** DOM KeyboardEvent.code，缺省由 evdev 码反查 */
    webCode?: string;
    /** DOM KeyboardEvent.key，缺省由 evdev 码 + 修饰键推导 */
    key?: string;
    repeat?: boolean;
    /** 指定派发目标，缺省为当前聚焦元素 */
    target?: unknown;
}

export type UniInputEvent = (UniPointerEvent | UniKeyEvent) & { source: InputSource };

/** 合成事件描述，由宿主映射为具体 DOM 事件 */
export type SimEventInit =
    | {
          kind: "pointer";
          type: "down" | "up" | "move";
          x: number;
          y: number;
          button: number;
          buttons: number;
          pointerType: string;
          pointerId: number;
      }
    | { kind: "mouse"; type: "click"; x: number; y: number; button: number; buttons: number }
    | { kind: "wheel"; type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; deltaMode: number }
    | {
          kind: "key";
          type: "down" | "up";
          code: string;
          key: string;
          repeat: boolean;
          shiftKey: boolean;
          ctrlKey: boolean;
          altKey: boolean;
          metaKey: boolean;
      };

/** 宿主实现的 DOM 操作，便于纯 node 环境注入替换 */
export interface InputSimHost {
    /** 命中测试视口坐标下的目标（DOM 实现：document.elementFromPoint） */
    targetAt(x: number, y: number): unknown;
    /** 当前聚焦目标（DOM 实现：document.activeElement） */
    activeTarget(): unknown;
    /** 聚焦目标或其最近的可聚焦元素 */
    focus(target: unknown): void;
    /** 构造并派发合成事件，返回合成事件（可读 defaultPrevented） */
    dispatch(target: unknown, e: SimEventInit): { defaultPrevented: boolean };
}

// DOM buttons 位掩码（1=左 2=右 4=中）
const BUTTONS_BIT = [1, 4, 2];

export class inputSim {
    private host: InputSimHost | null;
    // 按钮位掩码与修饰键状态由 api 自己维护（多来源事件统一推导）
    private buttons = 0;
    private downButtons = new Set<number>();
    private shift = false;
    private capsLock = false;
    private ctrl = false;
    private alt = false;
    private meta = false;

    constructor(host?: InputSimHost) {
        this.host = host ?? null;
    }

    // DOM 宿主惰性创建，便于纯 node 环境构造本类
    private getHost(): InputSimHost {
        if (!this.host) this.host = domInputSimHost();
        return this.host;
    }

    /** 传入统一输入事件，当前行为为模拟对应 DOM 事件 */
    emit(e: UniInputEvent): void {
        if (e.kind === "pointer") this.emitPointer(e);
        else this.emitKey(e);
    }

    private emitPointer(e: UniPointerEvent) {
        const host = this.getHost();
        const target = e.target ?? host.targetAt(e.x, e.y);
        const pointerType = e.pointerType ?? "mouse";
        const pointerId = e.pointerId ?? 1;

        if (e.type === "wheel") {
            host.dispatch(target, {
                kind: "wheel",
                type: "wheel",
                x: e.x,
                y: e.y,
                deltaX: e.deltaX ?? 0,
                deltaY: e.deltaY ?? 0,
                deltaMode: e.deltaMode ?? 0,
            });
            return;
        }

        const button = e.button ?? 0;
        const bit = BUTTONS_BIT[button] ?? 0;
        if (e.type === "move") {
            host.dispatch(target, {
                kind: "pointer",
                type: "move",
                x: e.x,
                y: e.y,
                button: -1,
                buttons: this.buttons,
                pointerType,
                pointerId,
            });
            return;
        }
        if (e.type === "down") {
            this.buttons |= bit;
            this.downButtons.add(button);
            host.dispatch(target, {
                kind: "pointer",
                type: "down",
                x: e.x,
                y: e.y,
                button,
                buttons: this.buttons,
                pointerType,
                pointerId,
            });
            return;
        }
        this.buttons &= ~bit;
        const pressed = this.downButtons.delete(button);
        host.dispatch(target, {
            kind: "pointer",
            type: "up",
            x: e.x,
            y: e.y,
            button,
            buttons: this.buttons,
            pointerType,
            pointerId,
        });
        // 合成的 click 不会触发聚焦，手动补齐，保证锁屏密码框等可输入
        if (pressed && button === 0) {
            host.focus(target);
            host.dispatch(target, {
                kind: "mouse",
                type: "click",
                x: e.x,
                y: e.y,
                button: 0,
                buttons: this.buttons,
            });
        }
    }

    private emitKey(e: UniKeyEvent) {
        const host = this.getHost();
        const web = e.webCode ?? evdevToWebCode(e.code);
        const down = e.type === "down";
        if (web === "ShiftLeft" || web === "ShiftRight") this.shift = down;
        else if (web === "ControlLeft" || web === "ControlRight") this.ctrl = down;
        else if (web === "AltLeft" || web === "AltRight") this.alt = down;
        else if (web === "MetaLeft" || web === "MetaRight") this.meta = down;
        else if (web === "CapsLock" && down) this.capsLock = !this.capsLock;
        const key = e.key ?? evdevToKey(web, this.shift, this.capsLock);
        const target = e.target ?? host.activeTarget();
        host.dispatch(target, {
            kind: "key",
            type: e.type,
            code: web,
            key,
            repeat: e.repeat ?? false,
            shiftKey: this.shift,
            ctrlKey: this.ctrl,
            altKey: this.alt,
            metaKey: this.meta,
        });
    }
}

/** 默认宿主：操作真实 DOM */
export function domInputSimHost(): InputSimHost {
    return {
        targetAt: (x, y) => document.elementFromPoint(x, y) ?? document.body,
        activeTarget: () => document.activeElement ?? document.body,
        focus: (target) => {
            const el = target as Element | null;
            const focusable = el?.closest("input, textarea, select, [tabindex]") as HTMLElement | null;
            focusable?.focus();
        },
        dispatch: (target, e) => {
            const t = target as Element;
            const event = makeDomEvent(e);
            t.dispatchEvent(event);
            // 合成事件没有默认行为，键入文本等常用默认行为在未被 preventDefault 时补齐
            if (e.kind === "key" && e.type === "down" && !event.defaultPrevented) {
                applyTextDefault(t, e.key);
            }
            return event;
        },
    };
}

function makeDomEvent(e: SimEventInit): Event {
    switch (e.kind) {
        case "pointer":
            return new PointerEvent(`pointer${e.type}`, {
                view: window,
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: e.x,
                clientY: e.y,
                button: e.button,
                buttons: e.buttons,
                pointerId: e.pointerId,
                pointerType: e.pointerType,
                isPrimary: true,
            });
        case "mouse":
            return new MouseEvent(e.type, {
                view: window,
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: e.x,
                clientY: e.y,
                button: e.button,
                buttons: e.buttons,
            });
        case "wheel":
            return new WheelEvent(e.type, {
                view: window,
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: e.x,
                clientY: e.y,
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                deltaMode: e.deltaMode,
            });
        case "key":
            return new KeyboardEvent(e.type === "down" ? "keydown" : "keyup", {
                view: window,
                bubbles: true,
                cancelable: true,
                composed: true,
                code: e.code,
                key: e.key,
                repeat: e.repeat,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                metaKey: e.metaKey,
            });
    }
}

// 可编辑元素（input/textarea/contenteditable）的文本输入默认行为补齐
function applyTextDefault(target: Element, key: string) {
    const editable = target.closest("input, textarea, [contenteditable]") as
        | HTMLInputElement
        | HTMLTextAreaElement
        | HTMLElement
        | null;
    if (!editable) return;
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
        if (key.length === 1) {
            insertText(editable, key);
        } else if (key === "Backspace") {
            deleteText(editable, -1);
        } else if (key === "Delete") {
            deleteText(editable, 1);
        } else {
            return;
        }
        editable.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        return;
    }
    if (editable.isContentEditable) {
        if (key.length === 1) document.execCommand("insertText", false, key);
        else if (key === "Backspace") document.execCommand("delete");
        else if (key === "Delete") document.execCommand("forwardDelete");
    }
}

function insertText(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
    try {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, start) + text + el.value.slice(end);
        el.setSelectionRange(start + text.length, start + text.length);
    } catch {
        // 部分 input 类型（如 number）不支持光标操作
        el.value += text;
    }
}

function deleteText(el: HTMLInputElement | HTMLTextAreaElement, dir: -1 | 1) {
    try {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        if (start !== end) {
            el.value = el.value.slice(0, start) + el.value.slice(end);
            el.setSelectionRange(start, start);
            return;
        }
        const from = dir === -1 ? start - 1 : start;
        const to = dir === -1 ? start : start + 1;
        if (from < 0 || to > el.value.length) return;
        el.value = el.value.slice(0, from) + el.value.slice(to);
        el.setSelectionRange(from, from);
    } catch {
        // 忽略不支持光标操作的 input 类型
    }
}

// evdev 键码 → DOM KeyboardEvent.code 反查表（由 mapKeyCode 的映射反转得到，保证 sendKey(mapKeyCode(code)) 往返一致）
const evdevToWebMap: Map<number, string> = (() => {
    const list = [
        "Space",
        "Enter",
        "Backspace",
        "Tab",
        "Escape",
        "ShiftLeft",
        "ShiftRight",
        "ControlLeft",
        "ControlRight",
        "AltLeft",
        "AltRight",
        "MetaLeft",
        "MetaRight",
        "Minus",
        "Equal",
        "BracketLeft",
        "BracketRight",
        "Backslash",
        "Semicolon",
        "Quote",
        "Backquote",
        "Comma",
        "Period",
        "Slash",
        "CapsLock",
        "Delete",
        "End",
        "Home",
        "Insert",
        "PageDown",
        "PageUp",
        "ScrollLock",
        "Pause",
        "PrintScreen",
        "NumLock",
        ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => `Key${c}`),
        ..."0123456789".split("").map((c) => `Digit${c}`),
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        ..."0123456789".split("").map((c) => `Numpad${c}`),
        "NumpadAdd",
        "NumpadSubtract",
        "NumpadMultiply",
        "NumpadDivide",
        "NumpadDecimal",
        "NumpadEnter",
        ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
    ];
    const m = new Map<number, string>();
    for (const web of list) {
        const code = mapKeyCode(web);
        if (code && !m.has(code)) m.set(code, web);
    }
    return m;
})();

function evdevToWebCode(code: number): string {
    return evdevToWebMap.get(code) ?? "Unidentified";
}

// 可打印字符：[普通, 上档]（美式布局）
const SHIFT_CHARS: Record<string, [string, string]> = {
    Space: [" ", " "],
    Digit1: ["1", "!"],
    Digit2: ["2", "@"],
    Digit3: ["3", "#"],
    Digit4: ["4", "$"],
    Digit5: ["5", "%"],
    Digit6: ["6", "^"],
    Digit7: ["7", "&"],
    Digit8: ["8", "*"],
    Digit9: ["9", "("],
    Digit0: ["0", ")"],
    Minus: ["-", "_"],
    Equal: ["=", "+"],
    BracketLeft: ["[", "{"],
    BracketRight: ["]", "}"],
    Backslash: ["\\", "|"],
    Semicolon: [";", ":"],
    Quote: ["'", '"'],
    Backquote: ["`", "~"],
    Comma: [",", "<"],
    Period: [".", ">"],
    Slash: ["/", "?"],
    Numpad0: ["0", "0"],
    Numpad1: ["1", "1"],
    Numpad2: ["2", "2"],
    Numpad3: ["3", "3"],
    Numpad4: ["4", "4"],
    Numpad5: ["5", "5"],
    Numpad6: ["6", "6"],
    Numpad7: ["7", "7"],
    Numpad8: ["8", "8"],
    Numpad9: ["9", "9"],
    NumpadAdd: ["+", "+"],
    NumpadSubtract: ["-", "-"],
    NumpadMultiply: ["*", "*"],
    NumpadDivide: ["/", "/"],
    NumpadDecimal: [".", "."],
};

// 命名键（不可打印）：DOM KeyboardEvent.key
const NAMED_KEYS: Record<string, string> = {
    Enter: "Enter",
    NumpadEnter: "Enter",
    Backspace: "Backspace",
    Tab: "Tab",
    Escape: "Escape",
    Delete: "Delete",
    End: "End",
    Home: "Home",
    Insert: "Insert",
    PageDown: "PageDown",
    PageUp: "PageUp",
    ScrollLock: "ScrollLock",
    Pause: "Pause",
    PrintScreen: "PrintScreen",
    NumLock: "NumLock",
    CapsLock: "CapsLock",
    ShiftLeft: "Shift",
    ShiftRight: "Shift",
    ControlLeft: "Control",
    ControlRight: "Control",
    AltLeft: "Alt",
    AltRight: "Alt",
    MetaLeft: "Meta",
    MetaRight: "Meta",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
};

// DOM KeyboardEvent.code → KeyboardEvent.key（美式布局，CapsLock 与 Shift 对字母取异或）
function evdevToKey(web: string, shift: boolean, capsLock: boolean): string {
    const chars = SHIFT_CHARS[web];
    if (chars) return shift ? chars[1] : chars[0];
    if (/^Key[A-Z]$/.test(web)) {
        const c = web.slice(3).toLowerCase();
        return capsLock !== shift ? c.toUpperCase() : c;
    }
    const named = NAMED_KEYS[web];
    if (named) return named;
    if (/^F\d+$/.test(web)) return web;
    return "Unidentified";
}
