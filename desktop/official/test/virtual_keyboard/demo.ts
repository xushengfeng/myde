import { addStyle, initDKH, txt, view } from "dkh-ui";
import { gGlassStyle, gRadius, gTextStyle, px } from "../../src/ui";
import {
    createAsciiKeyboard,
    createFullKeyboard,
    type VkbComposeState,
    type VkbKeyPress,
    type VkbSettings,
} from "../../src/virtual_keyboard/keyboard";

addStyle({
    html: { height: "100%" },
    body: {
        height: "100%",
        margin: "0",
        background: "linear-gradient(135deg, #e8eef3, #cfd8dc)",
        fontFamily: "sans-serif",
        overflow: "hidden",
    },
});
initDKH({ pureStyle: true });

const output = txt("（在下面的键盘输入）").style({
    ...gTextStyle.body,
    fontFamily: gTextStyle.monoFamily,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    minHeight: px(80),
    userSelect: "text",
});
let typed = "";

function render() {
    output.sv(typed || "（在下面的键盘输入）");
    output.style({ color: typed ? gTextStyle.color.primary : gTextStyle.color.muted });
}

// 预览里的输入法：拉丁字母当作拼音合成，候选栏展示固定候选，选中后写进上面的文本
const composeListeners = new Set<(state: VkbComposeState | undefined) => void>();
const COMPOSE_PAGES = [
    ["你", "尼", "泥", "拟", "逆"],
    ["呢", "妮", "倪", "腻", "溺"],
];
let composePreedit = "";
let composePage = 0;

function composeSnapshot(): VkbComposeState | undefined {
    if (!composePreedit) return undefined;
    const list = COMPOSE_PAGES[composePage];
    return {
        preedit: composePreedit,
        auxiliary: "",
        candidates: list,
        candidateLabels: list.map((_, i) => String(i + 1)),
        candidateCursor: -1,
        hasPrev: composePage > 0,
        hasNext: composePage + 1 < COMPOSE_PAGES.length,
    };
}

function emitCompose() {
    const state = composeSnapshot();
    for (const cb of composeListeners) cb(state);
}

function commitCandidate(index: number) {
    const list = COMPOSE_PAGES[composePage];
    typed += list[index] ?? composePreedit;
    composePreedit = "";
    composePage = 0;
    emitCompose();
    render();
}

function composingKey(press: VkbKeyPress) {
    if (press.ctrl || press.meta || press.alt) return false;
    if ([...press.key].length === 1 && /^[a-z]$/.test(press.key)) {
        composePreedit += press.key;
        emitCompose();
        return true;
    }
    if (!composePreedit) return false;
    if (press.code === "Backspace") {
        composePreedit = [...composePreedit].slice(0, -1).join("");
        emitCompose();
        return true;
    }
    if (press.code === "Space" || press.code === "Enter") {
        commitCandidate(0);
        return true;
    }
    return false;
}

const dispatcher = {
    key(press: VkbKeyPress) {
        if (composingKey(press)) return;
        if (press.code === "Backspace") {
            typed = [...typed].slice(0, -1).join("");
        } else if (press.code === "Enter") {
            typed += "\n";
        } else if (press.code === "Tab") {
            typed += "    ";
        } else if ([...press.key].length === 1) {
            typed += press.key;
        }
        render();
    },
    text(value: string) {
        typed += value;
        render();
    },
};

const defaults: VkbSettings = {
    x: -1,
    y: -1,
    width: 820,
    height: 380,
    page: "keys",
    layout: "minimal",
    fullVariant: "87",
    splitLayout: "top",
    touchpadKeyboard: "none",
    collapsed: false,
    recentEmoji: [],
    recentUnicode: [],
};
const settings = { ...defaults };

