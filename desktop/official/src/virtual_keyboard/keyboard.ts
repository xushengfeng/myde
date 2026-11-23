import { type ElType, trackPoint, txt, view } from "dkh-ui";
import { AnimationGear, timingFunction } from "myde-ui";
import { getIconXEl } from "../icon";
import {
    aLineText,
    gGlassStyle,
    gRadius,
    gShadowStyle,
    gSurfaceStyle,
    gTextStyle,
    px,
    sSize2,
    uSegmented,
} from "../ui";
import { EMOJI_CATEGORIES } from "./emoji";
import {
    ASCII_KEY_ROWS,
    DESKTOP_ARROWS,
    DESKTOP_MAIN_ROWS,
    DESKTOP_NAV_COMPACT_ROWS,
    DESKTOP_NAV_ROWS,
    DESKTOP_NUMPAD,
    keyLabelOf,
    keyValueOf,
    PHONE_LETTER_ROWS,
    PHONE_NUMBER_ROWS,
    PHONE_SYMBOL_ROWS,
    PHYSICAL_68_ROWS,
    type VkbFullVariant,
    type VkbKeyDef,
    type VkbKeyPress,
    type VkbLayoutId,
} from "./layout";
import { charOfCodePoint, formatCodePoint, parseCodePoint, UNICODE_GROUPS } from "./unicode";

export type { VkbKeyPress } from "./layout";

export type VkbPage = "keys" | "touchpad" | "emoji" | "unicode";
/** 顶栏标签：两个键盘布局直接作为标签，其余是普通页面 */
export type VkbTabId = VkbLayoutId | Exclude<VkbPage, "keys">;
export type VkbSplitLayout = "top" | "bottom" | "left" | "right";
export type VkbTouchpadKeyboardMode = "none" | "minimal" | "full";

export interface VkbSettings extends Record<string, unknown> {
    x: number;
    y: number;
    width: number;
    height: number;
    page: VkbPage;
    /** 键盘布局：极简 / 常规 */
    layout: VkbLayoutId;
    /** 常规键盘的配列 */
    fullVariant: VkbFullVariant;
    /** 同时显示键盘和触控板时，触控板所在的一侧 */
    splitLayout: VkbSplitLayout;
    /** 触控板页要一起显示的键盘：不显示 / 极简 / 常规 */
    touchpadKeyboard: VkbTouchpadKeyboardMode;
    collapsed: boolean;
    recentEmoji: string[];
    recentUnicode: string[];
}

export interface VkbSettingsAccess {
    get(): VkbSettings;
    patch(patch: Partial<VkbSettings>): void;
}

export interface VkbDispatcher {
    /** 普通按键或特殊键 */
    key(press: VkbKeyPress): void;
    /** 直接插入一段文字（emoji、unicode） */
    text(text: string): void;
}

export interface VkbImeStatus {
    available: boolean;
    label: string;
    currentUniqueName: string;
    entries: { uniqueName: string; name: string; label: string; off?: boolean }[];
    error?: string;
}

/** 键盘候选栏要显示的合成状态；没有合成时为 undefined */
export interface VkbComposeState {
    /** 合成中的文本（拼音等） */
    preedit: string;
    /** 辅助文本 */
    auxiliary: string;
    candidates: string[];
    candidateLabels: string[];
    /** 高亮候选下标，-1 表示无 */
    candidateCursor: number;
    hasPrev: boolean;
    hasNext: boolean;
}

export interface VkbImeAccess {
    onStatus(cb: (status: VkbImeStatus) => void): () => void;
    select(uniqueName: string): void;
    sync?(): void;
    /** 订阅输入法合成状态，用来在键盘里显示候选栏 */
    onCompose?(cb: (state: VkbComposeState | undefined) => void): () => void;
    selectCandidate?(index: number): void;
    pageCandidates?(next: boolean): void;
    /** 键盘自己显示候选时，浮动候选窗让位 */
    setCandidatesInKeyboard?(on: boolean): void;
}

export interface FullKeyboardOptions {
    layer: HTMLElement;
    dispatcher: VkbDispatcher;
    settings: VkbSettingsAccess;
    /** 创建时的桌面界面缩放 */
    uiScale?: number;
    /** 键盘内的输入法切换器 */
    ime?: VkbImeAccess;
    onOpenChange?: (open: boolean) => void;
    /** 触控板页是否激活；桌面据此把触屏交给触摸板变换器 */
    onTouchpadActiveChange?: (active: boolean) => void;
    onCollapseChange?: (collapsed: boolean) => void;
    /** 触控板页左/中/右键 */
    onTouchpadClick?: (button: number) => void;
    /** 触控板页右侧滚动条 */
    onTouchpadScroll?: (deltaY: number) => void;
}

export interface FullKeyboardHandle {
    el: ElType<HTMLElement>;
    open(): void;
    close(): void;
    toggle(): void;
    isOpen(): boolean;
    setPage(page: VkbPage): void;
    getPage(): VkbPage;
    setLayout(layout: VkbLayoutId): void;
    getLayout(): VkbLayoutId;
    setUiScale(scale: number): void;
    /** 窗口尺寸变化时重新校正尺寸和位置 */
    relayout(): void;
    /** 某个屏幕点是否落在键盘自身的 UI 上（触控板表面不算，触摸板页需要接管它） */
    isKeyboardUiAt(x: number, y: number): boolean;
    /** 供触摸板变换器读取当前运行时设置 */
    getState(): VkbSettings;
    /** 锁屏/解锁时临时隐藏，但保留打开状态 */
    setSuspended(suspended: boolean): void;
    setCollapsed(collapsed: boolean): void;
}

const PANEL_PADDING = sSize2.padding;
const HEADER_HEIGHT = 36;
const KEY_GAP = 4;
const MIN_HEIGHT = 240;
const DEFAULT_WIDTH = 820;
const DEFAULT_HEIGHT = 380;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** 常规配列要放下对应键区，不能缩得太窄 */
function minWidthFor(layout: VkbLayoutId, variant: VkbFullVariant): number {
    if (layout === "minimal") return 380;
    if (variant === "104") return 780;
    if (variant === "98") return 740;
    if (variant === "87") return 700;
    if (variant === "75") return 680;
    return 660;
}

function isVkbPage(value: unknown): value is VkbPage {
    return value === "keys" || value === "touchpad" || value === "emoji" || value === "unicode";
}

function isTouchpadKeyboardMode(value: unknown): value is VkbTouchpadKeyboardMode {
    return value === "none" || value === "minimal" || value === "full";
}

function normalizeLayout(value: unknown): VkbLayoutId {
    if (value === "full" || value === "desktop") return "full";
    return "minimal";
}

function normalizeFullVariant(value: unknown, legacyLayout: unknown): VkbFullVariant {
    if (isFullVariant(value)) return value;
    return legacyLayout === "desktop" ? "104" : "87";
}

function isFullVariant(value: unknown): value is VkbFullVariant {
    return value === "68" || value === "87" || value === "75" || value === "98" || value === "104";
}

function isSplitLayout(value: unknown): value is VkbSplitLayout {
    return value === "top" || value === "bottom" || value === "left" || value === "right";
}

type KeyVariant = "minimal" | "physical" | "ascii";

interface KeyState {
    /** 0 无 / 1 一次性 / 2 锁定 */
    shift: 0 | 1 | 2;
    caps: boolean;
    ctrl: boolean;
    alt: boolean;
    meta: boolean;
    /** Fn 也是粘滞的：0 无 / 1 一次性 / 2 锁定 */
    fn: 0 | 1 | 2;
}

