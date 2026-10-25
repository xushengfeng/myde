import type { TextInputState, WinHandle } from "../../../../src/desktop-api";
import type {
    ImComposeState,
    ImEntry,
    ImGroupInfo,
    ImState,
    inputMethod,
    inputMethodContext,
} from "../../../../src/sys_api/input_method";
import { imeCandidatePopup } from "../ui";
import { keyEventToIme } from "./keysym";
import { DEFAULT_IME_BINDINGS, type ImeBindings, matchBindings, normalizeBindings } from "./shortcut";

/** 窗口元素在视口中的位置，以及 surface 局部坐标 → 视口坐标需要的缩放/几何偏移 */
export interface ImeWindowFrame {
    left: number;
    top: number;
    width: number;
    height: number;
    scale: number;
    offsetX: number;
    offsetY: number;
}

export type PanelPreeditMode = "auto" | "always" | "never";

export interface ImeDeps {
    im: inputMethod | undefined;
    /** 候选窗挂载点（桌面覆盖层） */
    overlay: HTMLElement;
    isNormal(): boolean;
    getFocus(): WinHandle | undefined;
    sendKey(handle: WinHandle, code: number, type: "pressed" | "released"): void;
    sendText(handle: WinHandle, text: string, preedit: boolean): void;
    queryTextInput(handle: WinHandle): Promise<TextInputState>;
    windowFrame(handle: WinHandle): ImeWindowFrame | undefined;
    getPointer(): { x: number; y: number };
    getBindings(): Partial<ImeBindings>;
    /** 候选窗是否重复显示 fcitx 已经发给客户端的预编辑 */
    getPanelPreedit(): PanelPreeditMode;
}

export interface ImeStatus {
    available: boolean;
    state: ImState;
    /** 托盘显示的短标签：中/英/关 */
    label: string;
    current: ImEntry | undefined;
    group: ImGroupInfo | undefined;
    error: string | undefined;
}

type KeyKind = "ime" | "client" | "shortcut";

const EMPTY_TEXT_INPUT: TextInputState = { supported: false, enabled: false, cursorRect: null };

/**
 * 决定预编辑显示在哪：
 * - `inline` 只有在 fcitx 确实发了客户端预编辑时才下发；
 * - `panel` 在 `auto` 下避免和内联重复，fcitx 没发内联时作为兜底。
 */
export function resolveImePreedit(state: ImComposeState, mode: PanelPreeditMode): { inline: string; panel: string } {
    const inline = state.clientPreeditEnabled ? state.clientPreedit : "";
    let panel = "";
    if (mode === "always") {
        panel = state.panelPreedit;
    } else if (mode === "auto") {
        panel = state.clientPreeditEnabled && state.clientPreedit ? "" : state.panelPreedit;
    }
    return { inline, panel };
}

/**
 * 官方桌面的输入法控制层。
 *
 * 桌面是 fcitx5 的输入上下文客户端（不是 compositor 的 input-method-v2）：
 * 按键在转发给 Wayland 客户端之前先经过这里，被输入法消费的按下/抬起都不下发；
 * 提交文本和预编辑走 `input.text`。客户端不实现 text-input 时不拦截按键。
 */
export class ImeController {
    private readonly deps: ImeDeps;
    private readonly candidate: ReturnType<typeof imeCandidatePopup>;
    private readonly listeners = new Set<(status: ImeStatus) => void>();

    private readonly im: inputMethod | undefined;
    private ctx: inputMethodContext | undefined;
    private available = false;
    private error: string | undefined;

    private focusHandle: WinHandle | undefined;
    private state: ImState = 0;
    private current: ImEntry | undefined;
    private group: ImGroupInfo | undefined;

    private textInput: TextInputState = EMPTY_TEXT_INPUT;
    private textInputHandle: WinHandle | undefined;
    private textInputAt = 0;

    /** 本次按下交给谁，抬起时按它决定吞掉还是转发 */
    private readonly pressKinds = new Map<string, KeyKind>();
    private lastPreedit = "";
    private caretSeq = 0;
    private queue: Promise<void> = Promise.resolve();

    private bindings: ImeBindings = DEFAULT_IME_BINDINGS;

    constructor(deps: ImeDeps) {
        this.deps = deps;
        this.im = deps.im;
        this.candidate = imeCandidatePopup({
            select: (i) => void this.selectCandidate(i),
            nextPage: () => void this.page(true),
            prevPage: () => void this.page(false),
        });
        deps.overlay.appendChild(this.candidate.el.el);
        this.readBindings();
    }

