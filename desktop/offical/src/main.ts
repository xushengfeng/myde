import {
    addClass,
    addStyle,
    button,
    check,
    type ElType,
    ele,
    image,
    pack,
    setProperty,
    spacer,
    txt,
    view,
} from "dkh-ui";
import { AnimationGear, timingFunction } from "myde-ui";
import type {
    ConnectConnection,
    DesktopIconConfig,
    InputManager,
    UniInputEvent,
    WinHandle,
} from "../../../src/desktop-api";
import { InputEventCodes } from "../../../src/input_codes/types";
import type { blueDevice } from "../../../src/sys_api/blue";
import type { MenuItem } from "../../../src/sys_api/menu";
import type { wifiDevice } from "../../../src/sys_api/network";
import type { powerDevice } from "../../../src/sys_api/power";
import { TouchpadInput } from "../../../src/utils/touchpad";
import { Cursor } from "./cursor";
import { getIconXEl } from "./icon";
import { ImeController } from "./ime/ime";
import { DEFAULT_IME_BINDINGS, type KeyBinding, matchBindings } from "./ime/shortcut";
import { createImeTool } from "./ime/tool";
import {
    BTN_TO_BUTTON,
    canKey,
    HI_RES_SCALE,
    hasRelativeXY,
    type InputPointerPos,
    isTouchpad,
    isTouchscreen,
    pointerKindOf,
    ratioToView,
    WHEEL_STEP,
} from "./input_evdev";
import { Registry } from "./registry";
import { ScreenManager } from "./screen";
import { dynamicScrollList } from "./scroll-list";
import { createSettingsContent, type ImePanelPreeditMode } from "./settings";
import {
    aLineText,
    gGlassStyle,
    iItem,
    mMedia,
    nNotiList,
    nNumber,
    px,
    sSize,
    sSize2,
    tTrayMenu,
    ui,
    vVolume,
} from "./ui";

// ========== Registry 和 ControlNode ==========

// 特殊的id类型，表示可以用registry.get获取
type id<T extends string = string> = string & { __brand: T };

interface ControlNode {
    id: string;
    type: string;
    el: ElType<HTMLElement>;
    unmount?(): void;
}

// RegistrySchema 定义所有键值对类型
interface RegistrySchema {
    "power.battery": number;
    "power.lidClosed": boolean;
    "power.devices": id<"power.devices[]">[];
    "power.devices[]": {
        name: string;
        percentage: number;
        status:
            | "Charging"
            | "Discharging"
            | "Empty"
            | "Fully charged"
            | "Pending charge"
            | "Pending discharge"
            | "Unknown";
    };
    "wifi.enabled": boolean;
    "wifi.accessPoints": id<"wifi.accessPoints[]">[];
    "wifi.accessPoints[]": {
        ssid: string;
        connected: boolean;
    };
    "connect.enabled": boolean;
    "connect.id": string;
    "connect.devices": id<"connect.devices[]">[];
    "connect.devices[]": {
        id: string;
        name: string;
        connected: boolean;
        remembered: boolean;
    };
    "blue.power": boolean;
    "blue.devices": id<"blue.devices[]">[];
    "blue.devices[]": {
        name: string;
        connected: boolean;
    };
    "notification.list": id<"notification.list[]">[];
    "notification.list[]": {
        title: string;
        content: string;
    };
    "notification.list[].delete": boolean;
    "media.list": id<"media.list[]">[];
    "media.list[]": {
        title: string;
        cover: string;
        artist: string[];
        duration: number;
    };
    "media.list[].play": boolean;
    "media.list[].next": boolean;
    "media.list[].previous": boolean;
    "media.list[].currentTime": number;
    "tray.list": id<"tray.list[]">[];
    "tray.list[]": {
        icon: string;
        title: string;
        itemIsMenu: boolean;
    };
    "tray.list[].active": boolean;
    "tray.list[].menu": MenuItem[];
    "volume.output.default.muted": boolean;
    "volume.input.default.muted": boolean;
    "volume.output.default.volume": number;
    "volume.input.default.volume": number;
    "time.hour": number;
    "time.minute": number;
    "time.second": number;
    "time.year": number;
    "time.month": number;
    "time.day": number;
    "time.weekday": number;
}

type tmpRegistry = Registry<RegistrySchema>;

// 具体的键类型
type BooleanRegistryKeys = "wifi.enabled" | "blue.power" | "connect.enabled";
type NumericRegistryKeys = "power.battery";

function createToggle(registry: tmpRegistry, id: BooleanRegistryKeys): ControlNode {
    const source = registry.get(id);
    const toggle = check(id, ["on", "off"]);

    const unsub = source.getAndSubscribe((v) => toggle.sv(v));

    toggle.el.addEventListener("change", () => {
        source.set?.(toggle.gv);
    });

    return { id, type: "toggle", el: toggle as unknown as ElType<HTMLElement>, unmount: unsub };
}

function createIndicator(registry: tmpRegistry, id: NumericRegistryKeys): ControlNode {
    const source = registry.get(id);
    const label = txt();

    const unsub = source.getAndSubscribe((v) => label.sv(String(v)));
    return { id, type: "indicator", el: label as unknown as ElType<HTMLElement>, unmount: unsub };
}

const { MSysApi, MInputMap, MUtils, MSetting } = myde;
const fs = MSysApi.fs;

type View = {
    ox: number;
    oy: number;
};

type InternalWindowEntry = {
    el: ElType<HTMLDivElement>;
    view: View;
    setActive(active: boolean): void;
    dispose?: () => void;
};

/** 桌面自己创建的 DOM 窗口（不是 Wayland 客户端），与客户端窗口共用虚拟桌面、聚焦和关闭逻辑 */
const internalWindows = new Map<string, InternalWindowEntry>();

function isInternalWindow(id: MWinId | undefined): id is string {
    return id !== undefined && internalWindows.has(id);
}

type Plant = {
    id: string;
    items: { id: string; posi?: { archor: "center" | "start" | "end"; offset: number } }[];
    glow: boolean;
    posi: "top" | "left" | "right" | "bottom";
};

type ToolsItem = {
    cb: (p: {
        tipEl: HTMLElement;
        showTip: (op?: { state?: "show" | "hide" | "toggle"; anchorEl?: HTMLElement }) => void;
        showA: "left" | "right" | "top" | "bottom";
    }) => ElType<HTMLElement>;
    sizeLimit: {
        maxW: number;
        minW: number;
        maxH: number;
        minH: number;
    };
    selfBackground: boolean; // tool自身是否带背景，否则应为透明
};

class Tools {
    tools: Map<string, ToolsItem>;
    private tipEl: HTMLElement = view().el;
    constructor() {
        this.tools = new Map();
    }
    setTipEl(tipEl: HTMLElement) {
        this.tipEl = tipEl;
    }
    registerTool(
        name: string,
        tool: ToolsItem["cb"],
        op?: { selfBackground?: ToolsItem["selfBackground"]; sizeLimit?: Partial<ToolsItem["sizeLimit"]> },
    ) {
        this.tools.set(name, {
            cb: tool,
            selfBackground: op?.selfBackground ?? false,
            sizeLimit: {
                minH: op?.sizeLimit?.minH ?? 0,
                minW: op?.sizeLimit?.minW ?? 0,
                maxH: op?.sizeLimit?.maxH ?? Infinity,
                maxW: op?.sizeLimit?.maxW ?? Infinity,
            },
        });
    }
    getTool(name: string) {
        const tool = this.tools.get(name);
        if (!tool) return undefined;
        let launchEl: HTMLElement | null = null;
        const tipel = (() => {
            let show = false;
            const el = view()
                .style({
                    position: "fixed",
                    width: "fit-content",
                    height: "fit-content",
                })
                .style(
                    tool.selfBackground
                        ? {}
                        : {
                              padding: "6px",
                              background: "rgba(255,255,255,0.8)",
                              backdropFilter: "blur(12px)",
                              borderRadius: "12px",
                          },
                )
                .addInto(this.tipEl)
                .bindSet((s) => {
                    if (s === "show") {
                        show = true;
                    } else if (s === "hide") {
                        show = false;
                    } else {
                        show = !show;
                    }
                })
                .bindGet(() => show);
            return el;
        })().sv("hide");
        const gear = new AnimationGear<{ show: number }>(
            { show: 0 },
            { transition: { duration: 280, map: (x) => timingFunction.easeOut(x) } },
        );
        gear.addState("show", { show: 1 }, ["hide"]);
        gear.addState("hide", { show: 0 }, ["show"]);
        gear.setUpdateCallback((state) => {
            if (state.show === 0) {
                tipel.style({ display: "none" });
            } else {
                tipel.style({ display: "block", opacity: `${state.show}`, scale: `${state.show}` });
            }
        });
        gear.moveTo("hide", 0);
        // todo 回收
        // 只响应合成 click：原生 click 由下方「输入聚合层」吞掉（其注册早于本监听），永远到不了元素处理器；
        // 这里再显式忽略一次作为契约，避免日后代码重排回到「合成 click 打开弹窗 → 原生 click 立刻关闭」的
        // 点击无反应（点击不开弹窗的工具如 apps 不受影响，evdev 来源本来就没有原生事件）
        window.addEventListener(
            "click",
            (e) => {
                if (e.isTrusted) return;
                const target = e.target as HTMLElement;
                if (tipel.gv === true && !tipel.el.contains(target)) {
                    if (launchEl?.contains(target)) e.stopImmediatePropagation();
                    tipel.sv("hide");
                    gear.moveTo("hide");
                }
            },
            { capture: true },
        );
        return {
            getEl: (showA: "left" | "right" | "top" | "bottom") => {
                const el = tool.cb({
                    tipEl: tipel.el,
                    showTip: (s) => {
                        const state = s?.state || "toggle";
                        if (state === "show") {
                            tipel.sv("show");
                            gear.moveTo("show");
                        } else if (state === "hide") {
                            tipel.sv("hide");
                            gear.moveTo("hide");
                        } else {
                            tipel.sv("toggle");
                            if (tipel.gv === true) {
                                gear.moveTo("show");
                            } else {
                                gear.moveTo("hide");
                            }
                        }
                        const anchorname = `--${crypto.randomUUID()}`;
                        const anchorEl = s?.anchorEl ? pack(s.anchorEl) : el;
                        anchorEl.style({
                            anchorName: anchorname,
                        });
                        tipel.style({
                            positionAnchor: anchorname,
                            ...(showA === "left"
                                ? {
                                      positionArea: "left center",
                                      transformOrigin: "right center",
                                  }
                                : showA === "right"
                                  ? {
                                        positionArea: "right center",
                                        transformOrigin: "left center",
                                    }
                                  : showA === "top"
                                    ? {
                                          positionArea: "top center",
                                          transformOrigin: "bottom center",
                                      }
                                    : showA === "bottom"
                                      ? {
                                            positionArea: "bottom center",
                                            transformOrigin: "top center",
                                        }
                                      : {}),
                        });
                    },
                    showA,
                });
                launchEl = el.el;
                return el;
            },
        };
    }
}

/** 全局窗口身份：服务端 handle */
type MWinId = WinHandle;

function 回布局(index: number): { x: number; y: number } {
    const xi = index + 1;
    const w = Math.sqrt(xi);
    const 宽 = w % 2 === 1 ? w : Math.ceil(w) % 2 === 0 ? Math.ceil(w) + 1 : Math.ceil(w);
    const d = Math.floor(宽 / 2);
    const start = (宽 - 2) ** 2 + 1;
    const _offset = xi - start - d;
    const offset = _offset < 0 ? (宽 - 1) * 4 - _offset : _offset;
    const n = Math.floor(offset / (宽 - 1));
    const offsetOfN = offset % (宽 - 1);

    if (n === 0) {
        const y = -d;
        const x = -offsetOfN + d;
        return { x, y };
    } else if (n === 1) {
        const x = -d;
        const y = offsetOfN - d;
        return { x, y };
    } else if (n === 2) {
        const y = d;
        const x = offsetOfN - d;
        return { x, y };
    } else {
        const x = d;
        const y = -offsetOfN + d;
        return { x, y };
    }
}

/** 输入法控制层在下方创建；焦点回调可能早于此时，统一走可选链 */
let ime: ImeController | undefined;

class ViewData {
    private views: View[] = [];
    private win2View = new Map<MWinId, View>();
    /** 当前聚焦的窗口 handle，键盘按它反查客户端下发 */
    focusHandle: MWinId | undefined;
    newView() {
        for (let i = 1; i <= this.views.length + 1; i++) {
            const pos = 回布局(i);
            const exists = this.views.find((v) => v.ox === pos.x && v.oy === pos.y);
            if (!exists) {
                const v: View = { ox: pos.x, oy: pos.y };
                this.views.push(v);
                return v;
            }
        }
        const v: View = { ox: this.views.length, oy: 0 };
        this.views.push(v);
        return v;
    }
    getViewByWinId(winid: MWinId) {
        return this.win2View.get(winid);
    }
    moveWinToView(winid: MWinId, v: View) {
        this.win2View.set(winid, v);
        this.checkAndRmView();
    }
    closeWin(winid: MWinId) {
        this.win2View.delete(winid);
        this.checkAndRmView();
    }
    focusWin(winid: MWinId) {
        const internal = internalWindows.has(winid);
        if (!internal && !server.server.windows.get(winid)) {
            console.warn("cant find window", winid);
            return;
        }
        this.focusHandle = winid;
        for (const [id, win] of internalWindows) {
            win.setActive(id === winid);
        }
        // 目标聚焦、其余失焦，全部经 server 下发；内部窗口没有 Wayland 焦点，只清掉客户端焦点
        for (const info of server.server.windows.list()) {
            if (!internal && info.handle === winid) server.server.notify("window.focus", info.handle);
            else server.server.notify("window.blur", info.handle);
        }
        if (internal) void ime?.blur();
        else void ime?.focus(winid);
    }
    /** 只有 Wayland 窗口才有输入法上下文，内部窗口的文本输入由 DOM 自己处理 */
    getWaylandFocus() {
        return this.focusHandle !== undefined && !isInternalWindow(this.focusHandle) ? this.focusHandle : undefined;
    }
    blurAll() {
        this.focusHandle = undefined;
        for (const win of internalWindows.values()) {
            win.setActive(false);
        }
        for (const info of server.server.windows.list()) {
            server.server.notify("window.blur", info.handle);
        }
        void ime?.blur();
    }
    private checkAndRmView() {
        const allAliveViews = new Set(this.win2View.values());
        this.views = this.views.filter((v) => allAliveViews.has(v));
    }
}

const viewData = new ViewData();

interface WindowCenterConfig {
    enabled: boolean;
    viewport: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}

class WindowCenterManager {
    private config: WindowCenterConfig = {
        enabled: true,
        viewport: { x: 0, y: 0, width: 0, height: 0 },
    };
    private windowElements = new Map<string, HTMLElement>();
    private pausedWindows = new Set<string>();
    private resizeObserver: ResizeObserver | null = null;

    constructor() {
        this.initResizeObserver();
    }