interface KeyItem {
    def: VkbKeyDef;
    root: ElType<HTMLElement>;
    label: ElType<HTMLElement>;
}

interface KeyController {
    state: KeyState;
    press(def: VkbKeyDef): void;
    register(def: VkbKeyDef, root: ElType<HTMLElement>, label: ElType<HTMLElement>): void;
    refresh(): void;
    onChange(cb: () => void): void;
}

const isLetter = (def: VkbKeyDef) => def.code.startsWith("Key");

/** 修饰键、字符键和层切换的共享状态；多个布局可以共用同一份粘滞状态 */
function createKeyController(
    dispatcher: VkbDispatcher,
    onLayer: (layer: "letters" | "numbers" | "symbols") => void,
): KeyController {
    const state: KeyState = { shift: 0, caps: false, ctrl: false, alt: false, meta: false, fn: 0 };
    const keys: KeyItem[] = [];
    const listeners = new Set<() => void>();

    function apply(item: KeyItem) {
        const { def } = item;
        const shifted = isLetter(def) ? (state.shift !== 0) !== state.caps : state.shift !== 0;
        const fnActive = state.fn !== 0;
        item.label.sv(fnActive && def.fnLabel ? def.fnLabel : keyLabelOf(def, shifted));
        const active =
            (def.mod === "shift" && state.shift !== 0) ||
            (def.mod === "caps" && state.caps) ||
            (def.mod === "ctrl" && state.ctrl) ||
            (def.mod === "alt" && state.alt) ||
            (def.mod === "meta" && state.meta) ||
            (def.mod === "fn" && state.fn !== 0);
        item.root.style({
            background: active ? "#00aaff" : gSurfaceStyle.solid.backgroundColor,
            color: active ? gTextStyle.color.inverse : gTextStyle.color.primary,
        });
    }

    function refresh() {
        for (const item of keys) apply(item);
        for (const cb of listeners) cb();
    }

    function resetOneShot() {
        if (state.shift === 1) state.shift = 0;
        if (state.fn === 1) state.fn = 0;
        state.ctrl = false;
        state.alt = false;
        state.meta = false;
    }

    function press(def: VkbKeyDef) {
        if (def.mod) {
            if (def.mod === "shift") state.shift = state.shift === 0 ? 1 : state.shift === 1 ? 2 : 0;
            else if (def.mod === "caps") state.caps = !state.caps;
            else if (def.mod === "ctrl") state.ctrl = !state.ctrl;
            else if (def.mod === "alt") state.alt = !state.alt;
            else if (def.mod === "meta") state.meta = !state.meta;
            else if (def.mod === "fn") state.fn = state.fn === 0 ? 1 : state.fn === 1 ? 2 : 0;
            refresh();
            return;
        }

        if (def.layer) {
            onLayer(def.layer);
            refresh();
            return;
        }

        if (def.text !== undefined) {
            dispatcher.text(def.text);
            resetOneShot();
            refresh();
            return;
        }

        const shifted = state.shift !== 0;
        const fnActive = state.fn !== 0;
        const effectiveShift = def.forceShift ?? (isLetter(def) ? shifted !== state.caps : shifted);
        const code = fnActive && def.fnCode ? def.fnCode : def.code;
        const key =
            fnActive && def.fnKey !== undefined
                ? def.fnKey
                : def.action
                  ? (def.key ?? def.label)
                  : keyValueOf(def, effectiveShift);
        dispatcher.key({
            code,
            key,
            shift: effectiveShift,
            ctrl: state.ctrl,
            alt: state.alt,
            meta: state.meta,
        });

        // 修饰键是“粘滞”的：按一次只作用于下一个普通键
        resetOneShot();
        refresh();
    }

    return {
        state,
        press,
        register(def, root, label) {
            const item = { def, root, label };
            keys.push(item);
            apply(item);
        },
        refresh,
        onChange(cb) {
            listeners.add(cb);
        },
    };
}

function makeKey(controller: KeyController, def: VkbKeyDef, variant: KeyVariant): ElType<HTMLElement> {
    const fontSize = variant === "minimal" ? 17 : variant === "physical" ? 10 : 13;
    const radius = variant === "minimal" ? 12 : variant === "physical" ? 6 : gRadius.item;
    const label = txt(def.label).style({
        ...gTextStyle.body,
        fontSize: px(fontSize),
        lineHeight: "1",
        textAlign: "center",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        width: "100%",
        padding: "0 2px",
        boxSizing: "border-box",
    });
    const keyEl = view("x")
        .style({
            flex: `${def.flex ?? 1} 1 0`,
            minWidth: "0",
            width: "100%",
            height: "100%",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: px(radius),
            background: gSurfaceStyle.solid.backgroundColor,
            color: gTextStyle.color.primary,
            boxShadow: "0 1px 0 #00000012",
            cursor: "pointer",
            userSelect: "none",
            overflow: "hidden",
        })
        .add(label)
        .data({ "vkb-key": def.code })
        .on("pointerdown", (e) => {
            e.preventDefault();
            controller.press(def);
        });
    controller.register(def, keyEl, label);
    return keyEl;
}

function createKeyGrid(controller: KeyController, rows: VkbKeyDef[][], variant: KeyVariant): ElType<HTMLElement> {
    const gap = variant === "minimal" ? 6 : KEY_GAP;
    const grid = view("y").style({
        flex: "1",
        minHeight: "0",
        gap: px(gap),
    });
    for (const row of rows) {
        const rowEl = view("x").style({
            flex: "1",
            minHeight: "0",
            gap: px(gap),
        });
        for (const def of row) rowEl.add(makeKey(controller, def, variant));
        grid.add(rowEl);
    }
    return grid;
}

/** 完整键盘的物理配列：87 / 75 / 98 / 104，按是否有数字键盘和导航区宽度区分 */
function createPhysicalGrid(controller: KeyController, variant: VkbFullVariant): ElType<HTMLElement> {
    const compactNav = variant === "98" || variant === "75";
    const hasNumpad = variant === "104" || variant === "98";
    const navFlex = compactNav ? "2.4" : "3";
    const rightFlex = hasNumpad ? (compactNav ? "6.4" : "7") : navFlex;
    const outer = view("x").style({ flex: "1", minHeight: "0", gap: px(6) });

    const main = view("y").style({ flex: "15", minWidth: "0", gap: px(3) });
    for (const row of DESKTOP_MAIN_ROWS) {
        const rowEl = view("x").style({ flex: "1", minHeight: "0", gap: px(3) });
        for (const def of row) rowEl.add(makeKey(controller, def, "physical"));
        main.add(rowEl);
    }
    outer.add(main);

    const right = view("y").style({ flex: rightFlex, minWidth: "0", gap: px(3) });
    right.add(view().style({ flex: "1" })); // F 行高度
    const rightBody = view("x").style({ flex: "5", minHeight: "0", gap: px(6) });

    const navRows = compactNav ? DESKTOP_NAV_COMPACT_ROWS : DESKTOP_NAV_ROWS;
    const nav = view("y").style({ flex: navFlex, minWidth: "0", gap: px(3) });
    const navKeys = view("y").style({ flex: String(navRows.length), minHeight: "0", gap: px(3) });
    for (const row of navRows) {
        const rowEl = view("x").style({ flex: "1", minHeight: "0", gap: px(3) });
        for (const def of row) rowEl.add(makeKey(controller, def, "physical"));
        navKeys.add(rowEl);
    }
    nav.add(navKeys);

    const arrows = view().style({
        flex: "2",
        minWidth: "0",
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gridTemplateRows: "repeat(2, 1fr)",
        gap: px(3),
    });
    for (const item of DESKTOP_ARROWS) {
        const keyEl = makeKey(controller, item.key, "physical");
        keyEl.style({
            gridColumn: `${item.col} / span ${item.colSpan ?? 1}`,
            gridRow: `${item.row} / span ${item.rowSpan ?? 1}`,
        });
        arrows.add(keyEl);
    }
    nav.add(arrows);
    rightBody.add(nav);

    if (hasNumpad) {
        const pad = view().style({
            flex: "4",
            minWidth: "0",
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gridTemplateRows: "repeat(5, 1fr)",
            gap: px(3),
        });
        for (const item of DESKTOP_NUMPAD) {
            const keyEl = makeKey(controller, item.key, "physical");
            keyEl.style({
                gridColumn: `${item.col} / span ${item.colSpan ?? 1}`,
                gridRow: `${item.row} / span ${item.rowSpan ?? 1}`,
            });
            pad.add(keyEl);
        }
        rightBody.add(pad);
    }
    right.add(rightBody);
    outer.add(right);
    return outer;
}