    async init(): Promise<boolean> {
        if (!this.im) {
            this.emitStatus();
            return false;
        }
        try {
            this.ctx = await this.im.createContext("myde-desktop");
            this.ctx.on("update", (s) => this.onUpdate(s));
            this.ctx.on("commit", (text) => this.onCommit(text));
            this.ctx.on("im", () => void this.refresh());
            this.available = true;
            await this.refresh();
            this.emitStatus();
            // 初始化期间可能已经有窗口获得焦点，补一次 FocusIn
            const handle = this.deps.getFocus();
            if (handle !== undefined) await this.focus(handle);
            return true;
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
            this.available = false;
            this.emitStatus();
            return false;
        }
    }

    getBindings(): ImeBindings {
        return this.bindings;
    }

    getStatus(): ImeStatus {
        return {
            available: this.available,
            state: this.state,
            label: this.label(),
            current: this.current,
            group: this.group,
            error: this.error,
        };
    }

    onStatus(cb: (status: ImeStatus) => void): () => void {
        this.listeners.add(cb);
        cb(this.getStatus());
        return () => this.listeners.delete(cb);
    }

    /** 外部（fcitx-remote、托盘）可能改过状态，打开弹层时同步一次 */
    async sync() {
        await this.refresh();
    }

    // ───────────── 焦点与生命周期 ─────────────

    async focus(handle: WinHandle) {
        if (!this.available) return;
        if (!this.deps.isNormal()) {
            await this.blur();
            return;
        }
        if (this.focusHandle === handle && this.ctx) {
            await this.refresh();
            return;
        }
        this.clearPreedit();
        this.focusHandle = handle;
        this.pressKinds.clear();
        this.candidate.hide();
        this.invalidateTextInput();
        try {
            await this.ctx?.reset();
            await this.ctx?.focus();
        } catch (e) {
            this.setError(e);
        }
        await this.queryTextInput(handle);
        await this.refresh();
    }

    async blur() {
        this.clearPreedit();
        this.focusHandle = undefined;
        this.pressKinds.clear();
        this.candidate.hide();
        this.invalidateTextInput();
        try {
            await this.ctx?.reset();
            await this.ctx?.blur();
        } catch (e) {
            this.setError(e);
        }
        this.emitStatus();
    }

    /** 锁屏结束等场景：窗口焦点没有变，但上下文被 blur 过 */
    async resume() {
        if (!this.available) return;
        const handle = this.deps.getFocus();
        if (handle === undefined) return;
        this.focusHandle = handle;
        try {
            await this.ctx?.focus();
        } catch (e) {
            this.setError(e);
        }
        await this.refresh();
    }

    invalidateTextInput() {
        this.textInput = EMPTY_TEXT_INPUT;
        this.textInputHandle = undefined;
        this.textInputAt = 0;
    }

    /** 窗口里点了鼠标：光标位置和文本焦点都可能变了，下一次按键重新查询 */
    pointerDown() {
        this.clearPreedit();
        this.invalidateTextInput();
        this.candidate.hide();
        this.pressKinds.clear();
        void this.ctx?.reset().catch(() => {});
    }

    /** 主动清掉客户端里的内联预编辑；切换焦点/失焦/点击时不能留下半截拼音 */
    private clearPreedit() {
        if (this.focusHandle !== undefined && this.lastPreedit) {
            this.deps.sendText(this.focusHandle, "", true);
        }
        this.lastPreedit = "";
    }

    // ───────────── 按键 ─────────────

    /** 返回 true 表示这次按下由输入法接管（无论最终是喂给 fcitx 还是原样转发） */
    handleKeyDown(e: KeyboardEvent): boolean {
        if (!this.available || !this.deps.isNormal()) return false;
        if (isEditableTarget(e.target)) return false;
        const handle = this.deps.getFocus();
        if (handle === undefined) return false;
        this.enqueue(() => this.onKeyDown(e, handle));
        return true;
    }

    handleKeyUp(e: KeyboardEvent): boolean {
        if (!this.available || !this.deps.isNormal()) return false;
        if (isEditableTarget(e.target)) return false;
        const handle = this.deps.getFocus();
        if (handle === undefined) return false;
        this.enqueue(() => this.onKeyUp(e, handle));
        return true;
    }

    private enqueue(task: () => Promise<void>) {
        this.queue = this.queue.then(task).catch((e) => {
            console.warn("[ime] 按键处理失败:", e);
        });
    }