    private initResizeObserver() {
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const windowId = entry.target.getAttribute("data-window-id");
                if (windowId && !this.pausedWindows.has(windowId)) {
                    this.centerWindow(windowId);
                }
            }
        });
    }

    setViewport(x: number, y: number, width: number, height: number) {
        this.config.viewport = { x, y, width, height };
        this.recenterAll();
    }

    setViewportFromElement(element: HTMLElement) {
        const rect = element.getBoundingClientRect();
        this.setViewport(rect.left, rect.top, rect.width, rect.height);
    }

    addWindow(windowId: string, element: HTMLElement) {
        element.setAttribute("data-window-id", windowId);
        this.windowElements.set(windowId, element);
        this.resizeObserver?.observe(element);
        if (this.config.enabled) {
            this.centerWindow(windowId);
        }
    }

    removeWindow(windowId: string) {
        const element = this.windowElements.get(windowId);
        if (element) {
            this.resizeObserver?.unobserve(element);
            this.windowElements.delete(windowId);
            this.pausedWindows.delete(windowId);
        }
    }

    pauseCentering(windowId: string) {
        this.pausedWindows.add(windowId);
    }

    resumeCentering(windowId: string) {
        this.pausedWindows.delete(windowId);
        if (this.config.enabled) {
            this.centerWindow(windowId);
        }
    }

    isPaused(windowId: string): boolean {
        return this.pausedWindows.has(windowId);
    }

    setEnabled(enabled: boolean) {
        this.config.enabled = enabled;
        if (enabled) {
            this.recenterAll();
        }
    }

    isEnabled(): boolean {
        return this.config.enabled;
    }

    centerWindow(windowId: string) {
        const element = this.windowElements.get(windowId);
        if (!element) return;

        const windowWidth = element.offsetWidth;
        const windowHeight = element.offsetHeight;

        const centerX = this.config.viewport.x + (this.config.viewport.width - windowWidth) / 2;
        const centerY = this.config.viewport.y + (this.config.viewport.height - windowHeight) / 2;

        element.style.left = `${Math.round(centerX)}px`;
        element.style.top = `${Math.round(centerY)}px`;
    }

    private recenterAll() {
        if (!this.config.enabled) return;
        for (const windowId of this.windowElements.keys()) {
            if (!this.pausedWindows.has(windowId)) {
                this.centerWindow(windowId);
            }
        }
    }
}

const windowCenterManager = new WindowCenterManager();

const planteData: Plant[] = [
    {
        id: "0",
        posi: "top",
        items: [
            { id: "showAllView" },
            { id: "blank" },
            { id: "mediaControl" },
            { id: "tray" },
            { id: "blue" },
            { id: "network" },
            { id: "connect" },
            { id: "power" },
            { id: "volume" },
            { id: "ime" },
            { id: "login" },
            { id: "notifications" },
            { id: "clock" },
        ],
        glow: true,
    },
    {
        id: "1",
        posi: "bottom",
        items: [{ id: "startMenuFullScreen" }, { id: "apps" }],
        glow: false,
    },
];

const tools = new Tools();

// 全局记录当前鼠标坐标（与页面视口坐标系一致）
const mousePos = { x: 0, y: 0 } as { x: number; y: number };

/** 指针当前命中的客户端窗口；窗口关闭时据此立即清掉光标焦点 */
let pointerTarget: { handle: WinHandle; clientId: string } | undefined;

let viewAllShowing = false;

class trigger {
    private cbs: (() => undefined | true)[] = [];
    on(cb: () => undefined | true) {
        this.cbs.push(cb);
    }
    fire() {
        for (const cb of this.cbs) {
            const once = cb();
            if (once === true) break;
        }
    }
}

type StateMachineOnCallback<next extends string> = (op: {
    nextTrigger: (t: next) => void;
    leave: (cb: () => void) => void;
}) => void;

class stateMachine<T extends string, subT extends T> {
    private nowState: T | undefined;
    private onCallbacks = new Map<string, StateMachineOnCallback<T>>();
    private leaveFuns = new Map<T, () => void>();
    private x: Record<T, { next: { t?: trigger; n: subT }[] }>;

    constructor(x: typeof this.x) {
        this.x = x;

        for (const [k, v] of Object.entries(x) as [T, { next: { t?: trigger; n: T }[] }][]) {
            const hasT = new Set<trigger>();
            for (const n of v.next) {
                if (n.t && hasT.has(n.t)) {
                    console.error(`State ${k} has multiple transitions for the same trigger.`);
                } else {
                    if (n.t) hasT.add(n.t);
                }
            }
        }

        for (const [k, v] of Object.entries(x) as [T, { next: { t?: trigger; n: T }[] }][]) {
            for (const n of v.next) {
                if (n.t) {
                    n.t.on(() => {
                        if (this.nowState === k) {
                            this.setState(n.n);
                            return true;
                        }
                        return undefined;
                    });
                }
            }
        }
    }

    setState(s: T) {
        if (this.nowState === undefined || this.x[this.nowState].next.find((n) => n.n === s)) {
            const old = this.nowState;
            for (const [k, v] of this.leaveFuns)
                if (k !== s) {
                    v();
                    this.leaveFuns.delete(k);
                }
            this.onCallbacks.get(s)?.({
                nextTrigger: (x) => this.setState(x),
                leave: (cb) => {
                    this.leaveFuns.set(s, cb);
                },
            });
            if (this.x[s].next.length === 0) this.nowState = undefined;
            else this.nowState = s;
            console.log(`${s} ${old} -> ${this.nowState}`);
        } else {
            console.error(`Invalid state transition from ${this.nowState} to ${s}`);
        }
    }
    getState() {
        return this.nowState;
    }
    on(bindState: T, cb: StateMachineOnCallback<(typeof this.x)[T]["next"][number]["n"]>) {
        this.onCallbacks.set(bindState, cb);
    }
}

const dyj电源键 = new trigger();
const state = new stateMachine({
    normal: { next: [{ t: dyj电源键, n: "lock" }] },
    lock: { next: [{ n: "normal" }] },
});
const stateLock = new stateMachine({
    xipin: { next: [{ t: dyj电源键, n: "lock" }] },
    lock: {
        next: [{ t: dyj电源键, n: "xipin" }, { n: "passwd" }],
    },
    passwd: {
        next: [
            { n: "lock" },
            { n: "out" },
            {
                n: "passwd", // 用于输入密码时不断回到自己以延长定时器
            },
        ],
    },
    out: { next: [] },
});

/** 退出桌面（关闭桌面窗口，结束当前桌面进程）：Super+Shift+E 或 Ctrl+Alt+Delete */
const EXIT_BINDINGS: KeyBinding[] = [
    { code: "KeyE", meta: true, shift: true },
    { code: "Delete", ctrl: true, alt: true },
];

class Timer {
    private timerId: number | undefined;
    private onxcb: () => void = () => {};
    private delay = 0;
    end = true;
    constructor(delay: number) {
        this.delay = delay;
    }
    reset() {
        clearTimeout(this.timerId);
    }
    on(cb: () => void) {
        this.onxcb = cb;
    }
    start() {
        this.end = false;
        clearTimeout(this.timerId);
        this.timerId = window.setTimeout(() => {
            this.onxcb();
            this.end = true;
            clearTimeout(this.timerId);
        }, this.delay);
    }
}

function mouseMove(x: number, y: number) {
    // 更新全局鼠标坐标
    mousePos.x = x;
    mousePos.y = y;
    cursor.move(x, y);
    const target = sendPointerEvent("move", new PointerEvent("pointermove", { clientX: x, clientY: y }));
    // 指针移开surface或软件后恢复默认光标，重新进入时恢复对应客户端记忆的光标
    cursor.setSurfaceFocus(target?.clientId);
}

function cssVar(name: string) {
    return {
        getName() {
            return `var(--${name})`;
        },
        setValue(value: string) {
            setProperty(`--${name}`, value);
        },
    };
}

const viewWidth = cssVar("view-width");
const viewHeight = cssVar("view-height");

function newViewEl(v: { ox: number; oy: number }) {
    const id = `view-${v.ox}-${v.oy}`;
    if (windowViewMap.has(id)) {
        // biome-ignore lint/style/noNonNullAssertion: ---
        return windowViewMap.get(id)!;
    }
    const el = view()
        .style({
            left: `calc(${viewWidth.getName()} * ${v.ox})`,
            top: `calc(${viewHeight.getName()} * ${v.oy})`,
            width: "100%",
            height: "100%",
            position: "absolute",
        })
        .on("click", () => {
            if (viewAllShowing) {
                viewAllShowing = false;
                viewAll(false);
                setViewScorll({ x: v.ox, y: v.oy });
            }
        });
    windowEl.add(el);
    windowViewMap.set(id, el);
    return el;
}

function setViewScorll({ x, y }: { x: number; y: number }) {
    windowEl.style({
        left: `${-x * 100}%`,
        top: `${-y * 100}%`,
    });
}

/** 多窗口总览把所有窗口缩放到 VIEW_ALL_SCALE，关闭按钮反向放大以保持屏幕尺寸不变 */
const VIEW_ALL_SCALE = 0.25;

const windowCloseButtons = new Map<WinHandle, ElType<HTMLButtonElement>>();

/** 统一的窗口关闭按钮：白色圆底 + 叉号，压在任意窗口内容上都能看清 */
function createWindowCloseButton(op: { size: number; scale?: number; onClick: () => void }) {
    const btn = button(getIconXEl("cross", { size: Math.round(op.size * 0.55) })).style({
        width: `${op.size}px`,
        height: `${op.size}px`,
        padding: "0",
        border: "none",
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(255, 255, 255, 0.92)",
        boxShadow: "0 1px 4px #00000055",
        cursor: "pointer",
        zIndex: "10",
    });
    if (op.scale) {
        btn.style({ transform: `scale(${op.scale})`, transformOrigin: "top right" });
    }
    btn.on("click", (e) => {
        // 预览里父级点击是跳转窗口，总览里父级点击是退出总览
        e.stopPropagation();
        op.onClick();
    });
    return btn;
}

function viewAll(s: boolean) {
    windowElWarp.style({
        transition: "all 0.3s ease-in-out",
        transform: s ? `scale(${VIEW_ALL_SCALE})` : "none",
    });
    for (const btn of windowCloseButtons.values()) {
        btn.style({ display: s ? "flex" : "none" });
    }
}

function addWindow(v: View, el: HTMLElement, windowId?: string) {
    const pel = newViewEl(v);
    pel.add(el);
    setViewScorll({ x: v.ox, y: v.oy });

    pack(el).style({
        position: "absolute",
    });

    if (windowId) {
        windowCenterManager.addWindow(windowId, el);
    }
}

function jump2Win(winid: MWinId) {
    const v = viewData.getViewByWinId(winid);
    if (!v) return;
    setViewScorll({ x: v.ox, y: v.oy });
    viewData.focusWin(winid);
}

// ── 桌面自己的 DOM 窗口 ────────────────────────────────────────────────────────────────────────
// 设置窗口不是 Wayland 客户端，但仍然占用一个虚拟桌面、参与总览、聚焦和关闭，
// 与客户端窗口走同一套 ViewData / WindowCenterManager 逻辑。
const SETTINGS_WINDOW_ID = "internal:settings";

function openSettingsWindow() {
    if (viewAllShowing) {
        viewAllShowing = false;
        viewAll(false);
    }
    if (internalWindows.has(SETTINGS_WINDOW_ID)) {
        jump2Win(SETTINGS_WINDOW_ID);
        return;
    }

    const v = viewData.newView();
    viewData.moveWinToView(SETTINGS_WINDOW_ID, v);

    const root = view("y").data({ "internal-window": SETTINGS_WINDOW_ID }).style({
        position: "absolute",
        width: "760px",
        height: "540px",
        maxWidth: "calc(100vw - 24px)",
        maxHeight: "calc(100vh - 24px)",
        borderRadius: "18px",
        overflow: "hidden",
        background: "rgba(245, 245, 245, 0.97)",
        backdropFilter: "blur(18px)",
        boxShadow: "0 12px 40px #00000033",
        color: "#111",
        fontFamily: "sans-serif",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
    });

    const header = view("x")
        .style({
            height: "48px",
            alignItems: "center",
            gap: "10px",
            padding: "0 16px",
            flexShrink: "0",
            borderBottom: "1px solid #00000012",
            boxSizing: "border-box",
        })
        .add([
            getIconXEl("settings", { size: 18, width: 20, height: 20 }).el,
            txt("设置").style({ fontWeight: "600" }),
        ]);

    const settingsContent = createSettingsContent({
        getIconTheme: () => setting.get("icon.theme") || "breeze",
        setIconTheme: (theme) => setting.set("icon.theme", theme),
        getImePanelPreedit: () => (imeSetting.nget("panelPreedit") ?? "auto") as ImePanelPreeditMode,
        setImePanelPreedit: (mode) => imeSetting.nset("panelPreedit", mode),
        getCenterWindows: () => desktopSetting.nget("centerWindows") ?? true,
        setCenterWindows: (enabled) => {
            desktopSetting.nset("centerWindows", enabled);
            windowCenterManager.setEnabled(enabled);
        },
        getScale: () => screenManager.getScale(),
        setScale: (scale) => screenManager.setScale(scale),
        scaleFollowsHost: () => screenManager.scaleFollowsHost(),
        inputMethodAvailable: !!MSysApi.inputMethod,
        connectAvailable: !!myde.MConnect,
        getConnectEnabled,
        setConnectEnabled: (enabled) => {
            void setConnectEnabled(enabled);
        },
        getConnectId: () => connect.getId(),
        listConnectDevices,
        forgetConnectDevice,
        setConnectRemember: (targetId, remember) => connect.setRemember(targetId, remember),
        createConnectPairing,
        subscribeConnect,
        restartDesktop: async () => {
            const ok = await confirm("重启桌面会关闭所有窗口，继续？");
            if (ok) location.reload();
        },
        modalHost: root.el,
    });
    const content = settingsContent.el;

    const closeBtn = createWindowCloseButton({
        size: 24,
        onClick: () => closeSettingsWindow(),
    }).style({
        position: "absolute",
        top: "12px",
        right: "12px",
        zIndex: "20",
    });

    const setActive = (active: boolean) => {
        root.style({
            boxShadow: active ? "0 16px 48px #00000044" : "0 12px 40px #0000002a",
            outline: active ? "1px solid #00aaff88" : "1px solid transparent",
        });
    };
    setActive(false);

    root.add([header, content, closeBtn]);
    root.on("pointerdown", () => viewData.focusWin(SETTINGS_WINDOW_ID));

    // 标题栏拖动。拖动后暂停自动居中，避免父容器变化时把窗口拽回中间。
    header.on("pointerdown", (e) => {
        if ((e.target as HTMLElement).closest("button, input, select, textarea")) return;
        windowCenterManager.pauseCentering(SETTINGS_WINDOW_ID);
        const startX = e.clientX;
        const startY = e.clientY;
        const rect = root.el.getBoundingClientRect();
        const parentRect = root.el.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const origLeft = rect.left - parentRect.left;
        const origTop = rect.top - parentRect.top;

        function onPointerMove(ev: PointerEvent) {
            root.style({
                left: `${Math.round(ev.clientX - startX + origLeft)}px`,
                top: `${Math.round(ev.clientY - startY + origTop)}px`,
            });
        }
        function cleanup() {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", cleanup);
            window.removeEventListener("pointercancel", cleanup);
        }
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", cleanup, { once: true });
        window.addEventListener("pointercancel", cleanup, { once: true });
    });

    internalWindows.set(SETTINGS_WINDOW_ID, { el: root, view: v, setActive, dispose: settingsContent.dispose });
    addWindow(v, root.el, SETTINGS_WINDOW_ID);
    viewData.focusWin(SETTINGS_WINDOW_ID);
}

function closeSettingsWindow() {
    const entry = internalWindows.get(SETTINGS_WINDOW_ID);
    if (!entry) return;
    if (viewData.focusHandle === SETTINGS_WINDOW_ID) viewData.blurAll();
    internalWindows.delete(SETTINGS_WINDOW_ID);
    viewData.closeWin(SETTINGS_WINDOW_ID);
    windowCenterManager.removeWindow(SETTINGS_WINDOW_ID);
    entry.dispose?.();
    entry.el.remove();
}

function appLauncher(iconPath: () => Promise<string>, name: string, exec: string) {
    const p = appIconEl(exec);
    loadAppIcon(p, iconPath, name);
    return p;
}

/** 只创建应用图标容器，图标由调用方在需要时再加载 */
function appIconEl(exec?: string) {
    const p = view().style({
        width: "48px",
        height: "48px",
        borderRadius: "12px",
        padding: "6px",
        overflow: "hidden",
        background: "#ffffff",
        flexShrink: 0,
    });
    if (exec !== undefined) {
        p.on("click", async () => {
            console.log("exec", exec);
            await server.startXwayland();
            server.runApp(exec);
        });
    }
    return p;
}

