import { addClass, addStyle, button, check, type ElType, ele, image, input, pack, spacer, txt, view } from "dkh-ui";
import { AnimationGear, timingFunction } from "myde-ui";
import type {
    ConnectConnection,
    DesktopIconConfig,
    DeviceInfo,
    FileChooserRequest,
    InputManager,
    UniInputEvent,
    WinHandle,
} from "../../../src/desktop-api";
import { InputEventCodes } from "../../../src/input_codes/types";
import type { blueDevice } from "../../../src/sys_api/blue";
import type { MenuItem } from "../../../src/sys_api/menu";
import type { wifiDevice } from "../../../src/sys_api/network";
import type { NotificationData } from "../../../src/sys_api/notification";
import type { powerDevice } from "../../../src/sys_api/power";
import { TouchpadInput } from "../../../src/utils/touchpad";
import type { DragStartInfo, GestureCommand, WindowInfo } from "../../../src/wayland";
import { type ClipboardItem, type ClipboardStation, initClipboard } from "./clipboard";
import { createClipboardStationTool } from "./clipboard_tool";
import { Cursor } from "./cursor";
import { createFileChooserContent, fileChooserHeaderIcon, fileChooserTitle } from "./file_chooser";
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
import { latinVariants } from "./latin";
import { Registry } from "./registry";
import { ScreenManager } from "./screen";
import { dynamicScrollList } from "./scroll-list";
import { type SearchAiHandler, SearchEngine, type SearchProvider, type SearchResult, scoreLatin } from "./search";
import { createSettingsContent, type ImePanelPreeditMode } from "./settings";
import {
    aLineText,
    gGlassStyle,
    iItem,
    mMedia,
    nNotiList,
    nNumber,
    px,
    rRange,
    sSize,
    sSize2,
    tTrayMenu,
    ui,
    vVolume,
} from "./ui";

/** Chromium / Electron 的 Scheduler API；当前 TS lib 没有声明 */
declare const scheduler: { yield(): Promise<void> };

const debugGesture =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.MYDE_DEBUG_GESTURE === "1";

// ========== Registry 和 ControlNode ==========

/** 剪贴板数据层（server 创建后 init，见 `initClipboard`）；焦点路径可能早于初始化，所以可空 */
let clipboard: ClipboardStation | undefined;

type ToolShowTip = (s?: { state?: "show" | "hide" | "toggle"; anchorEl?: HTMLElement }) => void;
/** 剪贴板/中转站顶栏工具；拖拽事件会直接打开它 */
let clipboardStationTool: ReturnType<typeof createClipboardStationTool> | undefined;
let clipboardToolEl: HTMLElement | undefined;
let showClipboardTip: ToolShowTip | undefined;
/** 当前进行中的客户端拖拽；指针落在中转站弹窗上时把数据收进来 */
let activeDrag: DragStartInfo | undefined;
/** 中转站自动弹出可能正好盖住指针，要求指针在弹窗上停留一小段时间才算“要放这里” */
let stationHoverAt = 0;
let stationWasHover = false;

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
    "power.battery.charging": boolean;
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
    "power.profiles": id<"power.profiles[]">[];
    "power.profiles[]": {
        name: string;
        label: string;
    };
    "power.profile": string;
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
        /** summary */
        title: string;
        /** body */
        content: string;
        id: number;
        appName: string;
        appIcon: string;
        actions: string[];
        hints: Record<string, unknown>;
        expireTimeout: number;
        replacesId: number;
        closed: boolean;
        /** 1 超时 / 2 用户关闭 / 3 CloseNotification；活动通知为 0 */
        reason: number;
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
    "brightness.displays": id<"brightness.displays[]">[];
    "brightness.displays[]": {
        name: string;
        kind: "backlight" | "ddc";
        writable: boolean;
    };
    "brightness.displays[].brightness": number;
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

function createToggle(registry: tmpRegistry, id: BooleanRegistryKeys): ControlNode {
    const source = registry.get(id);
    const toggle = check(id, ["on", "off"]);

    const unsub = source.getAndSubscribe((v) => toggle.sv(v));

    toggle.el.addEventListener("change", () => {
        source.set?.(toggle.gv);
    });

    return { id, type: "toggle", el: toggle as unknown as ElType<HTMLElement>, unmount: unsub };
}

const { MSysApi, MInputMap, MUtils, MSetting } = myde;
const fs = MSysApi.fs;

