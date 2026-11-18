/**
 * Linux 输入事件码常量
 * 基于 linux/input-event-codes.h
 */

/** 事件类型 */
export const EV_SYN = 0;
export const EV_KEY = 1;
export const EV_REL = 2;
export const EV_ABS = 3;
export const EV_MSC = 4;
export const EV_SW = 5;
export const EV_LED = 6;
export const EV_SND = 7;
export const EV_REP = 8;
export const EV_FF = 9;
export const EV_PWR = 10;
export const EV_FF_STATUS = 11;
export const EV_MAX = 15;

/** 同步事件 */
export const SYN_REPORT = 0;
export const SYN_CONFIG = 1;
export const SYN_MT_REPORT = 2;
export const SYN_DROPPED = 3;

/** 按键事件 */
export const KEY_RESERVED = 0;
export const KEY_ESC = 1;
export const KEY_1 = 2;
export const KEY_2 = 3;
export const KEY_3 = 4;
export const KEY_4 = 5;
export const KEY_5 = 6;
export const KEY_6 = 7;
export const KEY_7 = 8;
export const KEY_8 = 9;
export const KEY_9 = 10;
export const KEY_0 = 11;
export const KEY_MINUS = 12;
export const KEY_EQUAL = 13;
export const KEY_BACKSPACE = 14;
export const KEY_TAB = 15;
export const KEY_Q = 16;
export const KEY_W = 17;
export const KEY_E = 18;
export const KEY_R = 19;
export const KEY_T = 20;
export const KEY_Y = 21;
export const KEY_U = 22;
export const KEY_I = 23;
export const KEY_O = 24;
export const KEY_P = 25;
export const KEY_LEFTBRACE = 26;
export const KEY_RIGHTBRACE = 27;
export const KEY_ENTER = 28;
export const KEY_LEFTCTRL = 29;
export const KEY_A = 30;
export const KEY_S = 31;
export const KEY_D = 32;
export const KEY_F = 33;
export const KEY_G = 34;
export const KEY_H = 35;
export const KEY_J = 36;
export const KEY_K = 37;
export const KEY_L = 38;
export const KEY_SEMICOLON = 39;
export const KEY_APOSTROPHE = 40;
export const KEY_GRAVE = 41;
export const KEY_LEFTSHIFT = 42;
export const KEY_BACKSLASH = 43;
export const KEY_Z = 44;
export const KEY_X = 45;
export const KEY_C = 46;
export const KEY_V = 47;
export const KEY_B = 48;
export const KEY_N = 49;
export const KEY_M = 50;
export const KEY_COMMA = 51;
export const KEY_DOT = 52;
export const KEY_SLASH = 53;
export const KEY_RIGHTSHIFT = 54;
export const KEY_KPASTERISK = 55;
export const KEY_LEFTALT = 56;
export const KEY_SPACE = 57;
export const KEY_CAPSLOCK = 58;
export const KEY_F1 = 59;
export const KEY_F2 = 60;
export const KEY_F3 = 61;
export const KEY_F4 = 62;
export const KEY_F5 = 63;
export const KEY_F6 = 64;
export const KEY_F7 = 65;
export const KEY_F8 = 66;
export const KEY_F9 = 67;
export const KEY_F10 = 68;
export const KEY_NUMLOCK = 69;
export const KEY_SCROLLLOCK = 70;
export const KEY_KP7 = 71;
export const KEY_KP8 = 72;
export const KEY_KP9 = 73;
export const KEY_KPMINUS = 74;
export const KEY_KP4 = 75;
export const KEY_KP5 = 76;
export const KEY_KP6 = 77;
export const KEY_KPPLUS = 78;
export const KEY_KP1 = 79;
export const KEY_KP2 = 80;
export const KEY_KP3 = 81;
export const KEY_KP0 = 82;
export const KEY_KPDOT = 83;
export const KEY_F11 = 87;
export const KEY_F12 = 88;
export const KEY_KPENTER = 96;
export const KEY_RIGHTCTRL = 97;
export const KEY_KPSLASH = 98;
export const KEY_SYSRQ = 99;
export const KEY_RIGHTALT = 100;
export const KEY_HOME = 102;
export const KEY_UP = 103;
export const KEY_PAGEUP = 104;
export const KEY_LEFT = 105;
export const KEY_RIGHT = 106;
export const KEY_END = 107;
export const KEY_DOWN = 108;
export const KEY_PAGEDOWN = 109;
export const KEY_INSERT = 110;
export const KEY_DELETE = 111;
export const KEY_LEFTMETA = 125;
export const KEY_RIGHTMETA = 126;
export const KEY_COMPOSE = 127;

/** 鼠标按钮 */
export const BTN_LEFT = 0x110;
export const BTN_RIGHT = 0x111;
export const BTN_MIDDLE = 0x112;
export const BTN_SIDE = 0x113;
export const BTN_EXTRA = 0x114;
export const BTN_FORWARD = 0x115;
export const BTN_BACK = 0x116;
export const BTN_TASK = 0x117;