const rasterizedIconCache = new Map<string, Promise<string>>();

/**
 * 把 SVG 图标提前画成位图。
 * 直接使用 SVG 时，每次滚动进视口或缩放都要重新光栅化，复杂图标会明显掉帧。
 */
function rasterizeIcon(url: string, size: number): Promise<string> {
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const pixel = Math.max(1, Math.round(size * dpr));
    const cacheKey = `${url}:${pixel}`;
    const cached = rasterizedIconCache.get(cacheKey);
    if (cached) return cached;

    const task = (async () => {
        try {
            const blob = await (await fetch(url)).blob();
            if (blob.type !== "image/svg+xml" && !url.startsWith("data:image/svg+xml")) {
                return url;
            }
            const img = new Image();
            img.decoding = "async";
            img.src = url;
            await img.decode();

            const canvas = document.createElement("canvas");
            canvas.width = pixel;
            canvas.height = pixel;
            const ctx = canvas.getContext("2d");
            if (!ctx) return url;

            // 与原 object-fit: cover 一致，保持比例并裁掉多余部分
            const iw = img.naturalWidth || pixel;
            const ih = img.naturalHeight || pixel;
            const scale = Math.max(pixel / iw, pixel / ih);
            const w = iw * scale;
            const h = ih * scale;
            ctx.drawImage(img, (pixel - w) / 2, (pixel - h) / 2, w, h);

            // toDataURL 同步完成，比 canvas.toBlob（隐藏/后台窗口下可能等约 1s）稳定得多
            return canvas.toDataURL("image/png");
        } catch {
            return url;
        }
    })();
    rasterizedIconCache.set(cacheKey, task);
    return task;
}

function loadAppIcon(
    p: ReturnType<typeof appIconEl>,
    iconPath: () => Promise<string>,
    name: string,
    op?: { rasterSize?: number },
) {
    return iconPath()
        .then(async (iconPath) => {
            if (!iconPath) return;
            const src = op?.rasterSize === undefined ? iconPath : await rasterizeIcon(iconPath, op.rasterSize);
            image(src, name)
                .attr({ loading: "lazy", decoding: "async", draggable: false })
                .style({
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                })
                .addInto(p);
        })
        .catch(() => {});
}

function internalWindowUnderPoint(x: number, y: number) {
    const target = document.elementFromPoint(x, y) as HTMLElement | null;
    return target?.closest<HTMLElement>("[data-internal-window]") ?? undefined;
}

function sendPointerEvent(
    type: "move" | "down" | "up",
    p: PointerEvent,
): { handle: WinHandle; clientId: string } | undefined {
    if (viewAllShowing) {
        pointerTarget = undefined;
        return undefined;
    }
    // 桌面自己的 DOM 窗口盖在客户端窗口上时，指针事件只交给 DOM，不再转发给 Wayland
    if (internalWindowUnderPoint(p.x, p.y)) {
        pointerTarget = undefined;
        return undefined;
    }
    let hit: { handle: WinHandle; clientId: string } | undefined;
    const handled = new Set<string>();
    for (const info of server.server.windows.list()) {
        // 每个客户端只处理第一个命中的窗口
        if (handled.has(info.clientId)) continue;
        const rect = render.getXdgSurfaceEle(info.renderId)?.getBoundingClientRect();
        if (!rect) continue;
        // DOM 是桌面物理 px；Wayland 坐标是 surface-local 逻辑 px
        const scale = info.scale || 1;
        const nx = (p.x - rect.left) / scale;
        const ny = (p.y - rect.top) / scale;
        // 交给 wayland 的完整几何命中检测：popup 超出顶层窗口范围时也能命中
        // todo 指针离开窗口时下发 wl_pointer.leave（待 server 提供），见 xdg 域 hitTest 的未命中分支
        if (!server.server.windows.hitTest(info.handle, { x: nx, y: ny })) continue;
        handled.add(info.clientId);
        hit ??= { handle: info.handle, clientId: info.clientId };

        const ev = { type, x: nx, y: ny, button: p.button };
        server.server.notify("input.pointer", info.handle, ev);
        // Firefox 的地址栏/select 弹层会给 seat0 的 pointer 留下未释放的 grab：
        // 弹层关闭后 seat0 的 motion 不再更新光标，但同一客户端的 seat1 pointer 不受影响。
        // Firefox 会把两把 seat 上完全相同的按下/抬起去重（实测一次点击只触发一次），
        // 所以这里把 move/down/up 都镜像到 seat1，作为 Firefox Wayland 的兼容回退。
        // 其它客户端（GTK 也绑两把 seat）不镜像，避免真的双击；远程会话活跃时也不镜像，
        // 把 seat1 留给远程光标。
        if (/firefox/i.test(info.appid) && connect.getActiveConnections().length === 0) {
            server.server.notify("input.pointer", info.handle, ev, "seat1");
        }
        if (type === "down") {
            viewData.focusWin(info.handle);
            ime?.pointerDown();
            for (const other of server.server.windows.list()) {
                if (other.clientId === info.clientId && other.handle !== info.handle) {
                    server.server.notify("window.blur", other.handle);
                }
            }
        }
    }
    pointerTarget = hit;
    return hit;
}

function sendScrollEvent(p: WheelEvent) {
    if (viewAllShowing) return;
    if (internalWindowUnderPoint(p.x, p.y)) return;
    const handled = new Set<string>();
    for (const info of server.server.windows.list()) {
        if (handled.has(info.clientId)) continue;
        const rootEl = render.getXdgSurfaceEle(info.renderId);
        if (!rootEl) continue;
        const rect = rootEl.getBoundingClientRect();
        const scale = info.scale || 1;
        const nx = (p.x - rect.left) / scale;
        const ny = (p.y - rect.top) / scale;
        if (!server.server.windows.hitTest(info.handle, { x: nx, y: ny })) continue;
        handled.add(info.clientId);

        // wl_pointer.axis 的单位是 surface-local，桌面滚轮的 CSS px 要除回逻辑
        server.server.notify("input.scroll", info.handle, {
            deltaX: p.deltaX / scale,
            deltaY: p.deltaY / scale,
            deltaZ: p.deltaZ / scale,
        });
    }
}

function fitRect(rect: { w: number; h: number }, maxW: number, maxH: number) {
    const w1 = maxW;
    const h1 = maxW * (rect.h / rect.w);
    if (h1 <= maxH) {
        return { w: w1, h: Math.floor(h1) };
    }
    const h2 = maxH;
    const w2 = maxH * (rect.w / rect.h);
    return { w: Math.floor(w2), h: h2 };
}

const setting = MSetting.init({
    version: "0.0.1",
    defaultNsSetting: {},
});

const desktopSetting = MSetting.init({
    version: "0.0.1",
    nameSpace: "desktop",
    defaultNsSetting: {
        centerWindows: true,
        scale: 1,
    },
});

windowCenterManager.setEnabled(desktopSetting.nget("centerWindows"));

const connectSetting = MSetting.init({
    version: "0.0.1",
    nameSpace: "connect",
    defaultNsSetting: {
        enabled: true,
    },
});

const connect = myde.MConnect();
let connectInited = false;

function getConnectEnabled() {
    return connectSetting.nget("enabled") ?? true;
}

// @ts-expect-error
window.dy = () => dyj电源键.fire();

const render = new MUtils.renderToolsHtmlEl();
render.on({
    onToplevelRemove: (wid) => {
        const el = render.getXdgSurfaceEle(wid);
        if (el) {
            el.remove();
        }
    },
});
const server = MSysApi.server({ render });
// 提前启动 xwayland-satellite；每次启动应用前再 await 一次，崩溃后也能重新拉起。
void server.startXwayland();

/** 屏幕信息 + 客户端缩放；缩放写入设置并同步给 wayland server。 */
const screenManager = new ScreenManager({
    display: MSysApi.display,
    getScaleSetting: () => {
        const value = desktopSetting.nget("scale");
        return typeof value === "number" ? value : 1;
    },
    setScaleSetting: (scale) => desktopSetting.nset("scale", scale),
    applyOutput: (output) => server.server.outputs.set(output),
    onScaleChanged: () => {
        // server 已更新窗口 DOM 尺寸；最大化窗口要用新的逻辑可用区重新 configure
        requestAnimationFrame(() => {
            for (const info of server.server.windows.list()) {
                if (!info.states.maximized) continue;
                const scale = screenManager.getScale();
                server.server.notify("window.maximize", info.handle, {
                    width: Math.max(1, Math.floor(windowEl.el.offsetWidth / scale)),
                    height: Math.max(1, Math.floor(windowEl.el.offsetHeight / scale)),
                });
            }
        });
    },
});
void screenManager.init().catch((e) => console.error("[screen] 初始化失败", e));

// 桌面可用空间（surface-local 逻辑尺寸）
server.server.respond("surfaceBounds.request", () => {
    const rect = windowEl.el.getBoundingClientRect();
    const scale = screenManager.getScale();
    return { width: rect.width / scale, height: rect.height / scale };
});

server.server.on("client.opened", (clientId) => {
    server.server.clients.get(clientId)?.setLogConfig({ receive: [], send: [] });
});
server.server.on("client.closed", (clientId) => {
    cursor.forgetClient(clientId);
});

/**
 * 桌面已应用的窗口状态。`window.changed` 是合并事件（rect/states/title/appid 任一变化），
 * 靠这份本地快照差分出「客户端请求 resize / maximize」。
 */
const appliedState = new Map<WinHandle, { w: number; h: number; maximized: boolean; scale: number }>();

server.server.on("window.created", (info) => {
    console.log(`Client ${info.clientId} created window ${info.handle}`, info.renderId);
    const wid = info.handle;
    appliedState.set(wid, { w: info.rect.w, h: info.rect.h, maximized: false, scale: info.scale });

    const v = viewData.newView();
    viewData.moveWinToView(wid, v);
    // biome-ignore lint/style/noNonNullAssertion: 刚刚创建的，一定有
    const winEl = render.getXdgSurfaceEle(info.renderId)!;
    pack(winEl).style({
        width: `${info.rect.w * info.scale}px`,
        height: `${info.rect.h * info.scale}px`,
    });
    const closeBtn = createWindowCloseButton({
        size: 24 * info.scale,
        scale: 1 / VIEW_ALL_SCALE,
        onClick: () => server.server.notify("window.close", wid),
    }).style({
        position: "absolute",
        top: `${4 * info.scale}px`,
        right: `${4 * info.scale}px`,
        display: viewAllShowing ? "flex" : "none",
    });
    closeBtn.addInto(winEl);
    windowCloseButtons.set(wid, closeBtn);
    addWindow(v, winEl, wid);
    viewData.focusWin(wid);
    server.server.notify("window.setBox", wid, { width: 800, height: 600 });
});

server.server.on("window.closed", (wid) => {
    console.log(`window ${wid} closed`);
    appliedState.delete(wid);
    windowCloseButtons.delete(wid);
    if (viewData.focusHandle === wid) viewData.blurAll();
    viewData.closeWin(wid);
    // 指针还停在刚关闭的窗口上时，立刻回到默认光标；
    // 否则客户端退出流程补发的 hidden 会把光标留成空白
    if (pointerTarget?.handle === wid) {
        pointerTarget = undefined;
        cursor.setSurfaceFocus(undefined);
    }
});

server.server.on("window.startMove", (wid) => {
    const info = server.server.windows.get(wid);
    if (!info) return;

    const winEl = render.getXdgSurfaceEle(info.renderId);
    if (!winEl) return;
    const rect = winEl.getBoundingClientRect();

    windowCenterManager.pauseCentering(wid);

    const startX = mousePos.x;
    const startY = mousePos.y;

    const parentRect = winEl.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const origLeft = rect.left - parentRect.left;
    const origTop = rect.top - parentRect.top;

    function onPointerMove() {
        const newLeft = Math.round(mousePos.x - startX + origLeft);
        const newTop = Math.round(mousePos.y - startY + origTop);
        if (!winEl) return;
        winEl.style.left = `${newLeft}px`;
        winEl.style.top = `${newTop}px`;
    }

    function cleanup() {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
    }

    function onPointerUp() {
        cleanup();
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerUp, { once: true });
});

server.server.on("window.changed", (info) => {
    const applied = appliedState.get(info.handle);
    if (!applied) return;
    const winEl = render.getXdgSurfaceEle(info.renderId);

    // 尺寸变化（来自 xdg_surface.set_window_geometry）或输出缩放变化
    if (applied.w !== info.rect.w || applied.h !== info.rect.h || applied.scale !== info.scale) {
        applied.w = info.rect.w;
        applied.h = info.rect.h;
        applied.scale = info.scale;
        if (winEl) {
            pack(winEl).style({
                width: `${info.rect.w * info.scale}px`,
                height: `${info.rect.h * info.scale}px`,
            });
            if (windowCenterManager.isEnabled() && !windowCenterManager.isPaused(info.handle)) {
                windowCenterManager.centerWindow(info.handle);
            }
        }
    }

    // 最大化状态变化（由客户端发起）
    if (applied.maximized !== info.states.maximized) {
        applied.maximized = info.states.maximized;
        if (!winEl) return;
        if (info.states.maximized) {
            const widthPx = windowEl.el.offsetWidth;
            const heightPx = windowEl.el.offsetHeight;
            pack(winEl).style({
                width: `${widthPx}px`,
                height: `${heightPx}px`,
                left: "0px",
                top: "0px",
            });
            server.server.notify("window.maximize", info.handle, {
                width: Math.max(1, Math.floor(widthPx / info.scale)),
                height: Math.max(1, Math.floor(heightPx / info.scale)),
            });
        } else {
            // 恢复尺寸是 surface 逻辑尺寸；DOM 按输出缩放放大
            const width = 800;
            const height = 600;
            pack(winEl).style({
                width: `${width * info.scale}px`,
                height: `${height * info.scale}px`,
                left: "0px",
                top: "0px",
            });
            server.server.notify("window.unmaximize", info.handle, { width, height });
        }
    }
});

// 断开时 server 统一补发该客户端全部窗口的 window.closed，上面的 closeWin 已经覆盖

// 桌面根节点固定铺满视口并裁剪溢出：整个桌面不能被滚轮/内容撑出滚动
const mainEl = view()
    .style({
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: "hidden",
        fontFamily: "sans-serif",
    })
    .addInto();

const bg = image(fs.readFileAsDataURLSync("/assets/wallpaper/1.svg"), "wallpaper").style({
    width: "100%",
    height: "100%",
    objectFit: "cover",
});

const windowElWarp = view().style({
    position: "absolute",
});