    private async onKeyDown(e: KeyboardEvent, handle: WinHandle) {
        const repeat = e.repeat;
        const prev = this.pressKinds.get(e.code);

        if (repeat) {
            if (prev === "shortcut") return;
            if (prev === "client") {
                this.forward(e, handle);
                return;
            }
            if (prev === "ime") {
                await this.feedKey(e, handle);
                return;
            }
        }

        const ti = await this.ensureTextInput(handle);
        if (!ti.supported) {
            // 客户端没有 text-input：不启用输入法，按键完全按旧路径走
            this.pressKinds.set(e.code, "client");
            this.forward(e, handle);
            return;
        }

        const bindings = this.bindings;
        if (matchBindings(e, bindings.toggle)) {
            this.pressKinds.set(e.code, "shortcut");
            await this.toggle();
            return;
        }
        if (matchBindings(e, bindings.nextIM)) {
            this.pressKinds.set(e.code, "shortcut");
            await this.stepIM(1);
            return;
        }
        if (matchBindings(e, bindings.prevIM)) {
            this.pressKinds.set(e.code, "shortcut");
            await this.stepIM(-1);
            return;
        }

        // keyboard-us / 停用状态：直接走客户端，不经过 fcitx，行为与 KDE 的键盘布局一致
        if (!ti.enabled || this.state !== 2 || this.current?.uniqueName === "keyboard-us") {
            this.pressKinds.set(e.code, "client");
            this.forward(e, handle);
            return;
        }

        const key = keyEventToIme(e);
        if (!key) {
            this.pressKinds.set(e.code, "client");
            this.forward(e, handle);
            return;
        }

        this.pressKinds.set(e.code, "ime");
        try {
            const r = await this.ctx?.keyEvent(key.keysym, {
                state: key.state,
                keycode: key.keycode,
                settleMs: 0,
            });
            if (!r?.handled) this.pressKinds.set(e.code, "client");
            if (!r?.handled) this.forward(e, handle);
        } catch (err) {
            this.setError(err);
            this.pressKinds.set(e.code, "client");
            this.forward(e, handle);
        }
    }

    private async onKeyUp(e: KeyboardEvent, handle: WinHandle) {
        const kind = this.pressKinds.get(e.code);
        this.pressKinds.delete(e.code);

        if (kind === "shortcut") return;
        if (kind === "ime") {
            const key = keyEventToIme(e);
            if (key) {
                await this.ctx
                    ?.keyEvent(key.keysym, {
                        isRelease: true,
                        state: key.state,
                        keycode: key.keycode,
                        settleMs: 0,
                    })
                    .catch((err) => this.setError(err));
            }
            return;
        }
        // kind === "client" 或没有记录：抬起照旧转发
        this.forward(e, handle);
    }

    private async feedKey(e: KeyboardEvent, handle: WinHandle) {
        const key = keyEventToIme(e);
        if (!key) return;
        try {
            const r = await this.ctx?.keyEvent(key.keysym, {
                state: key.state,
                keycode: key.keycode,
                settleMs: 0,
            });
            if (!r?.handled) {
                this.pressKinds.set(e.code, "client");
                this.forward(e, handle);
            }
        } catch (err) {
            this.setError(err);
            this.pressKinds.set(e.code, "client");
            this.forward(e, handle);
        }
    }

    private forward(e: KeyboardEvent, handle: WinHandle) {
        this.deps.sendKey(handle, myde.MInputMap.mapKeyCode(e.code), e.type === "keydown" ? "pressed" : "released");
    }

    // ───────────── 合成状态 ─────────────

    private onUpdate(state: ImComposeState) {
        const handle = this.focusHandle;
        if (handle === undefined || !this.deps.isNormal()) {
            this.candidate.hide();
            return;
        }

        const composing = state.preedit.length > 0 || state.candidates.length > 0 || state.auxiliary.length > 0;
        if (!composing) {
            this.candidate.hide();
            this.sendPreedit(handle, "");
            return;
        }

        const { inline, panel } = this.splitPreedit(state);
        if (inline !== this.lastPreedit) this.sendPreedit(handle, inline);

        const seq = ++this.caretSeq;
        this.candidate.setAnchor(this.anchorFor(handle));
        this.candidate.update({ ...state, preedit: panel });

        // 光标可能刚移动，异步刷新后再校正一次位置；旧请求不覆盖新状态
        void this.queryTextInput(handle)
            .then(() => {
                if (seq === this.caretSeq) this.candidate.setAnchor(this.anchorFor(handle));
            })
            .catch(() => {});
    }

    /**
     * 决定预编辑去哪儿：
     * - `inline` 只有在 fcitx 确实在发客户端预编辑时才下发（应用在 NO_PREEDIT_APPS 或被关掉时为空）；
     * - `panel` 默认在已经内联显示时不重复，应用不画或 fcitx 没开内联时作为兜底。
     */
    private splitPreedit(state: ImComposeState): { inline: string; panel: string } {
        return resolveImePreedit(state, this.deps.getPanelPreedit());
    }

    private onCommit(text: string) {
        const handle = this.focusHandle;
        if (handle === undefined) return;
        this.lastPreedit = "";
        this.deps.sendText(handle, text, false);
    }

    private sendPreedit(handle: WinHandle, text: string) {
        if (text === this.lastPreedit) return;
        this.lastPreedit = text;
        this.deps.sendText(handle, text, true);
    }