/** 轻触判定：避免在可滚动列表里拖动时误插入字符 */
function createTap() {
    let start: { x: number; y: number; id: number; value: string } | undefined;
    window.addEventListener("pointerup", (e) => {
        const s = start;
        start = undefined;
        if (!s || s.id !== e.pointerId) return;
        if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) return;
        tapCallback?.(s.value);
    });
    let tapCallback: ((value: string) => void) | undefined;
    return {
        setCallback(cb: (value: string) => void) {
            tapCallback = cb;
        },
        bind(el: ElType<HTMLElement>, value: string) {
            el.on("pointerdown", (e) => {
                start = { x: e.clientX, y: e.clientY, id: e.pointerId, value };
            });
        },
    };
}

function l2Panel() {
    return view().style({
        borderRadius: px(gRadius.item),
        background: gGlassStyle.itemInBg.backgroundColor,
        overflow: "hidden",
    });
}

function pageRoot() {
    return view("y").style({
        position: "absolute",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        gap: px(6),
        minHeight: "0",
        display: "none",
    });
}

function sectionTitle(text: string) {
    return txt(text).style({
        ...gTextStyle.captionStrong,
        color: gTextStyle.color.secondary,
        flexShrink: "0",
    });
}

function createEmojiPage(settings: VkbSettingsAccess, dispatcher: VkbDispatcher) {
    const root = pageRoot();
    let category = EMOJI_CATEGORIES[0]?.id ?? "smileys";
    const tabBar = uSegmented({
        items: EMOJI_CATEGORIES.map((c) => ({ label: c.name, value: c.id })),
        value: category,
        onChange: (v) => {
            category = v;
            renderGrid();
        },
    });
    tabBar.el.style({ flexShrink: "0" });
    root.add(tabBar.el);

    const recentTitle = sectionTitle("最近使用");
    const recentBar = view("x", "wrap").style({
        gap: px(4),
        flexShrink: "0",
    });
    root.add([recentTitle, recentBar]);

    const grid = view("x", "wrap").style({
        gap: px(4),
        alignContent: "flex-start",
        overflowY: "auto",
        flex: "1",
        minHeight: "0",
        paddingRight: px(2),
    });
    root.add(grid);

    const tap = createTap();
    tap.setCallback((emoji) => {
        dispatcher.text(emoji);
        remember(emoji);
    });

    function emojiCell(emoji: string) {
        const cell = view("x").style({
            width: px(38),
            height: px(38),
            alignItems: "center",
            justifyContent: "center",
            borderRadius: px(gRadius.item),
            background: gSurfaceStyle.solid.backgroundColor,
            fontSize: "22px",
            lineHeight: "1",
            cursor: "pointer",
            flexShrink: "0",
        });
        cell.add(txt(emoji));
        tap.bind(cell, emoji);
        return cell;
    }

    function renderRecent() {
        const list = settings.get().recentEmoji ?? [];
        recentBar.clear();
        recentTitle.el.style.display = list.length > 0 ? "" : "none";
        recentBar.el.style.display = list.length > 0 ? "flex" : "none";
        for (const emoji of list.slice(0, 24)) recentBar.add(emojiCell(emoji));
    }

    function renderGrid() {
        grid.clear();
        const cat = EMOJI_CATEGORIES.find((c) => c.id === category) ?? EMOJI_CATEGORIES[0];
        for (const emoji of cat?.emojis ?? []) grid.add(emojiCell(emoji));
    }

    function remember(emoji: string) {
        const list = [emoji, ...(settings.get().recentEmoji ?? []).filter((e) => e !== emoji)].slice(0, 24);
        settings.patch({ recentEmoji: list });
        renderRecent();
    }

    renderRecent();
    renderGrid();

    return { el: root, refresh: renderRecent };
}

function createUnicodePage(settings: VkbSettingsAccess, dispatcher: VkbDispatcher) {
    const root = pageRoot();
    let hex = "";

    const display = view("x").style({
        height: px(52),
        alignItems: "center",
        gap: px(12),
        padding: `0 ${px(sSize2.padding)}`,
        boxSizing: "border-box",
        borderRadius: px(gRadius.item),
        background: gGlassStyle.itemInBg.backgroundColor,
        flexShrink: "0",
    });
    const preview = txt("—").style({
        fontSize: "28px",
        lineHeight: "1",
        minWidth: px(40),
        textAlign: "center",
    });
    const codeText = txt("U+").style({
        fontFamily: gTextStyle.monoFamily,
        fontSize: "18px",
        fontWeight: "600",
        letterSpacing: "1px",
    });
    const hint = txt("输入码位后插入").style({
        ...gTextStyle.caption,
        color: gTextStyle.color.muted,
    });
    display.add([preview, codeText, hint]);
    root.add(display);

    const keypad = view("y").style({ gap: px(4), flexShrink: "0" });
    const keypadTap = createTap();
    const keysRow = view("x").style({ gap: px(4) });
    for (const d of "123456789ABCDEF0") {
        const b = view("x")
            .style({
                flex: "1",
                height: px(34),
                alignItems: "center",
                justifyContent: "center",
                borderRadius: px(gRadius.item),
                background: gSurfaceStyle.solid.backgroundColor,
                ...gTextStyle.body,
                fontSize: "15px",
                cursor: "pointer",
            })
            .add(txt(d));
        keypadTap.bind(b, d);
        keysRow.add(b);
    }
    const actionRow = view("x").style({ gap: px(4) });
    const action = (label: string, value: string) => {
        const b = view("x")
            .style({
                flex: "1",
                height: px(32),
                alignItems: "center",
                justifyContent: "center",
                borderRadius: px(gRadius.item),
                background: gGlassStyle.itemInBg.backgroundColor,
                ...gTextStyle.captionStrong,
                cursor: "pointer",
            })
            .add(txt(label));
        keypadTap.bind(b, value);
        actionRow.add(b);
    };
    action("退格", "backspace");
    action("清空", "clear");
    action("插入", "insert");
    keypad.add([keysRow, actionRow]);
    root.add(keypad);

    const recentTitle = sectionTitle("最近使用");
    const recentBar = view("x", "wrap").style({ gap: px(4), flexShrink: "0" });
    root.add([recentTitle, recentBar]);

    const scroll = view("y").style({
        flex: "1",
        minHeight: "0",
        overflowY: "auto",
        gap: px(8),
        paddingRight: px(2),
    });
    root.add(scroll);

    const groupTap = createTap();
    groupTap.setCallback((value) => {
        insert(value);
    });

    function charCell(ch: string) {
        const cell = view("x").style({
            width: px(34),
            height: px(34),
            alignItems: "center",
            justifyContent: "center",
            borderRadius: px(gRadius.item),
            background: gSurfaceStyle.solid.backgroundColor,
            fontSize: "17px",
            lineHeight: "1",
            cursor: "pointer",
            flexShrink: "0",
        });
        cell.add(txt(ch));
        groupTap.bind(cell, ch);
        return cell;
    }

    for (const group of UNICODE_GROUPS) {
        const groupEl = view("y").style({ gap: px(4) });
        groupEl.add(sectionTitle(group.name));
        const cells = view("x", "wrap").style({ gap: px(4) });
        for (const ch of group.chars) cells.add(charCell(ch));
        groupEl.add(cells);
        scroll.add(groupEl);
    }

    function renderRecent() {
        const list = settings.get().recentUnicode ?? [];
        recentBar.clear();
        recentTitle.el.style.display = list.length > 0 ? "" : "none";
        recentBar.el.style.display = list.length > 0 ? "flex" : "none";
        for (const ch of list.slice(0, 24)) recentBar.add(charCell(ch));
    }

    function updateDisplay() {
        codeText.sv(`U+${hex.toUpperCase() || "____"}`);
        const code = parseCodePoint(hex);
        const ch = code === undefined ? undefined : charOfCodePoint(code);
        preview.sv(ch ?? "—");
        preview.style({ color: ch ? gTextStyle.color.primary : gTextStyle.color.muted });
        hint.sv(code === undefined ? (hex ? "码位无效" : "输入码位后插入") : formatCodePoint(code));
    }

    function insert(value: string) {
        dispatcher.text(value);
        const list = [value, ...(settings.get().recentUnicode ?? []).filter((e) => e !== value)].slice(0, 24);
        settings.patch({ recentUnicode: list });
        renderRecent();
    }

    keypadTap.setCallback((value) => {
        if (value === "backspace") hex = hex.slice(0, -1);
        else if (value === "clear") hex = "";
        else if (value === "insert") {
            const code = parseCodePoint(hex);
            const ch = code === undefined ? undefined : charOfCodePoint(code);
            if (ch) {
                insert(ch);
                hex = "";
            }
        } else if (hex.length < 6) hex += value;
        updateDisplay();
    });

    updateDisplay();
    renderRecent();

    return { el: root, refresh: () => updateDisplay() };
}