const toolsEl = view()
    .style({ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" })
    .class(
        addClass(
            { pointerEvents: "none" },
            {
                "&>*": {
                    pointerEvents: "auto",
                },
            },
        ),
    );
tools.setTipEl(toolsEl.el);

const lockScreen = view().class(
    addClass(
        {
            background: "white",
            width: "100vw",
            height: "100vh",
            position: "fixed",
            top: "0",
            left: "0",
        },
        {
            "&>*": {
                position: "absolute",
                top: 0,
            },
        },
    ),
);

const lockScreenView = view().style({ width: "100%", height: "100%" }).addInto(lockScreen); // 图片 信息等
const lockScreenPassword = view().style({ width: "100%", height: "100%" }).addInto(lockScreen);

function xPosition(x: number, y: number) {
    return {
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        transform: `translate(-${x * 100}%, -${y * 100}%)`,
    };
}

const lockScreenAnimate = new AnimationGear({
    viewShow: 0,
    passwordShow: 0,
});

lockScreenAnimate.addState(
    "normal(out)",
    {
        viewShow: 0,
        passwordShow: 0,
    },
    [],
);

lockScreenAnimate.addState(
    "lockview",
    {
        viewShow: 1,
        passwordShow: 0,
    },
    [],
);
lockScreenAnimate.addState(
    "password",
    {
        viewShow: 1,
        passwordShow: 1,
    },
    [],
);
lockScreenAnimate.addState(
    "xipin",
    {
        viewShow: 2,
        passwordShow: 0,
    },
    [],
);
lockScreenAnimate.setUpdateCallback((v) => {
    lockScreen.style({ transform: `translateY(${(1 - Math.min(1, v.viewShow)) * -100}%)` });
    lockScreenPassword.style({
        opacity: v.passwordShow,
        pointerEvents: v.passwordShow === 1 ? "auto" : "none",
    });

    if (v.viewShow > 1) {
        lockScreen.style({
            background: "rgb(0,0,0)",
        });
        lockScreenView.style({ opacity: 1 - (v.viewShow - 1) });
    } else {
        lockScreen.style({
            background: "white",
        });
        lockScreenView.style({ opacity: 1 });
    }
});

state.on("normal", () => {
    lockScreenAnimate.moveTo("normal(out)");
    void ime?.resume();
});
state.on("lock", () => {
    stateLock.setState("lock");
    void ime?.blur();
});
state.setState("normal");

stateLock.on("xipin", ({ nextTrigger, leave }) => {
    // 息屏动画结束后再关 DPMS；动画被输入打断时不会执行
    lockScreenAnimate.moveTo("xipin", undefined, () => {
        void setScreenOff(true);
    });
    const onClick = () => nextTrigger("lock");
    lockScreen.el.addEventListener("click", onClick, { once: true });
    leave(() => {
        lockScreen.el.removeEventListener("click", onClick);
    });
});

const lock2xipinTimer = new Timer(30000);
lock2xipinTimer.on(() => {
    stateLock.setState("xipin");
});
stateLock.on("lock", ({ nextTrigger, leave }) => {
    lockScreenAnimate.moveTo("lockview");
    void setScreenOff(false);
    lockScreen.on("click", () => nextTrigger("passwd"), { once: true });
    lock2xipinTimer.start();
    leave(() => {
        lock2xipinTimer.reset();
    });
});
const passwd2lock = new Timer(3000);
passwd2lock.on(() => {
    stateLock.setState("lock");
});
stateLock.on("passwd", ({ leave }) => {
    lockScreenAnimate.moveTo("password");
    passwd2lock.start();
    leave(() => {
        passwd2lock.reset();
    });
});
stateLock.on("out", () => {
    state.setState("normal");
});

stateLock.setState("out");

/** 合盖：未锁屏先锁屏，锁屏界面已显示时直接息屏（与电源键的两段操作一致） */
function handleLidClosed() {
    if (state.getState() === "normal") state.setState("lock");
    if (stateLock.getState() === "passwd") stateLock.setState("lock");
    if (stateLock.getState() === "lock") stateLock.setState("xipin");
}

/** 开盖：合盖息屏后回到锁屏界面，不直接返回桌面 */
function handleLidOpened() {
    if (stateLock.getState() === "xipin") stateLock.setState("lock");
}

// 关屏：先铺一层黑色并等它真正上屏，再让 wrap 关 DPMS；
// 任意输入到来时先开屏并吞掉这次输入。
const screenOffLayer = view().style({
    position: "fixed",
    top: 0,
    left: 0,
    width: "100vw",
    height: "100vh",
    background: "#000",
    display: "none",
    pointerEvents: "none",
    zIndex: 9999,
});

type ScreenOffState = "on" | "requested" | "off";
let screenOffState: ScreenOffState = "on";
let screenOffSeq = 0;
let screenOffQueue: Promise<void> = Promise.resolve();

function nextPaint(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
}

/** 关屏/开屏：请求串行发送，避免同一个 ScreenPower 响应互相覆盖 */
function setScreenOff(off: boolean): Promise<void> {
    if (off) {
        if (screenOffState !== "on") return screenOffQueue;
        if (!MSysApi.display.supports("screen-power")) return screenOffQueue;
        screenOffState = "requested";
    } else {
        if (screenOffState === "on") return screenOffQueue;
        // 立即取消黑层，输入不需要等 socket 往返
        screenOffState = "on";
        screenOffLayer.style({ display: "none" });
    }

    const seq = ++screenOffSeq;
    const apply = async () => {
        if (off) {
            if (seq !== screenOffSeq) return; // 排队期间已被输入唤醒
            screenOffLayer.style({ display: "block" });
            await nextPaint();
            // 给 Chromium 一点时间把黑色提交给 wrap
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (seq !== screenOffSeq) return; // 等待期间已被输入唤醒
            try {
                const result = await MSysApi.display.setScreenPower(false);
                if (seq !== screenOffSeq) return; // 关屏请求在途时被唤醒，后面排队的开屏会处理
                if (result.screens.length === 0) throw new Error("wrap 未接受关屏");
                screenOffState = "off";
            } catch (e) {
                console.warn("[screen] 关屏失败:", e);
                screenOffState = "on";
                screenOffLayer.style({ display: "none" });
            }
        } else {
            try {
                await MSysApi.display.setScreenPower(true);
            } catch (e) {
                console.warn("[screen] 开屏失败:", e);
            }
        }
    };
    screenOffQueue = screenOffQueue.then(apply, apply);
    return screenOffQueue;
}

const cursorEl = view();
// 候选窗覆盖层：在窗口/工具栏之上、锁屏和光标之下
const imeOverlay = view().style({
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
});

mainEl.add([bg, windowElWarp, toolsEl, imeOverlay, lockScreen, cursorEl, screenOffLayer]);

const windowEl = view()
    .style({
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        transition: "0.4s",
    })
    .addInto(windowElWarp);
const windowViewMap = new Map<string, ElType<HTMLElement>>();

const ob = new ResizeObserver((e) => {
    for (const entry of e) {
        const rect = entry.contentRect;
        viewWidth.setValue(`${rect.width}px`);
        viewHeight.setValue(`${rect.height}px`);
        windowCenterManager.setViewport(0, 0, rect.width, rect.height);
    }
});

ob.observe(windowEl.el);

// ── 输入法 ──────────────────────────────────────────────────────────────────────────────────────
// 桌面作为 fcitx5 的输入上下文：按键先经过这里，再决定交给输入法还是转发给聚焦窗口。
// 客户端没有 text-input 时不拦截（按键仍走原路径）。
const imeSetting = MSetting.init({
    version: "0.0.1",
    nameSpace: "ime",
    defaultNsSetting: {
        toggle: DEFAULT_IME_BINDINGS.toggle,
        nextIM: DEFAULT_IME_BINDINGS.nextIM,
        prevIM: DEFAULT_IME_BINDINGS.prevIM,
        panelPreedit: "auto",
    },
});

ime = new ImeController({
    im: MSysApi.inputMethod,
    overlay: imeOverlay.el,
    isNormal: () => state.getState() === "normal",
    getFocus: () => viewData.getWaylandFocus(),
    sendKey: (handle, code, type) => server.server.notify("input.key", handle, code, type),
    sendText: (handle, text, preedit) => server.server.notify("input.text", handle, text, preedit),
    queryTextInput: (handle) => server.server.request("textInput.get", handle),
    windowFrame: (handle) => {
        const info = server.server.windows.get(handle);
        if (!info) return undefined;
        const el = render.getXdgSurfaceEle(info.renderId);
        if (!el) return undefined;
        const rect = el.getBoundingClientRect();
        return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            scale: info.rect.w > 0 ? rect.width / info.rect.w : 1,
            offsetX: info.rect.x,
            offsetY: info.rect.y,
        };
    },
    getPointer: () => mousePos,
    getPanelPreedit: () => {
        const mode = imeSetting.nget("panelPreedit");
        return mode === "always" || mode === "never" ? mode : "auto";
    },
    getBindings: () => ({
        toggle: imeSetting.nget("toggle"),
        nextIM: imeSetting.nget("nextIM"),
        prevIM: imeSetting.nget("prevIM"),
    }),
});
void ime.init();

const initRect = windowEl.el.getBoundingClientRect();
windowCenterManager.setViewport(0, 0, initRect.width, initRect.height);

async function confirm(text: string) {
    const p = Promise.withResolvers<boolean>();
    const el = view().style({
        background: "rgba(255, 255, 255, 0.6)",
        borderRadius: "14px",
        padding: "14px",
        backdropFilter: "blur(10px)",
        position: "absolute",
        left: "50%",
        transform: "translateX(-50%)",
        minWidth: "100px",
    });
    el.add(view().add(text));
    el.add(
        view("x")
            .style({ width: "100%" })
            .add([
                button("是")
                    .style({ textAlign: "center", flex: 1 })
                    .on("click", () => {
                        p.resolve(true);
                        gear.moveTo("hide");
                    }),
                button("否")
                    .style({ textAlign: "center", flex: 1 })
                    .on("click", () => {
                        p.resolve(false);
                        gear.moveTo("hide");
                    }),
            ]),
    );
    const gear = new AnimationGear({ v: 0 }, { transition: { duration: 200, map: timingFunction.easeOut } });
    gear.addState("show", { v: 1 }, ["hide"]);
    gear.addState("hide", { v: 0 }, ["show"]);
    gear.moveTo("hide", 0);
    gear.moveTo("show");

    gear.setUpdateCallback((v) => {
        if (v.v === 0) {
            el.remove();
        } else {
            toolsEl.add(el);
            el.style({ top: "40%", opacity: `${v.v}` });
        }
    });

    return p.promise;
}

// 全局 Registry 实例

// 硬件
const rawRegistry = new Registry<RegistrySchema>();
// 桌面注册，如桌面自定义通知
const _desktopRegistry = new Registry();
// 聚合硬件和桌面注册，广播出去，接收其他广播
// 事件中枢，可以被脚本、ai控制
const _hubRegistry = new Registry<RegistrySchema>();
// 预留：桌面注册与事件中枢尚未接线，void 引用以满足 noUnusedLocals
void _desktopRegistry;
void _hubRegistry;

function updateConnectRegistry() {
    rawRegistry.setData("connect.id", connect.getId());
    const devices = connect
        .getConnections()
        .filter((device) => device.remembered || device.connected)
        .sort((a, b) => Number(b.connected) - Number(a.connected) || a.targetId.localeCompare(b.targetId));
    const ids: id<"connect.devices[]">[] = [];
    for (const device of devices) {
        const key = `connect.devices.${device.targetId}` as "connect.devices[]";
        rawRegistry.setData(key, {
            id: device.targetId,
            name: device.remoteDeviceName === "unknown" ? device.targetId : device.remoteDeviceName,
            connected: device.connected,
            remembered: device.remembered,
        });
        ids.push(key as id<"connect.devices[]">);
    }
    rawRegistry.setData("connect.devices", ids);
}

function subscribeConnect(callback: () => void) {
    const unsubs = [
        connect.on("connection-added", callback),
        connect.on("connection-removed", callback),
        connect.on("connection-changed", callback),
        connect.on("connected", callback),
        connect.on("disconnected", callback),
        connect.on("id-changed", callback),
    ];
    return () => {
        for (const unsubscribe of unsubs) unsubscribe();
    };
}

async function setConnectEnabled(enabled: boolean) {
    connectSetting.nset("enabled", enabled);
    rawRegistry.setData("connect.enabled", enabled);
    if (enabled) {
        try {
            if (!connectInited) {
                await connect.init();
                connectInited = true;
            }
            for (const device of connect.getSavedConnections()) {
                void connect.connect(device.targetId).catch((error) => {
                    console.warn("connect: auto connect failed", device.targetId, error);
                });
            }
        } catch (error) {
            console.error("connect init error", error);
        }
    } else {
        for (const device of connect.getActiveConnections()) {
            await connect.disconnect(device.targetId);
        }
    }
    updateConnectRegistry();
}

function forgetConnectDevice(targetId: string) {
    connect.removeConnection(targetId);
    updateConnectRegistry();
}

function listConnectDevices(): ConnectConnection[] {
    return connect.getConnections();
}

function createConnectPairing() {
    return connect.startPairing();
}

function updateTime() {
    const now = new Date();
    rawRegistry.setData("time.second", now.getSeconds());
    rawRegistry.setData("time.minute", now.getMinutes());
    rawRegistry.setData("time.hour", now.getHours());
    rawRegistry.setData("time.day", now.getDate());
    rawRegistry.setData("time.month", now.getMonth() + 1);
    rawRegistry.setData("time.weekday", now.getDay());
    rawRegistry.setData("time.year", now.getFullYear());
}
updateTime();
setInterval(updateTime, 6000);

MSysApi.power
    .init()
    .then(async () => {
        const power = MSysApi.power;
        const registry = rawRegistry;

        const updateBattery = async () => {
            let batteryPercentage = 0;
            for (const device of power.getDevices()) {
                if (
                    (await device.getPowerSupply()) &&
                    ((await device.getType()) === "Battery" || (await device.getType()) === "Ups")
                ) {
                    batteryPercentage = await device.getPercentage();
                    break;
                }
            }
            registry.setData("power.battery", batteryPercentage);
        };

        const updateDeviceList = () => {
            registry.setData(
                "power.devices",
                power.getDevices().map((device) => `power.devices.${device.path}` as id<"power.devices[]">),
            );
        };

        const updateDevice = async (device: powerDevice) => {
            const name = (await device.getModel()) || "Unknown";
            const percentage = await device.getPercentage();
            const status = await device.getState();

            const id = `power.devices.${device.path}` as "power.devices[]";
            registry.setData(id, { name, percentage, status });
        };

        const watchDevice = (device: powerDevice) => {
            device.on("changed", async () => {
                await updateDevice(device);
                await updateBattery();
            });
        };

        power.on("device-added", async (device) => {
            watchDevice(device);
            updateDeviceList();
            await updateDevice(device);
            await updateBattery();
        });
        power.on("device-removed", async () => {
            updateDeviceList();
            await updateBattery();
        });

        updateDeviceList();
        for (const device of power.getDevices()) {
            watchDevice(device);
            await updateDevice(device);
        }
        await updateBattery();
    })
    .catch((e) => console.error("power init error", e));

MSysApi.lid
    .init()
    .then(() => {
        console.log("[lid] ready, closed =", MSysApi.lid.isClosed());
        const updateLid = (closed: boolean) => {
            rawRegistry.setData("power.lidClosed", closed);
            if (closed) handleLidClosed();
            else handleLidOpened();
        };
        updateLid(MSysApi.lid.isClosed());
        MSysApi.lid.on("changed", updateLid);
    })
    .catch((e) => console.warn("[lid] init error", e));

MSysApi.network
    .init()
    .then(async () => {
        const network = MSysApi.network;
        const registry = rawRegistry;

        const updateAccessPoints = async () => {
            const wifiDevice = network.getWifiDevices()[0];
            if (!wifiDevice) {
                registry.setData("wifi.accessPoints", []);
                return;
            }

            const [aps, active] = await Promise.all([wifiDevice.getAccessPoints(), network.getActiveWifiConnection()]);
            const connectedSsid = active?.id;
            const ids: string[] = [];
            const seen = new Set<string>();

            for (const ap of aps) {
                const ssid = await ap.getSsid();
                if (!ssid || seen.has(ssid)) continue;
                seen.add(ssid);
                ids.push(ssid);
                registry.setData(`wifi.accessPoints.${ssid}` as "wifi.accessPoints[]", {
                    ssid,
                    connected: ssid === connectedSsid,
                });
            }

            if (connectedSsid && !seen.has(connectedSsid)) {
                registry.setData(`wifi.accessPoints.${connectedSsid}` as "wifi.accessPoints[]", {
                    ssid: connectedSsid,
                    connected: true,
                });
            }

            registry.setData(
                "wifi.accessPoints",
                (connectedSsid ? [connectedSsid, ...ids.filter((id) => id !== connectedSsid)] : ids).map(
                    (id) => `wifi.accessPoints.${id}` as id<"wifi.accessPoints[]">,
                ),
            );
        };

        const watchDevice = (device: wifiDevice) => {
            device.on("changed", () => {
                void updateAccessPoints();
            });
            device.on("access-point-added", () => {
                void updateAccessPoints();
            });
            device.on("access-point-removed", () => {
                void updateAccessPoints();
            });
        };

        registry.setData("wifi.enabled", await network.isWirelessEnabled());
        registry.setSetCallback("wifi.enabled", (v) => network.setWirelessEnabled(v));

        network.on("changed", (changed) => {
            if ("WirelessEnabled" in changed) {
                registry.setData("wifi.enabled", Boolean(changed.WirelessEnabled));
            }
            void updateAccessPoints();
        });
        network.on("device-added", (device) => {
            watchDevice(device);
            void updateAccessPoints();
        });
        network.on("device-removed", () => {
            void updateAccessPoints();
        });

        for (const device of network.getWifiDevices()) {
            watchDevice(device);
        }
        await updateAccessPoints();
    })
    .catch((e) => console.error("network init error", e));

rawRegistry.setData("connect.enabled", getConnectEnabled());
rawRegistry.setSetCallback("connect.enabled", async (enabled) => {
    await setConnectEnabled(enabled);
});
updateConnectRegistry();
void subscribeConnect(updateConnectRegistry);
if (getConnectEnabled()) {
    void setConnectEnabled(true);
}

MSysApi.blue
    .init()
    .then(async () => {
        const blue = MSysApi.blue;
        const registry = rawRegistry;

        const updateDevice = async (device: blueDevice) => {
            const address = await device.getAddress();
            registry.setData(`blue.devices.${address}` as "blue.devices[]", {
                name: await device.getName(),
                connected: await device.isConnected(),
            });
        };

        const updateDevices = async () => {
            const connected: string[] = [];
            const other: string[] = [];
            for (const device of blue.getDevices()) {
                await updateDevice(device);
                if (!(await device.isTrusted())) continue;
                const address = await device.getAddress();
                if (await device.isConnected()) connected.push(address);
                else other.push(address);
            }
            registry.setData(
                "blue.devices",
                connected.concat(other).map((i) => `blue.devices.${i}` as id<"blue.devices[]">),
            );
        };

        const watchDevice = (device: blueDevice) => {
            device.on("changed", () => {
                void updateDevices();
            });
        };

        registry.setData("blue.power", await blue.isPowered());
        registry.setSetCallback("blue.power", (v) => blue.setPowered(v));

        blue.on("adapter-changed", (changed) => {
            if ("Powered" in changed) {
                registry.setData("blue.power", Boolean(changed.Powered));
            }
        });
        blue.on("device-added", (device) => {
            watchDevice(device);
            void updateDevices();
        });
        blue.on("device-removed", () => {
            void updateDevices();
        });

        for (const device of blue.getDevices()) {
            watchDevice(device);
        }
        await updateDevices();
    })
    .catch((e) => console.error("blue init error", e));

const notifications = new Map<string, { title: string; content: string; id: string }>();

MSysApi.notification
    .init()
    .then(() => {
        const registry = rawRegistry;
        const notification = MSysApi.notification;

        const removeNotification = (id: number) => {
            if (!notifications.delete(String(id))) return;
            registry.setData("notification.list", Array.from(notifications.keys()) as id<"notification.list[]">[]);
        };

        notification.on("new", (n) => {
            const id = String(n.id);
            notifications.set(id, { content: n.body, title: n.summary, id });

            registry.setData("notification.list", Array.from(notifications.keys()) as id<"notification.list[]">[]);

            registry.setData(`notification.list.${id}` as "notification.list[]", {
                title: n.summary,
                content: n.body,
            });
            registry.setSetCallback(`notification.list.${id}.delete` as "notification.list[].delete", () => {
                return notification.close(n.id, 2).then(() => undefined);
            });
        });

        notification.on("closed", (id) => {
            removeNotification(id);
        });
    })
    .catch((e) => console.error("notification init error", e));

const mediaControl = new Set<string>();
const mediaTimers = new Map<string, ReturnType<typeof setInterval>>();
MSysApi.media
    .init()
    .then(() => {
        const media = MSysApi.media;
        const registry = rawRegistry;

        media.on("new-player", async (p) => {
            const serverName = p.getServerName();
            const oldTimer = mediaTimers.get(serverName);
            if (oldTimer) clearInterval(oldTimer);
            mediaControl.add(serverName);
            registry.setData("media.list", Array.from(mediaControl.keys()) as id<"media.list[]">[]);
            async function setData() {
                registry.setData(registry.buildVarId("media.list[]", [serverName]), {
                    artist: await p.artist(),
                    cover: await p.artCover(),
                    duration: await p.duration(),
                    title: await p.title(),
                });
                registry.setSetCallback(registry.buildVarId("media.list[].next", [serverName]), () => {
                    p.next();
                    return Promise.resolve();
                });
                registry.setSetCallback(registry.buildVarId("media.list[].previous", [serverName]), () => {
                    p.previous();
                    return Promise.resolve();
                });
            }
            setData();

            p.onMetaChange(() => {
                setData();
            });

            registry.setData(registry.buildVarId("media.list[].play", [serverName]), await p.paused());
            p.onStatusChange(async () => {
                registry.setData(registry.buildVarId("media.list[].play", [serverName]), await p.paused());
            });
            registry.setSetCallback(registry.buildVarId("media.list[].play", [serverName]), (v) => {
                if (v) p.play();
                else p.pause();
                return Promise.resolve();
            });

            const timer = setInterval(() => {
                p.getCurrentTime().then((v) => {
                    registry.setData(registry.buildVarId("media.list[].currentTime", [serverName]), v);
                });
            }, 100);
            mediaTimers.set(serverName, timer);
            registry.setSetCallback(registry.buildVarId("media.list[].currentTime", [serverName]), (v) => {
                p.setCurrentTime(v);
                return Promise.resolve();
            });
        });

        media.on("remove-player", (name) => {
            const timer = mediaTimers.get(name);
            if (timer) clearInterval(timer);
            mediaTimers.delete(name);
            mediaControl.delete(name);
            registry.setData("media.list", Array.from(mediaControl.keys()) as id<"media.list[]">[]);
        });
    })
    .catch((e) => console.error("media player init error", e));

MSysApi.tray.init().then(async () => {
    const tray = MSysApi.tray;
    rawRegistry.setData("tray.list", Array.from(tray.tarysService.keys()) as id<"tray.list[]">[]);
    for (const k of tray.tarysService.keys()) bindData(k);
    tray.ev.on("new", (k) => {
        rawRegistry.setData("tray.list", Array.from(tray.tarysService.keys()) as id<"tray.list[]">[]);
        bindData(k);
    });
    tray.ev.on("remove", () => {
        rawRegistry.setData("tray.list", Array.from(tray.tarysService.keys()) as id<"tray.list[]">[]);
    });
    async function bindData(k: string) {
        const item = tray.tarysService.get(k);
        if (!item) return;
        const updateData = async () => {
            rawRegistry.setData(rawRegistry.buildVarId("tray.list[]", [k]), {
                icon:
                    (await item.getIcon({
                        theme: setting.get("icon.theme"),
                    })) || "",
                title: await item.title(),
                itemIsMenu: await item.itemIsMenu(),
            });
        };
        await updateData();
        item.getMenu().then((menu) => {
            rawRegistry.setData(rawRegistry.buildVarId("tray.list[].menu", [k]), menu);
        });
        item.ev.on("menuUpdate", async () => {
            item.getMenu().then((menu) => {
                rawRegistry.setData(rawRegistry.buildVarId("tray.list[].menu", [k]), menu);
            });
        });
        item.ev.on("changed", () => {
            void updateData();
        });
        rawRegistry.setSetCallback(rawRegistry.buildVarId("tray.list[].active", [k]), () => {
            item.activate();
            return Promise.resolve();
        });
    }
});

MSysApi.volume.init().then(async () => {
    const volume = MSysApi.volume;
    const d = volume.getDevices();
    console.log(d);
    function findDefault() {
        const output = volume.getSinks();
        const dop = output.find((o) => o.isDefault);
        const input = volume.getSources();
        const dip = input.find((o) => o.isDefault);
        return {
            output: dop,
            input: dip,
        };
    }
    function df() {
        volume.ev.on("deviceVolumeChange", (id, v) => {
            console.log(id, v); // todo 没触发 bug
            const { output, input } = findDefault();
            if (output?.id === id) {
                rawRegistry.setData("volume.output.default.volume", v);
            }
            if (input?.id === id) {
                rawRegistry.setData("volume.input.default.volume", v);
            }
        });
        volume.ev.on("deviceMuteChange", (id, b) => {
            const { output, input } = findDefault();
            if (output?.id === id) rawRegistry.setData("volume.output.default.muted", b);
            if (input?.id === id) rawRegistry.setData("volume.input.default.muted", b);
        });
        const { output, input } = findDefault();
        if (output?.volume !== undefined) rawRegistry.setData("volume.output.default.volume", output.volume);
        if (input?.volume !== undefined) rawRegistry.setData("volume.input.default.volume", input.volume);
        if (output?.isMuted !== undefined) rawRegistry.setData("volume.output.default.muted", output.isMuted);
        if (input?.isMuted !== undefined) rawRegistry.setData("volume.input.default.muted", input.isMuted);

        rawRegistry.setSetCallback("volume.output.default.volume", (v) => {
            const { output } = findDefault();
            if (output?.id !== undefined) volume.setDeviceVolume(output.id, v);
            return Promise.resolve();
        });
        rawRegistry.setSetCallback("volume.input.default.volume", (v) => {
            const { input } = findDefault();
            if (input?.id !== undefined) volume.setDeviceVolume(input.id, v);
            return Promise.resolve();
        });
        rawRegistry.setSetCallback("volume.output.default.muted", (b) => {
            const { output } = findDefault();
            if (output?.id !== undefined) volume.setDeviceMute(output.id, b);
            return Promise.resolve();
        });
        rawRegistry.setSetCallback("volume.input.default.muted", (b) => {
            const { input } = findDefault();
            if (input?.id !== undefined) volume.setDeviceMute(input.id, b);
            return Promise.resolve();
        });
    }
    df();
});

// UI 对象池
const uipool = {
    "power.battery": () => createIndicator(rawRegistry, "power.battery"),
    "power.devices": () => {
        const source = rawRegistry.get("power.devices");
        const us: (() => void)[] = [];
        const container = dynamicScrollList<string>({
            itemSize: sSize(1.5),
            containerSize: sSize(1.5) * 4,
            direction: "down",
            keyExtractor: (x) => x,
            renderItem: (k) => {
                const el = iItem({ type: "h", size: 1.5 }).style({
                    display: "flex",
                    alignItems: "center",
                    padding: `${sSize2.padding}px`,
                    gap: `${sSize2.padding}px`,
                });
                const s = rawRegistry.get(k as "power.devices[]").getAndSubscribe((v) => {
                    el.clear().add([
                        aLineText().sv(v.name),
                        spacer(),
                        aLineText().sv(v.percentage.toString()).style({ flexShrink: 0 }),
                    ]);
                });
                us.push(s);
                return el;
            },
        });

        const unsub = source.getAndSubscribe(async (ids) => {
            container.setList(ids);
        });
        return {
            id: "power.devices",
            type: "dynamic-list",
            el: container.el.style({ width: px(sSize(6)) }),
            unmount: () => {
                unsub();
                for (const s of us) s();
            },
        };
    },
    "wifi.toggle": () => createToggle(rawRegistry, "wifi.enabled"),
    "wifi.accessPoints": () => {
        const source = rawRegistry.get("wifi.accessPoints");
        const us: (() => void)[] = [];
        const container = dynamicScrollList<string>({
            itemSize: sSize(1.5),
            containerSize: sSize(1.5) * 4,
            direction: "down",
            keyExtractor: (x) => x,
            renderItem: (k) => {
                const el = iItem({ type: "h", size: 1.5 }).style({
                    display: "flex",
                    alignItems: "center",
                    padding: `${sSize2.padding}px`,
                    gap: `${sSize2.padding}px`,
                });
                const s = rawRegistry.get(k as "wifi.accessPoints[]").getAndSubscribe((v) => {
                    el.clear().add([
                        aLineText().sv(v.ssid),
                        spacer(),
                        aLineText().sv(v.connected.toString()).style({ flexShrink: 0 }),
                    ]);
                });
                us.push(s);
                return el;
            },
        });

        const unsub = source.getAndSubscribe(async (ids) => {
            container.setList(ids);
        });
        return {
            id: "wifi.devices",
            type: "dynamic-list",
            el: container.el.style({ width: px(sSize(6)) }),
            unmount: () => {
                unsub();
                for (const s of us) s();
            },
        };
    },
    "connect.toggle": () => createToggle(rawRegistry, "connect.enabled"),
    "connect.devices": () => {
        const source = rawRegistry.get("connect.devices");
        const us: (() => void)[] = [];
        const container = dynamicScrollList<string>({
            itemSize: sSize(1.5),
            containerSize: sSize(1.5) * 4,
            direction: "down",
            keyExtractor: (x) => x,
            renderItem: (k) => {
                const el = iItem({ type: "h", size: 1.5 }).style({
                    display: "flex",
                    alignItems: "center",
                    padding: `${sSize2.padding}px`,
                    gap: `${sSize2.padding}px`,
                });
                const s = rawRegistry.get(k as "connect.devices[]").getAndSubscribe((v) => {
                    el.clear().add([
                        aLineText().sv(v.name),
                        spacer(),
                        aLineText()
                            .sv(v.connected ? "已连接" : v.remembered ? "已记忆" : "临时")
                            .style({ flexShrink: "0" }),
                    ]);
                    el.style({ cursor: v.connected || getConnectEnabled() ? "pointer" : "default" });
                });
                el.on("click", async () => {
                    const device = await rawRegistry.get(k as "connect.devices[]").get();
                    if (!device || !getConnectEnabled()) return;
                    try {
                        if (device.connected) {
                            await connect.disconnect(device.id);
                        } else {
                            await connect.connect(device.id);
                        }
                    } catch (error) {
                        console.warn("connect: toggle device failed", device.id, error);
                    }
                });
                us.push(s);
                return el;
            },
        });

        const unsub = source.getAndSubscribe(async (ids) => {
            container.setList(ids);
        });
        return {
            id: "connect.devices",
            type: "dynamic-list",
            el: container.el.style({ width: px(sSize(6)) }),
            unmount: () => {
                unsub();
                for (const s of us) s();
            },
        };
    },
    "blue.toggle": () => createToggle(rawRegistry, "blue.power"),
    "blue.devices": () => {
        const source = rawRegistry.get("blue.devices");
        const us: (() => void)[] = [];
        const container = dynamicScrollList<string>({
            itemSize: sSize(1.5),
            containerSize: sSize(1.5) * 4,
            direction: "down",
            keyExtractor: (x) => x,
            renderItem: (k) => {
                const el = iItem({ type: "h", size: 1.5 }).style({
                    display: "flex",
                    alignItems: "center",
                    padding: `${sSize2.padding}px`,
                    gap: `${sSize2.padding}px`,
                });
                const s = rawRegistry.get(k as "blue.devices[]").getAndSubscribe((v) => {
                    el.clear().add([
                        aLineText().sv(v.name),
                        spacer(),
                        aLineText().sv(v.connected.toString()).style({ flexShrink: 0 }),
                    ]);
                });
                us.push(s);
                return el;
            },
        });

        const unsub = source.getAndSubscribe(async (ids) => {
            container.setList(ids);
        });
        return {
            id: "blue.devices",
            type: "dynamic-list",
            el: container.el.style({ width: px(sSize(6)) }),
            unmount: () => {
                unsub();
                for (const s of us) s();
            },
        };
    },
};

tools.registerTool("blank", () => {
    return view().style({ flexGrow: 1 });
});
tools.registerTool("showAllView", () => {
    const showAllViewBtn = button(getIconXEl("mutiWinView", { size: 20, width: 24, height: 24 })).on("click", () => {
        viewAllShowing = !viewAllShowing;
        viewAll(viewAllShowing);
    });
    return showAllViewBtn;
});

type DesktopApp = Awaited<ReturnType<typeof MSysApi.getDesktopEntries>>[number];

/** 开始菜单：按需构建应用格子，图标只在实际可见时加载 */
function createStartMenu(
    tipEl: HTMLElement,
    showTip: (op?: { state?: "show" | "hide" | "toggle"; anchorEl?: HTMLElement }) => void,
) {
    const iconConfig: DesktopIconConfig = {
        theme: setting.get("icon.theme"),
    };
    const menu = view("x", "wrap")
        .style({
            width: "80vw",
            height: "80vh",
            padding: "20px",
            borderRadius: "20px",
            // 内容滚动交给菜单自身，避免整个桌面参与滚动和重排
            overflowY: "auto",
            alignContent: "flex-start",
            background: "rgba(245, 245, 245, 0.96)",
            backdropFilter: "blur(12px)",
            boxShadow: "0 8px 32px #00000033",
            contain: "layout paint style",
        })
        .addInto(tipEl);
    const loadingEl = txt("正在加载应用…").style({ padding: "8px", opacity: "0.6" }).addInto(menu);

    // 图标查找是异步文件 IO，限制并发避免一次可见几十个图标时产生 IO 峰值
    const iconQueue: (() => Promise<void>)[] = [];
    let iconRunning = 0;
    function enqueueIcon(task: () => Promise<void>) {
        iconQueue.push(task);
        const next = () => {
            while (iconRunning < 6 && iconQueue.length > 0) {
                const job = iconQueue.shift();
                if (!job) break;
                iconRunning++;
                job()
                    .catch(() => {})
                    .finally(() => {
                        iconRunning--;
                        next();
                    });
            }
        };
        next();
    }

    const iconLoaders = new WeakMap<HTMLElement, () => Promise<void>>();
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== "undefined") {
        observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const target = entry.target as HTMLElement;
                    const load = iconLoaders.get(target);
                    if (!load) continue;
                    iconLoaders.delete(target);
                    observer?.unobserve(target);
                    enqueueIcon(load);
                }
            },
            // 菜单隐藏时不会触发；打开后只加载视口附近的行
            { root: menu.el, rootMargin: "120px 0px" },
        );
    }

    function createAppTile(app: DesktopApp) {
        const appEl = view("y").style({
            width: "80px",
            height: "80px",
            alignItems: "center",
            justifyContent: "flex-start",
            flexShrink: 0,
            // 屏幕外的格子跳过布局和绘制，长列表滚动更轻
            contentVisibility: "auto",
            containIntrinsicSize: "80px 80px",
        });
        const iconView = view().addInto(appEl);
        const iconEl = appIconEl(app.exec).style({
            width: "40px",
            height: "40px",
        });
        iconView.add(iconEl);
        appEl.add(
            txt(app.nameLocal).style({
                fontSize: "12px",
                maxWidth: "80%",
                overflow: "hidden",
                textAlign: "center",
            }),
        );

        const load = () =>
            loadAppIcon(iconEl, async () => (await MSysApi.getDesktopIcon(app.icon, iconConfig)) || "", app.name, {
                rasterSize: 40,
            });
        if (observer) {
            iconLoaders.set(appEl.el, load);
            observer.observe(appEl.el);
        } else {
            enqueueIcon(load);
        }
        return appEl;
    }

    /** 设置不是真实应用，但在开始菜单里模拟一个应用格子 */
    function createSettingsTile() {
        const appEl = view("y").style({
            width: "80px",
            height: "80px",
            alignItems: "center",
            justifyContent: "flex-start",
            flexShrink: 0,
        });
        const iconView = view().addInto(appEl);
        const iconEl = appIconEl().style({
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
        });
        iconEl.add(getIconXEl("settings", { size: 36, width: 36, height: 36 }));
        iconView.add(iconEl);
        appEl.add(
            txt("设置").style({
                fontSize: "12px",
                maxWidth: "80%",
                overflow: "hidden",
                textAlign: "center",
            }),
        );
        appEl.on("click", () => {
            showTip({ state: "hide" });
            openSettingsWindow();
        });
        return appEl;
    }

    // 元数据在空闲时预取，但不创建 DOM / 不读图标
    const entriesPromise = MSysApi.getDesktopEntries().catch(() => [] as DesktopApp[]);
    let buildPromise: Promise<void> | null = null;
    function build() {
        if (buildPromise) return buildPromise;
        buildPromise = (async () => {
            const apps = await entriesPromise;
            loadingEl.remove();
            menu.add(createSettingsTile());
            if (apps.length === 0) {
                txt("未找到应用").style({ padding: "8px", opacity: "0.6" }).addInto(menu);
                return;
            }
            // 分批插入：先让首屏尽快出现，其余在空闲帧继续，避免一次长任务卡住点击
            const batchSize = 40;
            for (let i = 0; i < apps.length; i += batchSize) {
                const batch: ReturnType<typeof createAppTile>[] = [];
                for (const app of apps.slice(i, i + batchSize)) {
                    batch.push(createAppTile(app));
                }
                menu.add(batch);
                if (i + batchSize < apps.length) await scheduler.yield();
            }
        })();
        return buildPromise;
    }

    const startMenuBtn = view()
        .style({
            width: "48px",
            height: "48px",
            borderRadius: "12px",
            background: "#00aaff",
        })
        .on("click", () => {
            build();
            showTip({ state: "toggle" });
        });
    return startMenuBtn;
}