type InternalWindowEntry = {
    el: ElType<HTMLDivElement>;
    title: string;
    setActive(active: boolean): void;
    close(): void;
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

type ViewTransform = {
    x: number;
    y: number;
    scale: number;
    opacity: number;
    /** 特殊屏淡出时的模糊量（px），普通屏为 0 */
    blur: number;
};

type ViewScreen = {
    readonly id: string;
    winId?: MWinId;
    empty: boolean;
    /** 启动台：固定在最右的应用图标屏，和空桌面一样不参与全局预览 */
    launchpad: boolean;
    /** 最近一次停留满缓冲期、成为当前屏的顺序，重排时从小到大（旧的到新的） */
    used: number;
    el: ElType<HTMLElement>;
    gear: AnimationGear<ViewTransform>;
    visual: ViewTransform;
    target: ViewTransform;
};

const SCREEN_TRANSITION = { duration: 320, map: timingFunction.easeOut };
/** 三指横滑位移倍率默认值；设置窗口可调 */
const DEFAULT_GESTURE_GAIN = 4;
/** 切屏后重排新旧顺序的延迟默认值（毫秒）；设置窗口可调 */
const DEFAULT_REORDER_DELAY = 3000;
/** 总览卡片间距（CSS px） */
const OVERVIEW_GAP = 24;
/** 三指手势判定横/竖方向前的死区（CSS px） */
const GESTURE_AXIS_DEADZONE = 12;
/** 三指上下滑从常规到全局预览的完整行程，按可用高度比例 */
const OVERVIEW_SWIPE_DISTANCE = 0.25;
/** 三指下拉展开启动器输入框的完整行程，按可用高度比例 */
const LAUNCHER_SWIPE_DISTANCE = 0.2;
/** 启动器输入框高度（CSS px） */
const LAUNCHER_HEIGHT = 52;
/** 全局预览时启动器距工作区顶部（CSS px） */
const OVERVIEW_LAUNCHER_TOP = 12;
/** 全局预览 grid 顶部为启动器预留的高度 */
const OVERVIEW_TOP_INSET = OVERVIEW_LAUNCHER_TOP + LAUNCHER_HEIGHT + 24;

type LauncherController = {
    getProgress(): number;
    getOverviewMix(): number;
    setProgress(progress: number): void;
    setOverviewMix(overview: number): void;
    animateVisual(progress: number, overview: number, onComplete?: () => void): void;
    settle(): void;
    isVisible(): boolean;
    blur(): void;
    /** 打开搜索栏并聚焦输入 */
    open(): void;
    /** 关闭搜索栏；全局预览中只失焦，启动器本身保持可见 */
    close(): void;
    /** Copilot 键：未展开时打开，有输入时交给 AI，空输入时收起 */
    copilot(): void;
    setAiHandler(handler: SearchAiHandler | undefined): void;
    /** 供后续处理器/AI 面板接入 */
    readonly search: SearchEngine;
    setStageSize(height: number): void;
    /** 舞台铺满视口时顶部工具栏仍覆盖在 stage 上，总览/搜索栏要额外下移这么多 */
    setTopInset(px: number): void;
    /** 桌面 UI 缩放；内部按缩放后的局部像素计算位置 */
    setUiScale(scale: number): void;
};

/** 三指横滑的当前倍率 */
let gestureSwitchGain = DEFAULT_GESTURE_GAIN;
/** 当前切屏重排延迟（毫秒） */
let reorderDelay = DEFAULT_REORDER_DELAY;

function normalizeGestureGain(value: unknown) {
    const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_GESTURE_GAIN;
    return Math.min(8, Math.max(1, n));
}

function normalizeReorderDelay(value: unknown) {
    const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_REORDER_DELAY;
    return Math.min(10000, Math.max(300, n));
}

function clampNumber(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

/** 输入法控制层在下方创建；焦点回调可能早于此时，统一走可选链 */
let ime: ImeController | undefined;

class ViewData {
    /** 所有虚拟屏，从左到右；空桌面永远在最后（最右） */
    private screens: ViewScreen[] = [];
    private win2Screen = new Map<MWinId, ViewScreen>();
    /** 当前聚焦的窗口 handle，键盘按它反查客户端下发 */
    focusHandle: MWinId | undefined;
    /** 全局预览（grid）状态 */
    overview = false;
    /** 预览进度：0 常规，1 完整 grid；上下滑过程中连续变化 */
    private overviewProgress = 0;
    private launcher?: LauncherController;
    /** 进入全局预览前的启动器进度，退出时恢复 */
    private launcherBeforeOverview = 0;

    private currentId = "";
    private usedSeq = 0;
    private nextId = 1;
    private reorderTimer: number | undefined;
    private chromeCallback?: () => void;
    private chromeInsets = { top: 0, bottom: 0, left: 0, right: 0 };
    private stageWidth = 1;
    private stageHeight = 1;
    private gesture:
        | {
              offset: number;
              base: Map<string, ViewTransform>;
              totalX: number;
              totalY: number;
              /** 手势开始时的预览进度，松手时按当前进度吸附 */
              startOverviewProgress: number;
              /** 手势开始时的启动器进度 */
              startLauncherProgress: number;
              /** 竖向手势本次控制的是预览还是启动器 */
              verticalRole: "none" | "overview" | "launcher";
              axis: "none" | "horizontal" | "vertical";
          }
        | undefined;

    constructor() {
        this.createEmptyScreen();
        this.createLaunchpadScreen();
        this.currentId = this.screens[0]?.id ?? "";
        this.render(false);
    }

    get launchpadScreen() {
        return this.screens.find((s) => s.launchpad);
    }

    get gestureActive() {
        return this.gesture !== undefined;
    }

    setLauncher(launcher: LauncherController) {
        this.launcher = launcher;
    }

    toggleLauncher() {
        if (this.overview) return;
        const visible = (this.launcher?.getProgress() ?? 0) > 0.5;
        // 隐藏状态下先把停靠位置归到常规，避免从预览顶部淡入
        this.launcher?.setOverviewMix(0);
        this.launcher?.animateVisual(visible ? 0 : 1, 0);
    }

    private currentIndex() {
        const index = this.screens.findIndex((s) => s.id === this.currentId);
        return index >= 0 ? index : Math.max(0, this.screens.length - 1);
    }

    private currentScreen() {
        return this.screens.find((s) => s.id === this.currentId);
    }

    /** 只允许当前虚拟屏里的窗口接收指针，滚动同理 */
    isCurrentWin(winid: MWinId) {
        return this.win2Screen.get(winid)?.id === this.currentId;
    }

    /** 当前虚拟屏的窗口；空桌面/启动台没有窗口 */
    currentWinId() {
        return this.currentScreen()?.winId;
    }

    /** 视图状态（当前屏/总览）变化后回调，用来同步全屏时工具栏的避让 */
    setChromeCallback(cb: () => void) {
        this.chromeCallback = cb;
    }

    /** 工具栏在 stage 内的占位；总览 grid 和搜索栏会用它避开工具栏 */
    setChromeInsets(insets: { top: number; bottom: number; left: number; right: number }) {
        const prev = this.chromeInsets;
        if (
            prev.top === insets.top &&
            prev.bottom === insets.bottom &&
            prev.left === insets.left &&
            prev.right === insets.right
        )
            return;
        this.chromeInsets = { ...insets };
        this.launcher?.setTopInset(insets.top);
    }

    setStageSize(width: number, height: number) {
        if (width <= 0 || height <= 0) return;
        if (Math.abs(width - this.stageWidth) < 0.5 && Math.abs(height - this.stageHeight) < 0.5) return;
        this.stageWidth = width;
        this.stageHeight = height;
        this.launcher?.setStageSize(height);
        this.cancelGesture();
        this.render(false);
    }

    private createScreen(kind: "empty" | "launchpad") {
        const id = `view-${this.nextId++}`;
        const el = createScreenEl(id, () => {
            if (this.overview) this.selectFromOverview(id);
        });
        const start = { x: this.stageWidth, y: 0, scale: 1, opacity: 1, blur: 0 };
        const gear = new AnimationGear<ViewTransform>(start, { transition: SCREEN_TRANSITION });
        const screen: ViewScreen = {
            id,
            empty: kind === "empty",
            launchpad: kind === "launchpad",
            used: 0,
            el,
            gear,
            visual: { ...start },
            target: { ...start },
        };
        gear.setUpdateCallback((value) => {
            screen.visual = value;
            applyScreenTransform(el, value);
        });
        return screen;
    }

    private createEmptyScreen() {
        const screen = this.createScreen("empty");
        // 空桌面始终在启动台左边
        const launchpadIndex = this.screens.findIndex((s) => s.launchpad);
        if (launchpadIndex >= 0) this.screens.splice(launchpadIndex, 0, screen);
        else this.screens.push(screen);
        return screen;
    }

    private createLaunchpadScreen() {
        const screen = this.createScreen("launchpad");
        this.screens.push(screen);
        return screen;
    }

    /**
     * 新窗口占用右侧的空桌面；空桌面自动补到最右。
     * 有父窗口时子窗口不占屏，直接挂到父窗口所在的屏上。
     */
    addWindowScreen(winid: MWinId, parent?: MWinId) {
        this.cancelGesture();
        const parentScreen = parent === undefined ? undefined : this.win2Screen.get(parent);
        if (parentScreen) {
            this.win2Screen.set(winid, parentScreen);
            // 子窗口出现时把视图切到父窗口所在屏（它可能在其他虚拟屏上）
            this.currentId = parentScreen.id;
            this.setOverviewInternal(false);
            this.render(true);
            return parentScreen;
        }
        let empty = this.screens.find((s) => s.empty);
        if (!empty) empty = this.createEmptyScreen();
        empty.empty = false;
        empty.winId = winid;
        empty.used = ++this.usedSeq;
        this.win2Screen.set(winid, empty);
        this.createEmptyScreen();
        this.currentId = empty.id;
        this.setOverviewInternal(false);
        this.scheduleReorder();
        this.render(true);
        return empty;
    }

    /**
     * 父子关系变化（`window.changed` 的 parent 差分）：
     * 子窗口搬到父窗口的屏，或取消父关系后重新占一个空桌面。
     * 只调整视图数据；元素搬动由调用方按返回的屏去做。
     */
    reparentWindow(winid: MWinId, parent: MWinId | undefined): ViewScreen | undefined {
        const screen = this.win2Screen.get(winid);
        const parentScreen = parent === undefined ? undefined : this.win2Screen.get(parent);
        if (parentScreen !== undefined) {
            if (screen !== undefined && screen.winId === winid) this.removeOwnScreen(screen, parentScreen);
            this.win2Screen.set(winid, parentScreen);
            return parentScreen;
        }
        if (screen !== undefined && screen.winId === winid) return screen;
        return this.addWindowScreen(winid);
    }

    /** 撤掉窗口独占的虚拟屏（窗口改挂到父窗口上时）；当前屏落到 fallback */
    private removeOwnScreen(screen: ViewScreen, fallback?: ViewScreen) {
        this.cancelGesture();
        const index = this.screens.indexOf(screen);
        if (index < 0) return;
        const wasCurrent = screen.id === this.currentId;
        screen.gear.moveTo(screen.visual, 0);
        screen.el.remove();
        this.screens.splice(index, 1);
        if (wasCurrent) {
            const next = fallback ?? this.screens[Math.min(index, this.screens.length - 1)] ?? this.screens[0];
            if (next) {
                this.currentId = next.id;
                if (next.winId) this.focusWin(next.winId);
                else this.blurAll();
            }
        }
        this.render(false);
    }

    /**
     * 切到某个虚拟屏。缓冲期内 `screens` 的空间顺序不变，只改当前屏；
     * 到点后把当前屏记为一次使用，再按最近使用顺序重排。
     * 途经的屏不算使用，否则连续切几屏会把中间屏也算成更新的。
     */
    setCurrentScreen(id: string, animate = true) {
        const screen = this.screens.find((s) => s.id === id);
        if (!screen) return;
        this.cancelGesture();
        this.currentId = screen.id;
        if (screen.winId) this.focusWin(screen.winId);
        else this.blurAll();
        this.scheduleReorder();
        this.render(animate);
    }

    /** 沿当前顺序跳到左边/右边的虚拟屏 */
    moveCurrent(delta: number, animate = true) {
        const index = this.currentIndex() + delta;
        const screen = this.screens[index];
        if (!screen) return;
        this.setCurrentScreen(screen.id, animate);
    }

    jumpToWin(winid: MWinId) {
        const screen = this.win2Screen.get(winid);
        if (!screen) return;
        this.setOverviewInternal(false);
        this.setCurrentScreen(screen.id, true);
    }

    /** 搜索栏用：当前全部虚拟屏（含空桌面、启动台），按空间顺序 */
    listScreens() {
        return this.screens.map((screen, index) => {
            let title = "空桌面";
            let kind: "empty" | "launchpad" | "window" = "empty";
            let appid = "";
            if (screen.launchpad) {
                title = "启动台";
                kind = "launchpad";
            } else if (screen.winId) {
                kind = "window";
                title = this.windowTitle(screen.winId);
                appid = internalWindows.has(screen.winId)
                    ? "桌面窗口"
                    : server.server.windows.get(screen.winId)?.appid || "";
            }
            return {
                id: screen.id,
                title,
                subtitle: `虚拟屏 ${index + 1}`,
                kind,
                appid,
                current: screen.id === this.currentId,
            };
        });
    }

    /** 搜索栏用：占着虚拟屏的窗口，包含设置、文件选择器等内部窗口 */
    listWindows() {
        const out: {
            handle: MWinId;
            title: string;
            appid: string;
            screenId: string;
            current: boolean;
        }[] = [];
        for (const screen of this.screens) {
            const handle = screen.winId;
            if (!handle) continue;
            const internal = internalWindows.get(handle);
            const info = internal ? undefined : server.server.windows.get(handle);
            out.push({
                handle,
                title: internal ? internal.title : info?.title || info?.appid || "窗口",
                appid: internal ? "桌面窗口" : info?.appid || "",
                screenId: screen.id,
                current: screen.id === this.currentId,
            });
        }
        return out;
    }

    switchScreen(id: string) {
        this.setOverviewInternal(false);
        this.setCurrentScreen(id, true);
    }

    /** Super+D：切到空桌面；已经在空桌面时回到最近使用的应用屏 */
    toggleEmptyScreen() {
        const empty = this.screens.find((s) => s.empty);
        if (!empty) return;
        if (this.currentId !== empty.id) {
            this.switchScreen(empty.id);
            return;
        }
        const previous = this.screens.filter((s) => !s.empty && !s.launchpad).sort((a, b) => b.used - a.used)[0];
        if (previous) this.switchScreen(previous.id);
    }

    private windowTitle(winid: MWinId) {
        if (internalWindows.has(winid)) return internalWindows.get(winid)?.title || "桌面窗口";
        const info = server.server.windows.get(winid);
        return info?.title || info?.appid || "窗口";
    }

    closeWin(winid: MWinId) {
        const screen = this.win2Screen.get(winid);
        if (!screen) return undefined;
        // 子窗口只从父窗口的屏里摘掉自己：父窗口和虚拟屏都还在，焦点回到父窗口
        if (screen.winId !== winid) {
            this.win2Screen.delete(winid);
            if (this.focusHandle === winid) {
                const parent = windowParents.get(winid);
                if (parent !== undefined) this.focusWin(parent);
                else this.blurAll();
            }
            return undefined;
        }
        this.cancelGesture();
        this.win2Screen.delete(winid);
        const index = this.screens.indexOf(screen);
        const wasCurrent = screen.id === this.currentId;
        screen.gear.moveTo(screen.visual, 0);
        screen.el.remove();
        this.screens.splice(index, 1);
        // 随屏一起消失的还有仍挂在这个屏上的子窗口映射（父窗口先关、客户端整体退出）
        for (const [other, mapped] of this.win2Screen) {
            if (mapped === screen) this.win2Screen.delete(other);
        }

        let next: ViewScreen | undefined;
        if (wasCurrent) {
            // 优先回上一个应用，没有就落到右边（通常是空桌面）
            next = this.screens[Math.min(index - 1, this.screens.length - 1)] ?? this.screens[0];
            if (next) {
                this.currentId = next.id;
                if (next.winId) this.focusWin(next.winId);
                else this.blurAll();
                this.scheduleReorder();
            }
        } else if (this.focusHandle === winid) {
            this.blurAll();
        }
        this.render(this.overview || wasCurrent);
        return next;
    }

    setOverview(on: boolean) {
        if (this.overview === on && this.overviewProgress === (on ? 1 : 0)) return;
        this.cancelGesture();
        this.applyOverview(on);
    }

    toggleOverview() {
        this.setOverview(!this.overview);
    }

    private applyOverview(on: boolean) {
        this.setOverviewInternal(on);
        if (on) {
            cursor.setLocalShape(undefined);
        } else {
            this.scheduleReorder();
        }
        this.render(true);
    }

    private setOverviewInternal(on: boolean) {
        const wasOverview = this.overview;
        this.overview = on;
        this.overviewProgress = on ? 1 : 0;
        if (on) {
            if (!wasOverview) {
                // 进入全局预览时启动器出现在 grid 上方；退出时恢复进入前的状态
                this.launcherBeforeOverview = this.launcher?.getProgress() ?? 0;
                if (this.launcher) {
                    if (this.launcher.isVisible()) {
                        // 常规可见：保持在原位，只从三分之一移到顶部
                        this.launcher.animateVisual(1, 1);
                    } else {
                        // 隐藏：直接放到顶部隐藏位置，再只做轻微滑入
                        this.launcher.setOverviewMix(1);
                        this.launcher.animateVisual(1, 1);
                    }
                }
            }
            this.cancelReorder();
        } else if (wasOverview) {
            if (this.launcherBeforeOverview >= 0.5) {
                // 进入前就是可见的：回到常规三分之一位置并保持可见
                this.launcher?.animateVisual(1, 0);
            } else {
                // 进入前隐藏：从顶部滑出工作区；隐藏位置与停靠 mix 无关
                this.launcher?.animateVisual(0, 1);
            }
        }
        windowEl.el.toggleAttribute("data-overview", on);
    }

    private selectFromOverview(id: string) {
        const screen = this.screens.find((s) => s.id === id);
        if (!screen || screen.empty) return;
        this.setOverviewInternal(false);
        this.setCurrentScreen(screen.id, true);
    }

    startGesture() {
        // 预览里也允许起手，用来识别三指下滑退出
        if (this.gesture || (!this.overview && this.screens.length < 2)) return;
        this.settleAnimation();
        this.launcher?.settle();
        const base = new Map<string, ViewTransform>();
        for (const screen of this.screens) base.set(screen.id, { ...screen.target });
        this.gesture = {
            offset: 0,
            base,
            totalX: 0,
            totalY: 0,
            startOverviewProgress: this.overviewProgress,
            startLauncherProgress: this.launcher?.getProgress() ?? 0,
            verticalRole: "none",
            axis: "none",
        };
    }

    private overviewSwipeDistance() {
        return Math.max(120, this.stageHeight * OVERVIEW_SWIPE_DISTANCE);
    }

    private launcherSwipeDistance() {
        return Math.max(100, this.stageHeight * LAUNCHER_SWIPE_DISTANCE);
    }

    /** 按 0..1 的进度把每个虚拟屏从常规位置插值到 grid 位置 */
    private renderOverviewPull(progress: number) {
        const normal = this.normalTargets(0);
        const overview = this.overviewTargets();
        const hidden = { x: -this.stageWidth * 2, y: 0, scale: 1, opacity: 0, blur: 0 };
        const p = clampNumber(progress, 0, 1);
        for (const screen of this.screens) {
            const special = screen.empty || screen.launchpad;
            // 特殊屏在虚拟屏下面；预览/过渡中当前应用屏再高一层，避免被其他屏盖住
            const z = special
                ? "0"
                : overview
                  ? screen.id === this.currentId
                      ? "2"
                      : "1"
                  : screen.id === this.currentId
                    ? "1"
                    : "0";
            screen.el.style({ zIndex: z });
            const from = normal.get(screen.id) ?? hidden;
            const to = overview.get(screen.id);
            if (!to) {
                // 空桌面和启动台不参与预览，留在原位淡出；启动台再缩小和模糊
                const shrink = screen.launchpad ? 1 - 0.12 * p : 1;
                const value = {
                    x: from.x + (this.stageWidth * (1 - shrink)) / 2,
                    y: from.y + (this.stageHeight * (1 - shrink)) / 2,
                    scale: from.scale * shrink,
                    opacity: from.opacity * (1 - p),
                    blur: screen.launchpad ? p * 8 : 0,
                };
                screen.visual = value;
                screen.target = value;
                applyScreenTransform(screen.el, value);
                continue;
            }
            const value = {
                x: from.x + (to.x - from.x) * p,
                y: from.y + (to.y - from.y) * p,
                scale: from.scale + (to.scale - from.scale) * p,
                opacity: from.opacity + (to.opacity - from.opacity) * p,
                blur: from.blur + (to.blur - from.blur) * p,
            };
            screen.visual = value;
            screen.target = value;
            applyScreenTransform(screen.el, value);
        }
    }

    private syncLauncherWithOverviewGesture(gesture: NonNullable<ViewData["gesture"]>, overviewProgress: number) {
        const launcher = this.launcher;
        if (!launcher) return;
        const p = clampNumber(overviewProgress, 0, 1);
        const entering = gesture.startOverviewProgress < 0.5;
        if (entering) {
            if (gesture.startLauncherProgress < 0.5) {
                // 隐藏 -> 全局：停在预览顶部，从工作区外滑入
                launcher.setOverviewMix(1);
                launcher.setProgress(p);
            } else {
                // 常规可见 -> 全局：保持不透明，从三分之一连续移到顶部
                launcher.setProgress(1);
                launcher.setOverviewMix(p);
            }
            return;
        }
        if (this.launcherBeforeOverview >= 0.5) {
            // 预览 -> 常规可见：保持不透明，从顶部移回三分之一
            launcher.setProgress(1);
            launcher.setOverviewMix(p);
        } else {
            // 预览 -> 隐藏：保持在顶部，向下滑动时收起
            launcher.setOverviewMix(1);
            launcher.setProgress(p);
        }
    }

    moveGesture(dx: number, dy: number) {
        const gesture = this.gesture;
        if (!gesture) return;
        gesture.totalX += dx;
        gesture.totalY += dy;

        const absX = Math.abs(gesture.totalX);
        const absY = Math.abs(gesture.totalY);
        if (gesture.axis === "none") {
            if (Math.max(absX, absY) < GESTURE_AXIS_DEADZONE) return;
            gesture.axis = absY > absX ? "vertical" : "horizontal";
        }

        if (gesture.axis === "vertical") {
            if (gesture.verticalRole === "none") {
                const up = gesture.totalY < 0;
                if (this.overview) {
                    // 预览里搜索栏不能收起；上滑自然停在满进度，下滑退出预览
                    gesture.verticalRole = "overview";
                } else if (gesture.startLauncherProgress > 0.5) {
                    // 常规已展开：上滑收起搜索栏；下滑保持不变
                    gesture.verticalRole = "launcher";
                } else {
                    // 搜索栏隐藏：上滑进入预览，下滑拉出搜索栏
                    gesture.verticalRole = up ? "overview" : "launcher";
                }
            }

            if (gesture.verticalRole === "overview") {
                // 手指往上时预览进度增大，往下时减小；同一次手势里可以连续来回
                const distance = this.overviewSwipeDistance();
                const progress = clampNumber(gesture.startOverviewProgress - gesture.totalY / distance, 0, 1);
                if (progress === this.overviewProgress) return;
                this.overviewProgress = progress;
                this.renderOverviewPull(progress);
                this.syncLauncherWithOverviewGesture(gesture, progress);
                return;
            }

            // 启动器：往下拉出，往上推回
            const distance = this.launcherSwipeDistance();
            const progress = clampNumber(gesture.startLauncherProgress + gesture.totalY / distance, 0, 1);
            this.launcher?.setOverviewMix(0);
            this.launcher?.setProgress(progress);
            return;
        }

        // 全局预览里不响应横滑
        if (this.overview) return;

        const index = this.currentIndex();
        const minOffset = -(this.screens.length - 1 - index) * this.stageWidth;
        const maxOffset = index * this.stageWidth;
        const offset = clampNumber(gesture.totalX * gestureSwitchGain, minOffset, maxOffset);
        if (offset === gesture.offset) return;
        gesture.offset = offset;
        for (const screen of this.screens) {
            const base = gesture.base.get(screen.id);
            if (!base) continue;
            const value = { ...base, x: base.x + offset };
            screen.visual = value;
            screen.target = value;
            applyScreenTransform(screen.el, value);
        }
    }

    endGesture() {
        const gesture = this.gesture;
        if (!gesture) return;
        this.gesture = undefined;

        if (gesture.axis === "vertical") {
            if (gesture.verticalRole === "launcher") {
                const visible = (this.launcher?.getProgress() ?? 0) >= 0.5;
                this.launcher?.animateVisual(visible ? 1 : 0, 0);
                return;
            }
            if (gesture.verticalRole === "overview") {
                const targetOverview = this.overviewProgress >= 0.5;
                const entering = gesture.startOverviewProgress < 0.5;
                // 从当前跟手进度吸附到最近的一端
                for (const screen of this.screens) screen.gear.moveTo(screen.visual, 0);
                this.applyOverview(targetOverview);
                if (this.launcher) {
                    if (entering) {
                        if (targetOverview) {
                            this.launcher.animateVisual(1, 1);
                            // 手势进入预览时，记录手势开始前的启动器状态，供按钮/Esc 退出时恢复
                            this.launcherBeforeOverview = gesture.startLauncherProgress;
                        } else {
                            this.launcher.animateVisual(gesture.startLauncherProgress >= 0.5 ? 1 : 0, 0);
                        }
                    } else if (targetOverview) {
                        this.launcher.animateVisual(1, 1);
                    } else if (this.launcherBeforeOverview >= 0.5) {
                        this.launcher.animateVisual(1, 0);
                    } else {
                        this.launcher.animateVisual(0, 1);
                    }
                }
            }
            return;
        }

        // 预览里横滑或点按：保持预览
        if (this.overview) {
            this.render(true);
            return;
        }

        const steps = Math.round(gesture.offset / this.stageWidth);
        const targetIndex = clampNumber(this.currentIndex() - steps, 0, this.screens.length - 1);
        const target = this.screens[targetIndex];
        // 从当前跟手位置继续动画，不要在松手时跳回旧位置
        for (const screen of this.screens) screen.gear.moveTo(screen.visual, 0);
        if (target && target.id !== this.currentId) this.setCurrentScreen(target.id, true);
        else this.render(true);
    }

    private cancelGesture() {
        if (!this.gesture) return;
        this.gesture = undefined;
        for (const screen of this.screens) screen.gear.moveTo(screen.visual, 0);
        this.overviewProgress = this.overview ? 1 : 0;
    }

    private settleAnimation() {
        for (const screen of this.screens) screen.gear.moveTo(screen.target, 0);
        this.overviewProgress = this.overview ? 1 : 0;
    }

    private scheduleReorder() {
        this.cancelReorder();
        this.reorderTimer = window.setTimeout(() => {
            this.reorderTimer = undefined;
            this.reorder();
        }, reorderDelay);
    }

    private cancelReorder() {
        if (this.reorderTimer !== undefined) {
            clearTimeout(this.reorderTimer);
            this.reorderTimer = undefined;
        }
    }

    /** 缓冲到点：当前屏记为一次使用，按最近使用重排，不需要动画 */
    private reorder() {
        if (this.overview) return;
        if (this.gesture) {
            this.scheduleReorder();
            return;
        }
        const current = this.currentScreen();
        if (current) current.used = ++this.usedSeq;
        const empty = this.screens.find((s) => s.empty);
        const launchpad = this.screens.find((s) => s.launchpad);
        const ordered = this.screens.filter((s) => !s.empty && !s.launchpad).toSorted((a, b) => a.used - b.used);
        if (empty) ordered.push(empty);
        if (launchpad) ordered.push(launchpad);
        const changed = ordered.some((s, i) => s !== this.screens[i]);
        this.screens = ordered;
        if (current) this.currentId = current.id;
        if (changed) this.render(false);
    }

    private normalTargets(offset: number) {
        const currentIndex = this.currentIndex();
        const targets = new Map<string, ViewTransform>();
        this.screens.forEach((screen, index) => {
            targets.set(screen.id, {
                x: (index - currentIndex) * this.stageWidth + offset,
                y: 0,
                scale: 1,
                opacity: 1,
                blur: 0,
            });
        });
        return targets;
    }

    /**
     * 总览 grid：忽略空桌面和启动台，新的从右往左、再从上往下铺。
     * 行列数按屏幕宽高比估算，卡片保持虚拟屏比例。
     */
    private overviewTargets() {
        const cards = this.screens
            .filter((s) => !s.empty && !s.launchpad)
            .slice()
            .reverse();
        const targets = new Map<string, ViewTransform>();
        const count = cards.length;
        if (count === 0) return targets;

        const insets = this.chromeInsets;
        const aspect = this.stageWidth / this.stageHeight;
        const cols = clampNumber(Math.round(Math.sqrt(count * aspect)), 1, count);
        const rows = Math.ceil(count / cols);
        const padding = Math.max(12, Math.min(this.stageWidth, this.stageHeight) * 0.04);
        const gap = Math.min(OVERVIEW_GAP, padding);
        // 舞台始终铺满视口，工具栏占位不会缩小 stage，总览要自己让开工具栏
        const leftBound = insets.left;
        const topBound = insets.top;
        const availableWidth = Math.max(1, this.stageWidth - insets.left - insets.right);
        const availableHeight = Math.max(1, this.stageHeight - topBound - insets.bottom);
        const topInset = OVERVIEW_TOP_INSET;
        const gridAreaHeight = Math.max(1, availableHeight - topInset);
        const cellWidth = (availableWidth - padding * 2 - gap * (cols - 1)) / cols;
        const cellHeight = (gridAreaHeight - padding * 2 - gap * (rows - 1)) / rows;
        const scale = Math.max(0.03, Math.min(cellWidth / this.stageWidth, cellHeight / this.stageHeight));
        const cardWidth = this.stageWidth * scale;
        const cardHeight = this.stageHeight * scale;
        const gridWidth = cols * cardWidth + (cols - 1) * gap;
        const gridHeight = rows * cardHeight + (rows - 1) * gap;
        const left = leftBound + (availableWidth - gridWidth) / 2;
        const top = topBound + topInset + (gridAreaHeight - gridHeight) / 2;

        cards.forEach((screen, index) => {
            const row = Math.floor(index / cols);
            const gridCol = cols - 1 - (index % cols);
            targets.set(screen.id, {
                x: left + gridCol * (cardWidth + gap),
                y: top + row * (cardHeight + gap),
                scale,
                opacity: 1,
                blur: 0,
            });
        });
        return targets;
    }

    render(animate = true) {
        // 手势跟手拖动时由 moveGesture 直接写样式，动画器只在松手/状态切换时接管
        if (this.gesture) return;
        // 先按当前屏的全屏状态决定工具栏是否隐藏
        this.chromeCallback?.();
        const normal = this.normalTargets(0);
        const overview = this.overview ? this.overviewTargets() : undefined;
        const hidden = { x: -this.stageWidth * 2, y: 0, scale: 1, opacity: 0, blur: 0 };
        for (const screen of this.screens) {
            const special = screen.empty || screen.launchpad;
            let target: ViewTransform;
            if (!overview) {
                target = normal.get(screen.id) ?? hidden;
            } else if (special) {
                // 特殊屏不进入预览：留在原位缩小、模糊、淡出，并在虚拟屏下面
                const base = normal.get(screen.id) ?? hidden;
                const shrink = screen.launchpad ? 0.88 : 1;
                target = {
                    x: base.x + (this.stageWidth * (1 - shrink)) / 2,
                    y: base.y + (this.stageHeight * (1 - shrink)) / 2,
                    scale: base.scale * shrink,
                    opacity: 0,
                    blur: screen.launchpad ? 8 : 0,
                };
            } else {
                target = overview.get(screen.id) ?? hidden;
            }
            screen.target = target;
            screen.gear.moveTo(target, animate ? SCREEN_TRANSITION : 0);
            const z = overview
                ? special
                    ? "0"
                    : screen.id === this.currentId
                      ? "2"
                      : "1"
                : screen.id === this.currentId
                  ? "1"
                  : "0";
            screen.el.style({ zIndex: z });
        }
    }

    focusWin(winid: MWinId) {
        this.launcher?.blur();
        // 模态对话框存在时不能把焦点交给它下面的窗口：聚焦最内层的模态子窗口
        winid = this.modalTarget(winid);
        const internal = internalWindows.has(winid);
        if (!internal && !server.server.windows.get(winid)) {
            console.warn("cant find window", winid);
            return;
        }
        this.focusHandle = winid;
        for (const [id, win] of internalWindows) {
            win.setActive(id === winid);
        }
        for (const [id, frame] of clientWindowFrames) {
            frame.el.el.toggleAttribute("data-active", id === winid);
        }
        // 目标聚焦、其余失焦，全部经 server 下发；内部窗口没有 Wayland 焦点，只清掉客户端焦点
        for (const info of server.server.windows.list()) {
            if (!internal && info.handle === winid) {
                server.server.notify("window.focus", info.handle);
                clipboard?.offer(info.handle);
            } else server.server.notify("window.blur", info.handle);
        }
        if (internal) void ime?.blur();
        else void ime?.focus(winid);
    }

    /** 沿模态子窗口链往下找：焦点落在最内层的模态对话框上 */
    private modalTarget(winid: MWinId): MWinId {
        let cur = winid;
        for (;;) {
            let next: MWinId | undefined;
            for (const [child, parent] of windowParents) {
                if (parent === cur && modalWindows.has(child)) {
                    next = child;
                    break;
                }
            }
            if (next === undefined) return cur;
            cur = next;
        }
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
        for (const frame of clientWindowFrames.values()) frame.el.el.removeAttribute("data-active");
        for (const info of server.server.windows.list()) {
            server.server.notify("window.blur", info.handle);
        }
        void ime?.blur();
    }
}

/** 在窗口层里创建一屏；窗口和空桌面共用这一层，只通过 transform 移动/缩放 */
function createScreenEl(id: string, onClick: () => void) {
    const el = view()
        .style({
            position: "absolute",
            left: "0",
            top: "0",
            width: "100%",
            height: "100%",
            transformOrigin: "0 0",
            willChange: "transform, opacity, filter",
            overflow: "hidden",
        })
        .data({ "view-id": id })
        .on("click", (e) => {
            e.stopPropagation();
            onClick();
        });
    windowEl.add(el);
    return el;
}

function applyScreenTransform(el: ElType<HTMLElement>, value: ViewTransform) {
    el.style({
        // 屏幕内容整体被预览缩放；覆盖层用倒数抵消，保持固定视觉尺寸
        "--view-inv-scale": `${1 / Math.max(value.scale, 0.0001)}`,
        transform: `translate3d(${value.x}px, ${value.y}px, 0) scale(${value.scale})`,
        opacity: `${value.opacity}`,
        filter: value.blur > 0 ? `blur(${value.blur}px)` : "none",
    });
}

/** 在窗口层创建完成后再实例化；之前的函数只在运行时访问它 */
let viewData!: ViewData;

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

    setViewport(x: number, y: number, width: number, height: number, recenter = true) {
        this.config.viewport = { x, y, width, height };
        if (recenter) this.recenterAll();
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
            { id: "clipboard" },
            { id: "blue" },
            { id: "network" },
            { id: "connect" },
            { id: "power" },
            { id: "volume" },
            { id: "brightness" },
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

type PointerHit = { handle: WinHandle; clientId: string };

/** 指针当前命中的客户端窗口；窗口关闭时据此立即清掉光标焦点 */
let pointerTarget: PointerHit | undefined;

/**
 * 一次按压序列的归属：
 * - `client`：已经交给 server，后续 move/up 都用 `hit` 的 handle 和局部坐标；
 * - `desktop`：落在桌面 UI 或桌面自己接管，后续 move 不再转发给客户端。
 *   客户端 grab 的按钮集合由 server 管理，这里只在桌面自己的按压上记按钮。
 */
type PointerRoute = { kind: "client"; hit: PointerHit } | { kind: "desktop"; buttons: Set<number> };
const pointerRoutes = new Map<string, PointerRoute>();

function pointerKey(p: PointerEvent) {
    return `${p.pointerType || "mouse"}:${p.pointerId ?? 1}`;
}

/** 正在用鼠标拖拽缩放的窗口 id；期间指针事件不转发给 Wayland 客户端 */
let resizingWindowId: string | undefined;

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

/** 退出桌面的按键：Super+Shift+E 或 Ctrl+Alt+Delete。
 * 在输入聚合层判定，早于桌面 UI 和状态机，页面部分逻辑失效时仍能退出。 */
const EXIT_KEY = {
    e: MInputMap.mapKeyCode("KeyE"),
    delete: MInputMap.mapKeyCode("Delete"),
    meta: [MInputMap.mapKeyCode("MetaLeft"), MInputMap.mapKeyCode("MetaRight")],
    shift: [MInputMap.mapKeyCode("ShiftLeft"), MInputMap.mapKeyCode("ShiftRight")],
    ctrl: [MInputMap.mapKeyCode("ControlLeft"), MInputMap.mapKeyCode("ControlRight")],
    alt: [MInputMap.mapKeyCode("AltLeft"), MInputMap.mapKeyCode("AltRight")],
};

/** 虚拟屏切换：Super+← 去右屏、Super+→ 去左屏，Super+Tab 开关全局预览 */
const DESKTOP_BINDINGS: KeyBinding[] = [
    { code: "ArrowLeft", meta: true },
    { code: "ArrowRight", meta: true },
    { code: "KeyD", meta: true },
    { code: "Tab", meta: true },
];

/** 当前聚焦窗口全屏：Super+F */
const FULLSCREEN_BINDINGS: KeyBinding[] = [{ code: "KeyF", meta: true }];

/** 顶部启动器：Alt+Space 拉出/收起 */
const LAUNCHER_BINDINGS: KeyBinding[] = [{ code: "Space", alt: true }];

/**
 * Copilot 键：键盘固件通常发 Shift+Super+F23，部分实现只发 F23。
 * 浏览器统一落到 `F23`，这里忽略修饰键，避免不同固件组合漏判。
 */
function isCopilotKey(e: KeyboardEvent) {
    return e.code === "F23";
}

/** 锁屏：Super+L */
const LOCK_BINDINGS: KeyBinding[] = [{ code: "KeyL", meta: true }];

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

function mouseMove(x: number, y: number, p?: PointerEvent) {
    // 更新全局鼠标坐标
    mousePos.x = x;
    mousePos.y = y;
    cursor.move(x, y);
    // 保留指针身份，按下时的归属才能按 pointerId 对上（触屏多指各自独立）
    const target = sendPointerEvent(
        "move",
        new PointerEvent("pointermove", {
            clientX: x,
            clientY: y,
            pointerType: p?.pointerType || "mouse",
            pointerId: p?.pointerId ?? 1,
            isPrimary: p?.isPrimary ?? true,
        }),
    );
    // 指针移开surface或软件后恢复默认光标，重新进入时恢复对应客户端记忆的光标
    cursor.setSurfaceFocus(target?.clientId);
}

/** 统一的窗口关闭按钮：白色圆底 + 叉号，压在任意窗口内容上都能看清 */
function createWindowCloseButton(op: { size: number; onClick: () => void }) {
    const btn = button(getIconXEl("cross", { size: Math.round(op.size * 0.55) }))
        .style({
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
        })
        .data({ "desktop-ui": "window-control" });
    btn.on("click", (e) => {
        // 预览里父级点击是跳转窗口；按钮自己先截断，避免触发跳转
        e.stopPropagation();
        op.onClick();
    });
    return btn;
}

/**
 * 全局预览里窗口右上角的关闭按钮。
 * 挂在窗口元素上，虚拟屏以后放多个窗口时每个窗口仍各自定位；
 * 卡片整体按预览比例缩小，这里用 `--view-inv-scale` 抵消，同时乘上桌面 UI 缩放，
 * 让按钮在任何缩放和卡片大小下都保持固定的视觉尺寸。
 */
function createOverviewWindowCloseButton(onClose: () => void) {
    return createWindowCloseButton({ size: 24, onClick: onClose })
        .style({
            position: "absolute",
            top: "calc(10px * var(--desktop-ui-scale, 1) * var(--view-inv-scale, 1))",
            right: "calc(10px * var(--desktop-ui-scale, 1) * var(--view-inv-scale, 1))",
            transformOrigin: "top right",
            transform: "scale(calc(var(--desktop-ui-scale, 1) * var(--view-inv-scale, 1)))",
            zIndex: "30",
        })
        .data({ "desktop-ui": "window-close" });
}

// ── 鼠标缩放窗口 ─────────────────────────────────────────────────────────────────────────────
// 窗口四周铺一圈透明热区（8 个方向），按住后按鼠标位移改 DOM 尺寸；Wayland 客户端窗口再同步
// window.setSize，让客户端按新尺寸重绘。窗口没有标题栏/边框，热区贴边覆盖在内容上。
type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const RESIZE_EDGE_SIZE = 6;
const RESIZE_CORNER_SIZE = 14;
/** 热区跨在窗口边界上时露在窗口外的比例，0.5 为居中 */
const RESIZE_OUTSIDE_RATIO = 0.5;
/** 最小窗口尺寸（逻辑 px，Wayland 窗口再按输出缩放换算成 CSS px） */
const RESIZE_MIN_WIDTH = 200;
const RESIZE_MIN_HEIGHT = 150;

/** 热区是桌面 UI；窗口本身不缩放，只让热区尺寸跟随界面缩放 */
function uiSized(px: number) {
    return `calc(${px}px * var(--desktop-ui-scale, 1))`;
}

// 拖拽预览尺寸走样式表 !important：渲染层在客户端提交时会直接写 xdg surface 元素的 inline 宽高，
// 普通 inline 样式会被它盖掉，加 !important 才能稳定显示桌面自己的预览，抬手后再摘掉属性
addStyle({
    "[data-resize-preview]": {
        width: "var(--resize-preview-width) !important",
        height: "var(--resize-preview-height) !important",
    },
    // 服务端装饰：只有标题栏有底色/模糊；内容区域保持透明，允许客户端透明窗口露出壁纸
    "[data-client-frame][data-decorated]": {
        boxShadow: "0 12px 40px #0000002a",
        borderRadius: "calc(var(--window-radius, 18px) * var(--desktop-ui-scale, 1))",
    },
    "[data-client-frame][data-decorated][data-active]": {
        boxShadow: "0 16px 48px #00000044",
    },
    // 最大化窗口与工作区边缘齐平：无圆角、无外阴影
    "[data-client-frame][data-decorated][data-maximized]": {
        borderRadius: "0",
        boxShadow: "none",
    },
    "[data-client-frame][data-decorated][data-maximized] [data-client-titlebar]": {
        borderTopLeftRadius: "0",
        borderTopRightRadius: "0",
    },
    // 只给根 surface 的画布做底部圆角；popup/subsurface 的 canvas 层级更深，不会被选中
    "[data-client-frame][data-decorated] > [id] > div > canvas": {
        borderBottomLeftRadius: "calc(var(--window-radius, 18px) * var(--desktop-ui-scale, 1))",
        borderBottomRightRadius: "calc(var(--window-radius, 18px) * var(--desktop-ui-scale, 1))",
    },
    // 必须和上面的根画布选择器同结构：否则普通状态的圆角选择器特异性更高，最大化仍会保留底部圆角
    "[data-client-frame][data-decorated][data-maximized] > [id] > div > canvas": {
        borderBottomLeftRadius: "0",
        borderBottomRightRadius: "0",
    },
    // 标题栏由 view("x") 的 inline display:flex 创建，隐藏/显示要用 !important 压过它
    "[data-client-frame] [data-client-titlebar]": {
        display: "none !important",
    },
    "[data-client-frame][data-decorated] [data-client-titlebar]": {
        display: "flex !important",
        // 标题栏自己的顶部圆角要单独处理，否则最大化时 frame 直角了、标题栏还是圆的
        borderTopLeftRadius: "var(--window-radius, 18px)",
        borderTopRightRadius: "var(--window-radius, 18px)",
    },
    // 总览里的关闭按钮用单独的覆盖层，避免和标题栏关闭按钮重叠
    "[data-overview] [data-client-titlebar-close]": {
        opacity: "0",
        pointerEvents: "none",
    },
    // 总览里隐藏缩放热区，避免缩小后挡住窗口缩略图
    "[data-overview] [data-desktop-ui='resize-handle']": {
        display: "none",
    },
    // 全屏/最大化窗口没有可拖拽的边框；否则热区会盖住标题栏按钮扩大的命中区
    "[data-fullscreen] [data-desktop-ui='resize-handle']": {
        display: "none",
    },
    "[data-client-frame][data-maximized] [data-desktop-ui='resize-handle']": {
        display: "none",
    },
    // 总览里内容不再接收指针，点击整张卡片只用于切换
    "[data-overview] [data-view-id] > *": {
        pointerEvents: "none",
    },
    // 卡片关闭按钮只在全局预览里出现，且要抢在内容禁指针之上
    "[data-desktop-ui='window-close']": {
        opacity: "0",
        pointerEvents: "none",
        transition: "opacity 120ms ease-out",
    },
    "[data-overview] [data-view-id] [data-desktop-ui='window-close']": {
        opacity: "1",
        pointerEvents: "auto",
    },
});

const resizeCursors: Record<ResizeEdge, string> = {
    n: "ns-resize",
    s: "ns-resize",
    e: "ew-resize",
    w: "ew-resize",
    ne: "nesw-resize",
    sw: "nesw-resize",
    nw: "nwse-resize",
    se: "nwse-resize",
};

/** 每个窗口的缩放热区；总览时隐藏，避免缩小后挡住窗口缩略图 */
const windowResizeHandles = new Map<string, ElType<HTMLElement>[]>();
/** 刚结束缩放、等客户端按新尺寸提交的窗口；期间 window.changed 不覆盖拖拽预览 */
const resizeSettleTimers = new Map<string, number>();

/** 指针目标对应的缩放光标；总览、最大化/全屏窗口不出缩放光标 */
function resizeCursorForTarget(target: EventTarget | null): string | undefined {
    const handle = target instanceof Element ? target.closest<HTMLElement>("[data-resize-cursor]") : undefined;
    if (!handle || viewData.overview) return undefined;
    const windowId = handle.closest<HTMLElement>("[data-window-id]")?.dataset.windowId;
    const info = windowId === undefined ? undefined : server.server.windows.get(windowId);
    if (info?.states.maximized || info?.states.fullscreen) return undefined;
    return handle.dataset.resizeCursor;
}

/** 指针下的热区形状；热区随窗口关闭/隐藏时用来恢复光标 */
function syncResizeCursorAt(x = mousePos.x, y = mousePos.y) {
    cursor.setLocalShape(resizeCursorForTarget(document.elementFromPoint(x, y)));
}

// 热区悬停统一在 window 上按目标判定：pointerout 先于 pointerover 触发，若离开热区时
// 直接复位，相邻热区之间会经过 default 形状，resize 形状之间的旋转过渡就丢了
window.addEventListener("pointerover", (e) => {
    if (resizingWindowId !== undefined) return;
    cursor.setLocalShape(resizeCursorForTarget(e.target));
});
window.addEventListener("pointerout", (e) => {
    if (resizingWindowId !== undefined) return;
    cursor.setLocalShape(resizeCursorForTarget(e.relatedTarget));
});

function removeResizeHandles(windowId: string) {
    for (const handle of windowResizeHandles.get(windowId) ?? []) handle.remove();
    windowResizeHandles.delete(windowId);
    const timer = resizeSettleTimers.get(windowId);
    if (timer !== undefined) {
        clearTimeout(timer);
        resizeSettleTimers.delete(windowId);
    }
    if (resizingWindowId === windowId) {
        resizingWindowId = undefined;
        syncResizeCursorAt();
    } else if (resizingWindowId === undefined) {
        // 非拖拽时热区被移除（窗口关闭/隐藏），指针下可能已经没有热区
        syncResizeCursorAt();
    }
}

/**
 * 给窗口元素加一圈缩放热区。
 * `wayland` 为 true 时，拖拽中通过 `window.setSize` 把逻辑尺寸下发给客户端；否则只改 DOM 尺寸
 * （设置窗口这类桌面自己创建的窗口）。
 */
function addResizeHandles(el: HTMLElement, windowId: string, wayland: boolean, contentEl: HTMLElement = el) {
    removeResizeHandles(windowId);

    const handles: ElType<HTMLElement>[] = [];
    const edges: ResizeEdge[] = ["n", "s", "w", "e", "nw", "ne", "sw", "se"];
    for (const edge of edges) {
        const corner = edge.length === 2;
        const size = corner ? RESIZE_CORNER_SIZE : RESIZE_EDGE_SIZE;
        const handle = view()
            .style({
                position: "absolute",
                zIndex: corner ? "10" : "9",
                touchAction: "none",
            })
            .data({ "resize-cursor": resizeCursors[edge], "desktop-ui": "resize-handle" });

        // 热区跨在窗口边界上：内外各占一半，避免靠边的客户端内容被整条挡住；
        // 边热区贯通整条边，角热区最后添加且层级更高，盖住交叠处
        if (corner) {
            const offset = uiSized(-size * RESIZE_OUTSIDE_RATIO);
            if (edge.includes("n")) handle.style({ top: offset });
            if (edge.includes("s")) handle.style({ bottom: offset });
            if (edge.includes("w")) handle.style({ left: offset });
            if (edge.includes("e")) handle.style({ right: offset });
            handle.style({ width: uiSized(size), height: uiSized(size) });
        } else if (edge === "n" || edge === "s") {
            const offset = uiSized(-size * RESIZE_OUTSIDE_RATIO);
            handle.style(edge === "n" ? { top: offset } : { bottom: offset });
            handle.style({ left: "0px", right: "0px", height: uiSized(size) });
        } else {
            const offset = uiSized(-size * RESIZE_OUTSIDE_RATIO);
            handle.style(edge === "w" ? { left: offset } : { right: offset });
            handle.style({ top: "0px", bottom: "0px", width: uiSized(size) });
        }

        handle.on("pointerdown", (e) => beginWindowResize(e, edge, el, windowId, wayland, contentEl));

        handle.addInto(el);
        handles.push(handle);
    }
    windowResizeHandles.set(windowId, handles);
}

function beginWindowResize(
    e: PointerEvent,
    edge: ResizeEdge,
    el: HTMLElement,
    windowId: string,
    wayland: boolean,
    contentEl: HTMLElement = el,
) {
    if (e.button !== 0 || e.isPrimary === false || viewData.overview || resizingWindowId !== undefined) return;
    const info = wayland ? server.server.windows.get(windowId) : undefined;
    if (wayland && (!info || info.states.maximized || info.states.fullscreen)) return;

    // 热区属于桌面覆盖层：阻止冒泡，窗口层的 down/up 就不会转发给客户端
    e.stopPropagation();
    e.preventDefault();
    viewData.focusWin(windowId);
    cursor.setLocalShape(resizeCursors[edge]);

    // 手动调整过尺寸后不再自动居中，和拖动窗口一致
    windowCenterManager.pauseCentering(windowId);
    // 子窗口被手动摆过位置后，不再自动回到父窗口正中
    if (windowParents.has(windowId)) childWindowPinned.add(windowId);
    const settleTimer = resizeSettleTimers.get(windowId);
    if (settleTimer !== undefined) {
        clearTimeout(settleTimer);
        resizeSettleTimers.delete(windowId);
        // 上一次缩放的预览还压着客户端几何：先摘掉，新的拖拽从客户端实际尺寸开始
        el.removeAttribute("data-resize-preview");
        el.style.removeProperty("--resize-preview-width");
        el.style.removeProperty("--resize-preview-height");
    }

    const scale = info?.scale || 1;
    const parentRect = el.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const rect = el.getBoundingClientRect();
    // 服务端装饰的窗口：热区在 frame 上，尺寸按内容算（标题栏不参与 configure）
    const contentRect = contentEl === el ? rect : contentEl.getBoundingClientRect();
    const start = {
        left: rect.left - parentRect.left,
        top: rect.top - parentRect.top,
        width: contentRect.width,
        height: contentRect.height,
    };
    const startX = e.clientX;
    const startY = e.clientY;
    // 逻辑尺寸按整数下发；DOM 尺寸是逻辑尺寸 × scale，避免缩放后窗口尺寸抖动。
    // 客户端 set_min_size / set_max_size 优先于桌面兜底的最小尺寸。
    const minLogicalWidth = Math.max(Math.ceil(RESIZE_MIN_WIDTH / scale), info?.minSize?.width ?? 0);
    const minLogicalHeight = Math.max(Math.ceil(RESIZE_MIN_HEIGHT / scale), info?.minSize?.height ?? 0);
    const minWidth = minLogicalWidth * scale;
    const minHeight = minLogicalHeight * scale;
    const maxWidth = info?.maxSize?.width ? info.maxSize.width * scale : Infinity;
    const maxHeight = info?.maxSize?.height ? info.maxSize.height * scale : Infinity;

    resizingWindowId = windowId;

    let rafId = 0;
    let pendingSize: { width: number; height: number } | undefined;
    let resized = false;

    function flushSize() {
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
        if (pendingSize) {
            server.server.notify("window.setSize", windowId, pendingSize);
            pendingSize = undefined;
        }
    }

    function onPointerMove(ev: PointerEvent) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let left = start.left;
        let top = start.top;
        let width = start.width;
        let height = start.height;
        if (edge.includes("e")) width += dx;
        if (edge.includes("s")) height += dy;
        if (edge.includes("w")) {
            width -= dx;
            left += dx;
        }
        if (edge.includes("n")) {
            height -= dy;
            top += dy;
        }

        if (width > maxWidth) {
            if (edge.includes("w")) left = start.left + start.width - maxWidth;
            width = maxWidth;
        }
        if (height > maxHeight) {
            if (edge.includes("n")) top = start.top + start.height - maxHeight;
            height = maxHeight;
        }
        if (width < minWidth) {
            if (edge.includes("w")) left = start.left + start.width - minWidth;
            width = minWidth;
        }
        if (height < minHeight) {
            if (edge.includes("n")) top = start.top + start.height - minHeight;
            height = minHeight;
        }

        if (wayland) {
            const logicalWidth = Math.max(1, Math.round(width / scale));
            const logicalHeight = Math.max(1, Math.round(height / scale));
            width = logicalWidth * scale;
            height = logicalHeight * scale;
            pendingSize = { width: logicalWidth, height: logicalHeight };
            // 指针事件可能远高于刷新率，configure 每帧最多发一次
            if (!rafId) {
                rafId = requestAnimationFrame(() => {
                    rafId = 0;
                    if (pendingSize) {
                        server.server.notify("window.setSize", windowId, pendingSize);
                        pendingSize = undefined;
                    }
                });
            }
        } else {
            width = Math.round(width);
            height = Math.round(height);
        }

        resized = true;
        const frame = wayland ? clientWindowFrames.get(windowId) : undefined;
        if (frame) {
            // 位置随指针走；尺寸等客户端提交后由渲染层回调同步，避免外框/阴影提前变大
            setClientFramePosition(frame, left, top);
        } else {
            el.style.left = `${Math.round(left)}px`;
            el.style.top = `${Math.round(top)}px`;
            if (wayland) {
                el.setAttribute("data-resize-preview", "");
                el.style.setProperty("--resize-preview-width", `${width}px`);
                el.style.setProperty("--resize-preview-height", `${height}px`);
            } else {
                el.style.width = `${width}px`;
                el.style.height = `${height}px`;
            }
        }
    }

    function finish(ev?: PointerEvent) {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        if (wayland) {
            flushSize();
            if (resized) {
                // 客户端按新尺寸 commit 之前，忽略中间 configure 的 window.changed 覆盖预览尺寸
                const timer = window.setTimeout(() => {
                    resizeSettleTimers.delete(windowId);
                    const current = server.server.windows.get(windowId);
                    const surfaceEl = current ? render.getXdgSurfaceEle(current.renderId) : undefined;
                    if (current && surfaceEl) {
                        // 摘掉预览，以客户端实际提交的几何为准（客户端可能夹到自己的最小/最大值）
                        surfaceEl.removeAttribute("data-resize-preview");
                        surfaceEl.style.removeProperty("--resize-preview-width");
                        surfaceEl.style.removeProperty("--resize-preview-height");
                        const frame = clientWindowFrames.get(windowId);
                        if (frame) {
                            if (frame.decorated) applyFrameSurfaceSize(frame);
                            else
                                setClientFrameLayout(
                                    frame,
                                    current.rect.w * current.scale,
                                    current.rect.h * current.scale,
                                );
                        } else
                            pack(surfaceEl).style({
                                width: `${current.rect.w * current.scale}px`,
                                height: `${current.rect.h * current.scale}px`,
                            });
                    }
                }, 250);
                resizeSettleTimers.set(windowId, timer);
            }
        }
        resizingWindowId = undefined;
        // 抬手时指针可能还停在热区上：按当前热区恢复缩放光标，否则回到客户端光标
        syncResizeCursorAt(ev?.clientX ?? mousePos.x, ev?.clientY ?? mousePos.y);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
}

/**
 * 把窗口元素放进某个虚拟屏。
 * `center=false` 用于子窗口：它由父子关系定位（`placeChildWindow`），
 * 不参与视口居中，也不跟随视口变化重排。
 */
function addWindow(screen: ViewScreen, el: HTMLElement, windowId?: string, center = true) {
    screen.el.add(el);

    pack(el).style({
        position: "absolute",
    });

    if (windowId) {
        if (center) windowCenterManager.addWindow(windowId, el);
        else el.setAttribute("data-window-id", windowId);
    }
}

// ── 服务端装饰（xdg-decoration）────────────────────────────────────────────────
// 窗口内容仍是 render 的 xdg 元素；外面包一层 frame 负责标题栏、阴影和缩放热区。
// 客户端没有协商 server_side（decorated=false）时 frame 只剩内容，行为与以前一致。

const CLIENT_TITLEBAR_HEIGHT = 38;

type ClientWindowFrame = {
    /** 全局窗口身份；父子关系/命中测试按它查 */
    handle: WinHandle;
    el: ElType<HTMLElement>;
    header: ElType<HTMLElement>;
    icon: ElType<HTMLElement>;
    title: ElType<HTMLElement>;
    /** 客户端内容元素（render 的 xdg surface） */
    content: HTMLElement;
    /** 标题栏右上角的窗口控制按钮（最大化/恢复、关闭） */
    controls: ElType<HTMLElement>[];
    maximizeIcon: ElType<HTMLElement>;
    restoreIcon: ElType<HTMLElement>;
    decorated: boolean;
    fullscreen: boolean;
    maximized: boolean;
    appid: string;
    /** xdg surface id（WindowInfo.renderId），渲染层尺寸回调按它反查 */
    renderId: string;
    /** 最近一次实际提交的 surface 显示尺寸（CSS px） */
    surfaceWidth: number;
    surfaceHeight: number;
};

const clientWindowFrames = new Map<WinHandle, ClientWindowFrame>();
const clientFrameByRenderId = new Map<string, ClientWindowFrame>();

// ── 父子窗口 ──────────────────────────────────────────────────────────────────────────
// 官方桌面「一屏一窗口」：顶层窗口各占一个虚拟屏，子窗口（对话框）不再占屏，
// 而是叠在父窗口所在屏的上面。父子关系来自 xdg_toplevel.set_parent，
// 模态提示来自 xdg-dialog-v1；桌面自己的内部窗口（文件选择器）也走同一套映射。

/** 子窗口 → 父窗口；键和值都可能是客户端 handle 或 `internal:*` */
const windowParents = new Map<MWinId, MWinId>();
/** 模态子窗口；存在时父窗口的指针/滚动/键盘都被挡住 */
const modalWindows = new Set<MWinId>();
/** 用户拖动/缩放过位置的子窗口：不再自动居中覆盖父窗口 */
const childWindowPinned = new Set<MWinId>();

/** 沿 parent 链找到顶层窗口（对话框的父窗口是应用主窗口，不是别的对话框） */
function rootWindow(winid: MWinId): MWinId {
    let cur = winid;
    for (;;) {
        const parent = windowParents.get(cur);
        if (parent === undefined) return cur;
        cur = parent;
    }
}

/** 子窗口在父链里的深度：命中测试与层叠顺序都按「深的先」 */
function windowDepth(winid: MWinId): number {
    let depth = 0;
    let cur = windowParents.get(winid);
    while (cur !== undefined) {
        depth++;
        cur = windowParents.get(cur);
    }
    return depth;
}

/**
 * 窗口按层叠顺序排列：子窗口在父窗口之上。
 * 指针/滚动命中必须按这个顺序第一个命中者先得，否则同客户端的父窗口会吃掉对话框的事件。
 */
function windowsTopFirst() {
    return server.server.windows.list().toSorted((a, b) => windowDepth(b.handle) - windowDepth(a.handle));
}

/** 客户端窗口与内部窗口共用的 DOM 取得方式 */
function windowElement(winid: MWinId): HTMLElement | undefined {
    return clientWindowFrames.get(winid)?.el.el ?? internalWindows.get(winid)?.el.el;
}

function setWindowPosition(winid: MWinId, left: number, top: number): void {
    const frame = clientWindowFrames.get(winid);
    if (frame) {
        setClientFramePosition(frame, left, top);
        return;
    }
    internalWindows.get(winid)?.el.style({ left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
}

/**
 * 把子窗口摆在父窗口正中并夹在舞台内。父/子尺寸会多次变化（客户端提交前是 1×1），
 * 所以调用方在 created、尺寸变化和父子变化后都会再调一次；用户拖过之后不再自动摆。
 */
function placeChildWindow(winid: MWinId, force = false): void {
    const parent = windowParents.get(winid);
    if (parent === undefined) return;
    if (!force && childWindowPinned.has(winid)) return;
    const self = windowElement(winid);
    const parentEl = windowElement(parent);
    if (!self || !parentEl) return;
    const width = self.offsetWidth;
    const height = self.offsetHeight;
    if (width <= 0 || height <= 0) return;
    const stageWidth = windowEl.el.offsetWidth;
    const stageHeight = windowEl.el.offsetHeight;
    if (stageWidth <= 0 || stageHeight <= 0) return;
    const left = parentEl.offsetLeft + (parentEl.offsetWidth - width) / 2;
    const top = parentEl.offsetTop + (parentEl.offsetHeight - height) / 2;
    setWindowPosition(
        winid,
        Math.min(Math.max(0, left), Math.max(0, stageWidth - width)),
        Math.min(Math.max(0, top), Math.max(0, stageHeight - height)),
    );
}

/** 父窗口拖动时子窗口跟着走（对话框一般贴着父窗口动） */
function moveChildWindows(parent: MWinId, dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    for (const [child, p] of windowParents) {
        if (p !== parent) continue;
        const el = windowElement(child);
        if (!el) continue;
        setWindowPosition(child, el.offsetLeft + dx, el.offsetTop + dy);
        moveChildWindows(child, dx, dy);
    }
}

/** 该窗口下面是否压着模态子窗口（递归：模态对话框里再开对话框） */
function hasModalChild(winid: MWinId): boolean {
    for (const [child, parent] of windowParents) {
        if (parent !== winid) continue;
        if (modalWindows.has(child)) return true;
        if (hasModalChild(child)) return true;
    }
    return false;
}

/** 当前虚拟屏里最内层的模态子窗口；它挡住同屏的下层窗口与桌面点击 */
function modalWindowInCurrentScreen(): MWinId | undefined {
    let top: MWinId | undefined;
    for (const child of modalWindows) {
        if (!viewData.isCurrentWin(child)) continue;
        if (top === undefined || windowDepth(child) > windowDepth(top)) top = child;
    }
    return top;
}

/** 点击被模态挡住的父窗口：聚到对话框并闪一下边框，说明点击被它接管 */
function flashWindow(winid: MWinId): void {
    const el = windowElement(winid);
    if (!el) return;
    el.style.outline = "2px solid #00aaff88";
    el.style.outlineOffset = "-2px";
    window.setTimeout(() => {
        el.style.outline = "";
        el.style.outlineOffset = "";
    }, 160);
}

/**
 * 父子关系变化（`window.created` 与 `window.changed` 的 parent 差分）：
 * 子窗口搬进父窗口的屏、停止视口居中、改成客户端自选尺寸；取消父关系则重新占一屏。
 */
function applyWindowParent(winid: MWinId, parent: MWinId | undefined): void {
    if (windowParents.get(winid) === parent) return;
    if (parent === undefined) {
        windowParents.delete(winid);
        const screen = viewData.reparentWindow(winid, undefined);
        const frame = clientWindowFrames.get(winid);
        if (frame && screen) {
            addWindow(screen, frame.el.el, winid, true);
            setClientFramePosition(frame, wino.l, wino.t);
        }
        return;
    }
    windowParents.set(winid, parent);
    const screen = viewData.reparentWindow(winid, parent);
    const frame = clientWindowFrames.get(winid);
    if (!frame || !screen) return;
    // 子窗口不参与视口居中，元素搬到父窗口所在的屏（同屏时是空操作）
    windowCenterManager.removeWindow(winid);
    screen.el.add(frame.el.el);
    frame.el.style({ position: "absolute" });
    // 已经按 800×600 映射过的窗口重发一次 configure 0×0，让客户端回到自己的固有尺寸
    const applied = appliedState.get(winid);
    server.server.notify(
        applied !== undefined && applied.w > 0 && applied.h > 0 ? "window.setSize" : "window.setBox",
        winid,
        { width: 0, height: 0 },
    );
    placeChildWindow(winid, true);
    viewData.focusWin(winid);
}

/** 模态提示变化；变成模态时把焦点从父窗口收到对话框上 */
function applyWindowModal(winid: MWinId, modal: boolean): void {
    if (modal) modalWindows.add(winid);
    else modalWindows.delete(winid);
    if (modal && viewData.focusHandle === windowParents.get(winid)) viewData.focusWin(winid);
}

/**
 * 服务端装饰标题栏的视觉高度，不参考 frame 当前是否全屏。
 * 退出全屏时要按「恢复后的状态」算内容尺寸，此时 frame.fullscreen 可能还是 true。
 */
function decoratedTitlebarPx(frame: ClientWindowFrame) {
    return frame.decorated ? Math.round(CLIENT_TITLEBAR_HEIGHT * uiScale) : 0;
}

/** 标题栏占用的视觉高度；全屏和未协商服务端装饰时为 0 */
function titlebarPx(frame: ClientWindowFrame) {
    return frame.fullscreen ? 0 : decoratedTitlebarPx(frame);
}

/** 视觉按钮固定 22px；最大化时只放大透明点击区，不改变图标和圆底的大小 */
const CLIENT_CONTROL_VISUAL_SIZE = 22;

/**
 * 最大化时把命中区撑满整条标题栏高度，图标本身不放大。
 * 关闭按钮的命中区贴到外框右边、上边，圆角不裁剪它（frame 没有 overflow:hidden）。
 */
function clientFrameControlHitSize(frame: ClientWindowFrame) {
    return frame.maximized ? CLIENT_TITLEBAR_HEIGHT : CLIENT_CONTROL_VISUAL_SIZE;
}

/**
 * 标题栏按钮与外框圆角对齐：视觉按钮圆心落在圆角圆心上
 * （距右边 = 圆角半径），内外留白因此随圆角设置变化。
 */
function updateClientFrameControls(frame: ClientWindowFrame) {
    const hitSize = clientFrameControlHitSize(frame);
    for (const control of frame.controls) control.style({ width: `${hitSize}px`, height: `${hitSize}px` });
    const inset = frame.maximized ? 0 : Math.max(4, Math.round(windowRadius - CLIENT_CONTROL_VISUAL_SIZE / 2));
    frame.header.style({ paddingRight: `${inset}px` });
}

function syncClientFrameMaximized(frame: ClientWindowFrame, maximized: boolean) {
    frame.maximized = maximized;
    frame.el.el.toggleAttribute("data-maximized", maximized);
    frame.maximizeIcon.style({ display: maximized ? "none" : "flex" });
    frame.restoreIcon.style({ display: maximized ? "flex" : "none" });
    updateClientFrameControls(frame);
}

function applyClientFrameChrome(frame: ClientWindowFrame) {
    frame.el.el.toggleAttribute("data-decorated", frame.decorated && !frame.fullscreen);
    frame.el.el.toggleAttribute("data-fullscreen", frame.fullscreen);
    // 标题栏高度变化只在这里写一次；surface 尺寸回调只改 frame 宽高，不动内容布局
    frame.content.style.top = `${titlebarPx(frame)}px`;
}

/**
 * 用最近一次实际提交的 surface 尺寸重算 frame：
 * 宽高 = surface 显示尺寸 + 标题栏。由渲染层在画布尺寸写入 DOM 的同一时刻触发，
 * 不用 ResizeObserver，避免回调晚一帧。
 */
function applyFrameSurfaceSize(frame: ClientWindowFrame, width?: number, height?: number) {
    if (width !== undefined) frame.surfaceWidth = Math.max(1, width);
    if (height !== undefined) frame.surfaceHeight = Math.max(1, height);
    const bar = titlebarPx(frame);
    frame.el.style({
        width: `${frame.surfaceWidth}px`,
        height: `${frame.surfaceHeight + bar}px`,
    });
}

/** 桌面主动设定内容尺寸（最大化/全屏），外框与内容在同一任务里对齐 */
function setClientFrameLayout(
    frame: ClientWindowFrame,
    contentWidth: number,
    contentHeight: number,
    fullscreen = false,
) {
    frame.fullscreen = fullscreen;
    const width = Math.max(1, contentWidth);
    const height = Math.max(1, contentHeight);
    frame.content.style.left = "0px";
    frame.content.style.width = `${width}px`;
    frame.content.style.height = `${height}px`;
    applyClientFrameChrome(frame);
    applyFrameSurfaceSize(frame, width, height);
}

function setClientFramePosition(frame: ClientWindowFrame, left: number, top: number) {
    frame.el.style({ left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
}

function updateClientFrameIcon(frame: ClientWindowFrame, appid: string) {
    frame.icon.clear();
    if (!appid) return;
    void (async () => {
        const desk = await MSysApi.getDesktopEntry(appid);
        const path = desk ? await MSysApi.getDesktopIcon(desk.icon || "", { theme: setting.get("icon.theme") }) : "";
        // await 期间 appid 可能又变了
        if (!path || frame.appid !== appid) return;
        frame.icon.add(
            image(path, desk?.name || appid).style({
                width: "100%",
                height: "100%",
                objectFit: "contain",
            }),
        );
    })().catch(() => {});
}

function updateClientFrameInfo(frame: ClientWindowFrame, info: WindowInfo) {
    frame.title.sv(info.title || info.appid || "窗口");
    if (frame.appid !== info.appid) {
        frame.appid = info.appid;
        updateClientFrameIcon(frame, info.appid);
    }
}

function beginClientFrameMove(frame: ClientWindowFrame, handle: WinHandle, e: PointerEvent) {
    viewData.focusWin(handle);
    windowCenterManager.pauseCentering(handle);
    // 子窗口被拖走后不再自动回到父窗口正中
    if (windowParents.has(handle)) childWindowPinned.add(handle);
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = frame.el.el.getBoundingClientRect();
    const parentRect = frame.el.el.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const origLeft = rect.left - parentRect.left;
    const origTop = rect.top - parentRect.top;
    let lastLeft = Math.round(origLeft);
    let lastTop = Math.round(origTop);

    function onPointerMove(ev: PointerEvent) {
        const left = Math.round(ev.clientX - startX + origLeft);
        const top = Math.round(ev.clientY - startY + origTop);
        frame.el.style({ left: `${left}px`, top: `${top}px` });
        moveChildWindows(handle, left - lastLeft, top - lastTop);
        lastLeft = left;
        lastTop = top;
    }
    function cleanup() {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
}

function createMaximizeGlyph() {
    return view()
        .style({ width: "12px", height: "12px", display: "flex", alignItems: "center", justifyContent: "center" })
        .add(
            view().style({
                width: "10px",
                height: "10px",
                border: "1.5px solid #111",
                borderRadius: "2px",
                boxSizing: "border-box",
            }),
        );
}

function createRestoreGlyph() {
    const glyph = view().style({ position: "relative", width: "12px", height: "12px" });
    const back = view().style({
        position: "absolute",
        top: "0",
        right: "0",
        width: "9px",
        height: "9px",
        border: "1.5px solid #111",
        borderRadius: "2px",
        boxSizing: "border-box",
    });
    const front = view().style({
        position: "absolute",
        left: "0",
        bottom: "0",
        width: "9px",
        height: "9px",
        border: "1.5px solid #111",
        borderRadius: "2px",
        boxSizing: "border-box",
        // 盖住背后方框穿过来的边，形成两个叠放的窗口
        background: "#f5f5f5",
    });
    glyph.add([back, front]);
    return glyph;
}

/** 标题栏按钮：外层是透明命中区，内层是 22px 圆底和图标 */
function createTitlebarControl(content: ElType<HTMLElement> | { el: HTMLElement }, onClick: () => void) {
    const visual = view()
        .style({
            width: `${CLIENT_CONTROL_VISUAL_SIZE}px`,
            height: `${CLIENT_CONTROL_VISUAL_SIZE}px`,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(255, 255, 255, 0.92)",
            boxShadow: "0 1px 4px #00000055",
        })
        .add(content);
    const btn = button(visual)
        .style({
            width: `${CLIENT_CONTROL_VISUAL_SIZE}px`,
            height: `${CLIENT_CONTROL_VISUAL_SIZE}px`,
            padding: "0",
            border: "none",
            background: "transparent",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            zIndex: "10",
            flexShrink: "0",
        })
        .data({ "desktop-ui": "window-control" });
    btn.on("click", (e) => {
        e.stopPropagation();
        onClick();
    });
    return btn;
}

function createClientWindowFrame(info: WindowInfo, content: HTMLElement): ClientWindowFrame {
    const title = txt("").style({
        flex: "1",
        minWidth: "0",
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        fontSize: "13px",
        fontWeight: "500",
        color: "#111",
        userSelect: "none",
    });
    const icon = view().style({
        width: "18px",
        height: "18px",
        flexShrink: "0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
    });
    const close = createTitlebarControl(getIconXEl("cross", { size: 12 }), () =>
        server.server.notify("window.close", info.handle),
    ).data({ "client-titlebar-close": "", "client-control": "close" });

    const maximizeIcon = createMaximizeGlyph();
    const restoreIcon = createRestoreGlyph();
    restoreIcon.style({ display: "none" });
    const maximize = createTitlebarControl(
        view()
            .style({ display: "flex", alignItems: "center", justifyContent: "center" })
            .add([maximizeIcon, restoreIcon]),
        () => {
            viewData.focusWin(info.handle);
            toggleMaximizeWindow(info.handle);
        },
    ).data({ "client-control": "maximize" });

    const header = view("x")
        .data({ "desktop-ui": "client-titlebar", "client-titlebar": "" })
        .style({
            position: "absolute",
            left: "0",
            top: "0",
            // 用 transform 而不是 zoom：zoom 下百分比宽度/命中区的视觉尺寸会缩水，
            // 高缩放时标题栏按钮会整体向左偏移。宽度先除回缩放倍率，再整体放大。
            width: "calc(100% / var(--desktop-ui-scale, 1))",
            height: `${CLIENT_TITLEBAR_HEIGHT}px`,
            transform: "scale(var(--desktop-ui-scale, 1))",
            transformOrigin: "top left",
            alignItems: "center",
            gap: "6px",
            paddingLeft: "14px",
            paddingRight: "14px",
            boxSizing: "border-box",
            borderBottom: "1px solid #00000012",
            background: "rgba(245, 245, 245, 0.97)",
            backdropFilter: "blur(18px)",
            zIndex: "6",
            cursor: "default",
            fontFamily: "sans-serif",
        })
        .add([icon, title, maximize, close]);

    header.on("pointerdown", (e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("button, input, select, textarea")) return;
        e.stopPropagation();
        beginClientFrameMove(frame, info.handle, e);
    });

    const el = view().data({ "client-frame": "", "client-window": info.handle }).style({
        position: "absolute",
        boxSizing: "border-box",
    });
    el.add([header, content]);

    const frame: ClientWindowFrame = {
        handle: info.handle,
        el,
        header,
        icon,
        title,
        content,
        controls: [maximize, close],
        maximizeIcon,
        restoreIcon,
        decorated: info.decorated,
        fullscreen: false,
        maximized: false,
        appid: "",
        renderId: info.renderId,
        surfaceWidth: 1,
        surfaceHeight: 1,
    };
    updateClientFrameInfo(frame, info);
    applyClientFrameChrome(frame);
    syncClientFrameMaximized(frame, info.states.maximized);
    clientFrameByRenderId.set(info.renderId, frame);
    applyFrameSurfaceSize(frame);
    return frame;
}

function jump2Win(winid: MWinId) {
    viewData.jumpToWin(winid);
}

// ── 桌面自己的 DOM 窗口 ────────────────────────────────────────────────────────────────────────
// 设置窗口、文件选择器不是 Wayland 客户端，但参与虚拟桌面、总览、聚焦和关闭，
// 与客户端窗口走同一套 ViewData / WindowCenterManager 逻辑；带 parent 的内部窗口
// 和客户端子窗口一样，不占屏、叠在父窗口上（文件选择器就挂在发起请求的应用上）。
const SETTINGS_WINDOW_ID = "internal:settings";

type InternalWindowContent = {
    el: ElType<HTMLElement>;
    dispose?: () => void;
};

type InternalWindowOptions = {
    id: string;
    title: string;
    icon?: HTMLElement | { el: HTMLElement };
    width: number;
    height: number;
    /**
     * 父窗口（客户端 handle 或别的内部窗口）：有父窗口时不占虚拟屏，
     * 覆盖在父窗口所在屏的上面，并随父窗口移动。文件选择器用它挂到发起请求的应用上。
     */
    parent?: MWinId;
    /** 模态：挡住父窗口的指针/滚动/键盘，直到本窗口关闭 */
    modal?: boolean;
    build(host: { inner: ElType<HTMLDivElement>; close: () => void }): InternalWindowContent;
    /** 关闭前调用，例如取消尚未结束的文件选择请求 */
    onClose?(): void;
    /** 窗口完全回收后调用，例如显示下一个排队请求 */
    onClosed?(): void;
};

function openInternalWindow(op: InternalWindowOptions) {
    if (viewData.overview) viewData.setOverview(false);
    if (internalWindows.has(op.id)) {
        jump2Win(op.id);
        return;
    }

    // 父窗口已经不存在时退化成独立窗口，避免对话框挂在一个已关闭的应用上
    let parent = op.parent === undefined ? undefined : rootWindow(op.parent);
    if (parent !== undefined && !internalWindows.has(parent) && !server.server.windows.get(parent)) parent = undefined;

    const screen = viewData.addWindowScreen(op.id, parent);
    if (parent !== undefined) {
        windowParents.set(op.id, parent);
        if (op.modal) modalWindows.add(op.id);
    }
    const root = view("y")
        .data({ "internal-window": op.id })
        .style({
            position: "absolute",
            width: `calc(${op.width}px * var(--desktop-ui-scale, 1))`,
            height: `calc(${op.height}px * var(--desktop-ui-scale, 1))`,
            maxWidth: "calc(100vw - 24px)",
            maxHeight: "calc(100vh - 24px)",
            borderRadius: "calc(var(--window-radius, 18px) * var(--desktop-ui-scale, 1))",
            background: "rgba(245, 245, 245, 0.97)",
            backdropFilter: "blur(18px)",
            boxShadow: "0 12px 40px #00000033",
            boxSizing: "border-box",
        });
    // 内容单独裁剪圆角；根节点不裁剪，缩放热区才能跨到窗口外
    const clip = view().style({
        position: "absolute",
        inset: "0",
        borderRadius: "calc(var(--window-radius, 18px) * var(--desktop-ui-scale, 1))",
        overflow: "hidden",
    });
    root.add(clip);
    // 外层窗口尺寸用视觉 px（居中/拖动/缩放沿用通用窗口逻辑）；内容在内层按屏幕缩放放大
    const inner = view("y").style({
        width: "100%",
        height: "100%",
        position: "relative",
        color: "#111",
        fontFamily: "sans-serif",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        zoom: "var(--desktop-ui-scale, 1)",
    });
    clip.add(inner);

    const header = view("x")
        .style({
            height: "48px",
            alignItems: "center",
            gap: "10px",
            padding: "0 46px 0 16px",
            flexShrink: "0",
            borderBottom: "1px solid #00000012",
            boxSizing: "border-box",
            minWidth: "0",
        })
        .add([
            ...(op.icon ? [op.icon] : []),
            txt(op.title).style({
                fontWeight: "600",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
            }),
        ]);

    function closeWindow() {
        const entry = internalWindows.get(op.id);
        if (!entry) return;
        internalWindows.delete(op.id);
        op.onClose?.();
        // closeWin 里要按父窗口恢复焦点，映射在它之后清
        viewData.closeWin(op.id);
        windowParents.delete(op.id);
        modalWindows.delete(op.id);
        childWindowPinned.delete(op.id);
        windowCenterManager.removeWindow(op.id);
        removeResizeHandles(op.id);
        entry.dispose?.();
        entry.el.remove();
        op.onClosed?.();
    }

    const content = op.build({ inner, close: closeWindow });

    const closeBtn = createWindowCloseButton({
        size: 24,
        onClick: closeWindow,
    }).style({
        position: "absolute",
        top: "12px",
        right: "12px",
        zIndex: "20",
    });

    const setActive = (active: boolean) => {
        root.style({ boxShadow: active ? "0 16px 48px #00000044" : "0 12px 40px #0000002a" });
    };
    setActive(false);

    inner.add([header, content.el, closeBtn]);
    root.on("pointerdown", () => viewData.focusWin(op.id));

    // 标题栏拖动。拖动后暂停自动居中，避免父容器变化时把窗口拽回中间。
    header.on("pointerdown", (e) => {
        if ((e.target as HTMLElement).closest("button, input, select, textarea")) return;
        windowCenterManager.pauseCentering(op.id);
        if (windowParents.has(op.id)) childWindowPinned.add(op.id);
        const startX = e.clientX;
        const startY = e.clientY;
        const rect = root.el.getBoundingClientRect();
        const parentRect = root.el.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const origLeft = rect.left - parentRect.left;
        const origTop = rect.top - parentRect.top;
        let lastLeft = Math.round(origLeft);
        let lastTop = Math.round(origTop);

        function onPointerMove(ev: PointerEvent) {
            const left = Math.round(ev.clientX - startX + origLeft);
            const top = Math.round(ev.clientY - startY + origTop);
            root.style({ left: `${left}px`, top: `${top}px` });
            moveChildWindows(op.id, left - lastLeft, top - lastTop);
            lastLeft = left;
            lastTop = top;
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

    internalWindows.set(op.id, {
        el: root,
        title: op.title,
        setActive,
        close: closeWindow,
        dispose: content.dispose,
    });
    addWindow(screen, root.el, op.id, parent === undefined);
    addResizeHandles(root.el, op.id, false);
    // 子窗口不在总览里单独成卡，关闭按钮由父窗口那张卡负责
    if (parent === undefined) createOverviewWindowCloseButton(closeWindow).addInto(root.el);
    else placeChildWindow(op.id, true);
    viewData.focusWin(op.id);
}

function openSettingsWindow() {
    openInternalWindow({
        id: SETTINGS_WINDOW_ID,
        title: "设置",
        icon: getIconXEl("settings", { size: 18, width: 20, height: 20 }),
        width: 760,
        height: 540,
        build: ({ inner }) => {
            const settingsContent = createSettingsContent({
                getIconTheme: () => setting.get("icon.theme") || "breeze",
                setIconTheme: (theme) => setting.set("icon.theme", theme),
                getWindowRadius: () => windowRadius,
                setWindowRadius,
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
                getResolution: () => screenManager.getResolution(),
                getResolutions: () => screenManager.getResolutions(),
                setResolution: (width, height) => screenManager.setResolution(width, height),
                getRefreshRate: () => screenManager.getRefreshRate(),
                getRefreshRates: () => screenManager.getRefreshRates(),
                setRefreshRate: (refreshRate) => screenManager.setRefreshRate(refreshRate),
                screenModeAvailable: () => MSysApi.display.supports("screen-mode"),
                getTouchpadScrollGain: () => touchpadScrollGain,
                setTouchpadScrollGain: (gain) => {
                    touchpadScrollGain = gain;
                    desktopSetting.nset("touchpadScrollGain", gain);
                },
                getNaturalScroll: () => naturalScroll,
                setNaturalScroll: (enabled) => {
                    naturalScroll = enabled;
                    desktopSetting.nset("naturalScroll", enabled);
                },
                getSwitchGestureGain: () => gestureSwitchGain,
                setSwitchGestureGain: (gain) => {
                    gestureSwitchGain = normalizeGestureGain(gain);
                    desktopSetting.nset("switchGestureGain", gestureSwitchGain);
                },
                getReorderDelay: () => reorderDelay,
                setReorderDelay: (delay) => {
                    reorderDelay = normalizeReorderDelay(delay);
                    desktopSetting.nset("reorderDelay", reorderDelay);
                },
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
                modalHost: inner.el,
            });
            return { el: settingsContent.el, dispose: settingsContent.dispose };
        },
    });
}

const FILE_CHOOSER_WINDOW_ID = "internal:file-chooser";
const fileChooserQueue: FileChooserRequest[] = [];

/**
 * portal 请求里的 `parent_window` 是应用用 xdg-foreign 导出的句柄；
 * 解析不到时退回当前聚焦的窗口，让选择器至少贴着用户眼前的应用。
 */
function fileChooserParent(request: FileChooserRequest): MWinId | undefined {
    const exported = request.parentWindow ? server.server.windows.lookupExport(request.parentWindow) : undefined;
    if (exported !== undefined) return rootWindow(exported);
    const focused = viewData.focusHandle;
    if (focused === undefined) return undefined;
    return rootWindow(focused);
}

function openFileChooserWindow(request: FileChooserRequest) {
    if (internalWindows.has(FILE_CHOOSER_WINDOW_ID)) {
        fileChooserQueue.push(request);
        return;
    }
    openInternalWindow({
        id: FILE_CHOOSER_WINDOW_ID,
        title: fileChooserTitle(request),
        icon: fileChooserHeaderIcon(request),
        width: 860,
        height: 580,
        parent: fileChooserParent(request),
        // portal 声明 non-modal 时不要挡住应用
        modal: request.modal,
        onClose: () => {
            void request.cancel();
        },
        onClosed: () => {
            const next = fileChooserQueue.shift();
            if (next) openFileChooserWindow(next);
        },
        build: ({ close }) => {
            const content = createFileChooserContent({ request, close });
            return { el: content.el, dispose: content.dispose };
        },
    });
}

MSysApi.portal?.on("fileChooser.request", (request) => {
    try {
        openFileChooserWindow(request);
    } catch (error) {
        console.error("[file-chooser] 打开失败:", error);
        void request.cancel();
    }
});

function appLauncher(iconPath: () => Promise<string>, name: string, exec: string, env?: Record<string, string>) {
    const p = appIconEl(exec, env);
    loadAppIcon(p, iconPath, name);
    return p;
}

/** 只创建应用图标容器，图标由调用方在需要时再加载 */
function appIconEl(exec?: string, env?: Record<string, string>) {
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
            server.runApp(exec, { env });
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

/**
 * 指针目标是否属于桌面 UI（而不是 Wayland 客户端内容）。
 * 工具栏弹窗、IME 候选窗、锁屏都在窗口层之外；内部窗口、窗口关闭按钮、缩放热区带标记。
 */
function isDesktopUiTarget(target: Element | null | undefined): boolean {
    if (!target) return true;
    if (!windowEl.el.contains(target)) return true;
    return target.closest("[data-internal-window], [data-desktop-ui]") !== null;
}

function desktopUiUnderPoint(x: number, y: number, target?: EventTarget | null) {
    return isDesktopUiTarget(target instanceof Element ? target : document.elementFromPoint(x, y));
}

/** 当前指针位置下命中的客户端窗口；被桌面 UI 盖住时为空 */
function pointerHits(p: { x: number; y: number; target?: EventTarget | null }): PointerHit[] {
    if (viewData.overview || viewData.gestureActive || resizingWindowId !== undefined) return [];
    if (desktopUiUnderPoint(p.x, p.y, p.target)) return [];

    const hits: PointerHit[] = [];
    const handled = new Set<string>();
    for (const info of windowsTopFirst()) {
        // 只有当前虚拟屏接收指针；相邻屏在滑动动画中也可能进入视口
        if (!viewData.isCurrentWin(info.handle)) continue;
        // 模态对话框挡住的父窗口（及祖先）不接收指针
        if (hasModalChild(info.handle)) continue;
        // 每个客户端只处理第一个命中的窗口；子窗口按 depth 排在父窗口前面
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
        hits.push({ handle: info.handle, clientId: info.clientId });
    }
    return hits;
}

/** 触摸板手势落到指针所在客户端窗口 */
function notifyGesture(handle: WinHandle, ev: GestureCommand): void {
    server.server.notify("input.gesture", handle, ev);
}

/**
 * 触摸板手势落到当前指针下的客户端窗口。
 * begin 时返回目标 handle，后续 update/end 必须复用同一个目标，避免手势中途换窗口。
 */
function sendGestureEvent(ev: GestureCommand, x: number, y: number): WinHandle | undefined {
    const hit = pointerHits({ x, y })[0];
    if (debugGesture) console.log("[gesture] send", ev, hit?.handle, { x, y });
    if (!hit) return undefined;
    notifyGesture(hit.handle, ev);
    return hit.handle;
}

/** 桌面坐标 → `dnd.move/drop` 需要的目标窗口 + surface 局部坐标 */
function dndTargetAt(x: number, y: number): { handle: WinHandle; x: number; y: number } | undefined {
    const hit = pointerHits({ x, y })[0];
    if (!hit) return undefined;
    const info = server.server.windows.get(hit.handle);
    const rect = info ? render.getXdgSurfaceEle(info.renderId)?.getBoundingClientRect() : undefined;
    if (!info || !rect) return undefined;
    const scale = info.scale || 1;
    return { handle: hit.handle, x: (x - rect.left) / scale, y: (y - rect.top) / scale };
}

function sendPointerTo(hit: PointerHit, type: "move" | "down" | "up", p: PointerEvent) {
    const info = server.server.windows.get(hit.handle);
    if (!info) return;
    const rect = render.getXdgSurfaceEle(info.renderId)?.getBoundingClientRect();
    if (!rect) return;
    // DOM 是桌面物理 px；Wayland 坐标是 surface-local 逻辑 px
    const scale = info.scale || 1;
    const nx = (p.x - rect.left) / scale;
    const ny = (p.y - rect.top) / scale;

    const ev = { type, x: nx, y: ny, button: p.button };
    server.server.notify("input.pointer", info.handle, ev);
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

type StationDrag = {
    item: ClipboardItem;
    last: { x: number; y: number };
    token?: string;
    ended?: { x: number; y: number };
};
let stationDrag: StationDrag | undefined;

function finishStationDrag(drag: StationDrag, x: number, y: number) {
    if (!drag.token) return;
    const target = dndTargetAt(x, y);
    if (target) server.server.notify("dnd.drop", drag.token, target);
    else server.server.notify("dnd.cancel", drag.token);
}

/** 中转站条目拖出：桌面作为 DnD 源，server 负责目标 offer 和数据转发 */
function handleStationDrag(item: ClipboardItem, phase: "start" | "move" | "end", x: number, y: number) {
    if (phase === "start") {
        const drag: StationDrag = { item, last: { x, y } };
        stationDrag = drag;
        void server.server
            .request("dnd.start", { id: item.id, mimes: item.mimes }, ["copy"])
            .then((token) => {
                if (stationDrag !== drag) {
                    server.server.notify("dnd.cancel", token);
                    return;
                }
                drag.token = token;
                if (drag.ended) {
                    stationDrag = undefined;
                    finishStationDrag(drag, drag.ended.x, drag.ended.y);
                } else {
                    server.server.notify("dnd.move", token, dndTargetAt(drag.last.x, drag.last.y) ?? null);
                }
            })
            .catch((err) => {
                console.error("dnd.start failed:", err);
                if (stationDrag === drag) stationDrag = undefined;
            });
        return;
    }

    const drag = stationDrag;
    if (!drag) return;
    drag.last = { x, y };
    if (phase === "move") {
        if (drag.token) server.server.notify("dnd.move", drag.token, dndTargetAt(x, y) ?? null);
        return;
    }
    if (drag.token) {
        stationDrag = undefined;
        finishStationDrag(drag, x, y);
    } else {
        drag.ended = { x, y };
    }
}

/** 拖拽指针落在中转站弹窗上松手：先读数据入库，再取消源客户端的拖拽会话 */
async function dropDragToStation() {
    const drag = activeDrag;
    if (!drag) return;
    activeDrag = undefined;
    clipboardStationTool?.setDragActive(false);
    let item: ClipboardItem | undefined;
    try {
        item = await clipboard?.add(drag.mimes, (mime) => server.server.request("dnd.read", drag.token, mime), {
            appid: drag.appid,
            seat: drag.seat,
            kind: "drag",
        });
    } finally {
        // 数据已经读完（或读失败）；取消让源客户端退出 drag 状态
        server.server.notify("dnd.cancel", drag.token);
    }
    // 收进中转站的内容直接成为当前剪贴板，用户可以马上粘贴
    if (item) clipboard?.copy(item.id);
}

function sendPointerEvent(type: "move" | "down" | "up", p: PointerEvent): PointerHit | undefined {
    const key = pointerKey(p);

    // 拖拽会话由桌面驱动：不把指针转给源窗口，改发 dnd.move/drop
    if (activeDrag) {
        // 弹窗被收起时，指针移到剪贴板图标上重新展开
        if (type === "move" && clipboardToolEl && clipboardToolEl.contains(document.elementFromPoint(p.x, p.y))) {
            showClipboardTip?.({ state: "show", anchorEl: clipboardToolEl });
        }
        const overStation = clipboardStationTool?.containsPoint(p.x, p.y) ?? false;
        if (overStation && !stationWasHover) stationHoverAt = performance.now();
        stationWasHover = overStation;
        clipboardStationTool?.setDropHover(overStation);
        // 刚自动弹出时指针可能正好在弹窗上；停留一小会儿才当成有意投递
        const stationArmed = overStation && performance.now() - stationHoverAt >= 160;
        if (stationArmed) {
            if (type === "up") {
                void dropDragToStation();
                pointerRoutes.delete(key);
                pointerTarget = undefined;
            }
            return undefined;
        }

        const target = dndTargetAt(p.x, p.y);
        if (type === "move") {
            server.server.notify("dnd.move", activeDrag.token, target ?? null);
        } else if (type === "up") {
            // 没有目标也走 drop(null)：让 GTK/Firefox 得到“窗口外释放”而不是取消
            server.server.notify("dnd.drop", activeDrag.token, target ?? null);
            activeDrag = undefined;
            clipboardStationTool?.setDragActive(false);
            pointerRoutes.delete(key);
            pointerTarget = undefined;
        }
        return undefined;
    }

    if (type === "down") {
        let route = pointerRoutes.get(key);
        if (!route) {
            // 第一次按下决定这次指针序列归谁：桌面 UI（desktop）或某个客户端窗口。
            // 一个 seat 同一时刻只能有一个 pointer focus，所以只给最上层命中的 client 发。
            const hit = pointerHits(p)[0];
            if (hit) {
                route = { kind: "client", hit };
                pointerRoutes.set(key, route);
                sendPointerTo(hit, "down", p);
            } else {
                route = { kind: "desktop", buttons: new Set() };
                pointerRoutes.set(key, route);
                // 模态对话框开着时点到了被挡住的父窗口：把注意力收回对话框
                // （点在桌面 UI 上不算，工具栏菜单之类照常响应）
                if (!desktopUiUnderPoint(p.x, p.y, p.target)) {
                    const modal = modalWindowInCurrentScreen();
                    if (modal !== undefined) {
                        viewData.focusWin(modal);
                        flashWindow(modal);
                    }
                }
            }
        } else if (route.kind === "client") {
            // 已经归属某个客户端时，后续按键沿用同一个窗口（隐式 grab）
            sendPointerTo(route.hit, "down", p);
        }

        if (route.kind === "client") {
            pointerTarget = route.hit;
            return route.hit;
        }
        route.buttons.add(p.button ?? 0);
        pointerTarget = undefined;
        return undefined;
    }

    if (type === "move") {
        const route = pointerRoutes.get(key);
        if (route) {
            // 按住期间保持按下时的归属：从客户端开始的拖拽不会因为经过弹窗而断掉，
            // 从桌面 UI 开始的按压也不会把 move 漏给下面的客户端
            if (route.kind === "desktop") {
                pointerTarget = undefined;
                return undefined;
            }
            sendPointerTo(route.hit, "move", p);
            pointerTarget = route.hit;
            return route.hit;
        }
        const hit = pointerHits(p)[0];
        if (hit) sendPointerTo(hit, "move", p);
        pointerTarget = hit;
        return hit;
    }

    const route = pointerRoutes.get(key);
    if (!route) {
        // 没有对应的按下（例如点击落在桌面 UI 上）：不能把抬起漏给客户端
        return undefined;
    }
    if (route.kind === "client") {
        sendPointerTo(route.hit, "up", p);
        pointerTarget = route.hit;
        // 客户端 grab 是否结束由 server 判断；不需要桌面维护按钮集合
        if (server.server.pointerGrab("seat0") === null) pointerRoutes.delete(key);
        return route.hit;
    }
    route.buttons.delete(p.button ?? 0);
    if (route.buttons.size === 0) pointerRoutes.delete(key);
    pointerTarget = undefined;
    return undefined;
}

/** `input.scroll` 需要的字段；real DOM WheelEvent 与统一输入事件都能直接用 */
type ScrollInput = {
    x: number;
    y: number;
    deltaX?: number;
    deltaY?: number;
    deltaMode?: number;
    wheelSource?: "wheel" | "finger" | "continuous";
    value120X?: number;
    value120Y?: number;
    scrollEnd?: boolean;
    /** 已命中的 DOM 目标；缺省按坐标取（和 inputSim 的命中测试一致） */
    target?: unknown;
};

function sendScrollEvent(p: ScrollInput) {
    if (viewData.overview || viewData.gestureActive || resizingWindowId !== undefined) return;
    // 只转发落在窗口层（windowEl）上的滚动；面板/任务栏/IME 候选窗等桌面 UI 不转发
    const target =
        p.target instanceof Element
            ? p.target
            : p.target instanceof Node
              ? p.target.parentElement
              : document.elementFromPoint(p.x, p.y);
    if (isDesktopUiTarget(target)) return;
    // 模态对话框开着时，滚动只发给对话框本身
    const modal = modalWindowInCurrentScreen();
    if (modal !== undefined) {
        const modalEl = windowElement(modal);
        if (!modalEl || !(target instanceof Node) || !modalEl.contains(target)) return;
    }
    const handled = new Set<string>();
    for (const info of windowsTopFirst()) {
        if (!viewData.isCurrentWin(info.handle)) continue;
        if (hasModalChild(info.handle)) continue;
        if (handled.has(info.clientId)) continue;
        const rootEl = render.getXdgSurfaceEle(info.renderId);
        if (!rootEl) continue;
        const rect = rootEl.getBoundingClientRect();
        const scale = info.scale || 1;
        const nx = (p.x - rect.left) / scale;
        const ny = (p.y - rect.top) / scale;
        if (!server.server.windows.hitTest(info.handle, { x: nx, y: ny })) continue;
        handled.add(info.clientId);

        // 行/页模式先换算成像素；触摸板的 delta 本身就是像素
        const unit = p.deltaMode === 1 ? 40 : p.deltaMode === 2 ? window.innerHeight : 1;
        const deltaX = (p.deltaX ?? 0) * unit;
        const deltaY = (p.deltaY ?? 0) * unit;
        const source = p.wheelSource ?? "wheel";

        // wl_pointer.axis 的单位是 surface-local，桌面滚轮的 CSS px 要除回逻辑；
        // value120 是物理滚轮刻度，不随窗口 scale 变化
        server.server.notify("input.scroll", info.handle, {
            deltaX: deltaX / scale,
            deltaY: deltaY / scale,
            deltaZ: 0,
            source,
            value120X: p.value120X ?? (source === "wheel" ? deltaX * 1.2 : undefined),
            value120Y: p.value120Y ?? (source === "wheel" ? deltaY * 1.2 : undefined),
            stop: p.scrollEnd,
            // 触摸板按自然滚动时，手指方向和 axis 方向相反；滚轮不在这里翻转
            relativeDirection: source !== "wheel" && naturalScroll ? "inverted" : "identical",
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
        /** 触摸板双指滚动的速度倍率 */
        touchpadScrollGain: 1,
        /** 触摸板自然滚动（内容跟随手指） */
        naturalScroll: true,
        /** 三指横滑切屏倍率 */
        switchGestureGain: DEFAULT_GESTURE_GAIN,
        /** 切屏后重排新旧顺序的延迟（毫秒） */
        reorderDelay: DEFAULT_REORDER_DELAY,
        /** 桌面绘制的窗口圆角（px，视觉值） */
        windowRadius: 18,
    },
});

const DEFAULT_WINDOW_RADIUS = 18;
function normalizeWindowRadius(value: unknown) {
    const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_WINDOW_RADIUS;
    return Math.min(24, Math.max(0, Math.round(n)));
}
let windowRadius = normalizeWindowRadius(desktopSetting.nget("windowRadius"));
document.documentElement.style.setProperty("--window-radius", `${windowRadius}px`);

// 滚轮在每帧回调里都会读到，缓存设置避免每次同步读配置文件
let touchpadScrollGain = desktopSetting.nget("touchpadScrollGain") ?? 1;
let naturalScroll = desktopSetting.nget("naturalScroll") ?? true;
/** 桌面自绘 UI 的缩放，跟随屏幕/客户端缩放；窗口模式和 winit 下由宿主 DPR 负责 */
let uiScale = 1;
/** 桌面 UI 元素是否已创建；屏幕缩放可能在初始化期间先到 */
let uiScaleReady = false;
document.documentElement.style.setProperty("--desktop-ui-scale", "1");
gestureSwitchGain = normalizeGestureGain(desktopSetting.nget("switchGestureGain"));
reorderDelay = normalizeReorderDelay(desktopSetting.nget("reorderDelay"));

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
    // 渲染层把 surface 尺寸写进画布的同一任务里同步外框；不用异步的 ResizeObserver
    onXdgSurfaceSize: (xdgId, width, height) => {
        const frame = clientFrameByRenderId.get(xdgId);
        if (!frame) return;
        frame.surfaceWidth = Math.max(1, width);
        frame.surfaceHeight = Math.max(1, height);
        if (frame.decorated && !frame.fullscreen) applyFrameSurfaceSize(frame);
        // 子窗口（对话框）的尺寸由客户端决定，首次拿到真实尺寸后重新在父窗口正中摆一次
        placeChildWindow(frame.handle);
    },
});
const server = MSysApi.server({ render });
// 剪贴板字节、历史、持久化都在桌面；server 只发事件、按需要数据
clipboard = initClipboard(server.server);
// 客户端开始拖拽 → 自动展开中转站弹窗，作为拖拽落点；结束时收起拖拽态
server.server.on("dnd.started", (drag) => {
    activeDrag = drag;
    stationHoverAt = 0;
    stationWasHover = false;
    clipboardStationTool?.setDragActive(true);
    showClipboardTip?.({ state: "show", anchorEl: clipboardToolEl });
});
server.server.on("dnd.finished", (token) => {
    if (activeDrag?.token !== token) return;
    activeDrag = undefined;
    stationHoverAt = 0;
    stationWasHover = false;
    clipboardStationTool?.setDragActive(false);
});
// 提前启动 xwayland-satellite；每次启动应用前再 await 一次，崩溃后也能重新拉起。
void server.startXwayland();

/** 窗口可用区（CSS px）：整块舞台内缩工具栏；最大化与普通窗口居中都用它 */
function availableStageSize() {
    return {
        x: wino.l,
        y: wino.t,
        width: Math.max(1, windowEl.el.offsetWidth - wino.l - wino.r),
        height: Math.max(1, windowEl.el.offsetHeight - wino.t - wino.b),
    };
}

/** server 已更新窗口 DOM 尺寸；最大化/全屏窗口要用新的可用区重新 configure */
function reconfigureMaximizedWindows() {
    requestAnimationFrame(() => {
        let hasFullscreen = false;
        const available = availableStageSize();
        for (const info of server.server.windows.list()) {
            if (info.states.fullscreen) {
                hasFullscreen = true;
                continue;
            }
            if (!info.states.maximized) continue;
            const scale = screenManager.getScale();
            const frame = clientWindowFrames.get(info.handle);
            const contentHeight = Math.max(1, available.height - (frame ? decoratedTitlebarPx(frame) : 0));
            if (frame) {
                setClientFrameLayout(frame, available.width, contentHeight);
                setClientFramePosition(frame, available.x, available.y);
            }
            server.server.notify("window.maximize", info.handle, {
                width: Math.max(1, Math.floor(available.width / scale)),
                height: Math.max(1, Math.floor(contentHeight / scale)),
            });
        }
        if (hasFullscreen) syncFullscreenWindowBoxes();
    });
}

/** 屏幕信息 + 客户端缩放；缩放写入设置并同步给 wayland server。 */
const screenManager = new ScreenManager({
    display: MSysApi.display,
    getScaleSetting: () => {
        const value = desktopSetting.nget("scale");
        return typeof value === "number" ? value : 1;
    },
    setScaleSetting: (scale) => desktopSetting.nset("scale", scale),
    applyOutput: (output) => server.server.outputs.set(output),
    onScaleChanged: (scale) => applyUiScale(scale),
    onModeChanged: reconfigureMaximizedWindows,
});
void screenManager
    .init()
    .then(() => applyUiScale(screenManager.getScale()))
    .catch((e) => console.error("[screen] 初始化失败", e));

// 桌面提供窗口可用空间（surface-local 逻辑尺寸）：工具栏通过内缩体现，stage 本身仍是整块视口
server.server.respond("surfaceBounds.request", () => {
    const rect = windowEl.el.getBoundingClientRect();
    const scale = screenManager.getScale();
    return {
        width: Math.max(1, (rect.width - wino.l - wino.r) / scale),
        height: Math.max(1, (rect.height - wino.t - wino.b) / scale),
    };
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
const appliedState = new Map<
    WinHandle,
    {
        w: number;
        h: number;
        maximized: boolean;
        fullscreen: boolean;
        scale: number;
        parent: WinHandle | null;
        modal: boolean;
    }
>();
/** 全屏时临时暂停居中的窗口；退出时只恢复这些，不打断用户手动拖动后的状态 */
const fullscreenCenteringPaused = new Set<WinHandle>();

/** 进入全屏：暂停自动居中，避免 ResizeObserver 用旧 viewport 把铺满的窗口移到偏移位置 */
function pauseCenteringForFullscreen(handle: WinHandle) {
    if (windowCenterManager.isPaused(handle)) return;
    windowCenterManager.pauseCentering(handle);
    fullscreenCenteringPaused.add(handle);
}

/** 退出全屏：只恢复因全屏而暂停的窗口 */
function resumeCenteringForFullscreen(handle: WinHandle) {
    if (!fullscreenCenteringPaused.delete(handle)) return;
    windowCenterManager.resumeCentering(handle);
}

server.server.on("window.created", (info) => {
    console.log(`Client ${info.clientId} created window ${info.handle}`, info.renderId);
    const wid = info.handle;
    const parent = info.parent ?? undefined;
    appliedState.set(wid, {
        w: info.rect.w,
        h: info.rect.h,
        maximized: false,
        fullscreen: false,
        scale: info.scale,
        parent: info.parent,
        modal: info.modal,
    });
    if (parent !== undefined) {
        windowParents.set(wid, parent);
        if (info.modal) modalWindows.add(wid);
    }

    const screen = viewData.addWindowScreen(wid, parent);
    // biome-ignore lint/style/noNonNullAssertion: 刚刚创建的，一定有
    const winEl = render.getXdgSurfaceEle(info.renderId)!;
    const frame = createClientWindowFrame(info, winEl);
    clientWindowFrames.set(wid, frame);
    applyFrameSurfaceSize(frame);
    setClientFramePosition(frame, wino.l, wino.t);
    addWindow(screen, frame.el.el, wid, parent === undefined);
    addResizeHandles(frame.el.el, wid, true, winEl);
    // 子窗口不在总览里单独成卡，关闭按钮由父窗口那张卡负责
    if (parent === undefined) {
        createOverviewWindowCloseButton(() => server.server.notify("window.close", wid)).addInto(frame.el);
    }
    // 子窗口让客户端自己决定尺寸（configure 0×0）：对话框有固有尺寸，
    // 给它塞 800×600 会把文件选择器这类对话框撑大。
    server.server.notify(
        "window.setBox",
        wid,
        parent === undefined ? { width: 800, height: 600 } : { width: 0, height: 0 },
    );
    viewData.focusWin(wid);
    if (parent !== undefined) {
        placeChildWindow(wid, true);
        // 客户端提交首帧后尺寸才确定，下一帧再摆一次（用户拖过之后 placeChildWindow 自己会跳过）
        requestAnimationFrame(() => placeChildWindow(wid, true));
    }
});

server.server.on("window.closed", (wid) => {
    console.log(`window ${wid} closed`);
    appliedState.delete(wid);
    // 挂在它上面的桌面内部窗口（文件选择器）一起收掉：否则 internalWindows 留下孤儿，
    // portal 请求也会一直挂着等不到结果
    for (const [child, parent] of [...windowParents]) {
        if (parent !== wid) continue;
        internalWindows.get(child)?.close();
    }
    lastFullscreenBox.delete(wid);
    fullscreenCenteringPaused.delete(wid);
    removeResizeHandles(wid);
    windowCenterManager.removeWindow(wid);
    const frame = clientWindowFrames.get(wid);
    clientWindowFrames.delete(wid);
    if (frame) {
        clientFrameByRenderId.delete(frame.renderId);
        frame.el.el.remove();
    }
    viewData.closeWin(wid);
    windowParents.delete(wid);
    modalWindows.delete(wid);
    childWindowPinned.delete(wid);
    // 指针还停在刚关闭的窗口上时，立刻回到默认光标；
    // 否则客户端退出流程补发的 hidden 会把光标留成空白
    if (pointerTarget?.handle === wid) {
        pointerTarget = undefined;
        cursor.setSurfaceFocus(undefined);
    }
    // 按下时归属该窗口的指针序列不再有接收方，后续 move/up 留在桌面
    for (const [key, route] of pointerRoutes) {
        if (route.kind === "client" && route.hit.handle === wid) {
            pointerRoutes.set(key, { kind: "desktop", buttons: new Set() });
        }
    }
});

server.server.on("window.startMove", (wid) => {
    const frame = clientWindowFrames.get(wid);
    if (!frame) return;
    const movingFrame = frame;
    const rect = movingFrame.el.el.getBoundingClientRect();

    windowCenterManager.pauseCentering(wid);
    if (windowParents.has(wid)) childWindowPinned.add(wid);

    const startX = mousePos.x;
    const startY = mousePos.y;

    const parentRect = movingFrame.el.el.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const origLeft = rect.left - parentRect.left;
    const origTop = rect.top - parentRect.top;
    let lastLeft = Math.round(origLeft);
    let lastTop = Math.round(origTop);

    function onPointerMove() {
        const newLeft = Math.round(mousePos.x - startX + origLeft);
        const newTop = Math.round(mousePos.y - startY + origTop);
        setClientFramePosition(movingFrame, newLeft, newTop);
        moveChildWindows(wid, newLeft - lastLeft, newTop - lastTop);
        lastLeft = newLeft;
        lastTop = newTop;
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
    // 父子关系/模态提示：payload 自包含，靠本地快照差分
    if (applied.parent !== info.parent) {
        applied.parent = info.parent;
        applyWindowParent(info.handle, info.parent ?? undefined);
    }
    if (applied.modal !== info.modal) {
        applied.modal = info.modal;
        applyWindowModal(info.handle, info.modal);
    }
    const frame = clientWindowFrames.get(info.handle);
    if (frame) {
        updateClientFrameInfo(frame, info);
        syncClientFrameMaximized(frame, info.states.maximized && !info.states.fullscreen);
    }

    // 服务端装饰协商结果变化：标题栏出现/消失会改变 frame 总高，即使内容尺寸没变也要重排
    const decorationChanged = frame !== undefined && frame.decorated !== info.decorated;
    if (frame && decorationChanged) {
        frame.decorated = info.decorated;
        applyClientFrameChrome(frame);
    }

    // 全屏状态变化（由客户端发起）：窗口铺满整块输出，工具栏随之避让
    if (applied.fullscreen !== info.states.fullscreen) {
        applied.fullscreen = info.states.fullscreen;
        if (info.states.fullscreen) {
            // 最大化与全屏互斥；进入全屏时把本地最大化快照一起收敛，避免走恢复分支
            applied.maximized = info.states.maximized;
            pauseCenteringForFullscreen(info.handle);
            syncFullscreenChrome();
            syncFullscreenWindowBoxes();
            return;
        }
        // 退出全屏：恢复普通窗口尺寸；若同时切到最大化，下面的最大化分支会再覆盖成铺满
        lastFullscreenBox.delete(info.handle);
        resumeCenteringForFullscreen(info.handle);
        if (!info.states.maximized) {
            const width = 800;
            const height = 600;
            if (frame) {
                setClientFrameLayout(frame, width * info.scale, height * info.scale);
                setClientFramePosition(frame, wino.l, wino.t);
            }
            server.server.notify("window.unfullscreen", info.handle, { width, height });
        } else {
            const available = availableStageSize();
            const contentHeight = Math.max(1, available.height - (frame ? decoratedTitlebarPx(frame) : 0));
            if (frame) {
                setClientFrameLayout(frame, available.width, contentHeight);
                setClientFramePosition(frame, available.x, available.y);
            }
            // 退出全屏恢复到最大化时，模块里的盒子还停在全屏尺寸；这里按可用区重新下发
            server.server.notify("window.unfullscreen", info.handle, {
                width: Math.max(1, Math.floor(available.width / info.scale)),
                height: Math.max(1, Math.floor(contentHeight / info.scale)),
            });
        }
        syncFullscreenChrome();
    }

    // 尺寸变化（来自 xdg_surface.set_window_geometry）或输出缩放变化。
    // 全屏窗口的 DOM 尺寸由桌面按输出铺满，不跟随客户端提交的普通几何。
    if (applied.w !== info.rect.w || applied.h !== info.rect.h || applied.scale !== info.scale || decorationChanged) {
        applied.w = info.rect.w;
        applied.h = info.rect.h;
        applied.scale = info.scale;
        // 拖拽缩放期间 DOM 尺寸是桌面自己的预览，等客户端提交或超时后再以客户端几何为准
        const previewingResize = resizingWindowId === info.handle || resizeSettleTimers.has(info.handle);
        if (frame && !previewingResize && !info.states.fullscreen) {
            if (info.states.maximized) {
                const available = availableStageSize();
                setClientFrameLayout(
                    frame,
                    available.width,
                    Math.max(1, available.height - decoratedTitlebarPx(frame)),
                );
                setClientFramePosition(frame, available.x, available.y);
            } else if (frame.decorated) {
                // 服务端装饰窗口只跟随渲染层回报的 surface 尺寸；window.changed 里的 rect 可能会早到
                if (decorationChanged) applyFrameSurfaceSize(frame);
            } else {
                // 没有桌面外框/阴影的窗口维持原来的内容几何
                setClientFrameLayout(frame, info.rect.w * info.scale, info.rect.h * info.scale);
            }
        }
        // 子窗口尺寸由客户端决定：几何一变就重新在父窗口正中摆一次（用户拖过则不动）
        if (windowParents.has(info.handle)) placeChildWindow(info.handle);
    }

    // 最大化状态变化（由客户端发起）
    if (applied.maximized !== info.states.maximized) {
        applied.maximized = info.states.maximized;
        if (info.states.fullscreen) return;
        if (!frame) return;
        if (info.states.maximized) {
            const available = availableStageSize();
            const contentHeight = Math.max(1, available.height - decoratedTitlebarPx(frame));
            setClientFrameLayout(frame, available.width, contentHeight);
            setClientFramePosition(frame, available.x, available.y);
            server.server.notify("window.maximize", info.handle, {
                width: Math.max(1, Math.floor(available.width / info.scale)),
                height: Math.max(1, Math.floor(contentHeight / info.scale)),
            });
        } else {
            // 恢复尺寸是 surface 逻辑尺寸；DOM 按输出缩放放大
            const width = 800;
            const height = 600;
            setClientFrameLayout(frame, width * info.scale, height * info.scale);
            setClientFramePosition(frame, wino.l, wino.t);
            server.server.notify("window.unmaximize", info.handle, { width, height });
        }
    }

    // 装饰协商变化时如果窗口正最大化，标题栏占位变了，需要重新给客户端下发可用内容尺寸
    if (decorationChanged && frame && info.states.maximized && !info.states.fullscreen) {
        const previewingResize = resizingWindowId === info.handle || resizeSettleTimers.has(info.handle);
        if (!previewingResize) {
            const available = availableStageSize();
            const contentHeight = Math.max(1, available.height - decoratedTitlebarPx(frame));
            setClientFrameLayout(frame, available.width, contentHeight);
            setClientFramePosition(frame, available.x, available.y);
            server.server.notify("window.maximize", info.handle, {
                width: Math.max(1, Math.floor(available.width / info.scale)),
                height: Math.max(1, Math.floor(contentHeight / info.scale)),
            });
        }
    }

    // 客户端可能在 commit 里用 set_window_geometry 把元素尺寸写回旧值（例如全屏前的最大化尺寸）；
    // 全屏窗口每次变化后都重新铺满输出，避免被工具栏占位部分裁掉
    if (info.states.fullscreen) syncFullscreenWindowBoxes();
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

/** 顶部/底部/左右工具栏占用的空间；只用于“可用区”计算，不限制 windowElWarp 的 DOM 尺寸 */
const wino = { t: 0, l: 0, r: 0, b: 0 };
/** 工具栏容器；界面缩放变化后按视觉尺寸重新计算 wino */
const chromePlants: { el: ElType<HTMLElement>; posi: Plant["posi"] }[] = [];
/** 启动台内容的外层；用视觉 px 避让工具栏，内部内容再按 zoom 缩放 */
let launchpadContentEl: ElType<HTMLElement> | undefined;

/**
 * 虚拟桌面包装始终铺满视口；工具栏避让只体现为窗口的可用区内缩（最大化、居中、surfaceBounds）。
 * 这样全屏渲染不需要改外部 DOM 尺寸，窗口/舞台天然是整块输出。
 */
const windowElWarp = view().style({
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    zIndex: "0",
});

const toolsEl = view()
    .style({
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: "10",
        zoom: "var(--desktop-ui-scale, 1)",
    })
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
            zIndex: "30",
        },
        {
            "&>*": {
                position: "absolute",
                top: 0,
            },
        },
    ),
);

const lockScreenView = view()
    .style({
        width: "100%",
        height: "100%",
        zoom: "var(--desktop-ui-scale, 1)",
    })
    .addInto(lockScreen); // 图片 信息等
const lockScreenPassword = view()
    .style({
        width: "100%",
        height: "100%",
        zoom: "var(--desktop-ui-scale, 1)",
    })
    .addInto(lockScreen);

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

/**
 * 从息屏唤醒时，DPMS ON 返回后面板真正出图还会晚一段时间。
 * 默认 300ms 动画会在面板亮起前结束，看起来像没有动画。
 */
const WAKE_ANIMATION_DURATION = 1600;

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
    const wakingFromXipin = lockScreenAnimate.currentStateName === "xipin";
    lockScreenAnimate.moveTo("lockview", wakingFromXipin ? WAKE_ANIMATION_DURATION : undefined);
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
    zIndex: "20",
});

mainEl.add([bg, windowElWarp, toolsEl, imeOverlay, lockScreen, cursorEl, screenOffLayer]);

const windowEl = view()
    .style({
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        overflow: "hidden",
    })
    .addInto(windowElWarp);

viewData = new ViewData();
const launcher = createLauncher();
viewData.setLauncher(launcher);
launcher.setUiScale(uiScale);
// AI 面板接入点：launcher.setAiHandler(({ text }) => ...)；未注册时 Copilot 显示「AI 未接入」
// 额外搜索处理器：launcher.search.register(provider)
// AI 面板接入点：launcher.setAiHandler(({ text }) => { ... })；
// 处理器也通过 launcher.search.register(provider) 增加，未注册 AI 时 Copilot 只提示“AI 未接入”。
const launchpadScreen = viewData.launchpadScreen;
if (launchpadScreen) {
    launchpadContentEl = createLaunchpadContent();
    launchpadScreen.el.add(launchpadContentEl);
}

// 总览里点到卡片以外的空白处退出预览
windowEl.on("click", (e) => {
    if (viewData.overview && e.target === windowEl.el) viewData.setOverview(false);
});

const ob = new ResizeObserver((e) => {
    for (const entry of e) {
        const rect = entry.contentRect;
        // stage 始终是整块视口；窗口可用区再按工具栏 inset 内缩
        windowCenterManager.setViewport(
            wino.l,
            wino.t,
            Math.max(1, rect.width - wino.l - wino.r),
            Math.max(1, rect.height - wino.t - wino.b),
        );
        viewData.setStageSize(rect.width, rect.height);
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
ime.setUiScale(uiScale);
void ime.init();

const initRect = windowEl.el.getBoundingClientRect();
windowCenterManager.setViewport(0, 0, initRect.width, initRect.height);
viewData.setStageSize(initRect.width, initRect.height);

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
            let batteryCharging = false;
            for (const device of power.getDevices()) {
                if (
                    (await device.getPowerSupply()) &&
                    ((await device.getType()) === "Battery" || (await device.getType()) === "Ups")
                ) {
                    batteryPercentage = await device.getPercentage();
                    batteryCharging = await device.isCharging();
                    break;
                }
            }
            registry.setData("power.battery", batteryPercentage);
            registry.setData("power.battery.charging", batteryCharging);
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

const powerProfileLabels: Record<string, string> = {
    "power-saver": "静音",
    balanced: "平衡",
    performance: "性能",
};

rawRegistry.setData("power.profiles", []);
rawRegistry.setData("power.profile", "");

MSysApi.powerProfiles
    .init()
    .then(async (available) => {
        if (!available) {
            console.warn("power-profiles-daemon 不可用，性能模式未启用");
            return;
        }
        const profiles = MSysApi.powerProfiles;

        const updateProfiles = async () => {
            const list = await profiles.getProfiles();
            for (const profile of list) {
                rawRegistry.setData(`power.profiles.${profile.name}` as "power.profiles[]", {
                    name: profile.name,
                    label: powerProfileLabels[profile.name] ?? profile.name,
                });
            }
            rawRegistry.setData(
                "power.profiles",
                list.map((profile) => `power.profiles.${profile.name}` as id<"power.profiles[]">),
            );
            rawRegistry.setData("power.profile", await profiles.getActiveProfile());
        };

        profiles.on("changed", (active) => rawRegistry.setData("power.profile", active));
        rawRegistry.setSetCallback("power.profile", async (name) => {
            try {
                await profiles.setActiveProfile(name);
                rawRegistry.setData("power.profile", name);
            } catch (e) {
                console.warn("设置性能模式失败", e);
            }
        });
        await updateProfiles();
    })
    .catch((e) => console.warn("powerProfiles init error", e));

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

type NotificationEntry = NotificationData & { closed: boolean; reason: number };
const notifications = new Map<string, NotificationEntry>();

MSysApi.notification
    .init()
    .then(() => {
        const registry = rawRegistry;
        const notification = MSysApi.notification;

        const setList = () => {
            registry.setData("notification.list", Array.from(notifications.keys()) as id<"notification.list[]">[]);
        };

        const setItem = (entry: NotificationEntry) => {
            registry.setData(`notification.list.${entry.id}` as "notification.list[]", {
                title: entry.summary,
                content: entry.body,
                id: entry.id,
                appName: entry.app_name,
                appIcon: entry.app_icon,
                actions: entry.actions,
                hints: entry.hints,
                expireTimeout: entry.expire_timeout,
                replacesId: entry.replaces_id,
                closed: entry.closed,
                reason: entry.reason,
            });
        };

        const removeNotification = (id: string | number) => {
            const key = String(id);
            if (!notifications.delete(key)) return;
            setList();
        };

        notification.on("new", (n) => {
            const key = String(n.id);
            const entry: NotificationEntry = { ...n, closed: false, reason: 0 };
            notifications.set(key, entry);
            setList();
            setItem(entry);
            registry.setSetCallback(`notification.list.${key}.delete` as "notification.list[].delete", async () => {
                const item = notifications.get(key);
                if (!item) return;
                // 活动通知先按“用户关闭”关闭；历史项只从面板移除
                if (!item.closed) {
                    await notification.close(item.id, 2).catch(() => undefined);
                }
                removeNotification(key);
            });
        });

        notification.on("closed", (id, reason) => {
            const key = String(id);
            const entry = notifications.get(key);
            if (!entry) return;
            entry.closed = true;
            entry.reason = reason;
            setItem(entry);
        });
    })
    .catch((e) => console.error("notification init error", e));

const mediaControl = new Set<string>();
const mediaTimers = new Map<string, ReturnType<typeof setInterval>>();
/** serverName → 是否正在播放；媒体键优先控制正在播放的播放器 */
const mediaPlaying = new Map<string, boolean>();
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

            const paused = await p.paused();
            mediaPlaying.set(serverName, !paused);
            registry.setData(registry.buildVarId("media.list[].play", [serverName]), paused);
            p.onStatusChange(async () => {
                const paused = await p.paused();
                mediaPlaying.set(serverName, !paused);
                registry.setData(registry.buildVarId("media.list[].play", [serverName]), paused);
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
            mediaPlaying.delete(name);
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

/** 音量键的目标值：pactl 写入是异步的，连续按键时按本地目标累加 */
const volumeTargets = new Map<number, number>();

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
    function syncDefault() {
        const { output, input } = findDefault();
        if (output?.volume !== undefined) rawRegistry.setData("volume.output.default.volume", output.volume);
        if (input?.volume !== undefined) rawRegistry.setData("volume.input.default.volume", input.volume);
        if (output?.isMuted !== undefined) rawRegistry.setData("volume.output.default.muted", output.isMuted);
        if (input?.isMuted !== undefined) rawRegistry.setData("volume.input.default.muted", input.isMuted);
    }
    function df() {
        volume.ev.on("deviceVolumeChange", (id, v) => {
            volumeTargets.set(id, v);
            const { output, input } = findDefault();
            if (output?.id === id) {
                rawRegistry.setData("volume.output.default.volume", v);
            }
            if (input?.id === id) {
                rawRegistry.setData("volume.input.default.volume", v);
            }
        });
        volume.ev.on("deviceRemove", (id) => volumeTargets.delete(id));
        volume.ev.on("deviceMuteChange", (id, b) => {
            const { output, input } = findDefault();
            if (output?.id === id) rawRegistry.setData("volume.output.default.muted", b);
            if (input?.id === id) rawRegistry.setData("volume.input.default.muted", b);
        });
        // 默认设备可能中途变化（插拔、连接蓝牙、手动切换），同步成新设备的状态
        volume.ev.on("defaultDeviceChange", syncDefault);
        syncDefault();

        rawRegistry.setSetCallback("volume.output.default.volume", (v) => {
            const { output } = findDefault();
            if (output?.id !== undefined) {
                volumeTargets.set(output.id, v);
                volume.setDeviceVolume(output.id, v);
            }
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

/** 亮度键的目标值：连续按键时 API 内部会合并写入，这里保留最新目标避免读到旧值 */
const brightnessTargets = new Map<string, number>();

MSysApi.brightness
    .init()
    .then(() => {
        const syncDisplays = () => {
            const ids: id<"brightness.displays[]">[] = [];
            for (const display of MSysApi.brightness.getDisplays()) {
                const itemId = rawRegistry.buildVarId("brightness.displays[]", [display.id]);
                const brightnessId = rawRegistry.buildVarId("brightness.displays[].brightness", [display.id]);
                rawRegistry.setData(itemId, {
                    name: display.name,
                    kind: display.kind,
                    writable: display.writable,
                });
                rawRegistry.setData(brightnessId, display.brightness);
                rawRegistry.setSetCallback(brightnessId, async (value) => {
                    await MSysApi.brightness.setBrightness(display.id, value);
                });
                brightnessTargets.set(display.id, display.brightness);
                ids.push(display.id as id<"brightness.displays[]">);
            }
            rawRegistry.setData("brightness.displays", ids);
            console.log("[brightness] ready, displays =", MSysApi.brightness.getDisplays());
        };

        MSysApi.brightness.on("added", syncDisplays);
        MSysApi.brightness.on("removed", (displayId) => {
            brightnessTargets.delete(displayId);
            syncDisplays();
        });
        MSysApi.brightness.on("changed", (id, value) => {
            brightnessTargets.set(id, value);
            rawRegistry.setData(rawRegistry.buildVarId("brightness.displays[].brightness", [id]), value);
        });
        syncDisplays();
    })
    .catch((e) => console.warn("[brightness] init error", e));

// UI 对象池
const uipool = {
    "power.battery": () => {
        const percentage = rawRegistry.get("power.battery");
        const charging = rawRegistry.get("power.battery.charging");
        const label = aLineText();
        let percentageValue = 0;
        let chargingValue = false;
        const render = () => label.sv(`${percentageValue} ${chargingValue ? "充电中" : "未充电"}`);
        const unsubPercentage = percentage.getAndSubscribe((v) => {
            percentageValue = v;
            render();
        });
        const unsubCharging = charging.getAndSubscribe((v) => {
            chargingValue = v;
            render();
        });
        return {
            id: "power.battery",
            type: "indicator",
            el: label as unknown as ElType<HTMLElement>,
            unmount: () => {
                unsubPercentage();
                unsubCharging();
            },
        };
    },
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
    "power.profiles": () => {
        const source = rawRegistry.get("power.profiles");
        const activeSource = rawRegistry.get("power.profile");
        const us: (() => void)[] = [];
        const container = dynamicScrollList<string>({
            itemSize: sSize(1.5),
            containerSize: sSize(1.5) * 3,
            direction: "down",
            keyExtractor: (x) => x,
            renderItem: (k) => {
                const el = iItem({ type: "h", size: 1.5 }).style({
                    display: "flex",
                    alignItems: "center",
                    padding: `${sSize2.padding}px`,
                    gap: `${sSize2.padding}px`,
                    cursor: "pointer",
                });
                let name = "";
                let active = "";
                const mark = txt().style({ flexShrink: 0 });
                const renderMark = () => mark.sv(name !== "" && active === name ? "✓" : "○");
                const usItem = rawRegistry.get(k as "power.profiles[]").getAndSubscribe((v) => {
                    name = v.name;
                    el.clear().add([aLineText().sv(v.label), spacer(), mark]);
                    renderMark();
                });
                const usActive = activeSource.getAndSubscribe((v) => {
                    active = v;
                    renderMark();
                });
                us.push(usItem, usActive);
                el.on("click", () => {
                    if (!name) return;
                    rawRegistry.get("power.profile").set?.(name);
                });
                return el;
            },
        });

        const unsub = source.getAndSubscribe((ids) => {
            container.setList(ids);
            container.el.style({ display: ids.length > 0 ? "" : "none" });
        });
        return {
            id: "power.profiles",
            type: "dynamic-list",
            el: container.el.style({ width: px(sSize(6)) }),
            unmount: () => {
                unsub();
                for (const s of us) s();
            },
        };
    },
    "brightness.displays": () => {
        const source = rawRegistry.get("brightness.displays");
        const list = view("y").style({ gap: px(sSize2.padding) });
        const bar = ui.bar([list]);
        bar.el.style({ width: px(sSize(6)) });
        const unsubscribes = new Map<string, () => void>();

        const unsub = source.getAndSubscribe((ids) => {
            for (const unsubscribe of unsubscribes.values()) unsubscribe();
            unsubscribes.clear();
            list.clear();
            bar.el.style({ display: ids.length > 0 ? "" : "none" });

            for (const key of ids) {
                const brightnessKey = rawRegistry.buildVarId("brightness.displays[].brightness", [key]);
                const brightnessSource = rawRegistry.get(brightnessKey);
                const track = view().style({ background: "white", borderRadius: px(sSize2.radius1) }).el;
                const setBrightness = MUtils.throttle((v: number) => {
                    brightnessSource.set?.(v * 100)?.catch((error) => {
                        console.warn("[brightness] 设置亮度失败", key, error);
                    });
                }, 50);
                const range = rRange({ mel: track, onEnd: () => setBrightness.flush() });
                range.el.style({
                    width: px(sSize(6)),
                    height: px(sSize(1)),
                    borderRadius: px(sSize2.radius1),
                    overflow: "hidden",
                    ...gGlassStyle.itemInBg,
                });
                range.onChange(setBrightness);
                list.add(range.el);

                const itemKey = rawRegistry.buildVarId("brightness.displays[]", [key]);
                const unsubItem = rawRegistry.get(itemKey).getAndSubscribe((v) => {
                    range.el.style({
                        opacity: v.writable ? "1" : "0.5",
                        pointerEvents: v.writable ? "auto" : "none",
                    });
                });
                const unsubBrightness = brightnessSource.getAndSubscribe((v) => {
                    range.sv(v / 100);
                });
                unsubscribes.set(key, () => {
                    unsubItem();
                    unsubBrightness();
                });
            }
        });
        return {
            id: "brightness.displays",
            type: "dynamic-list",
            el: bar.el,
            unmount: () => {
                unsub();
                for (const unsubscribe of unsubscribes.values()) unsubscribe();
                unsubscribes.clear();
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
        viewData.toggleOverview();
    });
    return showAllViewBtn;
});

type DesktopApp = Awaited<ReturnType<typeof MSysApi.getDesktopEntries>>[number];

/** 应用名/本地名的拉丁候选，按应用缓存；应用列表本身由 sys_api 缓存 */
const searchAppVariants = new WeakMap<DesktopApp, string[]>();
function appSearchVariants(app: DesktopApp) {
    let variants = searchAppVariants.get(app);
    if (!variants) {
        variants = latinVariants(app.name, app.nameLocal);
        searchAppVariants.set(app, variants);
    }
    return variants;
}

function searchIcon(icon: string) {
    return async () => {
        if (!icon) return undefined;
        try {
            return (await MSysApi.getDesktopIcon(icon, { theme: setting.get("icon.theme") })) || undefined;
        } catch {
            return undefined;
        }
    };
}

/** 按 appid 找应用图标；内部窗口没有 appid 时返回首字母 */
function searchIconByAppid(appid: string) {
    return async () => {
        if (!appid || appid === "桌面窗口") return undefined;
        try {
            const app = await MSysApi.getDesktopEntry(appid);
            if (!app?.icon) return undefined;
            return (await MSysApi.getDesktopIcon(app.icon, { theme: setting.get("icon.theme") })) || undefined;
        } catch {
            return undefined;
        }
    };
}

type ScoredSearchResult = { score: number; result: SearchResult };

function finishSearch(scored: ScoredSearchResult[], limit: number) {
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((item) => item.result);
}

/** 内置处理器：应用（原始 name 和本地化 nameLocal，中文转拼音） */
function createAppSearchProvider(): SearchProvider {
    return {
        id: "apps",
        order: 10,
        limit: 8,
        async search(query, signal) {
            const apps = await MSysApi.getDesktopEntries().catch(() => [] as DesktopApp[]);
            if (signal.aborted) return [];
            const scored: ScoredSearchResult[] = [];
            for (const app of apps) {
                const score = scoreLatin(query, appSearchVariants(app));
                if (score === -Infinity) continue;
                scored.push({
                    score,
                    result: {
                        id: `app:${app.desktopFile}`,
                        score,
                        title: app.nameLocal || app.name,
                        subtitle: app.nameLocal && app.nameLocal !== app.name ? app.name : undefined,
                        badge: "应用",
                        icon: searchIcon(app.icon),
                        run: async () => {
                            await server.startXwayland();
                            server.runApp(app.exec, { env: app.env });
                        },
                    },
                });
            }
            return finishSearch(scored, 8);
        },
    };
}

/** 内置处理器：跳到窗口（Windows 客户端窗口 + 设置/文件选择器等内部窗口） */
function createWindowSearchProvider(): SearchProvider {
    return {
        id: "windows",
        order: 20,
        limit: 6,
        search(query) {
            const scored: ScoredSearchResult[] = [];
            for (const win of viewData.listWindows()) {
                const score = scoreLatin(query, latinVariants(win.title, win.appid));
                if (score === -Infinity) continue;
                scored.push({
                    score,
                    result: {
                        id: `window:${win.handle}`,
                        score,
                        title: win.title,
                        subtitle: win.current ? `${win.appid || "窗口"} · 当前` : win.appid || undefined,
                        badge: "窗口",
                        icon: searchIconByAppid(win.appid),
                        run: () => jump2Win(win.handle),
                    },
                });
            }
            return finishSearch(scored, 6);
        },
    };
}

/** 内置处理器：切换虚拟屏（含空桌面和启动台） */
function createScreenSearchProvider(): SearchProvider {
    return {
        id: "screens",
        order: 30,
        limit: 5,
        search(query) {
            const scored: ScoredSearchResult[] = [];
            for (const screen of viewData.listScreens()) {
                if (screen.current) continue;
                const aliases =
                    screen.kind === "launchpad"
                        ? latinVariants("launchpad", "app launcher")
                        : screen.kind === "empty"
                          ? latinVariants("empty desktop")
                          : [];
                const score = scoreLatin(query, [...latinVariants(screen.title, screen.subtitle), ...aliases]);
                if (score === -Infinity) continue;
                scored.push({
                    score,
                    result: {
                        id: `screen:${screen.id}`,
                        score,
                        title: screen.title,
                        subtitle: screen.subtitle,
                        badge: screen.kind === "launchpad" ? "启动台" : "虚拟屏",
                        icon: searchIconByAppid(screen.appid),
                        run: () => viewData.switchScreen(screen.id),
                    },
                });
            }
            return finishSearch(scored, 5);
        },
    };
}

/** 开始菜单和启动台共用：应用格子、设置格子、图标懒加载 */
type AppTileFactoryOptions = {
    iconConfig: DesktopIconConfig;
    /** IntersectionObserver 的 root；null 表示视口，适合离屏的启动台 */
    root: HTMLElement | null;
    tileWidth: number;
    tileHeight: number;
    iconSize: number;
    labelSize: number;
    /** 设置格子的白底容器尺寸，图标按容器减内边距 */
    settingsIconBox: number;
    onSettingsClick: () => void;
};

function createAppTileFactory(op: AppTileFactoryOptions) {
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
            { root: op.root, rootMargin: "120px 0px" },
        );
    }

    function createAppTile(app: DesktopApp) {
        const appEl = view("y").style({
            width: `${op.tileWidth}px`,
            height: `${op.tileHeight}px`,
            alignItems: "center",
            justifyContent: "flex-start",
            flexShrink: 0,
            // 屏幕外的格子跳过布局和绘制，长列表滚动更轻
            contentVisibility: "auto",
            containIntrinsicSize: `${op.tileWidth}px ${op.tileHeight}px`,
        });
        const iconView = view().addInto(appEl);
        const iconEl = appIconEl(app.exec, app.env).style({
            width: `${op.iconSize}px`,
            height: `${op.iconSize}px`,
        });
        iconView.add(iconEl);
        appEl.add(
            txt(app.nameLocal).style({
                fontSize: `${op.labelSize}px`,
                maxWidth: "92%",
                overflow: "hidden",
                textAlign: "center",
            }),
        );

        const load = () =>
            loadAppIcon(iconEl, async () => (await MSysApi.getDesktopIcon(app.icon, op.iconConfig)) || "", app.name, {
                rasterSize: op.iconSize,
            });
        if (observer) {
            iconLoaders.set(appEl.el, load);
            observer.observe(appEl.el);
        } else {
            enqueueIcon(load);
        }
        return appEl;
    }

    function createSettingsTile() {
        const appEl = view("y").style({
            width: `${op.tileWidth}px`,
            height: `${op.tileHeight}px`,
            alignItems: "center",
            justifyContent: "flex-start",
            flexShrink: 0,
        });
        const iconView = view().addInto(appEl);
        const iconEl = appIconEl().style({
            width: `${op.settingsIconBox}px`,
            height: `${op.settingsIconBox}px`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
        });
        const settingsIconSize = Math.max(1, op.settingsIconBox - 12);
        iconEl.add(
            getIconXEl("settings", {
                size: settingsIconSize,
                width: settingsIconSize,
                height: settingsIconSize,
            }),
        );
        iconView.add(iconEl);
        appEl.add(
            txt("设置").style({
                fontSize: `${op.labelSize}px`,
                maxWidth: "92%",
                overflow: "hidden",
                textAlign: "center",
            }),
        );
        appEl.on("click", () => op.onSettingsClick());
        return appEl;
    }

    return { createAppTile, createSettingsTile };
}

/** 顶部搜索栏：默认藏在工作区上方，可跟手下拉/上推；结果由 SearchEngine 异步汇总 */
function createLauncher(): LauncherController {
    const LAUNCHER_TRANSITION = { duration: 260, map: timingFunction.easeOut };
    let stageHeight = Math.max(1, windowEl.el.getBoundingClientRect().height || window.innerHeight);
    let progress = 0;
    let overviewMix = 0;
    /** 桌面 UI 缩放；stageHeight/topInset 是视觉 px，位置计算改用局部 px */
    let scale = uiScale;
    /** 舞台铺满视口，顶部工具栏仍覆盖在上面 */
    let topInset = 0;
    const localStageHeight = () => stageHeight / scale;
    const localTopInset = () => topInset / scale;
    const restingTop = () => {
        const normalTop = localStageHeight() / 3 - LAUNCHER_HEIGHT / 2;
        return normalTop + (OVERVIEW_LAUNCHER_TOP + localTopInset() - normalTop) * overviewMix;
    };
    const hiddenOffset = () => Math.max(0, restingTop() + LAUNCHER_HEIGHT + 12);

    const search = new SearchEngine();
    search.register(createAppSearchProvider());
    search.register(createWindowSearchProvider());
    search.register(createScreenSearchProvider());

    const layer = view()
        .style({
            position: "absolute",
            inset: "0",
            overflow: "hidden",
            pointerEvents: "none",
            zIndex: "2",
            zoom: "var(--desktop-ui-scale, 1)",
        })
        .addInto(windowElWarp);
    const shell = view("y")
        .style({
            position: "absolute",
            top: "0px",
            left: "50%",
            width: "min(560px, calc(80vw / var(--desktop-ui-scale, 1)))",
            padding: "0",
            boxSizing: "border-box",
            alignItems: "stretch",
            gap: "0",
            overflow: "hidden",
            borderRadius: "16px",
            background: "rgba(255,255,255,0.94)",
            backdropFilter: "blur(20px)",
            boxShadow: "0 12px 40px #00000033",
            border: "1px solid #ffffff88",
            opacity: "0",
            transform: `translate3d(-50%, -${hiddenOffset()}px, 0)`,
            visibility: "hidden",
            pointerEvents: "none",
            willChange: "transform, opacity, filter",
        })
        .data({ "desktop-ui": "launcher", "launcher-input": "" })
        .addInto(layer);
    const inputRow = view("x").style({
        height: `${LAUNCHER_HEIGHT}px`,
        padding: "0 18px",
        boxSizing: "border-box",
        alignItems: "center",
        flexShrink: "0",
    });
    const field = input("text")
        .style({
            width: "100%",
            height: "100%",
            border: "none",
            outline: "none",
            background: "transparent",
            padding: "0",
            fontSize: "16px",
            color: "#111",
        })
        .attr({ placeholder: "搜索应用、窗口或虚拟屏" });
    inputRow.add(field);
    const resultsEl = view("y").style({
        display: "none",
        maxHeight: "min(360px, 50vh)",
        overflowY: "auto",
        padding: "6px",
        gap: "2px",
        boxSizing: "border-box",
        borderTop: "1px solid #0000000f",
    });
    shell.add([inputRow, resultsEl]);
    shell.on("click", () => field.el.focus());

    const gear = new AnimationGear({ progress: 0, overview: 0 }, { transition: LAUNCHER_TRANSITION });
    const blurInput = () => {
        if (document.activeElement instanceof HTMLElement && document.activeElement.closest("[data-launcher-input]")) {
            document.activeElement.blur();
        }
    };
    const apply = () => {
        const p = progress;
        shell.style({
            top: `${restingTop()}px`,
            transform: `translate3d(-50%, -${(1 - p) * hiddenOffset()}px, 0)`,
            opacity: `${p}`,
            visibility: p > 0 ? "visible" : "hidden",
            pointerEvents: p > 0.5 ? "auto" : "none",
        });
        if (p === 1 && document.activeElement !== field.el) {
            field.el.focus({ preventScroll: true });
        } else if (p === 0) {
            blurInput();
        }
    };
    gear.setUpdateCallback((value) => {
        progress = value.progress;
        overviewMix = value.overview;
        apply();
    });
    gear.moveTo({ progress: 0, overview: 0 }, 0);

    const settle = () => gear.moveTo({ progress, overview: overviewMix }, 0);

    // ── 搜索结果 ──────────────────────────────────────────────────────────────────────────────
    let results: SearchResult[] = [];
    let resultEls: ElType<HTMLElement>[] = [];
    let selectedIndex = 0;
    /** 每次重绘递增；旧的图标异步加载回来时用它丢弃结果 */
    let renderSeq = 0;
    let querySeq = 0;
    let aiSeq = 0;
    let queryTimer: number | undefined;

    function setSelected(index: number) {
        if (results.length === 0) return;
        selectedIndex = (index + results.length) % results.length;
        for (let i = 0; i < resultEls.length; i++) {
            resultEls[i].style({ background: i === selectedIndex ? "rgba(0,0,0,0.06)" : "transparent" });
        }
        resultEls[selectedIndex]?.el.scrollIntoView({ block: "nearest" });
    }

    function hideResults() {
        renderSeq++;
        resultsEl.clear();
        resultsEl.style({ display: "none" });
        resultEls = [];
    }

    function showNotice(text: string) {
        results = [];
        selectedIndex = 0;
        renderSeq++;
        resultEls = [];
        resultsEl.clear().style({ display: "flex" });
        view("x")
            .style({ height: "44px", padding: "0 12px", alignItems: "center", fontSize: "13px", color: "#666" })
            .add(txt(text))
            .addInto(resultsEl);
    }

    function createResultEl(result: SearchResult, index: number, seq: number) {
        const row = view("x").style({
            height: "48px",
            padding: "0 12px",
            borderRadius: "10px",
            boxSizing: "border-box",
            alignItems: "center",
            gap: "10px",
            cursor: "pointer",
            flexShrink: "0",
            background: "transparent",
        });
        row.on("pointerenter", () => setSelected(index));
        row.on("click", (e) => {
            e.stopPropagation();
            activateResult(index);
        });

        const iconBox = view().style({
            width: "30px",
            height: "30px",
            borderRadius: "9px",
            background: "#ffffff",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            flexShrink: "0",
        });
        iconBox.add(
            txt((result.title.trim()[0] || "?").toUpperCase()).style({
                fontSize: "13px",
                fontWeight: "600",
                color: "#555",
            }),
        );
        const iconPromise = result.icon?.();
        if (iconPromise) {
            void iconPromise
                .then((url) => {
                    if (!url || seq !== renderSeq || !row.el.isConnected) return;
                    iconBox
                        .clear()
                        .add(
                            ele("img")
                                .style({ width: "100%", height: "100%", objectFit: "contain" })
                                .attr({ src: url, alt: "" }),
                        );
                })
                .catch(() => {});
        }

        const textCol = view("y").style({ flex: "1", minWidth: "0", gap: "1px" });
        textCol.add(
            txt(result.title).style({
                fontSize: "14px",
                color: "#111",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
            }),
        );
        if (result.subtitle) {
            textCol.add(
                txt(result.subtitle).style({
                    fontSize: "11px",
                    color: "#666",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                }),
            );
        }
        row.add([iconBox, textCol]);
        if (result.badge) {
            row.add(
                txt(result.badge).style({
                    fontSize: "11px",
                    color: "#666",
                    background: "#0000000a",
                    padding: "2px 6px",
                    borderRadius: "6px",
                    flexShrink: "0",
                }),
            );
        }
        return row;
    }

    function renderResults(query: string) {
        if (!query.trim()) {
            hideResults();
            return;
        }
        const seq = ++renderSeq;
        resultEls = [];
        resultsEl.clear().style({ display: "flex" });
        if (results.length === 0) {
            view("x")
                .style({ height: "44px", padding: "0 12px", alignItems: "center", fontSize: "13px", color: "#666" })
                .add(txt("未找到匹配项"))
                .addInto(resultsEl);
            return;
        }
        for (let i = 0; i < results.length; i++) {
            const row = createResultEl(results[i], i, seq);
            resultEls.push(row);
            resultsEl.add(row);
        }
        setSelected(Math.min(selectedIndex, results.length - 1));
    }

    function requestSearch(value: string, delay = 80) {
        const seq = ++querySeq;
        aiSeq++;
        if (queryTimer !== undefined) {
            clearTimeout(queryTimer);
            queryTimer = undefined;
        }
        if (!value.trim()) {
            search.cancel();
            results = [];
            selectedIndex = 0;
            hideResults();
            return;
        }
        queryTimer = window.setTimeout(async () => {
            queryTimer = undefined;
            const response = await search.search(value);
            // 输入已经变了，或者这次搜索被中断；异步结果直接丢弃
            if (!response || seq !== querySeq) return;
            results = response.results;
            selectedIndex = 0;
            renderResults(response.query);
        }, delay);
    }

    function activateResult(index: number) {
        const result = results[index];
        if (!result) return;
        // 确认结果后先收起搜索栏；全局预览里由退出预览的流程恢复停靠位置
        closeSearch();
        void Promise.resolve()
            .then(result.run)
            .catch((error) => console.warn(`[search] 执行 ${result.id} 失败:`, error));
    }

    function clearSearch() {
        querySeq++;
        aiSeq++;
        if (queryTimer !== undefined) {
            clearTimeout(queryTimer);
            queryTimer = undefined;
        }
        search.cancel();
        results = [];
        selectedIndex = 0;
        field.sv("");
        hideResults();
    }

    function closeSearch() {
        clearSearch();
        if (viewData.overview) {
            // 全局预览里搜索栏固定显示，不能收进工作区外
            blurInput();
            return;
        }
        overviewMix = 0;
        settle();
        gear.moveTo({ progress: 0, overview: 0 }, LAUNCHER_TRANSITION);
    }

    function openSearch() {
        if (viewData.overview) {
            field.el.focus({ preventScroll: true });
            return;
        }
        if (progress >= 1) {
            field.el.focus({ preventScroll: true });
            return;
        }
        // 从全局预览退出后可能保留着 overview=1；重新打开时先归到常规隐藏位置
        overviewMix = 0;
        settle();
        gear.moveTo({ progress: 1, overview: 0 }, LAUNCHER_TRANSITION);
    }

    async function handToAi(text: string) {
        const seq = ++aiSeq;
        const handled = await search.askAi(text);
        // AI 返回前搜索栏已关闭、重新输入或又发起一次 AI 请求：不要覆盖当前状态
        if (seq !== aiSeq) return;
        if (!handled) {
            showNotice("AI 未接入");
            return;
        }
        field.sv("");
        results = [];
        selectedIndex = 0;
        hideResults();
    }

    function copilot() {
        if (progress < 0.5) {
            openSearch();
            return;
        }
        const text = field.gv.trim();
        if (text) void handToAi(text);
        else closeSearch();
    }

    field.on("input", () => requestSearch(field.gv));
    field.on("keydown", (e) => {
        if (e.isComposing) return;
        if (e.code === "ArrowDown" || e.code === "ArrowUp") {
            if (results.length === 0) return;
            e.preventDefault();
            e.stopPropagation();
            setSelected(selectedIndex + (e.code === "ArrowDown" ? 1 : -1));
            return;
        }
        if (e.code === "Enter") {
            if (results.length === 0) return;
            e.preventDefault();
            e.stopPropagation();
            activateResult(selectedIndex);
            return;
        }
        if (e.code === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeSearch();
        }
    });

    return {
        getProgress: () => progress,
        getOverviewMix: () => overviewMix,
        setProgress: (value) => {
            progress = clampNumber(value, 0, 1);
            apply();
        },
        setOverviewMix: (value) => {
            overviewMix = clampNumber(value, 0, 1);
            apply();
        },
        animateVisual: (targetProgress, targetOverview, onComplete) => {
            settle();
            gear.moveTo(
                {
                    progress: clampNumber(targetProgress, 0, 1),
                    overview: clampNumber(targetOverview, 0, 1),
                },
                LAUNCHER_TRANSITION,
                onComplete,
            );
        },
        settle,
        isVisible: () => progress >= 0.5,
        blur: blurInput,
        open: openSearch,
        close: closeSearch,
        copilot,
        setAiHandler: (handler) => search.setAiHandler(handler),
        search,
        setStageSize: (height) => {
            if (height <= 0) return;
            stageHeight = height;
            apply();
        },
        setTopInset: (px) => {
            topInset = Math.max(0, px);
            apply();
        },
        setUiScale: (value) => {
            if (value <= 0 || value === scale) return;
            scale = value;
            apply();
        },
    };
}

/** 启动台：放在空桌面右边，显示应用图标，和空桌面一样是特殊虚拟屏 */
function createLaunchpadContent() {
    // 外层用未缩放的视觉 px 避让工具栏；内部 grid 再按界面缩放
    const root = view().data({ "desktop-ui": "launchpad" }).style({
        position: "absolute",
        top: "0px",
        left: "0px",
        right: "0px",
        bottom: "0px",
        boxSizing: "border-box",
        overflow: "hidden",
    });
    const grid = view("x", "wrap").style({
        width: "100%",
        height: "100%",
        padding: "48px",
        boxSizing: "border-box",
        alignContent: "flex-start",
        justifyContent: "flex-start",
        gap: "18px",
        overflowY: "auto",
        zoom: "var(--desktop-ui-scale, 1)",
    });
    root.add(grid);
    const loadingEl = txt("正在加载应用…").style({ padding: "8px", opacity: "0.6" }).addInto(grid);
    const tileFactory = createAppTileFactory({
        iconConfig: { theme: setting.get("icon.theme") },
        root: null,
        tileWidth: 96,
        tileHeight: 104,
        iconSize: 64,
        labelSize: 13,
        settingsIconBox: 64,
        onSettingsClick: () => openSettingsWindow(),
    });

    void MSysApi.getDesktopEntries()
        .catch(() => [] as DesktopApp[])
        .then(async (apps) => {
            loadingEl.remove();
            grid.add(tileFactory.createSettingsTile());
            if (apps.length === 0) {
                txt("未找到应用").style({ padding: "8px", opacity: "0.6" }).addInto(grid);
                return;
            }
            const batchSize = 40;
            for (let i = 0; i < apps.length; i += batchSize) {
                grid.add(apps.slice(i, i + batchSize).map((app) => tileFactory.createAppTile(app)));
                if (i + batchSize < apps.length) await scheduler.yield();
            }
        });
    return root;
}

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
            width: "calc(80vw / var(--desktop-ui-scale, 1))",
            height: "calc(80vh / var(--desktop-ui-scale, 1))",
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

    const tileFactory = createAppTileFactory({
        iconConfig,
        root: menu.el,
        tileWidth: 80,
        tileHeight: 80,
        iconSize: 40,
        labelSize: 12,
        settingsIconBox: 48,
        onSettingsClick: () => {
            showTip({ state: "hide" });
            openSettingsWindow();
        },
    });

    // 元数据在空闲时预取，但不创建 DOM / 不读图标
    const entriesPromise = MSysApi.getDesktopEntries().catch(() => [] as DesktopApp[]);
    let buildPromise: Promise<void> | null = null;
    function build() {
        if (buildPromise) return buildPromise;
        buildPromise = (async () => {
            const apps = await entriesPromise;
            loadingEl.remove();
            menu.add(tileFactory.createSettingsTile());
            if (apps.length === 0) {
                txt("未找到应用").style({ padding: "8px", opacity: "0.6" }).addInto(menu);
                return;
            }
            // 分批插入：先让首屏尽快出现，其余在空闲帧继续，避免一次长任务卡住点击
            const batchSize = 40;
            for (let i = 0; i < apps.length; i += batchSize) {
                const batch = apps.slice(i, i + batchSize).map((app) => tileFactory.createAppTile(app));
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
                browserApp.env,
            ).addInto(appsEl);
        }
        if (fileManagerApp) {
            appLauncher(
                async () =>
                    (await MSysApi.getDesktopIcon(fileManagerApp.icon, iconConfig)) ||
                    fs.readFileAsDataURLSync("/assets/icons/file-manager.png"),
                fileManagerApp.name,
                fileManagerApp.exec,
                fileManagerApp.env,
            ).addInto(appsEl);
        }
        if (terminalApp) {
            appLauncher(
                async () =>
                    (await MSysApi.getDesktopIcon(terminalApp.icon, iconConfig)) ||
                    fs.readFileAsDataURLSync("/assets/icons/terminal.png"),
                terminalApp.name,
                terminalApp.exec,
                terminalApp.env,
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
        const profiles = uipool["power.profiles"]();
        const deviceList = uipool["power.devices"]();

        ui.bar([
            ui.barItem().add(batteryInfo.el),
            ui.barItem().add(profiles.el),
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
    "clipboard",
    ({ tipEl, showTip }) => {
        if (!clipboard) return view().add(txt("剪贴板未就绪"));
        clipboardStationTool = createClipboardStationTool({
            station: clipboard,
            tipEl,
            onCopy: () => showTip({ state: "hide" }),
            onDragItem: handleStationDrag,
        });
        showClipboardTip = showTip;
        const el = clipboardStationTool.el;
        clipboardToolEl = el.el;
        if (activeDrag) clipboardStationTool.setDragActive(true);
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

tools.registerTool(
    "brightness",
    ({ tipEl, showTip }) => {
        const btn = button(getIconXEl("sun", { size: 20, width: 24, height: 24 })).on("click", () => {
            showTip();
        });

        const displays = uipool["brightness.displays"]();
        displays.el.addInto(tipEl);

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

const exitModifiers = { meta: false, shift: false, ctrl: false, alt: false };

// ── window 模式：宿主把触摸板 pinch 合成成 Ctrl+wheel，桌面再转发给 Wayland 客户端 ──
// desktop 模式由 evdev 的 TouchpadInput 直接产生 pinch；window 模式拿不到 evdev，
// 只能从 Chromium 的 Ctrl+wheel 里还原 scale。物理 Ctrl+滚轮不在这里处理。
type PointerInput = Extract<UniInputEvent, { kind: "pointer" }>;
const hostGestureMode = MSysApi.display.getType() !== "desktop";
let hostPinch: { target: WinHandle; scale: number; timer?: ReturnType<typeof setTimeout> } | undefined;

function isHostPinch(e: PointerInput): boolean {
    return hostGestureMode && e.ctrlKey === true && !exitModifiers.ctrl;
}

function endHostPinch(): void {
    if (!hostPinch) return;
    if (hostPinch.timer !== undefined) clearTimeout(hostPinch.timer);
    notifyGesture(hostPinch.target, { type: "pinch", phase: "end", cancelled: false });
    hostPinch = undefined;
}

function handleHostPinch(e: PointerInput): void {
    // Chromium 把 Wayland pinch 的 scale 增量合成为 Ctrl+wheel：deltaY 约等于 -scale增量×100
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? window.innerHeight : 1;
    const step = Math.exp((-(e.deltaY ?? 0) * unit) / 100);
    if (!hostPinch) {
        const target = sendGestureEvent({ type: "pinch", phase: "begin", fingers: 2 }, e.x, e.y);
        if (target === undefined) return;
        hostPinch = { target, scale: 1 };
    }
    hostPinch.scale = Math.min(10, Math.max(0.1, hostPinch.scale * step));
    notifyGesture(hostPinch.target, {
        type: "pinch",
        phase: "update",
        deltaX: 0,
        deltaY: 0,
        scale: hostPinch.scale,
        rotation: 0,
    });
    if (hostPinch.timer !== undefined) clearTimeout(hostPinch.timer);
    const timer = setTimeout(endHostPinch, 120);
    (timer as { unref?: () => void }).unref?.();
    hostPinch.timer = timer;
}

/** 在进入 inputSim 和桌面 UI 之前处理退出键；返回 true 表示已触发退出 */
function checkExitKey(e: UniInputEvent): boolean {
    if (e.kind !== "key") return false;
    const down = e.type === "down";
    if (EXIT_KEY.meta.includes(e.code)) exitModifiers.meta = down;
    else if (EXIT_KEY.shift.includes(e.code)) exitModifiers.shift = down;
    else if (EXIT_KEY.ctrl.includes(e.code)) exitModifiers.ctrl = down;
    else if (EXIT_KEY.alt.includes(e.code)) exitModifiers.alt = down;

    if (!down || e.repeat) return false;
    if (e.code === EXIT_KEY.e && exitModifiers.meta && exitModifiers.shift) return true;
    if (e.code === EXIT_KEY.delete && exitModifiers.ctrl && exitModifiers.alt) return true;
    return false;
}

/** 键盘亮度键：优先调内置屏，没有内置屏时调所有可写外接屏（每次 5%） */
function adjustBrightness(delta: number) {
    const writable = MSysApi.brightness.getDisplays().filter((display) => display.writable);
    const backlights = writable.filter((display) => display.kind === "backlight");
    const targets = backlights.length > 0 ? backlights : writable;
    for (const display of targets) {
        const base = brightnessTargets.get(display.id) ?? display.brightness;
        const value = Math.min(100, Math.max(0, Math.round(base + delta)));
        brightnessTargets.set(display.id, value);
        void MSysApi.brightness.setBrightness(display.id, value).catch((error) => {
            console.warn("[brightness] 调整亮度失败", display.id, error);
        });
    }
}

/** 亮度键在输入聚合层处理，锁屏时也可用；不再转发给客户端 */
function checkBrightnessKey(e: UniInputEvent): boolean {
    if (e.kind !== "key") return false;
    const up = e.code === InputEventCodes.KEY_BRIGHTNESSUP || e.webCode === "BrightnessUp";
    const down = e.code === InputEventCodes.KEY_BRIGHTNESSDOWN || e.webCode === "BrightnessDown";
    if (!up && !down) return false;
    if (e.type === "down" && !e.repeat) adjustBrightness(up ? 5 : -5);
    return true;
}

/** 默认输出设备；音量键只调它 */
function defaultSink() {
    return MSysApi.volume.getSinks().find((device) => device.isDefault);
}

/** 键盘音量键：默认输出每次 5% */
function adjustVolume(delta: number) {
    const sink = defaultSink();
    if (!sink) return;
    const base = volumeTargets.get(sink.id) ?? sink.volume ?? 0;
    const value = Math.round(Math.min(1, Math.max(0, base + delta)) * 100) / 100;
    volumeTargets.set(sink.id, value);
    void MSysApi.volume.setDeviceVolume(sink.id, value);
}

/** 键盘静音键：切换默认输出的静音状态 */
function toggleVolumeMute() {
    const sink = defaultSink();
    if (!sink) return;
    void MSysApi.volume.setDeviceMute(sink.id, "toggle");
}

/** 音量/静音键在输入聚合层处理，锁屏时也可用；不再转发给客户端 */
function checkVolumeKey(e: UniInputEvent): boolean {
    if (e.kind !== "key") return false;
    const up = e.code === InputEventCodes.KEY_VOLUMEUP || e.webCode === "AudioVolumeUp";
    const down = e.code === InputEventCodes.KEY_VOLUMEDOWN || e.webCode === "AudioVolumeDown";
    const mute = e.code === InputEventCodes.KEY_MUTE || e.webCode === "AudioVolumeMute";
    if (!up && !down && !mute) return false;
    if (e.type === "down" && !e.repeat) {
        if (mute) toggleVolumeMute();
        else adjustVolume(up ? 0.05 : -0.05);
    }
    return true;
}

/** 菜单键：在指针位置合成一次右键按下/抬起，客户端和桌面 UI 都按右键处理；不再转发给客户端 */
function checkContextMenuKey(e: UniInputEvent): boolean {
    if (e.kind !== "key") return false;
    const menu =
        e.code === InputEventCodes.KEY_COMPOSE ||
        e.code === InputEventCodes.KEY_MENU ||
        e.code === InputEventCodes.KEY_CONTEXT_MENU ||
        e.webCode === "ContextMenu";
    if (!menu) return false;
    if (e.type !== "down" || e.repeat) return true;
    const pointer: PointerInput = {
        kind: "pointer",
        type: "down",
        x: mousePos.x,
        y: mousePos.y,
        button: 2,
        pointerType: "mouse",
        pointerId: 1,
        isPrimary: true,
        source: e.source,
    };
    dispatchInput(pointer);
    dispatchInput({ ...pointer, type: "up" });
    return true;
}

/** 媒体键目标：优先正在播放的播放器，没有时用最近加入的 */
function currentMediaPlayer() {
    const players = MSysApi.media.getPlayers();
    return players.find((player) => mediaPlaying.get(player.getServerName())) ?? players.at(-1);
}

/** 媒体键在输入聚合层处理，锁屏时也可用；不再转发给客户端 */
function checkMediaKey(e: UniInputEvent): boolean {
    if (e.kind !== "key") return false;
    const playPause = e.code === InputEventCodes.KEY_PLAYPAUSE || e.webCode === "MediaPlayPause";
    const play =
        e.code === InputEventCodes.KEY_PLAY || e.code === InputEventCodes.KEY_PLAYCD || e.webCode === "MediaPlay";
    const pause = e.code === InputEventCodes.KEY_PAUSECD || e.webCode === "MediaPause";
    const next = e.code === InputEventCodes.KEY_NEXTSONG || e.webCode === "MediaTrackNext";
    const previous = e.code === InputEventCodes.KEY_PREVIOUSSONG || e.webCode === "MediaTrackPrevious";
    const stop = e.code === InputEventCodes.KEY_STOPCD || e.webCode === "MediaStop";
    if (!playPause && !play && !pause && !next && !previous && !stop) return false;
    if (e.type === "down" && !e.repeat) {
        const player = currentMediaPlayer();
        if (player) {
            if (playPause) player.playPause();
            else if (play) player.play();
            else if (pause) player.pause();
            else if (next) player.next();
            else if (previous) player.previous();
            else player.stop();
        }
    }
    return true;
}

/** 分发：统一传入新 api（当前行为为模拟 DOM 事件） */
function dispatchInput(e: UniInputEvent) {
    if (checkExitKey(e)) {
        window.close();
        return;
    }
    if (screenOffState !== "on") {
        // 用任意输入唤醒，唤醒这一下不交给应用；锁屏息屏时回到锁屏界面
        // 被吞掉的按下/抬起不会成对到达，清掉指针归属避免一直停在某个客户端上
        pointerRoutes.clear();
        pointerTarget = undefined;
        void setScreenOff(false);
        if (stateLock.getState() === "xipin") stateLock.setState("lock");
        return;
    }
    if (checkBrightnessKey(e)) return;
    if (checkVolumeKey(e)) return;
    if (checkMediaKey(e)) return;
    if (checkContextMenuKey(e)) return;
    // 滚轮/触摸板：先按窗口几何命中转发给 Wayland 客户端，再模拟 DOM 事件给桌面 UI。
    // 源信息（触摸板连续滚动、高精度刻度）随统一事件带下来，不能等模拟成 DOM WheelEvent 再取。
    if (e.kind === "pointer" && e.type === "wheel") {
        if (isHostPinch(e)) {
            handleHostPinch(e);
            return;
        }
        sendScrollEvent(e);
        if (e.scrollEnd) return;
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
            ctrlKey: e.ctrlKey,
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
    chromePlants.push({ el: plantEl, posi: p.posi });
}

/** 工具栏在 toolsEl 里跟着界面缩放；窗口可用区要用缩放后的视觉尺寸 */
function measureChromeInsets() {
    wino.t = 0;
    wino.b = 0;
    wino.l = 0;
    wino.r = 0;
    for (const plant of chromePlants) {
        const rect = plant.el.el.getBoundingClientRect();
        if (plant.posi === "top") wino.t = Math.max(wino.t, rect.height);
        else if (plant.posi === "bottom") wino.b = Math.max(wino.b, rect.height);
        else if (plant.posi === "left") wino.l = Math.max(wino.l, rect.width);
        else wino.r = Math.max(wino.r, rect.width);
    }
    // wino 不限制舞台尺寸，只用于窗口可用区：居中使用区、最大化尺寸、surfaceBounds 与总览布局
    windowCenterManager.setViewport(
        wino.l,
        wino.t,
        Math.max(1, windowEl.el.offsetWidth - wino.l - wino.r),
        Math.max(1, windowEl.el.offsetHeight - wino.t - wino.b),
        false,
    );
    viewData.setChromeInsets({ top: wino.t, bottom: wino.b, left: wino.l, right: wino.r });
    // 启动台内容避让工具栏；外层是未缩放的视觉 px，内部 grid 自己处理 zoom
    launchpadContentEl?.style({
        top: `${wino.t}px`,
        left: `${wino.l}px`,
        right: `${wino.r}px`,
        bottom: `${wino.b}px`,
    });
    reconfigureMaximizedWindows();
}

measureChromeInsets();

// ── 全屏渲染：工具栏不改变层级，而是模糊淡出；窗口本来就在整块舞台上，不需要改外部 DOM ──
// 用户进入全局预览，或切到没有全屏窗口的虚拟屏时，工具栏原样恢复。

/** 工具栏当前是否处于隐藏状态 */
let fullscreenChromeHidden = false;
/** 全屏窗口最近一次下发的尺寸，避免重复 configure */
const lastFullscreenBox = new Map<WinHandle, string>();

/** 当前虚拟屏的窗口是否全屏 */
function currentScreenFullscreen() {
    const winid = viewData.currentWinId();
    return winid !== undefined && server.server.windows.get(winid)?.states.fullscreen === true;
}

/** 整块输出尺寸（CSS px）；舞台固定铺满视口 */
function fullOutputSize() {
    return { width: windowEl.el.offsetWidth, height: windowEl.el.offsetHeight };
}

/** 把全屏窗口的 DOM 与客户端逻辑尺寸铺满整块输出 */
function syncFullscreenWindowBoxes() {
    const out = fullOutputSize();
    for (const info of server.server.windows.list()) {
        if (!info.states.fullscreen) continue;
        const frame = clientWindowFrames.get(info.handle);
        if (!frame) continue;
        setClientFrameLayout(frame, out.width, out.height, true);
        setClientFramePosition(frame, 0, 0);
        const width = Math.max(1, Math.floor(out.width / info.scale));
        const height = Math.max(1, Math.floor(out.height / info.scale));
        const key = `${width}x${height}@${info.scale}`;
        if (lastFullscreenBox.get(info.handle) === key) continue;
        lastFullscreenBox.set(info.handle, key);
        // 用 setSize 只改盒子并 configure：全屏 state 已在记录里，
        // 这样给后台虚拟屏的全屏窗口重新下发尺寸时不会顺带改变焦点状态
        server.server.notify("window.setSize", info.handle, { width, height });
    }
}

const fullscreenChromeGear = new AnimationGear(
    { mix: 0 },
    { transition: { duration: 260, map: timingFunction.easeOut } },
);
fullscreenChromeGear.setUpdateCallback(({ mix }) => {
    // 先加模糊，后半程再透明：动画结束时工具栏完全让位
    const fade = Math.max(0, (mix - 0.35) / 0.65);
    toolsEl.style({
        opacity: `${1 - fade}`,
        filter: mix > 0.001 ? `blur(${mix * 10}px)` : "none",
    });
    const hidden = mix >= 0.999;
    toolsEl.style({ visibility: hidden ? "hidden" : "visible" });
    toolsEl.el.toggleAttribute("data-fullscreen-toolbars", hidden);
});
fullscreenChromeGear.moveTo({ mix: 0 }, 0);

/** 视图（当前屏 / 全局预览 / 手势）或窗口状态变化后，重新计算全屏模式 */
function syncFullscreenChrome(animate = true) {
    const currentFullscreen = currentScreenFullscreen();
    if (currentFullscreen) {
        // 客户端后续的 set_window_geometry 可能把元素尺寸写回旧值，进入/停留全屏时都重新铺满
        syncFullscreenWindowBoxes();
    }
    const hide = currentFullscreen && !viewData.overview && !viewData.gestureActive;
    if (fullscreenChromeHidden === hide) return;
    fullscreenChromeHidden = hide;
    // 动画一开始就不再让工具栏接收输入；恢复时立即重新可用
    toolsEl.el.inert = hide;
    fullscreenChromeGear.moveTo({ mix: hide ? 1 : 0 }, animate ? undefined : 0);
}

/** 标题栏最大化/恢复按钮：桌面主动下发，窗口命令不会回 window.changed */
function toggleMaximizeWindow(winid = viewData.focusHandle) {
    if (winid === undefined || isInternalWindow(winid)) return;
    const info = server.server.windows.get(winid);
    const frame = clientWindowFrames.get(winid);
    if (!info || !frame || info.states.fullscreen) return;
    const applied = appliedState.get(winid);
    const maximized = !info.states.maximized;

    syncClientFrameMaximized(frame, maximized);
    if (maximized) {
        const available = availableStageSize();
        const contentHeight = Math.max(1, available.height - decoratedTitlebarPx(frame));
        setClientFrameLayout(frame, available.width, contentHeight);
        setClientFramePosition(frame, available.x, available.y);
        if (applied) {
            applied.maximized = true;
            applied.w = Math.max(1, Math.floor(available.width / info.scale));
            applied.h = Math.max(1, Math.floor(contentHeight / info.scale));
            applied.scale = info.scale;
        }
        server.server.notify("window.maximize", winid, {
            width: Math.max(1, Math.floor(available.width / info.scale)),
            height: Math.max(1, Math.floor(contentHeight / info.scale)),
        });
    } else {
        const width = 800;
        const height = 600;
        setClientFrameLayout(frame, width * info.scale, height * info.scale);
        setClientFramePosition(frame, wino.l, wino.t);
        if (applied) {
            applied.maximized = false;
            applied.w = width;
            applied.h = height;
            applied.scale = info.scale;
        }
        server.server.notify("window.unmaximize", winid, { width, height });
    }
}

/** 桌面主动切换当前聚焦窗口的全屏（Super+F） */
function toggleFullscreen(winid = viewData.focusHandle) {
    if (winid === undefined || isInternalWindow(winid)) return;
    const info = server.server.windows.get(winid);
    if (!info) return;
    const next = !info.states.fullscreen;
    const applied = appliedState.get(winid);
    const frame = clientWindowFrames.get(winid);

    if (next) {
        const out = fullOutputSize();
        server.server.notify("window.fullscreen", winid, {
            width: Math.max(1, Math.floor(out.width / info.scale)),
            height: Math.max(1, Math.floor(out.height / info.scale)),
        });
        // 桌面命令不发 window.changed，这里自己更新本地快照
        if (applied) {
            applied.fullscreen = true;
            applied.maximized = false;
        }
        pauseCenteringForFullscreen(winid);
        syncFullscreenChrome();
        syncFullscreenWindowBoxes();
        return;
    }

    server.server.notify("window.unfullscreen", winid, { width: 800, height: 600 });
    lastFullscreenBox.delete(winid);
    resumeCenteringForFullscreen(winid);
    // 先恢复工具栏和 stage 尺寸，再按恢复后的可用区铺窗口（最大化要看 inset 后的尺寸）
    syncFullscreenChrome();
    // 进入全屏前是最大化的话，协议层会把最大化恢复回来；这里按恢复后的状态铺窗口
    const restoredMaximized = server.server.windows.get(winid)?.states.maximized === true;
    if (applied) {
        applied.fullscreen = false;
        applied.maximized = restoredMaximized;
    }
    if (frame) {
        if (restoredMaximized) {
            const available = availableStageSize();
            const contentHeight = Math.max(1, available.height - decoratedTitlebarPx(frame));
            setClientFrameLayout(frame, available.width, contentHeight);
            setClientFramePosition(frame, available.x, available.y);
            server.server.notify("window.maximize", winid, {
                width: Math.max(1, Math.floor(available.width / info.scale)),
                height: Math.max(1, Math.floor(contentHeight / info.scale)),
            });
        } else {
            setClientFrameLayout(frame, 800 * info.scale, 600 * info.scale);
            setClientFramePosition(frame, wino.l, wino.t);
        }
    }
}

viewData.setChromeCallback(() => syncFullscreenChrome());
syncFullscreenChrome(false);

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
    mouseMove(e.x, e.y, e);
});
// 指针按下/抬起在 window capture 统一处理：路由层不再局限于窗口元素，
// 这样才能记录「按下在桌面 UI 上」的指针序列，避免抬起时漏给下面的客户端。
window.addEventListener(
    "pointerdown",
    (e) => {
        if (e.isTrusted || isSecondaryTouch(e)) return;
        sendPointerEvent("down", e);
    },
    true,
);
window.addEventListener(
    "pointerup",
    (e) => {
        if (e.isTrusted || isSecondaryTouch(e)) return;
        sendPointerEvent("up", e);
    },
    true,
);

// 点击桌面或其他窗口时让内部窗口失焦。只处理 inputSim 合成的 pointerdown：
// 原生事件在输入聚合层已经被 stopImmediatePropagation 拦截，不会再走到这里。
window.addEventListener(
    "pointerdown",
    (e) => {
        if (e.isTrusted) return;
        const target = e.target as HTMLElement | null;
        if (!target?.closest("[data-launcher-input]")) {
            if (launcher.isVisible()) launcher.close();
            else launcher.blur();
        }
        if (!isInternalWindow(viewData.focusHandle)) return;
        if (!target?.closest("[data-internal-window]")) viewData.blurAll();
    },
    true,
);

function isLauncherInputFocused() {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.closest("[data-launcher-input]") !== null;
}

body.on("keydown", (e) => {
    if (state.getState() !== "normal") return;
    if (!e.repeat && matchBindings(e, LOCK_BINDINGS)) {
        e.preventDefault();
        state.setState("lock");
        return;
    }
    if (!e.repeat && matchBindings(e, LAUNCHER_BINDINGS)) {
        e.preventDefault();
        viewData.toggleLauncher();
        return;
    }
    if (!e.repeat && isCopilotKey(e)) {
        e.preventDefault();
        launcher.copilot();
        return;
    }
    if (viewData.overview) {
        // 全局预览只响应普通点击和 Esc；启动器/内部窗口的输入留给 DOM
        if (!e.repeat && e.code === "Escape") {
            e.preventDefault();
            viewData.setOverview(false);
            return;
        }
        if (isLauncherInputFocused() || isInternalWindow(viewData.focusHandle)) return;
        e.preventDefault();
        return;
    }
    if (!e.repeat && matchBindings(e, DESKTOP_BINDINGS)) {
        e.preventDefault();
        if (e.code === "ArrowLeft") viewData.moveCurrent(1);
        else if (e.code === "ArrowRight") viewData.moveCurrent(-1);
        else if (e.code === "KeyD") viewData.toggleEmptyScreen();
        else viewData.toggleOverview();
        return;
    }
    if (!e.repeat && matchBindings(e, FULLSCREEN_BINDINGS)) {
        e.preventDefault();
        toggleFullscreen();
        return;
    }
    // 启动器和内部窗口自己处理 DOM 键盘事件，不转发给 Wayland 客户端
    if (isLauncherInputFocused()) return;
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
    if (
        matchBindings(e, DESKTOP_BINDINGS) ||
        matchBindings(e, LAUNCHER_BINDINGS) ||
        isCopilotKey(e) ||
        matchBindings(e, FULLSCREEN_BINDINGS)
    ) {
        e.preventDefault();
        return;
    }
    if (isLauncherInputFocused()) return;
    if (viewData.overview) {
        e.preventDefault();
        return;
    }
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

const cursor = new Cursor(cursorEl);
cursor.setScale(uiScale);

/** 桌面 UI 跟随屏幕缩放；窗口模式/winit 下 screenManager 固定 1x，宿主 DPR 负责缩放 */
function applyUiScale(scale: number) {
    const value = Number.isFinite(scale) && scale > 0 ? scale : 1;
    uiScale = value;
    document.documentElement.style.setProperty("--desktop-ui-scale", String(value));
    if (!uiScaleReady) return;
    // 先更新带 zoom 的子树，再按视觉尺寸重新测量工具栏占位
    launcher.setUiScale(value);
    cursor.setScale(value);
    ime?.setUiScale(value);
    measureChromeInsets();
    // 标题栏高度跟着界面缩放走；内容尺寸由渲染层按新 scale 更新，frame 再从内容盒子同步
    for (const [handle, frame] of clientWindowFrames) {
        const info = server.server.windows.get(handle);
        if (!info || info.states.maximized || info.states.fullscreen) continue;
        applyClientFrameChrome(frame);
        if (frame.decorated) applyFrameSurfaceSize(frame);
        else setClientFrameLayout(frame, info.rect.w * info.scale, info.rect.h * info.scale);
    }
    // 界面缩放会改变内部窗口的外层尺寸；只重排未被用户拖动的内部窗口，不动应用窗口
    for (const id of internalWindows.keys()) {
        if (!windowCenterManager.isPaused(id)) windowCenterManager.centerWindow(id);
    }
}

/** 窗口圆角设置：CSS 变量负责视觉，按钮内缩量需要按新半径重算 */
function setWindowRadius(value: number) {
    const next = normalizeWindowRadius(value);
    if (next === windowRadius) return;
    windowRadius = next;
    desktopSetting.nset("windowRadius", next);
    document.documentElement.style.setProperty("--window-radius", `${next}px`);
    for (const frame of clientWindowFrames.values()) updateClientFrameControls(frame);
}

uiScaleReady = true;
applyUiScale(screenManager.getScale());

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
    /** 触摸板设备的 phys 集合：伴随鼠标节点的滚轮是触摸板手势的重复上报 */
    touchpadPhys: Set<string>,
    /** phys → 最近一次触摸板 ABS 滚动时间 */
    lastTouchpadScroll: Map<string, number>,
    /** 正在滚动的触摸板 phys */
    touchpadScrolling: Set<string>,
) {
    const dev = input.getDevice(path);
    if (!dev) return () => {};
    const info = dev.info;
    const kind = pointerKindOf(info);
    const touchpad = isTouchpad(info);
    const touchscreen = isTouchscreen(info);
    const rel = hasRelativeXY(info);
    const abs = MInputMap.absPosMapping(info);
    const keyboard = canKey(info);
    if (debugGesture && touchpad) {
        console.log("[touchpad] device", {
            name: info.name,
            type: info.type,
            phys: info.phys,
            capabilities: info.capabilities,
            absInfo: info.absInfo,
            touchInfo: info.touchInfo,
        });
    }
    if (!rel && !abs && !keyboard) return () => {};
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
    // 高精度滚轮刻度（1/120 格），与像素 delta 分开累积；不随窗口缩放
    let wheelValueX = 0;
    let wheelValueY = 0;
    const frameKeys: { code: number; value: number }[] = [];
    // 本设备按下、还没抬起的键：设备移除时补成 up，避免模拟层和客户端一直保持按下
    const pressedKeys = new Set<number>();
    const pressedButtons = new Set<number>();

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
                  debugGesture: debugGesture ? (g) => console.log("[touchpad] two-finger", g) : undefined,
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
        if (info.phys) {
            lastTouchpadScroll.set(info.phys, performance.now());
            touchpadScrolling.add(info.phys);
        }
        const sign = naturalScroll ? 1 : -1;
        emit({
            kind: "pointer",
            type: "wheel",
            x: pointerPos.x,
            y: pointerPos.y,
            deltaX: deltaX * sign * touchpadScrollGain,
            deltaY: deltaY * sign * touchpadScrollGain,
            wheelSource: "finger",
            source: "evdev",
        });
    });
    touchpadInput?.on("scrollEnd", () => {
        if (info.phys) touchpadScrolling.delete(info.phys);
        emit({
            kind: "pointer",
            type: "wheel",
            x: pointerPos.x,
            y: pointerPos.y,
            deltaX: 0,
            deltaY: 0,
            wheelSource: "finger",
            scrollEnd: true,
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
    // 手势目标在 begin 时锁定：update/end 必须发给同一个窗口，不能中途改到别的客户端
    let gestureTarget: WinHandle | undefined;
    const forwardGesture = (ev: GestureCommand) => {
        if (debugGesture) console.log("[gesture] forward", ev);
        if (ev.phase === "begin") {
            gestureTarget = sendGestureEvent(ev, pointerPos.x, pointerPos.y);
            return;
        }
        if (gestureTarget === undefined) return;
        notifyGesture(gestureTarget, ev);
        if (ev.phase === "end") gestureTarget = undefined;
    };
    touchpadInput?.on("pinchStart", (fingers) => {
        forwardGesture({ type: "pinch", phase: "begin", fingers });
    });
    touchpadInput?.on("pinchUpdate", (deltaX, deltaY, scale, rotation) => {
        forwardGesture({ type: "pinch", phase: "update", deltaX, deltaY, scale, rotation });
    });
    touchpadInput?.on("pinchEnd", (cancelled) => {
        forwardGesture({ type: "pinch", phase: "end", cancelled });
    });
    // 三指横滑切换虚拟屏、上下滑总览/启动器：桌面捕获，不发给应用。
    // 四指及以上没有系统手势，第一次移动时作为 swipe 发给应用。
    let appSwipe = false;
    let appSwipeStarted = false;
    let appSwipeFingers = 0;
    let appHold = false;
    touchpadInput?.on("holdStart", (fingers) => {
        // 三指及以上是桌面手势，像全局快捷键一样消费掉，不发给应用
        if (fingers >= 3 || appSwipe) return;
        appHold = true;
        forwardGesture({ type: "hold", phase: "begin", fingers });
    });
    touchpadInput?.on("holdEnd", (cancelled) => {
        if (!appHold) return;
        appHold = false;
        forwardGesture({ type: "hold", phase: "end", cancelled });
    });
    touchpadInput?.on("multiStart", (fingers) => {
        if (fingers === 3) {
            viewData.startGesture();
            return;
        }
        if (fingers > 3) {
            appSwipe = true;
            appSwipeStarted = false;
            appSwipeFingers = fingers;
        }
    });
    touchpadInput?.on("multiMove", (fingers, moveX, moveY) => {
        if (appSwipe) {
            if (!appSwipeStarted) {
                appSwipeStarted = true;
                forwardGesture({ type: "swipe", phase: "begin", fingers: appSwipeFingers });
            }
            forwardGesture({ type: "swipe", phase: "update", deltaX: moveX, deltaY: moveY });
        } else if (fingers >= 3) {
            viewData.moveGesture(moveX, moveY);
        }
    });
    touchpadInput?.on("multiEnd", () => {
        if (appSwipe) {
            if (appSwipeStarted) forwardGesture({ type: "swipe", phase: "end" });
            appSwipe = false;
            appSwipeStarted = false;
            appSwipeFingers = 0;
        } else {
            viewData.endGesture();
        }
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
        if (wheelX || wheelY || wheelValueX || wheelValueY) {
            const deltaX = wheelX;
            const deltaY = wheelY;
            const value120X = wheelValueX;
            const value120Y = wheelValueY;
            wheelX = 0;
            wheelY = 0;
            wheelValueX = 0;
            wheelValueY = 0;
            // 触摸板即使通过相对滚轮通道上报，也是连续滚动，不能发离散步进
            const wheelSource = touchpad ? "finger" : "wheel";
            emit({
                kind: "pointer",
                type: "wheel",
                x: pointerPos.x,
                y: pointerPos.y,
                deltaX,
                deltaY,
                wheelSource,
                value120X: wheelSource === "wheel" ? value120X : undefined,
                value120Y: wheelSource === "wheel" ? value120Y : undefined,
                source: "evdev",
            });
        }
        const frame = frameKeys.splice(0);
        for (const { code, value } of frame) {
            const button = BTN_TO_BUTTON[code];
            if (button !== undefined) {
                if (value === 0) pressedButtons.delete(code);
                else pressedButtons.add(code);
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
                if (value === 0) pressedKeys.delete(code);
                else if (value === 1) pressedKeys.add(code);
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

    if (!dev.startReading().ok) return () => {};

    dev.on("relative", (code, value) => {
        // 相对设备出过事件：同 phys 的触摸板绝对坐标视为伴随鼠标通道的重复上报
        if (!touchpad && info.phys) relativeActivity.set(info.phys, performance.now());
        // 触摸板的伴随鼠标节点也会报滚轮；ABS 路径正在滚动时它是重复上报，
        // 丢掉它，让触摸板统一走 finger/axis（和 KDE/libinput 的行为一致）
        const wheelCode =
            code === InputEventCodes.REL_WHEEL_HI_RES ||
            code === InputEventCodes.REL_HWHEEL_HI_RES ||
            code === InputEventCodes.REL_WHEEL ||
            code === InputEventCodes.REL_HWHEEL;
        if (
            wheelCode &&
            !touchpad &&
            info.phys !== undefined &&
            touchpadPhys.has(info.phys) &&
            (touchpadScrolling.has(info.phys) ||
                performance.now() - (lastTouchpadScroll.get(info.phys) ?? -Infinity) < 200)
        ) {
            return;
        }
        if (code === InputEventCodes.REL_X) dx += value;
        else if (code === InputEventCodes.REL_Y) dy += value;
        else if (code === InputEventCodes.REL_WHEEL_HI_RES) {
            wheelY += -value * HI_RES_SCALE;
            wheelValueY += -value;
        } else if (code === InputEventCodes.REL_HWHEEL_HI_RES) {
            wheelX += value * HI_RES_SCALE;
            wheelValueX += value;
        } else if (code === InputEventCodes.REL_WHEEL && !hiResWheel) {
            wheelY += -value * WHEEL_STEP;
            wheelValueY += -value * 120;
        } else if (code === InputEventCodes.REL_HWHEEL && !hiResWheel) {
            wheelX += value * WHEEL_STEP;
            wheelValueX += value * 120;
        }
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
        } else if (code < InputEventCodes.BTN_0 || code === InputEventCodes.KEY_CONTEXT_MENU) {
            // 键盘按键（KEY_CONTEXT_MENU 数值落在 BTN_* 区间，但它是键盘键）
            frameKeys.push({ code, value });
        }
    });
    dev.on("sync", flushFrame);

    return function dispose() {
        // 设备移除：触摸板的轻触定时器/进行中的滚动/物理键由它自己收尾
        touchpadInput?.dispose();
        // 触屏还按着的接触点补 up，否则 pointer 会一直停在按下状态
        for (const c of touchContacts.values()) {
            if (c.starting) continue;
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
        }
        touchContacts.clear();
        for (const code of pressedButtons) {
            const button = BTN_TO_BUTTON[code];
            if (button === undefined) continue;
            emit({
                kind: "pointer",
                type: "up",
                x: pointerPos.x,
                y: pointerPos.y,
                button,
                pointerType: kind,
                source: "evdev",
            });
        }
        pressedButtons.clear();
        for (const code of pressedKeys) {
            emit({ kind: "key", type: "up", code, source: "evdev" });
        }
        pressedKeys.clear();
        if (dev.isReading()) dev.stopReading();
        dev.removeAllListeners();
    };
}

/** 接入 input api：逐设备解码 evdev 事件流（含热插拔），产出统一输入事件 */
function useEvdevInput(input: InputManager, emit: (e: UniInputEvent) => void, pointerPos: InputPointerPos) {
    // phys → 最近一次相对位移时间：触摸板与它的伴随鼠标节点共用
    const relativeActivity = new Map<string, number>();
    // 触摸板 phys：伴随鼠标节点的滚轮是同一手势的重复上报
    const touchpadPhys = new Set<string>();
    // phys → 最近一次触摸板 ABS 滚动时间
    const lastTouchpadScroll = new Map<string, number>();
    // 正在滚动的触摸板 phys：伴随鼠标节点的滚轮此时是重复上报
    const touchpadScrolling = new Set<string>();
    // 设备 path → 注销函数
    const attached = new Map<string, () => void>();

    /** 设备走了以后按 phys 清掉共享状态；同 phys 的伴随节点/另一台设备还在就保留 */
    const prunePhysState = () => {
        const live = new Set<string>();
        for (const info of input.getDevices()) {
            if (info.phys) live.add(info.phys);
        }
        for (const phys of relativeActivity.keys()) if (!live.has(phys)) relativeActivity.delete(phys);
        for (const phys of lastTouchpadScroll.keys()) if (!live.has(phys)) lastTouchpadScroll.delete(phys);
        for (const phys of touchpadScrolling) if (!live.has(phys)) touchpadScrolling.delete(phys);
        for (const phys of touchpadPhys) if (!live.has(phys)) touchpadPhys.delete(phys);
    };

    const detach = (path: string) => {
        const dispose = attached.get(path);
        if (!dispose) return;
        attached.delete(path);
        dispose();
        prunePhysState();
    };

    const attach = (info: DeviceInfo) => {
        // 同一 path 重新出现时先收尾旧设备，避免重复订阅和残留按键
        detach(info.path);
        if (info.phys && isTouchpad(info)) touchpadPhys.add(info.phys);
        attached.set(
            info.path,
            useEvdevDevice(
                input,
                emit,
                pointerPos,
                info.path,
                relativeActivity,
                touchpadPhys,
                lastTouchpadScroll,
                touchpadScrolling,
            ),
        );
    };

    for (const info of input.getDevices()) {
        attach(info);
    }
    input.on("deviceAdded", attach);
    input.on("deviceRemoved", detach);
    input.on("error", (error) => {
        console.warn("[input] 设备错误:", error.message);
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