/** 键盘里的候选栏：合成文本 + 候选词 + 翻页，和手机输入法一样贴在键帽上方 */
function createCandidateBar(op: { selectCandidate: (index: number) => void; page: (next: boolean) => void }) {
    // 高度固定：有没有候选都占同样的位置，打字时键帽不会上下跳
    const root = view("x")
        .style({
            display: "flex",
            flexShrink: "0",
            height: px(34),
            alignItems: "center",
            gap: px(4),
            padding: `0 ${px(4)}`,
            boxSizing: "border-box",
            borderRadius: px(gRadius.item),
            background: "transparent",
        })
        .data({ "vkb-candidates": "1" });

    const preedit = txt("").style({
        ...gTextStyle.body,
        color: gTextStyle.color.secondary,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "34%",
        flexShrink: "0",
    });

    const pager = (dir: "left" | "right") => {
        const btn = view("x")
            .style({
                width: px(24),
                height: px(24),
                flexShrink: "0",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: px(gRadius.item),
                cursor: "pointer",
                opacity: "0.3",
            })
            .add(getIconXEl(dir === "left" ? "chevron.left" : "chevron.right", { size: 14 }))
            .on("click", () => op.page(dir === "right"));
        return btn;
    };
    const prev = pager("left");
    const next = pager("right");

    const list = view("x").style({
        flex: "1",
        minWidth: "0",
        alignItems: "center",
        gap: px(4),
        overflowX: "auto",
        overflowY: "hidden",
        scrollbarWidth: "none",
    });

    root.add([preedit, prev, list, next]);

    function update(state: VkbComposeState | undefined) {
        const text = state?.preedit.trim() || state?.auxiliary.trim() || "";
        const candidates = state?.candidates ?? [];
        const show = !!state && (text.length > 0 || candidates.length > 0);
        root.style({ background: show ? gGlassStyle.itemInBg.backgroundColor : "transparent" });
        list.clear();
        list.style({ display: show ? "flex" : "none" });
        prev.style({ display: show ? "flex" : "none" });
        next.style({ display: show ? "flex" : "none" });
        if (!show || !state) {
            preedit.sv("").style({ display: "none" });
            return;
        }
        preedit.sv(text).style({ display: text ? "" : "none" });
        prev.style({
            opacity: state.hasPrev ? "1" : "0.3",
            pointerEvents: state.hasPrev ? "auto" : "none",
        });
        next.style({
            opacity: state.hasNext ? "1" : "0.3",
            pointerEvents: state.hasNext ? "auto" : "none",
        });
        state.candidates.forEach((candidate, index) => {
            if (!candidate) return;
            const active = index === state.candidateCursor;
            const chip = view("x")
                .style({
                    height: px(26),
                    padding: `0 ${px(10)}`,
                    flexShrink: "0",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: px(gRadius.item),
                    background: active ? gSurfaceStyle.solid.backgroundColor : "transparent",
                    cursor: "pointer",
                })
                .add(
                    txt(candidate).style({
                        ...gTextStyle.body,
                        color: gTextStyle.color.primary,
                        whiteSpace: "nowrap",
                    }),
                )
                .on("click", () => op.selectCandidate(index));
            list.add(chip);
        });
    }

    return { el: root, update };
}

function createTouchpadPanel(op: { onClick: (button: number) => void; onScroll: (deltaY: number) => void }): {
    el: ElType<HTMLElement>;
    setCompact(compact: boolean): void;
} {
    const root = view("y").style({ flex: "1", minHeight: "0", gap: px(8) });

    const mainRow = view("x").style({ flex: "1", minHeight: "0", gap: px(8) });

    const surface = l2Panel()
        .style({
            flex: "1",
            minWidth: "0",
            borderRadius: px(gRadius.container),
            background: "#ffffff55",
            border: "1px solid #00000014",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: px(8),
        })
        .data({ "vkb-touchpad-surface": "1" });
    const hint1 = txt("在此区域滑动，手势与物理触摸板一致").style({
        ...gTextStyle.caption,
        color: gTextStyle.color.muted,
    });
    const hint2 = txt("单指移动 · 轻触左键 · 双指滚动/右键 · 三指中键").style({
        ...gTextStyle.caption,
        color: gTextStyle.color.muted,
    });
    surface.add([txt("触控板").style({ ...gTextStyle.display, color: gTextStyle.color.secondary }), hint1, hint2]);
    mainRow.add(surface);

    // 右侧就是一个可滚动的条形区域，不画内部滑块
    const scrollbar = view()
        .style({
            width: px(16),
            flexShrink: "0",
            borderRadius: px(8),
            background: "#00000012",
            cursor: "pointer",
        })
        .data({ "vkb-touchpad-scrollbar": "1" });
    let lastY = 0;
    trackPoint(scrollbar, {
        start: (e) => {
            e.preventDefault();
            lastY = e.clientY;
            return { x: 0, y: 0, data: {} };
        },
        ing: (_point, e) => {
            const delta = e.clientY - lastY;
            lastY = e.clientY;
            if (delta !== 0) op.onScroll(delta * 6);
        },
        end: () => {
            op.onScroll(0);
        },
    });
    mainRow.add(scrollbar);
    root.add(mainRow);

    const buttons = view("x").style({
        height: px(40),
        flexShrink: "0",
        gap: px(8),
    });
    const addButton = (label: string, button: number) => {
        const el = view("x")
            .style({
                flex: "1",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: px(gRadius.item),
                background: gSurfaceStyle.solid.backgroundColor,
                ...gTextStyle.body,
                cursor: "pointer",
                userSelect: "none",
            })
            .add(txt(label))
            .data({ "vkb-touchpad-button": String(button) })
            .on("pointerdown", (e) => {
                e.preventDefault();
                op.onClick(button);
            });
        buttons.add(el);
    };
    addButton("左键", 0);
    addButton("中键", 1);
    addButton("右键", 2);
    root.add(buttons);

    return {
        el: root,
        setCompact(compact: boolean) {
            hint1.el.style.display = compact ? "none" : "";
            hint2.el.style.display = compact ? "none" : "";
        },
    };
}