tools.registerTool("startMenuFullScreen", ({ tipEl, showTip }) => createStartMenu(tipEl, showTip), {
    selfBackground: true,
});

tools.registerTool("clock", () => {
    const clockEl = view("x").style({ alignItems: "center" });
    const hh = view();
    const mm = view();
    clockEl.add([hh, nNumber(":"), mm]);
    rawRegistry.get("time.hour").getAndSubscribe((v) => {
        hh.clear().add(nNumber(v.toString().padStart(2, "0")));
    });
    rawRegistry.get("time.minute").getAndSubscribe((v) => {
        mm.clear().add(nNumber(v.toString().padStart(2, "0")));
    });
    return clockEl;
});

tools.registerTool("apps", ({ tipEl, showA, showTip }) => {
    const appsEl = view().style({
        display: "flex",
        flexDirection: "inherit",
        maxWidth: "800px",
        overflowX: "auto",
    });
    const a = showA;

    const iconConfig: DesktopIconConfig = {
        theme: setting.get("icon.theme"),
    };

    MSysApi.getDesktopEntries().then(async (apps) => {
        console.log(apps);

        const browserApp =
            apps.find((app) => app.name === "Google Chrome") ||
            apps.find((app) => app.name === "Firefox") ||
            apps.find((app) => app.name === "Microsoft Edge");
        const fileManagerApp =
            apps.find((app) => app.name === "org.gnome.Nautilus") || apps.find((app) => app.name === "Dolphin");
        const terminalApp =
            apps.find((app) => app.name === "org.gnome.Terminal") || apps.find((app) => app.name === "Konsole");

        if (browserApp) {
            appLauncher(
                async () =>
                    (await MSysApi.getDesktopIcon(browserApp.icon, iconConfig)) ||
                    fs.readFileAsDataURLSync("/assets/icons/browser.png"),
                browserApp.name,
                browserApp.exec,
            ).addInto(appsEl);
        }
        if (fileManagerApp) {
            appLauncher(
                async () =>
                    (await MSysApi.getDesktopIcon(fileManagerApp.icon, iconConfig)) ||
                    fs.readFileAsDataURLSync("/assets/icons/file-manager.png"),
                fileManagerApp.name,
                fileManagerApp.exec,
            ).addInto(appsEl);
        }
        if (terminalApp) {
            appLauncher(
                async () =>
                    (await MSysApi.getDesktopIcon(terminalApp.icon, iconConfig)) ||
                    fs.readFileAsDataURLSync("/assets/icons/terminal.png"),
                terminalApp.name,
                terminalApp.exec,
            ).addInto(appsEl);
        }
    });
    /** appid → 图标；「某应用有哪些窗口」直接从 server 的窗口表算 */
    const nowApps = new Map<string, ElType<HTMLElement>>();
    const pendingApps = new Set<string>();
    /** handle → appid：`window.closed` 时窗口已从表里移除，靠它定位是哪个应用没了窗口 */
    const handleAppid = new Map<WinHandle, string>();
    const preview = view()
        .style({ display: "flex" })
        .on("pointerenter", () => {
            autoHide.moveTo("reset");
        })
        .on("pointerleave", () => {
            autoHide.moveTo("hide");
        })
        .addInto(tipEl);
    const autoHide = new AnimationGear({ v: 0 }, { transition: { duration: 400 } });
    autoHide.setUpdateCallback((v) => {
        if (v.v === 1) {
            showTip({ state: "hide" });
        }
    });
    autoHide.addState("reset", { v: 0 }, ["hide"]);
    autoHide.addState("hide", { v: 1 }, ["reset"]);
    async function addAppIcon(appid: string) {
        if (!appid) return;
        // window.changed 会连发多次，await 期间不能放第二个进来（否则图标重复）
        if (nowApps.has(appid) || pendingApps.has(appid)) return;
        pendingApps.add(appid);
        try {
            const desk = await MSysApi.getDesktopEntry(appid);
            const iconPath = async () => (await MSysApi.getDesktopIcon(desk?.icon || "", iconConfig)) || "";
            const appEl = appIconEl();
            loadAppIcon(appEl, iconPath, desk?.name || appid);
            appsEl.add(appEl);
            nowApps.set(appid, appEl);
            appEl.on("click", () => {
                const allWin = server.server.windows.list().filter((w) => w.appid === appid);
                if (allWin.length === 0) return;
                const focusedWinIndex = allWin.findIndex((w) => w.states.activated);
                if (focusedWinIndex === -1) {
                    jump2Win(allWin[0].handle);
                } else {
                    const nextIndex = (focusedWinIndex + 1) % allWin.length;
                    jump2Win(allWin[nextIndex].handle);
                }
            });
            appEl
                .on("pointerenter", () => {
                    if (!nowApps.has(appid)) return;
                    autoHide.moveTo("reset");
                    preview.clear();
                    if (a === "left" || a === "right") {
                        preview.style({ flexDirection: "column" });
                    } else {
                        preview.style({ flexDirection: "row" });
                    }
                    const allWin = server.server.windows.list().filter((w) => w.appid === appid);

                    preview.clear().add(
                        allWin.map((info) => {
                            const el = view().style({ position: "relative" });
                            el.add(txt(info.title || ""));
                            const canvas = ele("canvas").addInto(el);
                            const rawCanvas = server.server.windows.preview(info.handle);
                            if (!rawCanvas) return undefined;
                            const { w, h } = fitRect({ w: rawCanvas.width, h: rawCanvas.height }, 200, 150);
                            canvas.attr({ width: w, height: h });
                            // biome-ignore lint/style/noNonNullAssertion: ---
                            const ctx = canvas.el.getContext("2d")!;
                            ctx.drawImage(rawCanvas, 0, 0, rawCanvas.width, rawCanvas.height, 0, 0, w, h);
                            el.add(
                                createWindowCloseButton({
                                    size: 20,
                                    onClick: () => {
                                        server.server.notify("window.close", info.handle);
                                        // 立刻从预览里拿掉，不用等 window.closed 回来
                                        el.remove();
                                        if (preview.el.children.length === 0) showTip({ state: "hide" });
                                    },
                                }).style({ position: "absolute", top: "2px", right: "2px" }),
                            );
                            el.on("click", () => {
                                jump2Win(info.handle);
                            });
                            return el;
                        }),
                    );
                    showTip({ state: "show", anchorEl: appEl.el });
                })
                .on("pointerleave", () => {
                    autoHide.moveTo("hide");
                });
        } finally {
            pendingApps.delete(appid);
        }
    }
    for (const info of server.server.windows.list()) {
        if (info.appid) {
            handleAppid.set(info.handle, info.appid);
            addAppIcon(info.appid);
        }
    }
    function checkAndTryRm(appid: string) {
        const iconEl = nowApps.get(appid);
        if (!iconEl) return;
        if (server.server.windows.list().some((w) => w.appid === appid)) return;
        iconEl.remove();
        nowApps.delete(appid);
    }
    // 一次订阅覆盖全部客户端：appid 落到窗口上就补图标
    server.server.on("window.changed", (info) => {
        if (!info.appid) return;
        handleAppid.set(info.handle, info.appid);
        addAppIcon(info.appid);
    });
    server.server.on("window.closed", (handle) => {
        const appid = handleAppid.get(handle);
        handleAppid.delete(handle);
        if (appid) checkAndTryRm(appid);
    });
    return appsEl;
});