/** 游戏手柄按钮 */
export const BTN_TRIGGER = 0x120;
export const BTN_THUMB = 0x121;
export const BTN_THUMB2 = 0x122;
export const BTN_TOP = 0x123;
export const BTN_TOP2 = 0x124;
export const BTN_PINKIE = 0x125;
export const BTN_BASE = 0x126;
export const BTN_BASE2 = 0x127;
export const BTN_BASE3 = 0x128;
export const BTN_BASE4 = 0x129;
export const BTN_BASE5 = 0x12a;
export const BTN_BASE6 = 0x12b;
export const BTN_DEAD = 0x12f;

export const BTN_A = 0x130;
export const BTN_B = 0x131;
export const BTN_C = 0x132;
export const BTN_X = 0x133;
export const BTN_Y = 0x134;
export const BTN_Z = 0x135;
export const BTN_TL = 0x136;
export const BTN_TR = 0x137;
export const BTN_TL2 = 0x138;
export const BTN_TR2 = 0x139;
export const BTN_SELECT = 0x13a;
export const BTN_START = 0x13b;
export const BTN_MODE = 0x13c;
export const BTN_THUMBL = 0x13d;
export const BTN_THUMBR = 0x13e;

/** 数位板按钮 */
export const BTN_TOOL_PEN = 0x140;
export const BTN_TOOL_RUBBER = 0x141;
export const BTN_TOOL_BRUSH = 0x142;
export const BTN_TOOL_PENCIL = 0x143;
export const BTN_TOOL_AIRBRUSH = 0x144;
export const BTN_TOOL_FINGER = 0x145;
export const BTN_TOOL_MOUSE = 0x146;
export const BTN_TOOL_LENS = 0x147;
export const BTN_TOOL_QUINTTAP = 0x148;
export const BTN_STYLUS3 = 0x149;
export const BTN_TOUCH = 0x14a;
export const BTN_STYLUS = 0x14b;
export const BTN_STYLUS2 = 0x14c;
export const BTN_TOOL_DOUBLETAP = 0x14d;
export const BTN_TOOL_TRIPLETAP = 0x14e;
export const BTN_TOOL_QUADTAP = 0x14f;

/** 触摸事件 */
export const BTN_DIGI = 0x140;
export const BTN_WHEEL = 0x150;

/** 相对轴 */
export const REL_X = 0;
export const REL_Y = 1;
export const REL_Z = 2;
export const REL_RX = 3;
export const REL_RY = 4;
export const REL_RZ = 5;
export const REL_HWHEEL = 6;
export const REL_DIAL = 7;
export const REL_WHEEL = 8;
export const REL_MISC = 9;
export const REL_RESERVED = 10;
export const REL_WHEEL_HI_RES = 11;
export const REL_HWHEEL_HI_RES = 12;
export const REL_MAX = 15;

/** 绝对轴 */
export const ABS_X = 0;
export const ABS_Y = 1;
export const ABS_Z = 2;
export const ABS_RX = 3;
export const ABS_RY = 4;
export const ABS_RZ = 5;
export const ABS_THROTTLE = 6;
export const ABS_RUDDER = 7;
export const ABS_WHEEL = 8;
export const ABS_GAS = 9;
export const ABS_BRAKE = 10;
export const ABS_HAT0X = 16;
export const ABS_HAT0Y = 17;
export const ABS_HAT1X = 18;
export const ABS_HAT1Y = 19;
export const ABS_HAT2X = 20;
export const ABS_HAT2Y = 21;
export const ABS_HAT3X = 22;
export const ABS_HAT3Y = 23;
export const ABS_PRESSURE = 24;
export const ABS_DISTANCE = 25;
export const ABS_TILT_X = 26;
export const ABS_TILT_Y = 27;
export const ABS_TOOL_WIDTH = 28;
export const ABS_VOLUME = 32;
export const ABS_MISC = 40;
export const ABS_RESERVED = 46;

/** 多点触控事件 */
export const ABS_MT_SLOT = 0x2f; // 47
export const ABS_MT_TOUCH_MAJOR = 0x30; // 48
export const ABS_MT_TOUCH_MINOR = 0x31; // 49
export const ABS_MT_WIDTH_MAJOR = 0x32; // 50
export const ABS_MT_WIDTH_MINOR = 0x33; // 51
export const ABS_MT_ORIENTATION = 0x34; // 52
export const ABS_MT_POSITION_X = 0x35; // 53
export const ABS_MT_POSITION_Y = 0x36; // 54
export const ABS_MT_TOOL_TYPE = 0x37; // 55
export const ABS_MT_BLOB_ID = 0x38; // 56
export const ABS_MT_TRACKING_ID = 0x39; // 57
export const ABS_MT_PRESSURE = 0x3a; // 58
export const ABS_MT_DISTANCE = 0x3b; // 59
export const ABS_MT_TOOL_X = 0x3c; // 60
export const ABS_MT_TOOL_Y = 0x3d; // 61