/** 桌面内可移动、可缩放的完整虚拟键盘 */
export function createFullKeyboard(op: FullKeyboardOptions): FullKeyboardHandle {
    const raw = op.settings.get();
    let hasStoredPosition = Number.isFinite(raw.x) && raw.x >= 0 && Number.isFinite(raw.y) && raw.y >= 0;
    const state: VkbSettings = {
        ...raw,
        page: isVkbPage(raw.page) ? raw.page : "keys",
        layout: normalizeLayout(raw.layout),
        fullVariant: normalizeFullVariant(raw.fullVariant, raw.layout),
        splitLayout: isSplitLayout(raw.splitLayout) ? raw.splitLayout : "top",
        touchpadKeyboard: isTouchpadKeyboardMode(raw.touchpadKeyboard) ? raw.touchpadKeyboard : "none",
        x: hasStoredPosition ? raw.x : -1,
        y: hasStoredPosition ? raw.y : -1,
        width: Number.isFinite(raw.width) ? raw.width : DEFAULT_WIDTH,
        height: Number.isFinite(raw.height) ? raw.height : DEFAULT_HEIGHT,
        collapsed: raw.collapsed === true,
        recentEmoji: Array.isArray(raw.recentEmoji) ? raw.recentEmoji : [],
        recentUnicode: Array.isArray(raw.recentUnicode) ? raw.recentUnicode : [],
    };
    let open = false;
    let suspended = false;
    let scale = Number.isFinite(op.uiScale) && (op.uiScale ?? 0) > 0 ? (op.uiScale as number) : 1;
    let page: VkbPage = state.page;

    const outer = view().style({
        position: "absolute",
        top: "0",
        left: "0",
        transformOrigin: "top left",
        pointerEvents: "none",
    });

    const panel = view("y")
        .style({
            width: px(state.width),
            height: px(state.height),
            padding: px(PANEL_PADDING),
            boxSizing: "border-box",
            gap: px(PANEL_PADDING),
            borderRadius: px(gRadius.container),
            ...gGlassStyle.bg,
            pointerEvents: "auto",
            display: "none",
            transformOrigin: "center bottom",
        })
        .data({ "virtual-keyboard": "1" });
    outer.add(panel);

    const header = view("x").style({
        height: px(HEADER_HEIGHT),
        flexShrink: "0",
        gap: px(6),
        alignItems: "center",
        padding: `0 ${px(4)}`,
        boxSizing: "border-box",
        borderRadius: px(gRadius.item),
        background: gGlassStyle.itemInBg.backgroundColor,
        cursor: "grab",
    });
    panel.add(header);

    const tabBar = uSegmented<VkbTabId>({
        items: [
            { label: "极简", value: "minimal" },
            { label: "常规", value: "full" },
            { label: "触控板", value: "touchpad" },
            { label: "表情", value: "emoji" },
            { label: "Unicode", value: "unicode" },
        ],
        value: page === "keys" ? state.layout : (page as VkbTabId),
        onChange: (v) => {
            if (v === "minimal" || v === "full") {
                setLayout(v);
                if (page !== "keys") setPage("keys");
                return;
            }
            setPage(v);
        },
    });
    const tabWrap = view().style({ flex: "1", minWidth: "0" }).data({ "vkb-no-drag": "1" });

    const dragGrip = view("x")
        .style({
            width: px(18),
            height: px(28),
            flexShrink: "0",
            display: "grid",
            gridTemplateColumns: "repeat(2, 3px)",
            gridAutoRows: "3px",
            gap: "3px",
            alignContent: "center",
            justifyContent: "center",
            cursor: "grab",
        })
        .data({ "vkb-drag": "1" });
    for (let i = 0; i < 6; i++) {
        dragGrip.add(
            view().style({
                width: px(3),
                height: px(3),
                borderRadius: "50%",
                background: "#00000055",
            }),
        );
    }
    header.add(dragGrip);
    tabWrap.add(tabBar.el);
    header.add(tabWrap);

    const gearBtn = view("x")
        .style({
            width: px(28),
            height: px(28),
            alignItems: "center",
            justifyContent: "center",
            borderRadius: px(gRadius.item),
            background: gGlassStyle.itemInBg.backgroundColor,
            cursor: "pointer",
            flexShrink: "0",
        })
        .add(getIconXEl("settings", { size: 16 }))
        .data({ "vkb-no-drag": "1", "vkb-settings": "1" })
        .on("pointerdown", (e) => {
            e.preventDefault();
            toggleSettings();
        });
    header.add(gearBtn);

    const collapseBtn = view("x")
        .style({
            width: px(64),
            height: px(28),
            alignItems: "center",
            justifyContent: "center",
            borderRadius: px(gRadius.item),
            background: gGlassStyle.itemInBg.backgroundColor,
            ...gTextStyle.captionStrong,
            cursor: "pointer",
            flexShrink: "0",
        })
        .add(txt("收起"))
        .data({ "vkb-no-drag": "1" })
        .on("pointerdown", (e) => {
            e.preventDefault();
            setCollapsed(!state.collapsed);
        });
    header.add(collapseBtn);

    const closeBtn = view("x")
        .style({
            width: px(28),
            height: px(28),
            alignItems: "center",
            justifyContent: "center",
            borderRadius: px(gRadius.item),
            background: gGlassStyle.itemInBg.backgroundColor,
            cursor: "pointer",
            flexShrink: "0",
        })
        .add(getIconXEl("cross", { size: 14 }))
        .data({ "vkb-no-drag": "1" })
        .on("pointerdown", (e) => {
            e.preventDefault();
            close();
        });
    header.add(closeBtn);

    // 拖拽：用视觉坐标做增量，再除回缩放写入逻辑坐标
    trackPoint(header, {
        start: (e) => {
            if ((e.target as Element | null)?.closest("[data-vkb-no-drag]")) return false;
            header.style({ cursor: "grabbing" });
            return {
                x: 0,
                y: 0,
                data: {
                    x: state.x,
                    y: state.y,
                    cx: e.clientX,
                    cy: e.clientY,
                },
            };
        },
        ing: (_point, e, { startData }) => {
            const nextX = startData.x + (e.clientX - startData.cx) / scale;
            const nextY = startData.y + (e.clientY - startData.cy) / scale;
            state.x = nextX;
            state.y = nextY;
            clampPosition();
            applyPlacement();
        },
        end: () => {
            header.style({ cursor: "grab" });
            hasStoredPosition = true;
            op.settings.patch({ x: state.x, y: state.y });
        },
    });

    const content = view().style({
        position: "relative",
        flex: "1",
        minHeight: "0",
    });
    panel.add(content);

    const keysPage = pageRoot();
    const keyBody = view("y").style({
        flex: "1",
        minHeight: "0",
        gap: px(6),
    });
    const candidateBar = createCandidateBar({
        selectCandidate: (index) => op.ime?.selectCandidate?.(index),
        page: (next) => op.ime?.pageCandidates?.(next),
    });
    const gridHost = view().style({
        position: "relative",
        flex: "1",
        minHeight: "0",
    });
    keyBody.add([candidateBar.el, gridHost]);
    keysPage.add(keyBody);

    op.ime?.onCompose?.((state) => candidateBar.update(state));

    let minimalLayer: "letters" | "numbers" | "symbols" = "letters";
    const keyLayers: { id: string; wrap: ElType<HTMLElement> }[] = [];

    const controller = createKeyController(op.dispatcher, (layer) => {
        if (state.layout === "minimal") minimalLayer = layer;
        showKeys();
    });

    function addKeyLayer(id: string, el: ElType<HTMLElement>) {
        const wrap = view().style({
            position: "absolute",
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            display: "none",
            flexDirection: "column",
        });
        wrap.add(el);
        gridHost.add(wrap);
        keyLayers.push({ id, wrap });
    }

    addKeyLayer("minimal-letters", createKeyGrid(controller, PHONE_LETTER_ROWS, "minimal"));
    addKeyLayer("minimal-numbers", createKeyGrid(controller, PHONE_NUMBER_ROWS, "minimal"));
    addKeyLayer("minimal-symbols", createKeyGrid(controller, PHONE_SYMBOL_ROWS, "minimal"));
    addKeyLayer("full-68", createKeyGrid(controller, PHYSICAL_68_ROWS, "physical"));
    addKeyLayer("full-75", createPhysicalGrid(controller, "75"));
    addKeyLayer("full-87", createPhysicalGrid(controller, "87"));
    addKeyLayer("full-98", createPhysicalGrid(controller, "98"));
    addKeyLayer("full-104", createPhysicalGrid(controller, "104"));

    function showKeys() {
        const active = state.layout === "minimal" ? `minimal-${minimalLayer}` : `full-${state.fullVariant}`;
        for (const layer of keyLayers) layer.wrap.style({ display: layer.id === active ? "flex" : "none" });
    }

    content.add(keysPage);

    // 小设置页：布局、触控板键盘位置、粘滞键和输入法都收在这里，不占键盘页面
    const settingsPage = view("y")
        .style({
            position: "absolute",
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            display: "none",
            flexDirection: "column",
            gap: px(10),
            padding: px(12),
            boxSizing: "border-box",
            borderRadius: px(gRadius.item),
            background: "#ffffffdd",
            backdropFilter: "blur(12px)",
            overflowY: "auto",
            zIndex: "3",
        })
        .data({ "vkb-settings-page": "1" });

    const settingsTitleRow = view("x").style({
        alignItems: "center",
        gap: px(8),
        flexShrink: "0",
    });
    const settingsTitle = txt("键盘设置").style({
        ...gTextStyle.title,
        flexGrow: "1",
    });
    const settingsClose = view("x")
        .style({
            width: px(24),
            height: px(24),
            alignItems: "center",
            justifyContent: "center",
            borderRadius: px(gRadius.item),
            cursor: "pointer",
            flexShrink: "0",
        })
        .add(getIconXEl("cross", { size: 14 }))
        .on("pointerdown", (e) => {
            e.preventDefault();
            setSettingsOpen(false);
        });
    settingsTitleRow.add([settingsTitle, settingsClose]);
    settingsPage.add(settingsTitleRow);

    const variantSeg = uSegmented<VkbFullVariant>({
        items: [
            { label: "68", value: "68" },
            { label: "75", value: "75" },
            { label: "87", value: "87" },
            { label: "98", value: "98" },
            { label: "104", value: "104" },
        ],
        value: state.fullVariant,
        onChange: (value) => setFullVariant(value),
    });
    variantSeg.el.style({ width: "100%" });
    const variantBox = view("y").style({ gap: px(4), flexShrink: "0" });
    variantBox.add([
        sectionTitle("常规配列"),
        variantSeg.el,
        txt("在“常规”标签下生效").style({
            ...gTextStyle.caption,
            color: gTextStyle.color.muted,
        }),
    ]);
    settingsPage.add(variantBox);

    const splitSeg = uSegmented<VkbSplitLayout>({
        items: [
            { label: "触控板上", value: "top" },
            { label: "触控板下", value: "bottom" },
            { label: "触控板左", value: "left" },
            { label: "触控板右", value: "right" },
        ],
        value: state.splitLayout,
        onChange: (value) => applySplitLayout(value, true),
    });
    splitSeg.el.style({ width: "100%" });
    const splitBox = view("y").style({ gap: px(4), flexShrink: "0" });
    splitBox.add([
        sectionTitle("触控板键盘位置"),
        splitSeg.el,
        txt("在触控板页选择极简 / 常规键盘后生效").style({
            ...gTextStyle.caption,
            color: gTextStyle.color.muted,
        }),
    ]);
    settingsPage.add(splitBox);

    const stickyDot = view().style({
        width: px(7),
        height: px(7),
        borderRadius: "50%",
        background: "#00aaff",
        opacity: "0.35",
        flexShrink: "0",
    });
    const stickyText = txt("修饰键粘滞已开启").style({
        ...gTextStyle.body,
        color: gTextStyle.color.secondary,
        flexShrink: "0",
    });
    const stickyRow = view("x").style({ alignItems: "center", gap: px(8), flexShrink: "0" });
    stickyRow.add([stickyDot, stickyText]);
    const stickyBox = view("y").style({ gap: px(4), flexShrink: "0" });
    stickyBox.add([
        sectionTitle("粘滞键"),
        stickyRow,
        txt("Shift / Fn：单击一次、再单击锁定；Ctrl / Alt / Meta：用一次后释放").style({
            ...gTextStyle.caption,
            color: gTextStyle.color.muted,
        }),
    ]);
    settingsPage.add(stickyBox);

    const imeBox = view("y").style({ gap: px(4), flexShrink: "0" });
    const imeCurrent = aLineText()
        .sv("—")
        .style({
            ...gTextStyle.body,
            color: gTextStyle.color.secondary,
        });
    const imeList = view("y").style({ gap: px(2) });
    imeBox.add([sectionTitle("输入法"), imeCurrent, imeList]);
    settingsPage.add(imeBox);
    // 输入法切换器放在布局下面，打开设置页就能看到
    settingsPage.el.insertBefore(imeBox.el, splitBox.el);

    function renderImeStatus(status: VkbImeStatus) {
        imeCurrent.sv(status.available ? `${status.label} · 点击切换` : "fcitx5 不可用");
        imeList.clear();
        if (!status.available) {
            if (status.error) {
                imeList.add(
                    txt(status.error).style({
                        ...gTextStyle.caption,
                        color: gTextStyle.color.muted,
                        wordBreak: "break-all",
                    }),
                );
            }
            return;
        }
        for (const entry of status.entries) {
            const active = status.currentUniqueName === entry.uniqueName;
            const row = view("x").style({
                height: px(30),
                alignItems: "center",
                gap: px(8),
                padding: `0 ${px(8)}`,
                borderRadius: px(gRadius.item),
                background: active ? "#ffffff" : "transparent",
                cursor: "pointer",
                flexShrink: "0",
            });
            row.add([
                txt(entry.off ? "关" : entry.label?.trim() || "·").style({
                    ...gTextStyle.caption,
                    width: px(20),
                    textAlign: "center",
                    flexShrink: "0",
                }),
                aLineText()
                    .sv(entry.off ? "关闭输入法" : entry.name)
                    .style({ ...gTextStyle.body, flexGrow: "1", width: "0", minWidth: "0" }),
            ]);
            row.on("click", () => op.ime?.select(entry.uniqueName));
            imeList.add(row);
        }
    }
    if (op.ime) op.ime.onStatus(renderImeStatus);
    else renderImeStatus({ available: false, label: "—", currentUniqueName: "", entries: [] });

    content.add(settingsPage);

    controller.onChange(() => {
        const s = controller.state;
        const active = s.shift !== 0 || s.caps || s.ctrl || s.alt || s.meta || s.fn !== 0;
        stickyDot.style({ opacity: active ? "1" : "0.35" });
        stickyText.style({ color: active ? gTextStyle.color.primary : gTextStyle.color.secondary });
    });

    function updateVariantVisibility() {
        variantBox.el.style.display = state.layout === "full" ? "flex" : "none";
    }

    function ensureWidth() {
        const minW = minWidthFor(state.layout, state.fullVariant);
        if (state.width >= minW) return;
        state.width = minW;
        op.settings.patch({ width: minW });
        applySize();
        clampPosition();
        applyPlacement();
    }

    function setLayout(next: VkbLayoutId) {
        if (state.layout === next) return;
        state.layout = next;
        op.settings.patch({ layout: next });
        if (page === "keys") tabBar.setValue(next);
        updateVariantVisibility();
        ensureWidth();
        showKeys();
        if (state.touchpadKeyboard !== "none" && state.touchpadKeyboard !== next) {
            state.touchpadKeyboard = next;
            op.settings.patch({ touchpadKeyboard: next });
            touchpadKeyboardSeg.setValue(next);
            syncTouchpadKeyboard();
        }
    }

    function setFullVariant(next: VkbFullVariant) {
        if (state.fullVariant === next) return;
        state.fullVariant = next;
        op.settings.patch({ fullVariant: next });
        variantSeg.setValue(next);
        ensureWidth();
        showKeys();
    }

    updateVariantVisibility();
    showKeys();

    let settingsOpen = false;
    function setSettingsOpen(next: boolean) {
        settingsOpen = next;
        if (next) op.ime?.sync?.();
        settingsPage.style({ display: next ? "flex" : "none" });
        gearBtn.style({
            background: next ? "#ffffff" : gGlassStyle.itemInBg.backgroundColor,
            boxShadow: next ? gShadowStyle.panel : "none",
        });
        syncCandidateOwner();
    }
    function toggleSettings() {
        setSettingsOpen(!settingsOpen);
    }

    const emojiPage = createEmojiPage(op.settings, op.dispatcher);
    const unicodePage = createUnicodePage(op.settings, op.dispatcher);

    // 触控板页：面板 + 可选键盘（不显示 / 极简 / 常规）
    const touchpadPage = pageRoot();
    const touchpadBar = view("x").style({
        height: px(32),
        flexShrink: "0",
        alignItems: "center",
        gap: px(8),
    });
    const touchpadKeyboardSeg = uSegmented<VkbTouchpadKeyboardMode>({
        items: [
            { label: "不显示键盘", value: "none" },
            { label: "极简", value: "minimal" },
            { label: "常规", value: "full" },
        ],
        value: state.touchpadKeyboard,
        onChange: (value) => setTouchpadKeyboard(value),
    });
    touchpadKeyboardSeg.el.style({ flex: "1", minWidth: "0" });
    touchpadBar.add(touchpadKeyboardSeg.el);
    touchpadPage.add(touchpadBar);

    const touchpadBody = view().style({
        flex: "1",
        minHeight: "0",
        display: "flex",
        gap: px(8),
    });
    const touchpadSlot = view().style({
        display: "flex",
        flexDirection: "column",
        minWidth: "0",
        minHeight: "0",
        flex: "1",
    });
    const keyboardSlot = view().style({
        display: "none",
        flexDirection: "column",
        minWidth: "0",
        minHeight: "0",
        flex: "1",
    });
    const touchpadPanel = createTouchpadPanel({
        onClick: (button) => op.onTouchpadClick?.(button),
        onScroll: (deltaY) => op.onTouchpadScroll?.(deltaY),
    });
    touchpadSlot.add(touchpadPanel.el);
    touchpadBody.add([touchpadSlot, keyboardSlot]);
    touchpadPage.add(touchpadBody);
    content.add([emojiPage.el, unicodePage.el, touchpadPage.el]);

    function applySplitLayout(layout: VkbSplitLayout, persist: boolean) {
        state.splitLayout = layout;
        if (persist) op.settings.patch({ splitLayout: layout });
        splitSeg.setValue(layout);
        const horizontal = layout === "left" || layout === "right";
        const touchFirst = layout === "top" || layout === "left";
        const showKeyboard = state.touchpadKeyboard !== "none";
        touchpadPanel.setCompact(showKeyboard);
        touchpadBody.style({ flexDirection: horizontal ? "row" : "column" });
        if (!showKeyboard) {
            keyboardSlot.style({ display: "none", order: "1", flex: "1" });
            touchpadSlot.style({ display: "flex", order: "0", flex: "1", minWidth: "0", minHeight: "0" });
            return;
        }
        keyboardSlot.style({
            display: "flex",
            order: touchFirst ? "1" : "0",
            flex: "1",
            minWidth: "0",
            minHeight: "0",
        });
        touchpadSlot.style({
            display: "flex",
            order: touchFirst ? "0" : "1",
            flex: "0 0 38%",
            minWidth: horizontal ? px(220) : "0",
            minHeight: horizontal ? "0" : px(90),
        });
    }

    let keyboardInTouchpad = false;
    function syncTouchpadKeyboard() {
        const show = page === "touchpad" && state.touchpadKeyboard !== "none";
        if (show) {
            if (!keyboardInTouchpad) {
                keyboardInTouchpad = true;
                keyboardSlot.add(keyBody);
            }
            keyboardSlot.style({ display: "flex" });
        } else {
            if (keyboardInTouchpad) {
                keyboardInTouchpad = false;
                keysPage.add(keyBody);
            }
            keyboardSlot.style({ display: "none" });
        }
        applySplitLayout(state.splitLayout, false);
    }

    function setTouchpadKeyboard(mode: VkbTouchpadKeyboardMode) {
        if (state.touchpadKeyboard === mode) return;
        state.touchpadKeyboard = mode;
        op.settings.patch({ touchpadKeyboard: mode });
        touchpadKeyboardSeg.setValue(mode);
        if (mode !== "none" && state.layout !== mode) {
            // 触控板页的键盘和键盘页共用同一个布局选择
            state.layout = mode;
            op.settings.patch({ layout: mode });
            if (page === "keys") tabBar.setValue(mode);
            updateVariantVisibility();
            ensureWidth();
            showKeys();
        }
        syncTouchpadKeyboard();
        syncCandidateOwner();
    }

    const pages: Record<VkbPage, ElType<HTMLElement>> = {
        keys: keysPage,
        touchpad: touchpadPage,
        emoji: emojiPage.el,
        unicode: unicodePage.el,
    };

    // 缩放手柄
    const grip = view("x")
        .style({
            position: "absolute",
            right: px(4),
            bottom: px(4),
            width: px(16),
            height: px(16),
            alignItems: "flex-end",
            justifyContent: "flex-end",
            gap: px(2),
            padding: px(3),
            boxSizing: "border-box",
            cursor: "nwse-resize",
            pointerEvents: "auto",
            zIndex: "2",
        })
        .data({ "vkb-resize": "1" });
    for (let i = 0; i < 3; i++) {
        const dot = view().style({
            width: px(3),
            height: px(3),
            borderRadius: "50%",
            background: "#00000055",
            flexShrink: "0",
        });
        // 三个点沿右下角排成斜线
        dot.style({ position: "absolute", right: px(3 + i * 4), bottom: px(3 + (2 - i) * 4) });
        grip.add(dot);
    }
    panel.add(grip);
    trackPoint(grip, {
        start: (e) => {
            e.preventDefault();
            return {
                x: 0,
                y: 0,
                data: {
                    width: state.width,
                    height: state.height,
                    cx: e.clientX,
                    cy: e.clientY,
                },
            };
        },
        ing: (_point, e, { startData }) => {
            const maxW = window.innerWidth / scale - state.x;
            const maxH = window.innerHeight / scale - state.y;
            const minW = minWidthFor(state.layout, state.fullVariant);
            state.width = clamp(startData.width + (e.clientX - startData.cx) / scale, minW, Math.max(minW, maxW));
            state.height = clamp(
                startData.height + (e.clientY - startData.cy) / scale,
                MIN_HEIGHT,
                Math.max(MIN_HEIGHT, maxH),
            );
            applySize();
        },
        end: () => {
            op.settings.patch({ width: state.width, height: state.height });
            clampPosition();
            applyPlacement();
        },
    });

    const gear = new AnimationGear<{ v: number }>(
        { v: 0 },
        { transition: { duration: 200, map: (x) => timingFunction.easeOut(x) } },
    );
    gear.addState("show", { v: 1 }, ["hide"]);
    gear.addState("hide", { v: 0 }, ["show"]);
    gear.setUpdateCallback(({ v }) => {
        if (v === 0 && !open) {
            panel.style({ display: "none" });
            outer.style({ pointerEvents: "none" });
            return;
        }
        panel.style({
            display: "flex",
            opacity: `${v}`,
            scale: `${0.96 + 0.04 * v}`,
        });
    });
    gear.moveTo("hide", 0);

    if (state.x < 0 || state.y < 0) defaultPosition();
    applySize();
    clampPosition();
    applyPlacement();
    setPage(page);
    updateCollapseButton();

    function applyPlacement() {
        outer.style({
            transform: `translate(${state.x * scale}px, ${state.y * scale}px) scale(${scale})`,
        });
    }

    function applySize() {
        panel.style({
            width: px(state.width),
            height: px(state.collapsed && page === "touchpad" ? HEADER_HEIGHT + PANEL_PADDING * 2 : state.height),
        });
        if (state.collapsed && page === "touchpad") content.style({ display: "none" });
        else content.style({ display: "block" });
        applyPlacement();
    }

    function clampPosition() {
        const maxX = Math.max(0, window.innerWidth / scale - state.width);
        const maxY = Math.max(0, window.innerHeight / scale - panel.el.offsetHeight);
        state.x = clamp(state.x, 0, maxX);
        state.y = clamp(state.y, 0, maxY);
    }

    function defaultPosition() {
        state.x = (window.innerWidth / scale - state.width) / 2;
        state.y = window.innerHeight / scale - state.height - 72;
    }

    /** 设置窗口或屏幕尺寸变化时使用 */
    function relayout() {
        if (!hasStoredPosition) defaultPosition();
        const minW = minWidthFor(state.layout, state.fullVariant);
        state.width = clamp(state.width, minW, Math.max(minW, window.innerWidth / scale));
        state.height = clamp(state.height, MIN_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight / scale));
        applySize();
        clampPosition();
        applyPlacement();
    }

    function updateCollapseButton() {
        const showCollapse = page === "touchpad";
        collapseBtn.el.style.display = showCollapse ? "flex" : "none";
        collapseBtn.clear().add(txt(state.collapsed ? "展开" : "收起"));
    }

    /** 键盘自己显示候选时，让浮动候选窗让位 */
    function syncCandidateOwner() {
        const visible =
            open &&
            !suspended &&
            !settingsOpen &&
            !(page === "touchpad" && state.collapsed) &&
            (page === "keys" || (page === "touchpad" && state.touchpadKeyboard !== "none"));
        op.ime?.setCandidatesInKeyboard?.(visible);
    }

    function setPage(next: VkbPage) {
        if (settingsOpen) setSettingsOpen(false);
        page = next;
        state.page = next;
        if (next !== "touchpad" && state.collapsed) {
            state.collapsed = false;
            op.settings.patch({ collapsed: false });
        }
        syncTouchpadKeyboard();
        for (const key of Object.keys(pages) as VkbPage[]) {
            pages[key].el.style.display = key === next ? "flex" : "none";
        }
        tabBar.setValue(next === "keys" ? state.layout : (next as VkbTabId));
        applySize();
        updateCollapseButton();
        op.settings.patch({ page: next });
        op.onTouchpadActiveChange?.(open && !suspended && next === "touchpad");
        if (next === "emoji") emojiPage.refresh();
        if (next === "unicode") unicodePage.refresh();
        syncCandidateOwner();
    }

    function setCollapsed(collapsed: boolean) {
        if (state.collapsed === collapsed) return;
        state.collapsed = collapsed;
        op.settings.patch({ collapsed });
        op.onCollapseChange?.(collapsed);
        applySize();
        updateCollapseButton();
        op.onTouchpadActiveChange?.(open && !suspended && page === "touchpad");
        syncCandidateOwner();
    }

    function show() {
        if (open || suspended) return;
        open = true;
        gear.moveTo("show");
        outer.style({ pointerEvents: "auto" });
        op.onOpenChange?.(true);
        op.onTouchpadActiveChange?.(page === "touchpad");
        syncCandidateOwner();
    }

    function close() {
        if (!open) return;
        if (settingsOpen) setSettingsOpen(false);
        open = false;
        gear.moveTo("hide");
        op.onOpenChange?.(false);
        op.onTouchpadActiveChange?.(false);
        syncCandidateOwner();
    }

    function setSuspended(next: boolean) {
        if (suspended === next) return;
        suspended = next;
        if (next) {
            close();
        }
        op.onTouchpadActiveChange?.(open && !suspended && page === "touchpad");
    }

    op.layer.appendChild(outer.el);
    // 首次打开前用默认尺寸校正一次位置
    relayout();

    return {
        el: outer,
        open: show,
        close,
        toggle: () => (open ? close() : show()),
        isOpen: () => open,
        setPage,
        getPage: () => page,
        setLayout,
        getLayout: () => state.layout,
        setUiScale(next: number) {
            if (!Number.isFinite(next) || next <= 0 || scale === next) return;
            scale = next;
            relayout();
        },
        relayout,
        isKeyboardUiAt(x: number, y: number) {
            if (!open || suspended) return false;
            if (panel.el.style.display === "none") return false;
            const el = document.elementFromPoint(x, y);
            if (!el || !panel.el.contains(el)) return false;
            return el.closest("[data-vkb-touchpad-surface]") === null;
        },
        getState: () => state,
        setSuspended,
        setCollapsed,
    };
}

/** 锁屏密码键盘：独立、固定布局，不使用输入法 */
export function createAsciiKeyboard(op: { dispatcher: VkbDispatcher }): { el: ElType<HTMLElement> } {
    const panel = view("y").style({
        width: "100%",
        height: "100%",
        padding: px(PANEL_PADDING),
        boxSizing: "border-box",
        gap: px(PANEL_PADDING),
        borderRadius: px(gRadius.container),
        ...gGlassStyle.bg,
    });
    const controller = createKeyController(op.dispatcher, () => {});
    const grid = createKeyGrid(controller, ASCII_KEY_ROWS, "ascii");
    panel.add(grid);
    return { el: panel };
}