tools.registerTool(
    "login",
    ({ tipEl, showTip }) => {
        const el = view("x")
            .style({ alignItems: "center" })
            .add(getIconXEl("shutdown", { size: 20, width: 24, height: 24 }));

        function bButton(icon: HTMLElement, txt: string, onClick: () => void) {
            return button()
                .style({
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                })
                .add([icon, aLineText().sv(txt)])
                .on("click", () => {
                    onClick();
                });
        }

        ui.bar([
            ui.barItem().add(
                iItem({ type: "h", size: 1 }).add(
                    bButton(getIconXEl("lock", { size: 16 }).el, "锁屏", () => {
                        state.setState("lock");
                    }),
                ),
            ),
            ui.barItem().add([
                iItem({ type: "h", size: 1 }).add(
                    bButton(getIconXEl("shutdown", { size: 16 }).el, "关机", async () => {
                        const t = await confirm("确认 关机？");
                        if (t) MSysApi.login("shutdown");
                    }),
                ),
                iItem({ type: "h", size: 1 }).add(
                    bButton(getIconXEl("reboot", { size: 16 }).el, "重启", async () => {
                        const t = await confirm("确认 重启？");
                        if (t) MSysApi.login("restart");
                    }),
                ),
                iItem({ type: "h", size: 1 }).add(
                    bButton(getIconXEl("suspend", { size: 16 }).el, "挂起", async () => {
                        const t = await confirm("确认 挂起？");
                        if (t) MSysApi.login("suspend");
                    }),
                ),
            ]),
        ])
            .el.style({ width: px(sSize(3)) })
            .addInto(tipEl);

        el.on("click", () => {
            showTip({ state: "toggle" });
        });
        return el;
    },
    { selfBackground: true },
);

tools.registerTool(
    "mediaControl",
    ({ tipEl, showTip }) => {
        const btn = button(getIconXEl("music", { size: 20, width: 24, height: 24 })).on("click", () => {
            showTip();
        });

        const media = mMedia({
            map: async (k) => {
                return {
                    data: rawRegistry.get(rawRegistry.buildVarId("media.list[]", [k])),
                    play: rawRegistry.get(rawRegistry.buildVarId("media.list[].play", [k])),
                    currentTime: rawRegistry.get(rawRegistry.buildVarId("media.list[].currentTime", [k])),
                    next: () => rawRegistry.get(rawRegistry.buildVarId("media.list[].next", [k])).set?.(true),
                    previous: () => rawRegistry.get(rawRegistry.buildVarId("media.list[].previous", [k])).set?.(true),
                };
            },
        });

        media.el.addInto(tipEl);

        rawRegistry.get("media.list").getAndSubscribe((ids) => media.setList(ids));

        return btn;
    },
    { selfBackground: true },
);