    private anchorFor(handle: WinHandle) {
        const caret = this.textInput.cursorRect;
        const frame = this.deps.windowFrame(handle);
        if (caret && frame) {
            const scale = frame.scale || 1;
            return {
                x: frame.left + (caret.x - frame.offsetX) * scale,
                y: frame.top + (caret.y - frame.offsetY) * scale,
                w: caret.w * scale,
                h: caret.h * scale,
            };
        }
        const p = this.deps.getPointer();
        return { x: p.x, y: p.y, w: 0, h: 0 };
    }

    private async selectCandidate(index: number) {
        try {
            const r = await this.ctx?.selectCandidate(index);
            if (r) this.applyState(r);
        } catch (e) {
            this.setError(e);
        }
    }

    private async page(next: boolean) {
        try {
            const s = next ? await this.ctx?.nextPage() : await this.ctx?.prevPage();
            if (s) this.applyState(s);
        } catch (e) {
            this.setError(e);
        }
    }

    private applyState(s: ImComposeState) {
        if (this.focusHandle === undefined) return;
        const { inline, panel } = this.splitPreedit(s);
        if (inline !== this.lastPreedit) this.sendPreedit(this.focusHandle, inline);
        this.candidate.setAnchor(this.anchorFor(this.focusHandle));
        if (panel || s.candidates.length > 0 || s.auxiliary) this.candidate.update({ ...s, preedit: panel });
        else this.candidate.hide();
    }

    // ───────────── 开关与切换 ─────────────

    async toggle() {
        if (!this.im) return;
        try {
            await this.im.toggle();
            this.candidate.hide();
            this.clearPreedit();
            await this.refresh();
        } catch (e) {
            this.setError(e);
        }
    }

    async setCurrentIM(uniqueName: string) {
        if (!this.im) return;
        try {
            await this.im.setCurrentIM(uniqueName);
            this.candidate.hide();
            this.clearPreedit();
            await this.refresh();
        } catch (e) {
            this.setError(e);
        }
    }

    async stepIM(dir: 1 | -1) {
        const list = this.group?.inputMethods;
        if (!list || list.length === 0) return;
        const cur = this.current?.uniqueName ?? "";
        const found = list.findIndex((e) => e.uniqueName === cur);
        const index = found >= 0 ? found : dir === 1 ? -1 : 0;
        const next = list[(index + dir + list.length) % list.length];
        if (next) await this.setCurrentIM(next.uniqueName);
    }

    private async refresh() {
        if (!this.im) return;
        this.error = undefined;
        try {
            this.state = await this.im.getState();
        } catch (e) {
            this.setError(e);
        }
        try {
            this.current = await this.im.getCurrentIM();
        } catch {
            // 没有聚焦上下文时可能取不到，保留上一次
        }
        try {
            this.group = await this.im.getGroupInfo();
        } catch {
            // 组信息失败不影响输入
        }
        this.emitStatus();
    }

    // ───────────── 文本焦点缓存 ─────────────

    private async ensureTextInput(handle: WinHandle): Promise<TextInputState> {
        const now = performance.now();
        if (this.textInputHandle === handle && this.textInput && now - this.textInputAt < 250) return this.textInput;
        return this.queryTextInput(handle);
    }

    private async queryTextInput(handle: WinHandle): Promise<TextInputState> {
        try {
            this.textInput = await this.deps.queryTextInput(handle);
        } catch {
            this.textInput = EMPTY_TEXT_INPUT;
        }
        this.textInputHandle = handle;
        this.textInputAt = performance.now();
        return this.textInput;
    }

    // ───────────── 状态输出 ─────────────

    private readBindings() {
        const b = this.deps.getBindings();
        this.bindings = {
            toggle: normalizeBindings(b.toggle, DEFAULT_IME_BINDINGS.toggle),
            nextIM: normalizeBindings(b.nextIM, DEFAULT_IME_BINDINGS.nextIM),
            prevIM: normalizeBindings(b.prevIM, DEFAULT_IME_BINDINGS.prevIM),
        };
    }

    private label(): string {
        if (!this.available) return "—";
        if (this.current?.uniqueName === "keyboard-us") return "关";
        if (this.state === 2) return this.current?.label?.trim() || this.current?.name?.slice(0, 1) || "中";
        if (this.state === 1) return this.current?.label?.trim() || "英";
        return "关";
    }

    private setError(e: unknown) {
        this.error = e instanceof Error ? e.message : String(e);
        this.emitStatus();
    }

    private emitStatus() {
        const s = this.getStatus();
        for (const cb of this.listeners) cb(s);
    }
}

function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== "function") return false;
    return !!el.closest("input, textarea, select, [contenteditable='true']");
}