view()
    .style({
        position: "fixed",
        left: px(24),
        top: px(24),
        width: px(520),
        padding: px(16),
        borderRadius: px(gRadius.container),
        ...gGlassStyle.bg,
        display: "flex",
        flexDirection: "column",
        gap: px(8),
    })
    .add([
        txt("虚拟键盘预览").style({ ...gTextStyle.title, color: gTextStyle.color.primary }),
        txt("拖动标题栏移动，右下角圆点缩放；表情和 Unicode 页会直接插入文字。").style({
            ...gTextStyle.caption,
            color: gTextStyle.color.secondary,
        }),
        output,
    ])
    .addInto();

const layer = view()
    .style({
        position: "fixed",
        top: "0",
        left: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        overflow: "visible",
    })
    .addInto();

const keyboard = createFullKeyboard({
    layer: layer.el,
    dispatcher,
    settings: {
        get: () => ({ ...settings }),
        patch(patch) {
            Object.assign(settings, patch);
        },
    },
    uiScale: 1,
    ime: {
        onStatus(cb) {
            cb({
                available: true,
                label: "拼",
                currentUniqueName: "pinyin",
                entries: [
                    { uniqueName: "keyboard-us", name: "键盘 - 英语 (US)", label: "En", off: true },
                    { uniqueName: "pinyin", name: "拼音", label: "拼" },
                ],
            });
            return () => {};
        },
        select() {},
        onCompose(cb) {
            composeListeners.add(cb);
            cb(composeSnapshot());
            return () => {
                composeListeners.delete(cb);
            };
        },
        selectCandidate: (index) => commitCandidate(index),
        pageCandidates: (next) => {
            const target = composePage + (next ? 1 : -1);
            if (target < 0 || target >= COMPOSE_PAGES.length) return;
            composePage = target;
            emitCompose();
        },
        setCandidatesInKeyboard() {},
    },
    onTouchpadClick: (button) => console.log("touchpad click", button),
    onTouchpadScroll: (deltaY) => console.log("touchpad scroll", deltaY),
});
keyboard.open();

// 方便在浏览器控制台/预览脚本里切换页面
declare global {
    interface Window {
        __virtualKeyboard?: typeof keyboard;
        __virtualKeyboardText?: () => string;
    }
}
window.__virtualKeyboard = keyboard;
window.__virtualKeyboardText = () => typed;

// 锁屏密码键盘预览
let password = "";
const passwordDots = txt("").style({
    ...gTextStyle.display,
    fontFamily: gTextStyle.monoFamily,
    letterSpacing: "6px",
    minHeight: px(28),
    color: gTextStyle.color.primary,
});
const passwordHint = txt("点击下面的键盘输入密码").style({
    ...gTextStyle.caption,
    color: gTextStyle.color.muted,
});
function renderPassword() {
    passwordDots.sv([...password].map(() => "•").join(""));
    passwordHint.sv(password ? "Enter 提交" : "点击下面的键盘输入密码");
}
const asciiKeyboard = createAsciiKeyboard({
    dispatcher: {
        key(press) {
            if (press.code === "Backspace") password = [...password].slice(0, -1).join("");
            else if (press.code === "Enter") password = "";
            else if ([...press.key].length === 1) password += press.key;
            renderPassword();
        },
        text(value) {
            password += value;
            renderPassword();
        },
    },
});
const passwordField = view("x").style({
    height: px(48),
    borderRadius: px(gRadius.item),
    ...gGlassStyle.itemInBg,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "column",
    gap: px(2),
    flexShrink: "0",
});
passwordField.add([passwordDots, passwordHint]);
view("y")
    .style({
        position: "fixed",
        right: px(24),
        top: px(24),
        width: px(660),
        height: px(300),
        padding: px(16),
        boxSizing: "border-box",
        borderRadius: px(gRadius.container),
        ...gGlassStyle.bg,
        display: "flex",
        flexDirection: "column",
        gap: px(8),
        zIndex: "5",
    })
    .add([
        txt("锁屏密码键盘").style({ ...gTextStyle.title, color: gTextStyle.color.primary }),
        passwordField,
        view().style({ flex: "1", minHeight: "0", display: "flex", flexDirection: "column" }).add(asciiKeyboard.el),
    ])
    .addInto(document.body);
renderPassword();