tools.registerTool(
    "tray",
    ({ tipEl, showTip }) => {
        const el = view("x");
        rawRegistry.get("tray.list").getAndSubscribe(async (ids) => {
            el.clear();
            for (const id of ids) {
                const icon = view().addInto(el);
                const menuEl = tTrayMenu({
                    click: () => {
                        rawRegistry.get(rawRegistry.buildVarId("tray.list[].active", [id])).set?.(true);
                    },
                    clickItem: () => {
                        showTip({ state: "hide", anchorEl: icon.el });
                    },
                });

                rawRegistry
                    .get(rawRegistry.buildVarId("tray.list[]", [id]))
                    .get()
                    .then((data) => {
                        image(data.icon, data.title)
                            .style({ width: "24px", height: "24px", objectFit: "cover" })
                            .addInto(icon);
                        icon.on("click", async () => {
                            const menu = await rawRegistry.get(rawRegistry.buildVarId("tray.list[].menu", [id])).get();
                            if (!menu) return;
                            menuEl.setTree(menu);
                            pack(tipEl).clear();
                            menuEl.el.addInto(tipEl);
                            showTip({ state: "show", anchorEl: icon.el });
                        });
                        menuEl.setTitle(data.title);
                    });
            }
        });

        return el;
    },
    { selfBackground: true },
);

tools.registerTool(
    "power",
    ({ tipEl, showTip }) => {
        const el = view("x").style({ alignItems: "center" });

        // 顶部显示电池状态
        const batteryIndicator = getIconXEl("battery", { size: 20, width: 24, height: 24 });
        el.add(batteryIndicator.el);

        rawRegistry.get("power.battery").getAndSubscribe((v) => batteryIndicator.sv("value", v / 100));

        // 弹出框显示详情
        const batteryInfo = uipool["power.battery"]();
        const deviceList = uipool["power.devices"]();

        ui.bar([
            // todo 性能方案
            ui.barItem().add(batteryInfo.el),
            ui.barItem().add(deviceList.el),
        ]).el.addInto(tipEl);

        el.on("click", () => {
            showTip({ state: "show", anchorEl: el.el });
        });

        return el;
    },
    { selfBackground: true },
);

tools.registerTool(
    "network",
    ({ tipEl, showTip }) => {
        const el = view("x")
            .style({ alignItems: "center" })
            .add(getIconXEl("wifi", { size: 20, width: 24, height: 24 }));
        const toggle = uipool["wifi.toggle"]();
        const apList = uipool["wifi.accessPoints"]();
        ui.bar([ui.barItem().add(toggle.el), ui.barItem().add(apList.el)]).el.addInto(tipEl);

        el.on("click", () => {
            showTip({ state: "show", anchorEl: el.el });
        });

        return el;
    },
    { selfBackground: true },
);

tools.registerTool(
    "connect",
    ({ tipEl, showTip }) => {
        const el = view("x")
            .style({ alignItems: "center" })
            .add(getIconXEl("connect", { size: 20, width: 24, height: 24 }).el);
        const toggle = uipool["connect.toggle"]();
        const deviceList = uipool["connect.devices"]();
        const idText = aLineText();
        rawRegistry.get("connect.id").getAndSubscribe((id) => idText.sv(`本机 ID: ${id}`));

        ui.bar([ui.barItem().add(toggle.el), ui.barItem().add(idText), ui.barItem().add(deviceList.el)]).el.addInto(
            tipEl,
        );

        el.on("click", () => {
            showTip({ state: "show", anchorEl: el.el });
        });

        return el;
    },
    { selfBackground: true },
);

tools.registerTool(
    "blue",
    ({ tipEl, showTip }) => {
        const el = view("x")
            .add(getIconXEl("blue", { size: 20, width: 24, height: 24 }).el)
            .style({ alignItems: "center" });
        const toggle = uipool["blue.toggle"]();
        const deviceList = uipool["blue.devices"]();
        ui.bar([ui.barItem().add(toggle.el), ui.barItem().add(deviceList.el)]).el.addInto(tipEl);

        el.on("click", () => {
            showTip({ state: "show", anchorEl: el.el });
        });

        return el;
    },
    { selfBackground: true },
);

tools.registerTool(
    "notifications",
    ({ tipEl, showTip }) => {
        const btn = button(getIconXEl("notification", { size: 20, width: 24, height: 24 })).on("click", () => {
            showTip();
        });

        const nl = nNotiList({
            map: async (id) => {
                const x = await rawRegistry.get(`notification.list.${id}` as "notification.list[]").get();
                return {
                    ...x,
                    delete: () => {
                        rawRegistry.get(`notification.list.${id}.delete` as "notification.list[].delete")?.set?.(true);
                    },
                };
            },
        });

        rawRegistry.get("notification.list").getAndSubscribe((ids) => {
            nl.setList(ids);
        });

        nl.el.addInto(tipEl);

        return btn;
    },
    { selfBackground: true },
);

tools.registerTool(
    "ime",
    ({ tipEl, showTip }) => {
        return createImeTool({ ime: () => ime, tipEl, showTip });
    },
    { selfBackground: true },
);

tools.registerTool(
    "volume",
    ({ tipEl, showTip }) => {
        const btn = button(getIconXEl("speaker", { size: 20, width: 24, height: 24 })).on("click", () => {
            showTip();
        });

        const m = vVolume({
            outputM: rawRegistry.get("volume.output.default.muted"),
            inputM: rawRegistry.get("volume.input.default.muted"),
            outputV: rawRegistry.get("volume.output.default.volume"),
            inputV: rawRegistry.get("volume.input.default.volume"),
        });

        m.el.addInto(tipEl);

        return btn;
    },
    { selfBackground: true },
);

(() => {
    const day = view("x");
    const clockEl = view("x");
    const y = view();
    const m = view();
    const d = view();
    const w = view();
    day.add([y, nNumber("/"), m, nNumber("/"), d, nNumber(" "), w]);
    const hh = view();
    const mm = view();
    clockEl.add([hh, nNumber(":", { fontSize: 120 }), mm]);
    rawRegistry.get("time.year").getAndSubscribe((v) => {
        y.clear().add(nNumber(v.toString()));
    });
    rawRegistry.get("time.month").getAndSubscribe((v) => {
        m.clear().add(nNumber(v.toString()));
    });
    rawRegistry.get("time.day").getAndSubscribe((v) => {
        d.clear().add(nNumber(v.toString()));
    });
    rawRegistry.get("time.weekday").getAndSubscribe((v) => {
        w.clear().add(nNumber(v.toString()));
    });
    rawRegistry.get("time.hour").getAndSubscribe((v) => {
        hh.clear().add(nNumber(v.toString().padStart(2, "0"), { fontSize: 120 }));
    });
    rawRegistry.get("time.minute").getAndSubscribe((v) => {
        mm.clear().add(nNumber(v.toString().padStart(2, "0"), { fontSize: 120 }));
    });
    lockScreenView.style({ width: "100%", height: "100%" }).add([
        image(fs.readFileAsDataURLSync("/assets/wallpaper/1.svg"), "wallpaper").style({
            width: "100%",
            height: "100%",
            objectFit: "cover",
        }),
        view("y")
            .style({ position: "absolute", ...xPosition(0.5, 0.4), alignItems: "center", gap: px(40) })
            .add([day, clockEl]),
    ]);

    lockScreenPassword.style({ width: "100%", height: "100%", backdropFilter: "blur(40px)" });

    const inputEl = ui.passwd();
    inputEl.placeholder("请输入密码");
    inputEl.el.style({ width: px(sSize(5)), height: px(sSize(1)) });
    let cheking = false;
    async function check() {
        if (cheking) return;
        cheking = true;
        inputEl.disable(true);
        const r = await myde.MSysApi.verifyUserPassword(inputEl.el.gv);
        if (r) {
            inputEl.clear();
            inputEl.disable(false);
            cheking = false;

            stateLock.setState("out");
        } else {
            inputEl.clear();
            inputEl.disable(false);
            inputEl.placeholder("密码错误，请重试"); // todo pam code
            cheking = false;
        }
    }

    lockScreenPassword.add(
        view("x")
            .add([
                inputEl.el,
                view()
                    .add(getIconXEl("chevron.right", { size: 16, width: sSize(1), height: sSize(1) }))
                    .style({
                        ...gGlassStyle.justItem,
                        width: px(sSize(1)),
                        height: px(sSize(1)),
                        borderRadius: px(sSize2.radius1),
                    })
                    .on("click", check),
            ])
            .style({ gap: px(8), position: "absolute", ...xPosition(0.5, 0.6) }),
    );

    inputEl.el.on("change", () => {
        check();
    });
    inputEl.el.on("input", () => {
        stateLock.setState("passwd");
    });
})();

// ── 输入聚合层 ────────────────────────────────────────────────────────────────────────────────────
// DOM 原生事件与 input api（evdev）聚合为统一输入事件流，传入 MSysApi.inputSim 模拟 DOM 事件，
// UI 组件与 wayland 窗口转发照旧消费模拟出的 DOM 事件
// 聚合：window capture 捕获真实 DOM 事件 + input api 设备事件，都归一化为 UniInputEvent
// 来源只以 source 标记保留类型数据（现实难以同源双触发，不做去重）；合成事件（!isTrusted）不回流防环
// 分发：统一 dispatchInput() → inputSim.emit()，evdev 判定/换算工具见 input_evdev.ts
// 注册必须早于所有 UI 监听（紧接着的 plant 循环就会注册 Tools 的 window capture click）：被吞掉的原生事件
// 只对注册在它之后的监听不可见；排在它之前的监听仍会先收到原生事件，而原生 click 不受 preventDefault 影响
// （它不是兼容鼠标事件）且派发在合成 click 之后，于是同一次物理点击会被处理两遍
const inputSim = MSysApi.inputSim;
const inputApi = MSysApi.input;

/** 分发：统一传入新 api（当前行为为模拟 DOM 事件） */
function dispatchInput(e: UniInputEvent) {
    if (screenOffState !== "on") {
        // 用任意输入唤醒，唤醒这一下不交给应用；锁屏息屏时回到锁屏界面
        void setScreenOff(false);
        if (stateLock.getState() === "xipin") stateLock.setState("lock");
        return;
    }
    inputSim.emit(e);
}

// 聚合层指针位置（视口坐标）：DOM 事件直接取坐标，evdev 相对设备做位移积分
const inputPointerPos = { x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2) };

// 统一重新模拟的真实事件（click/auxclick/contextmenu 等由 inputSim 从 down/up 合成，原生的直接吞掉；
// hover 类（pointerover/out/enter/leave）不在其中，DOM 来源放行原生事件，evdev 来源由 inputSim 按目标变化补齐；
// keydown 原生默认行为也被屏蔽，文本输入由 inputSim 在未被 preventDefault 时补齐）
const SWALLOWED_EVENTS = [
    "pointerdown",
    "pointerup",
    "pointermove",
    "mousedown",
    "mouseup",
    "mousemove",
    "wheel",
    "click",
    "auxclick",
    "dblclick",
    "contextmenu",
    "keydown",
    "keyup",
];

function domInputEvent(e: Event) {
    if (!e.isTrusted) return; // 合成事件不回流
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e instanceof KeyboardEvent) {
        dispatchInput({
            kind: "key",
            type: e.type === "keydown" ? "down" : "up",
            code: MInputMap.mapKeyCode(e.code),
            webCode: e.code,
            key: e.key,
            repeat: e.repeat,
            source: "dom",
            target: e.target,
        });
        return;
    }
    if (e instanceof WheelEvent) {
        dispatchInput({
            kind: "pointer",
            type: "wheel",
            x: e.clientX,
            y: e.clientY,
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            deltaMode: e.deltaMode,
            source: "dom",
            target: e.target,
        });
        return;
    }
    if (e instanceof PointerEvent && (e.type === "pointerdown" || e.type === "pointerup" || e.type === "pointermove")) {
        inputPointerPos.x = e.clientX;
        inputPointerPos.y = e.clientY;
        dispatchInput({
            kind: "pointer",
            type: e.type === "pointerdown" ? "down" : e.type === "pointerup" ? "up" : "move",
            x: e.clientX,
            y: e.clientY,
            button: e.button,
            pointerType: e.pointerType === "touch" || e.pointerType === "pen" ? e.pointerType : "mouse",
            pointerId: e.pointerId,
            isPrimary: e.isPrimary,
            source: "dom",
            target: e.target,
        });
    }
}

for (const type of SWALLOWED_EVENTS) {
    window.addEventListener(type, domInputEvent, true);
}

const wino = { t: 0, l: 0, r: 0, b: 0 };
for (const p of planteData) {
    const plantEl = view().style({ position: "absolute" }).addInto(toolsEl);
    switch (p.posi) {
        case "left":
            plantEl.style({ left: "0px", flexDirection: "column" });
            break;
        case "right":
            plantEl.style({ right: "0px", flexDirection: "column" });
            break;
        case "top":
            plantEl.style({ top: "0px" });
            break;
        case "bottom":
            plantEl.style({ bottom: "0px" });
            break;
    }
    const d = p.posi === "left" || p.posi === "right" ? "y" : "x";
    plantEl.style({
        display: "flex",
        background: "rgba(255, 255, 255, 0.6)",
        borderRadius: "22px",
        backdropFilter: "blur(10px)",
    });
    if (p.glow) {
        plantEl.style(d === "x" ? { width: "100%", borderRadius: 0 } : { height: "100%", borderRadius: 0 });
    } else {
        plantEl.style(
            d === "x" ? { left: "50%", transform: "translateX(-50%)" } : { top: "50%", transform: "translateY(-50%)" },
        );
    }
    for (const t of p.items) {
        const tt = tools.getTool(t.id);
        if (!tt) {
            console.warn(`Tool ${t.id} not found`);
            continue;
        }
        plantEl.add(tt.getEl(({ top: "bottom", bottom: "top", left: "right", right: "left" } as const)[p.posi]));
    }
    if (d === "x") {
        const x = plantEl.el.offsetHeight;
        if (p.posi === "top") {
            wino.t = Math.max(wino.t, x);
        }
        if (p.posi === "bottom") {
            wino.b = Math.max(wino.b, x);
        }
    }
    if (d === "y") {
        const x = plantEl.el.offsetWidth;
        if (p.posi === "left") {
            wino.l = Math.max(wino.l, x);
        }
        if (p.posi === "right") {
            wino.r = Math.max(wino.r, x);
        }
    }
}
windowElWarp.style({
    left: `${wino.l}px`,
    right: `${wino.r}px`,
    top: `${wino.t}px`,
    bottom: `${wino.b}px`,
});

const body = pack(document.body);

addStyle({
    // 触屏的浏览器手势（平移/缩放/双击放大）全部关掉：触摸统一走 pointer 事件由桌面自己处理
    html: {
        touchAction: "none",
    },
    body: {
        userSelect: "none",
        touchAction: "none",
    },
});

/** 触屏多指同时上报时，桌面光标与窗口转发只跟随主指针，其余指针交给 UI 交互层 */
function isSecondaryTouch(e: PointerEvent) {
    return e.pointerType === "touch" && !e.isPrimary;
}

body.on("pointermove", (e) => {
    if (isSecondaryTouch(e)) return;
    mouseMove(e.x, e.y);
});
windowEl.on("pointerdown", (e) => {
    if (isSecondaryTouch(e)) return;
    sendPointerEvent("down", e);
});
windowEl.on("pointerup", (e) => {
    if (isSecondaryTouch(e)) return;
    sendPointerEvent("up", e);
});

// 点击桌面或其他窗口时让内部窗口失焦。只处理 inputSim 合成的 pointerdown：
// 原生事件在输入聚合层已经被 stopImmediatePropagation 拦截，不会再走到这里。
window.addEventListener(
    "pointerdown",
    (e) => {
        if (e.isTrusted) return;
        if (!isInternalWindow(viewData.focusHandle)) return;
        const target = e.target as HTMLElement | null;
        if (!target?.closest("[data-internal-window]")) viewData.blurAll();
    },
    true,
);