/** 多点触控工具类型 */
export const MT_TOOL_FINGER = 0;
export const MT_TOOL_PEN = 1;
export const MT_TOOL_PALM = 2;
export const MT_TOOL_MAX = 2;

/** LED 事件 */
export const LED_NUML = 0;
export const LED_CAPSL = 1;
export const LED_SCROLLL = 2;
export const LED_COMPOSE = 3;
export const LED_KANA = 4;
export const LED_SLEEP = 5;
export const LED_SUSPEND = 6;
export const LED_MUTE = 7;
export const LED_MISC = 8;
export const LED_MAIL = 9;
export const LED_CHARGING = 10;
export const LED_MAX = 15;

/** Web 键码到 Linux 键码的映射 */
export const WEB_TO_LINUX_KEY: Record<string, number> = {
  Escape: KEY_ESC,
  Digit1: KEY_1,
  Digit2: KEY_2,
  Digit3: KEY_3,
  Digit4: KEY_4,
  Digit5: KEY_5,
  Digit6: KEY_6,
  Digit7: KEY_7,
  Digit8: KEY_8,
  Digit9: KEY_9,
  Digit0: KEY_0,
  Minus: KEY_MINUS,
  Equal: KEY_EQUAL,
  Backspace: KEY_BACKSPACE,
  Tab: KEY_TAB,
  KeyQ: KEY_Q,
  KeyW: KEY_W,
  KeyE: KEY_E,
  KeyR: KEY_R,
  KeyT: KEY_T,
  KeyY: KEY_Y,
  KeyU: KEY_U,
  KeyI: KEY_I,
  KeyO: KEY_O,
  KeyP: KEY_P,
  BracketLeft: KEY_LEFTBRACE,
  BracketRight: KEY_RIGHTBRACE,
  Enter: KEY_ENTER,
  ControlLeft: KEY_LEFTCTRL,
  KeyA: KEY_A,
  KeyS: KEY_S,
  KeyD: KEY_D,
  KeyF: KEY_F,
  KeyG: KEY_G,
  KeyH: KEY_H,
  KeyJ: KEY_J,
  KeyK: KEY_K,
  KeyL: KEY_L,
  Semicolon: KEY_SEMICOLON,
  Quote: KEY_APOSTROPHE,
  Backquote: KEY_GRAVE,
  ShiftLeft: KEY_LEFTSHIFT,
  Backslash: KEY_BACKSLASH,
  KeyZ: KEY_Z,
  KeyX: KEY_X,
  KeyC: KEY_C,
  KeyV: KEY_V,
  KeyB: KEY_B,
  KeyN: KEY_N,
  KeyM: KEY_M,
  Comma: KEY_COMMA,
  Period: KEY_DOT,
  Slash: KEY_SLASH,
  ShiftRight: KEY_RIGHTSHIFT,
  NumpadMultiply: KEY_KPASTERISK,
  AltLeft: KEY_LEFTALT,
  Space: KEY_SPACE,
  CapsLock: KEY_CAPSLOCK,
  F1: KEY_F1,
  F2: KEY_F2,
  F3: KEY_F3,
  F4: KEY_F4,
  F5: KEY_F5,
  F6: KEY_F6,
  F7: KEY_F7,
  F8: KEY_F8,
  F9: KEY_F9,
  F10: KEY_F10,
  NumLock: KEY_NUMLOCK,
  ScrollLock: KEY_SCROLLLOCK,
  Numpad7: KEY_KP7,
  Numpad8: KEY_KP8,
  Numpad9: KEY_KP9,
  NumpadSubtract: KEY_KPMINUS,
  Numpad4: KEY_KP4,
  Numpad5: KEY_KP5,
  Numpad6: KEY_KP6,
  NumpadAdd: KEY_KPPLUS,
  Numpad1: KEY_KP1,
  Numpad2: KEY_KP2,
  Numpad3: KEY_KP3,
  Numpad0: KEY_KP0,
  NumpadDecimal: KEY_KPDOT,
  F11: KEY_F11,
  F12: KEY_F12,
  NumpadEnter: KEY_KPENTER,
  ControlRight: KEY_RIGHTCTRL,
  NumpadDivide: KEY_KPSLASH,
  PrintScreen: KEY_SYSRQ,
  AltRight: KEY_RIGHTALT,
  Home: KEY_HOME,
  ArrowUp: KEY_UP,
  PageUp: KEY_PAGEUP,
  ArrowLeft: KEY_LEFT,
  ArrowRight: KEY_RIGHT,
  End: KEY_END,
  ArrowDown: KEY_DOWN,
  PageDown: KEY_PAGEDOWN,
  Insert: KEY_INSERT,
  Delete: KEY_DELETE,
  MetaLeft: KEY_LEFTMETA,
  MetaRight: KEY_RIGHTMETA,
  ContextMenu: KEY_COMPOSE,
};

/** Linux 键码到 Web 键码的映射 */
export const LINUX_TO_WEB_KEY: Record<number, string> = Object.fromEntries(
  Object.entries(WEB_TO_LINUX_KEY).map(([web, linux]) => [linux, web]),
);