body.on("keydown", (e) => {
    if (!e.repeat && matchBindings(e, EXIT_BINDINGS)) {
        e.preventDefault();
        window.close();
        return;
    }
    if (state.getState() !== "normal") return;
    // 内部窗口自己处理 DOM 键盘事件（输入框、下拉框等），不转发给 Wayland 客户端
    if (isInternalWindow(viewData.focusHandle)) return;
    const handle = viewData.focusHandle;
    if (handle === undefined) return;
    if (ime?.handleKeyDown(e)) {
        e.preventDefault();
        return;
    }
    e.preventDefault();
    if (e.repeat) return;
    server.server.notify("input.key", handle, MInputMap.mapKeyCode(e.code), "pressed");
});
body.on("keyup", (e) => {
    if (state.getState() !== "normal") return;
    if (isInternalWindow(viewData.focusHandle)) return;
    const handle = viewData.focusHandle;
    if (handle === undefined) return;
    if (ime?.handleKeyUp(e)) {
        e.preventDefault();
        return;
    }
    e.preventDefault();
    if (e.repeat) return;
    server.server.notify("input.key", handle, MInputMap.mapKeyCode(e.code), "released");
});

windowEl.on("wheel", (e) => {
    sendScrollEvent(e);
});

const cursor = new Cursor(cursorEl);

// 光标形态改由 server 事件下发（renderToolsOn.onCursorUpdata 保留给渲染侧，语义相同）
server.server.on("cursor.changed", (clientId, state) => {
    // 客户端断开后 close 流程还会补发一次 hidden，忽略已经不在册的客户端
    if (!server.server.clients.get(clientId)) return;
    if (state.kind === "hidden") cursor.hide(clientId);
    else if (state.kind === "shape") cursor.setShape(clientId, state.shape);
    else if (state.canvas) {
        // 光标 surface 的尺寸/热点是逻辑坐标；显示时乘输出缩放
        const scale = screenManager.getScale();
        cursor.setImage(clientId, state.canvas, state.hotspot.x * scale, state.hotspot.y * scale, {
            width: state.size.width * scale,
            height: state.size.height * scale,
        });
    }
});

// ── 输入聚合层：evdev（input api）设备接入 ────────────────────────────────────────────────────────
// 触摸 pointerId 全局递增，多个触屏同时接入也不会撞号；鼠标缺省 pointerId 是 1，触摸从 2 开始避让
let nextTouchPointerId = 2;

/** 单个 input api（evdev）设备 → 统一输入事件（帧合并后 emit） */
function useEvdevDevice(
    input: InputManager,
    emit: (e: UniInputEvent) => void,
    pointerPos: InputPointerPos,
    path: string,
    /** phys → 最近一次相对位移时间，用来识别触摸板的伴随鼠标节点 */
    relativeActivity: Map<string, number>,
) {
    const dev = input.getDevice(path);
    if (!dev) return;
    const info = dev.info;
    const kind = pointerKindOf(info);
    const touchpad = isTouchpad(info);
    const touchscreen = isTouchscreen(info);
    const rel = hasRelativeXY(info);
    const abs = MInputMap.absPosMapping(info);
    const keyboard = canKey(info);
    if (!rel && !abs && !keyboard) return;
    // 高精度滚轮与普通滚轮会同时上报，优先高精度避免重复滚动
    const hiResWheel = info.capabilities.relAxes.includes(InputEventCodes.REL_WHEEL_HI_RES);
    // MT-B 设备多指会交替上报各 slot 坐标
    let slot = 0;
    let sawSlot = false;

    // 帧缓冲：一帧（EV_SYN 前）内的位移/滚轮/按键合并，保持事件顺序
    let dx = 0;
    let dy = 0;
    let moved = false;
    let wheelX = 0;
    let wheelY = 0;
    const frameKeys: { code: number; value: number }[] = [];

    // ── 触摸板：设备事件交给 utils/touchpad 封装，绝对坐标只用于算位移和手指数 ──
    const hasTrackingId = info.capabilities.absAxes.includes(InputEventCodes.ABS_MT_TRACKING_ID);
    // ── 触屏：每个接触点映射成一个独立 pointer，pointerId 区分手指 ──
    // MT-B 用 slot + tracking id 跟踪每根手指，第一根按下的手指是主指针（isPrimary）；
    // 没有 tracking id 的旧设备退回单指 BTN_TOUCH 路径。
    const touchByContacts = touchscreen && hasTrackingId;
    type TouchContact = {
        pointerId: number;
        primary: boolean;
        x: number;
        y: number;
        /** 本帧新按下，还没有发过 down */
        starting: boolean;
        /** 坐标在本帧变化过 */
        moved: boolean;
        /** 已抬起，本帧发完 up 后删除 */
        released: boolean;
    };
    const touchContacts = new Map<number, TouchContact>(); // MT slot → 接触点
    let primaryTouchId: number | undefined;
    const primaryContact = () => {
        for (const c of touchContacts.values()) if (c.pointerId === primaryTouchId) return c;
        return undefined;
    };
    const followContact = () => {
        const p = primaryContact();
        if (p) return p;
        for (const c of touchContacts.values()) if (!c.released) return c;
        return undefined;
    };
    // 同一 phys 的伴随鼠标节点在出事件时，说明内核走的是相对鼠标通道，
    // 触摸板绝对值就不要再用，避免双倍位移
    const companionActive = () => {
        if (!info.phys) return false;
        const t = relativeActivity.get(info.phys);
        return t !== undefined && performance.now() - t < 500;
    };
    // 触摸板事件工具：自己订阅设备事件，桌面只接收 move/scroll/button 语义事件
    const touchpadInput =
        touchpad && abs
            ? new TouchpadInput(dev, info, {
                  mapX: (code, value) => {
                      const ratio = MInputMap.absRatio(info, code, value);
                      return ratio === undefined ? undefined : ratioToView(ratio, window.innerWidth);
                  },
                  mapY: (code, value) => {
                      const ratio = MInputMap.absRatio(info, code, value);
                      return ratio === undefined ? undefined : ratioToView(ratio, window.innerHeight);
                  },
                  ignoreAbs: companionActive,
              })
            : undefined;
    touchpadInput?.on("move", (moveX, moveY) => {
        pointerPos.x = Math.min(Math.max(pointerPos.x + moveX, 0), window.innerWidth - 1);
        pointerPos.y = Math.min(Math.max(pointerPos.y + moveY, 0), window.innerHeight - 1);
        emit({
            kind: "pointer",
            type: "move",
            x: pointerPos.x,
            y: pointerPos.y,
            pointerType: kind,
            source: "evdev",
        });
    });
    touchpadInput?.on("scroll", (deltaX, deltaY) => {
        emit({
            kind: "pointer",
            type: "wheel",
            x: pointerPos.x,
            y: pointerPos.y,
            deltaX,
            deltaY,
            source: "evdev",
        });
    });
    touchpadInput?.on("button", (action, button) => {
        emit({
            kind: "pointer",
            type: action,
            x: pointerPos.x,
            y: pointerPos.y,
            button,
            pointerType: kind,
            source: "evdev",
        });
    });

    function flushFrame() {
        if ((dx || dy) && touchpad && companionActive()) {
            dx = 0;
            dy = 0;
        }
        if (dx || dy) {
            pointerPos.x = Math.min(Math.max(pointerPos.x + dx, 0), window.innerWidth - 1);
            pointerPos.y = Math.min(Math.max(pointerPos.y + dy, 0), window.innerHeight - 1);
            dx = 0;
            dy = 0;
            moved = true;
        }
        if (moved) {
            moved = false;
            emit({
                kind: "pointer",
                type: "move",
                x: pointerPos.x,
                y: pointerPos.y,
                pointerType: kind,
                source: "evdev",
            });
        }
        // 触屏各接触点：先按下、再移动、最后抬起，顺序与 DOM pointer 事件一致
        for (const [slot, c] of touchContacts) {
            if (c.starting) {
                c.starting = false;
                emit({
                    kind: "pointer",
                    type: "down",
                    x: c.x,
                    y: c.y,
                    button: 0,
                    pointerType: kind,
                    pointerId: c.pointerId,
                    isPrimary: c.primary,
                    source: "evdev",
                });
            } else if (c.moved) {
                c.moved = false;
                emit({
                    kind: "pointer",
                    type: "move",
                    x: c.x,
                    y: c.y,
                    pointerType: kind,
                    pointerId: c.pointerId,
                    isPrimary: c.primary,
                    source: "evdev",
                });
            }
            if (c.released) {
                emit({
                    kind: "pointer",
                    type: "up",
                    x: c.x,
                    y: c.y,
                    button: 0,
                    pointerType: kind,
                    pointerId: c.pointerId,
                    isPrimary: c.primary,
                    source: "evdev",
                });
                touchContacts.delete(slot);
            }
        }
        if (wheelX || wheelY) {
            const deltaX = wheelX;
            const deltaY = wheelY;
            wheelX = 0;
            wheelY = 0;
            emit({
                kind: "pointer",
                type: "wheel",
                x: pointerPos.x,
                y: pointerPos.y,
                deltaX,
                deltaY,
                source: "evdev",
            });
        }
        const frame = frameKeys.splice(0);
        for (const { code, value } of frame) {
            const button = BTN_TO_BUTTON[code];
            if (button !== undefined) {
                emit({
                    kind: "pointer",
                    type: value === 1 ? "down" : "up",
                    x: pointerPos.x,
                    y: pointerPos.y,
                    button,
                    pointerType: kind,
                    source: "evdev",
                });
            } else {
                // 键盘按键（BTN_*（>=BTN_0）是鼠标/触屏按钮，走上面的分支）
                emit({
                    kind: "key",
                    type: value === 0 ? "up" : "down",
                    code,
                    repeat: value === 2,
                    source: "evdev",
                });
            }
        }
    }

    if (!dev.startReading().ok) return;

    dev.on("relative", (code, value) => {
        // 相对设备出过事件：同 phys 的触摸板绝对坐标视为伴随鼠标通道的重复上报
        if (!touchpad && info.phys) relativeActivity.set(info.phys, performance.now());
        if (code === InputEventCodes.REL_X) dx += value;
        else if (code === InputEventCodes.REL_Y) dy += value;
        else if (code === InputEventCodes.REL_WHEEL_HI_RES) wheelY += -value * HI_RES_SCALE;
        else if (code === InputEventCodes.REL_HWHEEL_HI_RES) wheelX += value * HI_RES_SCALE;
        else if (code === InputEventCodes.REL_WHEEL && !hiResWheel) wheelY += -value * WHEEL_STEP;
        else if (code === InputEventCodes.REL_HWHEEL && !hiResWheel) wheelX += value * WHEEL_STEP;
    });
    dev.on("absolute", (code, value) => {
        if (!abs) return;
        // 触摸板的绝对坐标由事件工具订阅并转换
        if (touchpad) return;
        if (code === InputEventCodes.ABS_MT_SLOT) {
            sawSlot = true;
            slot = value;
            return;
        }
        if (touchscreen) {
            // 旧设备没有 MT tracking id：只支持单指，按下/抬起走 BTN_TOUCH
            if (!touchByContacts) {
                if (sawSlot && slot !== 0) return;
                if (code === abs.xCode) {
                    pointerPos.x = ratioToView(abs.ratioX(value), window.innerWidth);
                    moved = true;
                } else if (code === abs.yCode) {
                    pointerPos.y = ratioToView(abs.ratioY(value), window.innerHeight);
                    moved = true;
                }
                return;
            }
            if (code === InputEventCodes.ABS_MT_TRACKING_ID) {
                if (value === -1) {
                    const c = touchContacts.get(slot);
                    if (c) {
                        c.released = true;
                        if (primaryTouchId === c.pointerId) primaryTouchId = undefined;
                    }
                } else if (!touchContacts.has(slot)) {
                    // 第一根手指是主指针；之后的手指各自有独立的 pointerId
                    const c: TouchContact = {
                        pointerId: nextTouchPointerId++,
                        primary: touchContacts.size === 0,
                        x: pointerPos.x,
                        y: pointerPos.y,
                        starting: true,
                        moved: false,
                        released: false,
                    };
                    touchContacts.set(slot, c);
                    if (c.primary) primaryTouchId = c.pointerId;
                }
                return;
            }
            // 同时接受 ABS_X/ABS_Y（内核合成的单指坐标）和 ABS_MT_POSITION_*（每根手指自己的坐标）
            const isX = code === InputEventCodes.ABS_X || code === InputEventCodes.ABS_MT_POSITION_X;
            const isY = code === InputEventCodes.ABS_Y || code === InputEventCodes.ABS_MT_POSITION_Y;
            if (!isX && !isY) return;
            const ratio = MInputMap.absRatio(info, code, value);
            if (ratio === undefined) return;
            // MT 定位轴按 slot 找手指；ABS_X/ABS_Y 是单指坐标，跟随主手指
            const mtPosition = isX
                ? code === InputEventCodes.ABS_MT_POSITION_X
                : code === InputEventCodes.ABS_MT_POSITION_Y;
            const c = mtPosition ? touchContacts.get(slot) : followContact();
            if (!c) return;
            const pos = ratioToView(ratio, isX ? window.innerWidth : window.innerHeight);
            if (isX) {
                if (pos !== c.x) {
                    c.x = pos;
                    c.moved = true;
                }
            } else if (pos !== c.y) {
                c.y = pos;
                c.moved = true;
            }
            if (c.primary) {
                pointerPos.x = c.x;
                pointerPos.y = c.y;
            }
            return;
        }
        // 数位板等其它绝对设备：悬停也跟踪
        if (code === abs.xCode) {
            pointerPos.x = ratioToView(abs.ratioX(value), window.innerWidth);
            moved = true;
        } else if (code === abs.yCode) {
            pointerPos.y = ratioToView(abs.ratioY(value), window.innerHeight);
            moved = true;
        }
    });
    dev.on("key", (code, value) => {
        if (touchpad) {
            // 触摸板的 BTN_TOUCH/BTN_TOOL_*/物理按键由事件工具订阅，
            // BTN_TOUCH 只是“手指接触”不能当左键
            if (touchpadInput) return;
            if (code === InputEventCodes.BTN_TOUCH) return;
        }
        if (touchscreen && code === InputEventCodes.BTN_TOUCH) {
            // 多接触设备每根手指的按下/抬起由 tracking id 产生，BTN_TOUCH 只表示“还有手指”
            if (touchByContacts) return;
            // 单指旧设备仍走下面的 BTN_TO_BUTTON 分支
        }
        if (BTN_TO_BUTTON[code] !== undefined) {
            if (value === 0 || value === 1) frameKeys.push({ code, value });
        } else if (code < InputEventCodes.BTN_0) {
            // 键盘按键
            frameKeys.push({ code, value });
        }
    });
    dev.on("sync", flushFrame);
}

/** 接入 input api：逐设备解码 evdev 事件流（含热插拔），产出统一输入事件 */
function useEvdevInput(input: InputManager, emit: (e: UniInputEvent) => void, pointerPos: InputPointerPos) {
    // phys → 最近一次相对位移时间：触摸板与它的伴随鼠标节点共用
    const relativeActivity = new Map<string, number>();
    for (const info of input.getDevices()) {
        useEvdevDevice(input, emit, pointerPos, info.path, relativeActivity);
    }
    input.on("deviceAdded", (info) => {
        useEvdevDevice(input, emit, pointerPos, info.path, relativeActivity);
    });
}

// evdev 原生输入：判定/换算工具见 input_evdev.ts
// 只在 desktop（DRM/myde-wrap）模式用：此时没有宿主桌面转发指针/键盘事件，
// 桌面自己读设备。window 模式下 Chromium 已经从宿主合成器拿到 DOM 输入，
// 再用 evdev 会两路叠加（鼠标位移/按键各走一遍）。
if (MSysApi.display.getType() === "desktop" && inputApi?.isInitialized()) {
    useEvdevInput(inputApi, dispatchInput, inputPointerPos);
    console.log(`[input] use evdev native input (${inputApi.getAccessMode?.() ?? "unknown"})`);
} else {
    console.log("[input] use dom input");
}

MSysApi.getDesktopEntries().then((e) => {
    for (const x of e) {
        MSysApi.getDesktopIcon(x.icon, {
            theme: setting.get("icon.theme"),
        });
    }
}); // 预加载
