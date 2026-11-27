import { addClass, addStyle, button, type ElType, ele, image, input, pack, txt, view } from "dkh-ui";
import { type AnimationGear, timingFunction } from "myde-ui";
import type {
    ConnectConnection,
    DesktopIconConfig,
    DeviceInfo,
    FileChooserRequest,
    InputManager,
    SemanticWheelEvent,
    UniInputEvent,
    WheelEventSemantics,
    WinHandle,
} from "../../../src/desktop-api";
import { InputEventCodes } from "../../../src/input_codes/types";
import type { blueDevice } from "../../../src/sys_api/blue";
import type { wifiDevice } from "../../../src/sys_api/network";
import type { NotificationData } from "../../../src/sys_api/notification";
import type { powerDevice } from "../../../src/sys_api/power";
import { normalizePointerSpeed } from "../../../src/utils/pointer_accel";
import { TouchpadInput } from "../../../src/utils/touchpad";
import type { DragStartInfo, GestureCommand, WindowInfo } from "../../../src/wayland";
import { createAnimationGear, setAnimationSpeed } from "./animation_time";
import { type ClipboardItem, type ClipboardStation, initClipboard } from "./clipboard";
import { clipboardPreview, clipboardTime, createClipboardStationTool } from "./clipboard_tool";
import { Cursor } from "./cursor";
import { DragIcon } from "./drag_icon";
import { createFileChooserContent, fileChooserHeaderIcon, fileChooserTitle } from "./file_chooser";
import { getIconX, getIconXEl } from "./icon";
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
    WHEEL_SEQUENCE_DELAY,
    WHEEL_STEP,
} from "./input_evdev";
import { latinVariants } from "./latin";
import { createPolkitDialog } from "./polkit_dialog";
import { type BindingSource, Registry } from "./registry";
import type { id, RegistrySchema } from "./registry_schema";
import { ScreenManager } from "./screen";
import { type SearchAiHandler, SearchEngine, type SearchProvider, type SearchResult, scoreLatin } from "./search";
import { createSettingsContent, type ImePanelPreeditMode } from "./settings";
import { createBluePanel, createClockPanel, createConnectPanel, createPowerPanel, createWifiPanel } from "./tool_panel";
import {
    aLineText,
    gGlassStyle,
    gRadius,
    gShadowStyle,
    gSurfaceStyle,
    gTextStyle,
    mMedia,
    nNotiList,
    nNotiToast,
    nNumber,
    OSD_HEIGHT,
    OSD_WIDTH,
    px,
    sourceTag,
    sSize,
    sSize2,
    tTrayMenu,
    uBrightnessList,
    uBrightnessSlider,
    ui,
    uLevelRow,
    uScrollList,
    uStatusToast,
    uSystemMenu,
    vVolume,
} from "./ui";
import {
    createAsciiKeyboard,
    createFullKeyboard,
    type FullKeyboardHandle,
    type VkbDispatcher,
    type VkbImeAccess,
    type VkbKeyPress,
    type VkbSettings,
    type VkbSettingsAccess,
} from "./virtual_keyboard/keyboard";
import { TouchpadMode } from "./virtual_keyboard/touchpad_mode";
import { createWallpaperStore, type WallpaperSlot } from "./wallpaper";

/** Chromium / Electron 的 Scheduler API；当前 TS lib 没有声明 */
declare const scheduler: { yield(): Promise<void> };

const debugGesture =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.MYDE_DEBUG_GESTURE === "1";

// ========== Registry ==========

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

const { MSysApi, MInputMap, MUtils, MSetting } = myde;
const fs = MSysApi.fs;

/** 测试注入的应用列表；设置后替代真实 .desktop 扫描（`__mydeTest.setApps`） */
let testApps: DesktopApp[] | undefined;

function desktopApps(lans: string[] = []): Promise<DesktopApp[]> {
    return testApps ? Promise.resolve(testApps) : MSysApi.getDesktopEntries(lans);
}

function desktopApp(appid: string, lans: string[] = []): Promise<DesktopApp | undefined> {
    return testApps
        ? Promise.resolve(testApps.find((app) => app.desktopFile === appid))
        : MSysApi.getDesktopEntry(appid, lans);
}

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

const OSD_MAX_VISIBLE = 4;
const OSD_GAP = sSize2.paddingx;
const OSD_ANIMATION_DURATION = 300;

type ShowTip = (op?: {
    state?: "show" | "hide" | "toggle";
    anchorEl?: HTMLElement;
    /** 已经展开时把锚点位置平滑移过去，不再瞬移 */
    animate?: boolean;
}) => void;
type ShowToast = (
    content: ElType<HTMLElement>,
    op?: { duration?: number; anchorEl?: HTMLElement; key?: string },
) => void;
type HideToast = (key?: string) => void;

type ToolsItem = {
    cb: (p: {
        tipEl: HTMLElement;
        showTip: ShowTip;
        /** 自动消失的临时提示；下拉弹窗展开时不会显示 */
        showToast: ShowToast;
        hideToast: HideToast;
        /** 订阅下拉弹窗显隐；返回取消订阅函数 */
        onTipVisibleChange: (cb: (visible: boolean) => void) => () => void;
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

type ToastItem = {
    id: number;
    /** 同一 key 的提示更新同一条，而不是再压一条新的 */
    key?: string;
    timer?: number;
};

class Tools {
    tools: Map<string, ToolsItem>;
    private tipEl: HTMLElement = view().el;
    /** 当前展开的下拉弹窗；有值时所有临时提示都不显示 */
    private openTip: object | undefined;
    /** OSD 队列，新的在前；列表本身是唯一的 L1，每项只放内容 */
    private toastItems: ToastItem[] = [];
    /** 列表数据要能 structuredClone，DOM 元素单独按 id 存放 */
    private toastEls = new Map<number, ReturnType<typeof view>>();
    private toastHost: ElType<HTMLElement> | undefined;
    private toastList: ReturnType<typeof uScrollList<ToastItem>> | undefined;
    private toastGear: AnimationGear<{ show: number }> | undefined;
    private toastId = 0;
    private toastHideTimer: number | undefined;
    /** 每个弹窗一个隐藏的锚点替身：真实锚点被移除后，弹窗位置不会跟着失效 */
    private anchorProbes = new WeakMap<HTMLElement, HTMLElement>();
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
    /** 弹窗对应的隐藏锚点替身；替身常驻工具栏层，真实按钮被移除后仍能保持位置 */
    private getAnchorProbe(el: ElType<HTMLElement>) {
        let probe = this.anchorProbes.get(el.el);
        if (probe) return probe;
        probe = document.createElement("div");
        probe.dataset.anchorProbe = "1";
        probe.style.position = "fixed";
        probe.style.pointerEvents = "none";
        probe.style.opacity = "0";
        probe.style.margin = "0";
        probe.style.padding = "0";
        probe.style.border = "0";
        this.anchorProbes.set(el.el, probe);
        return probe;
    }
    /** 下拉弹窗和临时提示共用同一套锚点定位 */
    private place(
        el: ElType<HTMLElement>,
        anchorEl: HTMLElement | ElType<HTMLElement>,
        showA: "left" | "right" | "top" | "bottom",
        animate = false,
    ) {
        const anchorNode = anchorEl instanceof HTMLElement ? anchorEl : anchorEl.el;
        const probe = this.getAnchorProbe(el);
        // 锚点已经不在页面里时沿用替身上一次的位置，避免弹窗跳到 (0, 0)
        if (anchorNode.isConnected) {
            const rect = anchorNode.getBoundingClientRect();
            const tipRect = this.tipEl.getBoundingClientRect();
            const scale = uiScale > 0 ? uiScale : 1;
            // 锚点替身自己带过渡，弹窗跟着它连续移动；首次出现时直接落到目标位置
            probe.style.transition =
                animate && el.el.style.display !== "none" ? "left 180ms ease-out, top 180ms ease-out" : "none";
            probe.style.left = `${(rect.left - tipRect.left) / scale}px`;
            probe.style.top = `${(rect.top - tipRect.top) / scale}px`;
            probe.style.width = `${Math.max(1, rect.width / scale)}px`;
            probe.style.height = `${Math.max(1, rect.height / scale)}px`;
        }
        const anchorname = `--${crypto.randomUUID()}`;
        probe.style.setProperty("anchor-name", anchorname);
        // 先写名字再挂进 DOM，锚点才能在当前帧内被解析；弹窗必须在替身之后
        if (probe.parentElement !== this.tipEl || probe.nextSibling !== el.el) {
            probe.remove();
            this.tipEl.insertBefore(probe, el.el);
        }
        // 上一次关闭可能把弹窗锁定在固定坐标，重新打开时交回锚点定位
        for (const key of ["left", "top", "right", "bottom"]) el.el.style.removeProperty(key);
        el.style({
            positionAnchor: anchorname,
            ...(showA === "left"
                ? {
                      positionArea: "left center",
                  }
                : showA === "right"
                  ? {
                        positionArea: "right center",
                    }
                  : showA === "top"
                    ? {
                          positionArea: "top center",
                      }
                    : {
                          positionArea: "bottom center",
                      }),
        });
    }
    /**
     * 缩放原点对准实际锚点按钮：沿弹窗靠锚点的那条边，另一轴取按钮中心。
     * 靠边的弹窗会被浏览器平移，不能再用固定的 `top center`。
     */
    private setOrigin(el: ElType<HTMLElement>, showA: "left" | "right" | "top" | "bottom") {
        const probe = this.anchorProbes.get(el.el);
        if (!probe) return;
        const node = el.el;
        // 弹出瞬间 scale 为 0、display 还是 none，直接量会得到零尺寸；
        // 临时按完整尺寸量一次，绘制前恢复
        const prevDisplay = node.style.display;
        const prevScale = node.style.scale;
        const prevOpacity = node.style.opacity;
        node.style.display = "block";
        node.style.scale = "1";
        node.style.opacity = "0";
        const rect = node.getBoundingClientRect();
        const anchorRect = probe.getBoundingClientRect();
        // transform-origin 用元素的局部坐标，祖先 zoom 不会作用到这里；先换回局部尺寸
        const scale = uiScale > 0 ? uiScale : 1;
        const width = rect.width / scale;
        const height = rect.height / scale;
        const anchorX = (anchorRect.left + anchorRect.width / 2 - rect.left) / scale;
        const anchorY = (anchorRect.top + anchorRect.height / 2 - rect.top) / scale;
        const origin =
            showA === "bottom"
                ? `${anchorX}px 0px`
                : showA === "top"
                  ? `${anchorX}px ${height}px`
                  : showA === "right"
                    ? `0px ${anchorY}px`
                    : `${width}px ${anchorY}px`;
        node.style.transformOrigin = origin;
        node.style.display = prevDisplay;
        node.style.scale = prevScale;
        node.style.opacity = prevOpacity;
    }
    /** 关闭时锁定当前视觉位置；之后锚点元素被移除也不会跳到别处 */
    private freeze(el: ElType<HTMLElement>) {
        const node = el.el;
        if (node.style.display === "none") return;
        const prevScale = node.style.scale;
        const prevOpacity = node.style.opacity;
        node.style.scale = "1";
        node.style.opacity = "0";
        const rect = node.getBoundingClientRect();
        node.style.scale = prevScale;
        node.style.opacity = prevOpacity;
        node.style.removeProperty("position-anchor");
        node.style.removeProperty("position-area");
        node.style.removeProperty("right");
        node.style.removeProperty("bottom");
        // 弹窗在带 zoom 的工具栏层里，left/top 也要换回局部坐标
        const tipRect = this.tipEl.getBoundingClientRect();
        const scale = uiScale > 0 ? uiScale : 1;
        node.style.left = `${(rect.left - tipRect.left) / scale}px`;
        node.style.top = `${(rect.top - tipRect.top) / scale}px`;
    }
    /** 临时提示的 L1：列表本身负责毛玻璃、padding 和 gap；位置按第一项触发时的锚点计算 */
    private ensureToast() {
        if (this.toastHost && this.toastList && this.toastGear) {
            return { host: this.toastHost, list: this.toastList, gear: this.toastGear };
        }

        const host = view("y")
            .style({
                position: "fixed",
                width: "fit-content",
                height: "fit-content",
                padding: `${sSize2.padding}px`,
                ...gGlassStyle.bg,
                borderRadius: `${gRadius.container}px`,
                display: "none",
                pointerEvents: "none",
            })
            .addInto(this.tipEl);

        const list = uScrollList<ToastItem>({
            itemSize: OSD_HEIGHT,
            gap: OSD_GAP,
            containerSize: {
                min: OSD_HEIGHT,
                max: OSD_HEIGHT * OSD_MAX_VISIBLE + OSD_GAP * (OSD_MAX_VISIBLE - 1),
            },
            direction: "down",
            crossSize: OSD_WIDTH,
            listCrossSize: "100%",
            keyExtractor: (item) => String(item.id),
            renderItem: (item) => this.toastEls.get(item.id) ?? view(),
            bufferSize: 1,
            animationDuration: OSD_ANIMATION_DURATION,
            empty: "",
        });
        host.add(list.el);

        const gear = createAnimationGear<{ show: number }>(
            { show: 0 },
            { transition: { duration: 280, map: (x) => timingFunction.easeOut(x) } },
        );
        gear.addState("show", { show: 1 }, ["hide"]);
        gear.addState("hide", { show: 0 }, ["show"]);
        gear.setUpdateCallback((state) => {
            if (state.show === 0) host.style({ display: "none" });
            else host.style({ display: "flex", opacity: `${state.show}`, scale: `${state.show}` });
        });
        gear.moveTo("hide", 0);

        this.toastHost = host;
        this.toastList = list;
        this.toastGear = gear;
        return { host, list, gear };
    }

    private createToastItem(content: ElType<HTMLElement>) {
        return view("x")
            .style({
                width: "100%",
                height: "100%",
                alignItems: "center",
                flexShrink: "0",
            })
            .add(content);
    }

    private syncToastList() {
        const { host, list } = this.ensureToast();
        // 只有超出可视条目时才需要接收滚轮 / 拖拽，否则保持点击穿透
        host.style({ pointerEvents: this.toastItems.length > OSD_MAX_VISIBLE ? "auto" : "none" });
        list.setList(this.toastItems.slice());
    }

    private scheduleToastHide(item: ToastItem, duration: number) {
        if (item.timer !== undefined) clearTimeout(item.timer);
        item.timer = window.setTimeout(() => {
            item.timer = undefined;
            this.removeToast(item);
        }, duration);
    }

    private removeToast(item: ToastItem) {
        if (!this.toastItems.includes(item)) return;
        if (item.timer !== undefined) {
            clearTimeout(item.timer);
            item.timer = undefined;
        }
        this.toastItems = this.toastItems.filter((candidate) => candidate !== item);
        this.syncToastList();
        this.toastEls.delete(item.id);
        if (this.toastItems.length === 0) this.hideToastHost();
    }

    /** 最后一条淡出动画结束后再隐藏 L1，期间有新提示则取消隐藏 */
    private hideToastHost() {
        if (this.toastHideTimer !== undefined) clearTimeout(this.toastHideTimer);
        this.toastHideTimer = window.setTimeout(() => {
            this.toastHideTimer = undefined;
            if (this.toastItems.length > 0) return;
            if (!this.toastHost || !this.toastGear) return;
            this.freeze(this.toastHost);
            this.toastGear.moveTo("hide");
        }, OSD_ANIMATION_DURATION);
    }

    /** 打开下拉弹窗前收起全部提示，避免两个浮层同时出现 */
    private hideToastNow() {
        if (this.toastHideTimer !== undefined) {
            clearTimeout(this.toastHideTimer);
            this.toastHideTimer = undefined;
        }
        for (const item of this.toastItems) {
            if (item.timer !== undefined) {
                clearTimeout(item.timer);
                item.timer = undefined;
            }
        }
        const hadItems = this.toastItems.length > 0;
        if (hadItems) {
            this.toastItems = [];
            this.syncToastList();
            this.toastEls.clear();
        }
        if (!this.toastHost || !this.toastGear) return;
        if (hadItems) this.freeze(this.toastHost);
        this.toastGear.moveTo("hide", 0);
    }

    private hideToast(key?: string) {
        if (key === undefined) {
            this.hideToastNow();
            return;
        }
        const item = this.toastItems.find((candidate) => candidate.key === key);
        if (item) this.removeToast(item);
    }

    private showToast(
        content: ElType<HTMLElement>,
        op?: { duration?: number; key?: string; anchorEl?: HTMLElement; side?: "left" | "right" | "top" | "bottom" },
    ) {
        // 下拉弹窗展开时不弹临时提示，避免和面板抢同一块位置
        if (this.openTip) return;

        const { host, list, gear } = this.ensureToast();
        const key = op?.key;
        const existing = key === undefined ? undefined : this.toastItems.find((item) => item.key === key);
        const first = this.toastItems.length === 0;

        let item: ToastItem;
        if (existing) {
            const el = this.toastEls.get(existing.id);
            el?.clear().add(content);
            // 更新也算一次新提示，移到最上面并重新计时
            this.toastItems = [existing, ...this.toastItems.filter((candidate) => candidate !== existing)];
            item = existing;
        } else {
            item = {
                id: ++this.toastId,
                key,
            };
            this.toastEls.set(item.id, this.createToastItem(content));
            this.toastItems = [item, ...this.toastItems];
        }

        this.syncToastList();
        // 新提示 / 更新的提示都在顶部，滚回顶部保证能看到
        list.scrollTo(0, false);

        if (first) {
            if (op?.anchorEl) this.place(host, op.anchorEl, op.side ?? "bottom");
            gear.moveTo("show");
            if (op?.anchorEl) this.setOrigin(host, op.side ?? "bottom");
        } else {
            gear.moveTo("show");
        }

        this.scheduleToastHide(item, op?.duration ?? 2400);
    }
    getTool(name: string) {
        const tool = this.tools.get(name);
        if (!tool) return undefined;
        let launchEl: HTMLElement | null = null;
        /** 标识这个工具的下拉弹窗；多个工具中只有一个是展开的 */
        const tipToken = {};
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
                              padding: `${sSize2.padding}px`,
                              ...gGlassStyle.bg,
                              borderRadius: `${gRadius.container}px`,
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
        const gear = createAnimationGear<{ show: number }>(
            { show: 0 },
            { transition: { duration: 280, map: (x) => timingFunction.easeOut(x) } },
        );
        gear.addState("show", { show: 1 }, ["hide"]);
        gear.addState("hide", { show: 0 }, ["show"]);
        gear.setUpdateCallback((state) => {
            if (state.show === 0) {
                tipel.style({ display: "none" });
            } else {
                // 工具下拉用缩放 + 透明度即可；加了 blur 反而让层级不明显，合成开销也高
                tipel.style({ display: "block", opacity: `${state.show}`, scale: `${state.show}` });
            }
        });
        gear.moveTo("hide", 0);

        const tipVisibleListeners = new Set<(visible: boolean) => void>();
        let tipVisible = false;
        const setTipVisible = (visible: boolean) => {
            if (tipVisible === visible) return;
            tipVisible = visible;
            tipel.sv(visible ? "show" : "hide");
            gear.moveTo(visible ? "show" : "hide");
            for (const cb of tipVisibleListeners) cb(visible);
        };

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
                    setTipVisible(false);
                    if (this.openTip === tipToken) this.openTip = undefined;
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
                        const next = state === "show" ? true : state === "hide" ? false : !(tipel.gv === true);
                        const anchorEl = s?.anchorEl ? pack(s.anchorEl).el : el;
                        if (next) {
                            this.hideToastNow();
                            this.openTip = tipToken;
                            this.place(tipel, anchorEl, showA, s?.animate === true && tipVisible);
                            setTipVisible(true);
                            this.setOrigin(tipel, showA);
                        } else {
                            // 关闭只按当前画面收缩，不再切到调用方给的新锚点
                            this.freeze(tipel);
                            setTipVisible(false);
                            if (this.openTip === tipToken) this.openTip = undefined;
                        }
                    },
                    showToast: (content, op) => {
                        const anchorEl = op?.anchorEl ? pack(op.anchorEl).el : launchEl;
                        this.showToast(content, {
                            duration: op?.duration,
                            key: op?.key,
                            anchorEl: anchorEl ?? undefined,
                            side: showA,
                        });
                    },
                    hideToast: (key) => this.hideToast(key),
                    onTipVisibleChange: (cb) => {
                        tipVisibleListeners.add(cb);
                        return () => tipVisibleListeners.delete(cb);
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
    /** 顶层窗口，按底到顶的顺序；子窗口不在这里 */
    winIds: MWinId[];
    /** 这张屏上次聚焦的窗口；退出总览/搜索时按 `focus` 轴选屏后优先还给它 */
    focusWindow?: MWinId;
    empty: boolean;
    /** 启动台：固定在最右的应用图标屏，和空桌面一样不参与全局预览 */
    launchpad: boolean;
    /** 最近一次停留满缓冲期、成为当前屏的顺序，重排时从小到大（旧的到新的） */
    used: number;
    el: ElType<HTMLElement>;
    gear: AnimationGear<ViewTransform>;
    visual: ViewTransform;
    target: ViewTransform;
    /** 预览展开时这张卡片的接力方式：跟手线性 / 定时去 grid / 打断后回线性 */
    pullMode: "tracked" | "grid" | "linear";
};

function topWin(screen: ViewScreen | undefined): MWinId | undefined {
    return screen?.winIds[screen.winIds.length - 1];
}

type OverviewLayout = {
    cards: ViewScreen[];
    targets: Map<string, ViewTransform>;
    cols: number;
    cardWidth: number;
    cardHeight: number;
    gap: number;
};

const SCREEN_TRANSITION = { duration: 320, map: timingFunction.easeOut };
/** 按键/按钮打开、收起搜索栏不做过渡，直接跳到端点；手势仍按行程跟手 */
const LAUNCHER_KEY_TRANSITION = { duration: 0, map: timingFunction.linear };
/** 不在聚焦虚拟屏上的窗口目标帧率；server 按输出刷新率取最接近的整数因数 */
const BACKGROUND_WINDOW_FPS = 30;
/** 三指横滑位移倍率默认值；设置窗口可调 */
const DEFAULT_GESTURE_GAIN = 4;
/** 切屏后重排新旧顺序的延迟默认值（毫秒）；设置窗口可调 */
const DEFAULT_REORDER_DELAY = 3000;
/** 总览卡片间距（CSS px） */
const OVERVIEW_GAP = 24;
/** 过了这段纵向进度就不再绑定 level，用固定时长把整排重排到 grid */
const OVERVIEW_GRID_HANDOFF = 0.8;
/** 跨过接力点后的固定重排动画；与手势速度无关，避免不同速度下观感差异过大 */
const OVERVIEW_GRID_TRANSITION = { duration: 200, map: timingFunction.easeOut };
/** 聚焦面板比卡片略大 */
const FOCUS_PANEL_SCALE = 1.04;
/** 聚焦面板出现/消失的独立过渡时长（ms），不跟移动进度 */
const FOCUS_PANEL_FADE = 180;
/** 三指手势每个轴各自生效前的死区（CSS px）；横竖两轴独立，不锁定方向 */
const GESTURE_AXIS_DEADZONE = 12;
/** 三指上下滑从常规到全局预览的完整行程，按可用高度比例 */
const OVERVIEW_SWIPE_DISTANCE = 0.25;
/** 三指下拉展开启动器输入框的完整行程，按可用高度比例 */
const LAUNCHER_SWIPE_DISTANCE = 0.2;
/** 启动器输入 L2 高度（CSS px） */
const LAUNCHER_HEIGHT = 52;
/** 启动器 L1 外壳高度：输入 L2 + 上下 padding */
const LAUNCHER_SHELL_HEIGHT = LAUNCHER_HEIGHT + sSize2.padding * 2;
/** 搜索结果固定行高（4 × 12） */
const SEARCH_RESULT_ITEM_HEIGHT = 48;
/** 搜索结果面板固定 7 行：要么隐藏，要么 7 × 48 */
const SEARCH_RESULT_ROWS = 7;
const SEARCH_RESULT_PANEL_HEIGHT = SEARCH_RESULT_ITEM_HEIGHT * SEARCH_RESULT_ROWS;
/** 全局预览时启动器距工作区顶部（CSS px） */
const OVERVIEW_LAUNCHER_TOP = 12;
/** 全局预览 grid 顶部为启动器留出的高度 */
const OVERVIEW_TOP_INSET = OVERVIEW_LAUNCHER_TOP + LAUNCHER_SHELL_HEIGHT + 24;

/** 启动器两条连续路径：n-h-t 线与 n-t 直连 */
type LauncherRoute = "line" | "direct";

type LauncherBinding =
    | { kind: "line"; level: number }
    | { kind: "direct"; from: "n" | "t"; to: "n" | "t"; progress: number };

type LauncherController = {
    /** 由纵轴驱动：路径决定 level 怎么映射到搜索栏位置 */
    setLevel(level: number, route: LauncherRoute): void;
    isVisible(): boolean;
    blur(): void;
    /** 打开搜索栏并聚焦输入 */
    open(): void;
    /** 关闭搜索栏；全局预览中只失焦，启动器本身保持可见 */
    close(): void;
    /** 搜索框里是否有内容；全局预览的 ←/→、Enter 据此决定是移动屏还是交给搜索 */
    hasText(): boolean;
    /** 把按键文字插进搜索框（全局预览里搜索框没聚焦时，其它按键交给搜索） */
    insertText(text: string): void;
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

function sameTransform(a: ViewTransform, b: ViewTransform) {
    return (
        Math.abs(a.x - b.x) < 0.5 &&
        Math.abs(a.y - b.y) < 0.5 &&
        Math.abs(a.scale - b.scale) < 0.001 &&
        a.opacity === b.opacity &&
        a.blur === b.blur
    );
}

/** 输入法控制层在下方创建；焦点回调可能早于此时，统一走可选链 */
let ime: ImeController | undefined;
/** 虚拟键盘在输入法之后创建；锁屏/解锁回调可能更早 */
let vkb: FullKeyboardHandle | undefined;
/** 触控板页激活时把触屏映射成触控板 */
let keyboardTouchpad: TouchpadMode | undefined;
/** 顶栏虚拟键盘按钮；打开状态需要同步高亮 */
let vkbToolEl: ElType<HTMLElement> | undefined;

function updateVirtualKeyboardTool() {
    if (!vkbToolEl) return;
    const open = vkb?.isOpen() ?? false;
    vkbToolEl.style({
        background: open ? "#ffffff" : "transparent",
        boxShadow: open ? gShadowStyle.panel : "none",
    });
}

class ViewData {
    /** 所有虚拟屏，从左到右；空桌面永远在最后（最右） */
    private screens: ViewScreen[] = [];
    private win2Screen = new Map<MWinId, ViewScreen>();
    /** 已下发的窗口帧率上限，避免每次布局都重复 notify */
    private appliedFrameRates = new Map<MWinId, number | null>();
    /** 当前聚焦的窗口 handle，键盘按它反查客户端下发 */
    focusHandle: MWinId | undefined;
    /** 桌面模式（总览/搜索/锁屏）是否接管了键盘，退出时由它决定要不要补焦点 */
    private overlayHeldKeys = false;

    /**
     * 纵轴：桌面模式/预览进度。`<0` 只影响启动器，`>=0` 是预览进度。
     * 启动器自己解释负半段，桌面布局只看 `max(0, level)`，所以路径不影响屏。
     */
    private readonly levelGear: AnimationGear<{ v: number }>;
    /** 横轴：连续虚拟屏下标；整数表示停稳在某张屏 */
    private readonly focusGear: AnimationGear<{ v: number }>;
    private levelValue = 0;
    private focusValue = 0;
    /** 离散命令的目标；指针、键盘路由用 target，不用半动画中的视觉值 */
    private levelTarget = 0;
    private focusTarget = 0;
    /**
     * 启动器当前路径：`line` 是 n-h-t，`direct` 是 n-t。
     * 桌面布局不读它；它只决定 level 怎么映射到启动器位置，以及手势接管后继续走哪条。
     */
    private launcherRoute: LauncherRoute = "line";
    /** 从 t 程序化退出时回 n 还是 h；只有 direct 进入 t 才记 n */
    private tOrigin: "n" | "h" = "h";

    /** 预览里的聚焦面板；位置由 focus 连续插值，透明度独立淡入淡出 */
    private readonly focusPanelEl: ElType<HTMLElement>;
    private readonly focusPanelGear: AnimationGear<{ opacity: number }>;
    private launcher?: LauncherController;

    private usedSeq = 0;
    private nextId = 1;
    private reorderTimer: number | undefined;
    private chromeCallback?: () => void;
    /** 手势中两轴实时变化时更轻量的工具栏回调：只算显示/隐藏，不重排窗口 */
    private chromeProgressCallback?: () => void;
    private chromeInsets = { top: 0, bottom: 0, left: 0, right: 0 };
    private stageWidth = 1;
    private stageHeight = 1;
    private gesture:
        | {
              startLevel: number;
              startFocus: number;
              totalX: number;
              totalY: number;
              panelHold: boolean;
          }
        | undefined;

    constructor() {
        this.createEmptyScreen();
        this.createLaunchpadScreen();
        this.focusTarget = 0;
        this.focusValue = 0;
        this.focusPanelEl = view()
            .style({
                position: "absolute",
                left: "0",
                top: "0",
                width: "100%",
                height: "100%",
                transformOrigin: "0 0",
                pointerEvents: "none",
                // 面板始终在所有卡片下面；窗口层已隔离成独立层叠上下文
                zIndex: "-1",
                opacity: "0",
                willChange: "transform, opacity",
                borderRadius: "calc((var(--window-radius, 18px) + 2px) * var(--desktop-ui-scale, 1))",
                // 纯白不透明，避免 backdrop-filter 带来的合成压力
                background: "#fff",
            })
            .data({ "desktop-ui": "focus-panel" })
            .addInto(windowEl);
        this.focusPanelGear = createAnimationGear(
            { opacity: 0 },
            { transition: { duration: FOCUS_PANEL_FADE, map: timingFunction.easeOut } },
        );
        this.focusPanelGear.setUpdateCallback((value) => {
            this.focusPanelEl.style({ opacity: `${value.opacity}` });
        });
        this.levelGear = createAnimationGear({ v: 0 }, { transition: SCREEN_TRANSITION });
        this.levelGear.setUpdateCallback(({ v }) => {
            this.levelValue = v;
            this.applyAxes();
        });
        this.focusGear = createAnimationGear({ v: 0 }, { transition: SCREEN_TRANSITION });
        this.focusGear.setUpdateCallback(({ v }) => {
            this.focusValue = v;
            this.applyAxes();
        });
        this.render(false);
    }

    get launchpadScreen() {
        return this.screens.find((s) => s.launchpad);
    }

    get gestureActive() {
        return this.gesture !== undefined;
    }

    /** 预览是否处于目标状态；手势途中看的是松手会落到哪一侧 */
    get overview() {
        return this.levelTarget >= 0.5;
    }

    /** 0 = 常规，1 = 全局预览；手势途中取实时值 */
    get overviewProgress() {
        return clampNumber(this.levelValue, 0, 1);
    }

    setLauncher(launcher: LauncherController) {
        this.launcher = launcher;
        this.launcher.setLevel(this.levelValue, this.launcherRoute);
    }

    toggleLauncher() {
        if (this.overview) return;
        this.requestLauncherLevel(this.levelTarget <= -0.5 ? 0 : -1);
    }

    /** 启动器请求一个离散的常规/搜索位置；路径固定回 n-h-t 线 */
    requestLauncherLevel(target: number) {
        if (this.overview) return;
        this.cancelGesture();
        if (this.launcherRoute === "direct") {
            // 直连途中请求搜索：走完到 n，再折回 n-h-t 线
            this.animateLevel(0, true, () => this.finishLevelSettle(0));
            this.render(true);
            return;
        }
        this.levelTarget = clampNumber(target, -1, 0);
        // 按键/按钮开关搜索只走启动器，动画缩短；手势松手仍走 animateLevel 的常规吸附
        this.render(true, LAUNCHER_KEY_TRANSITION);
    }

    /** 当前稳定屏下标；离散位置，不使用动画中的小数 */
    private currentIndex() {
        if (this.screens.length === 0) return 0;
        return clampNumber(Math.round(this.focusTarget), 0, this.screens.length - 1);
    }

    private currentScreen() {
        return this.screens[this.currentIndex()];
    }

    private get currentId() {
        return this.currentScreen()?.id ?? "";
    }

    /** 所有结构变化都通过这里改 focus，避免下标随 splice 漂移 */
    private setFocusById(id: string | undefined, animate = false) {
        const index = id === undefined ? -1 : this.screens.findIndex((s) => s.id === id);
        const target = clampNumber(index >= 0 ? index : this.currentIndex(), 0, Math.max(0, this.screens.length - 1));
        this.focusTarget = target;
        if (!animate) {
            this.focusValue = target;
            this.focusGear.moveTo({ v: target }, 0);
            return;
        }
        const running = this.focusGear.getRunningAnimation();
        if (running.isRunning && running.toValue.v === target) return;
        if (!running.isRunning && Math.abs(this.focusValue - target) < 0.001) {
            this.focusValue = target;
            return;
        }
        // 停稳后再同步一次工具栏：切到/切离全屏屏时，显示/隐藏发生在轴动画之后
        this.focusGear.moveTo({ v: target }, { ...SCREEN_TRANSITION, onComplete: () => this.chromeCallback?.() });
    }

    private animateLevel(target: number, animate = true, onComplete?: () => void, transition = SCREEN_TRANSITION) {
        this.levelTarget = target;
        const running = this.levelGear.getRunningAnimation();
        if (!animate) {
            const same = Math.abs(this.levelValue - target) < 0.001;
            this.levelValue = target;
            this.levelGear.moveTo({ v: target }, 0);
            // 已经在目标上的重算不算一次过渡，不能重置 tOrigin
            if (!same) onComplete?.();
            return;
        }
        if (running.isRunning && running.toValue.v === target) return;
        // 已经在目标上就不要重新起一段 1→1 的动画；否则完成回调会重置 tOrigin
        if (!running.isRunning && Math.abs(this.levelValue - target) < 0.001) {
            this.levelValue = target;
            return;
        }
        // moveTo 会把 onComplete 写进传入的 transition；克隆一份，避免污染共享的 SCREEN_TRANSITION
        this.levelGear.moveTo({ v: target }, onComplete ? { ...transition, onComplete } : transition);
    }

    /** 只允许当前虚拟屏里的窗口接收指针，滚动同理 */
    isCurrentWin(winid: MWinId) {
        return this.win2Screen.get(winid)?.id === this.currentId;
    }

    /**
     * 只有聚焦虚拟屏上的窗口跟随输出刷新率，其余屏上的窗口压到接近 30Hz。
     * 屏幕切换、窗口增删/移动都会经过 applyAxes，这里只做差分下发。
     */
    private syncWindowFrameRates() {
        const current = this.currentId;
        for (const [handle, screen] of this.win2Screen) {
            // 桌面内部窗口没有 Wayland surface，不需要也不能下发帧率
            if (internalWindows.has(handle) || !server.server.windows.get(handle)) continue;
            const fps = screen.id === current ? null : BACKGROUND_WINDOW_FPS;
            if (this.appliedFrameRates.get(handle) === fps) continue;
            this.appliedFrameRates.set(handle, fps);
            server.server.notify("window.setFrameRate", handle, fps);
        }
        for (const handle of this.appliedFrameRates.keys()) {
            if (!this.win2Screen.has(handle)) this.appliedFrameRates.delete(handle);
        }
    }

    screenOf(winid: MWinId) {
        return this.win2Screen.get(winid);
    }

    /** 当前虚拟屏最上层的窗口；空桌面/启动台没有窗口 */
    currentWinId() {
        return topWin(this.currentScreen());
    }

    /** 视图状态（当前屏/总览）变化后回调，用来同步全屏时工具栏的避让 */
    setChromeCallback(cb: () => void) {
        this.chromeCallback = cb;
    }

    /** 手势中两轴每帧变化时回调，不重排窗口，只让工具栏跟随偏移立刻显示/隐藏 */
    setChromeProgressCallback(cb: () => void) {
        this.chromeProgressCallback = cb;
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
        // 总览 grid 和搜索栏都依赖 insets；当前就在预览里时要立刻重排
        this.applyAxes();
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

    /** 三指横滑/触摸板滚轮切到相邻虚拟屏所需的位移（CSS px），与手势共用倍率设置 */
    get screenSwitchDistance() {
        return Math.max(1, this.stageWidth) / (2 * gestureSwitchGain);
    }

    private createScreen(kind: "empty" | "launchpad" | "app") {
        const id = `view-${this.nextId++}`;
        const el = createScreenEl(id, () => {
            if (this.overview) this.selectFromOverview(id);
        });
        const start = { x: this.stageWidth, y: 0, scale: 1, opacity: 1, blur: 0 };
        const gear = createAnimationGear<ViewTransform>(start, { transition: SCREEN_TRANSITION });
        const screen: ViewScreen = {
            id,
            winIds: [],
            empty: kind === "empty",
            launchpad: kind === "launchpad",
            used: 0,
            el,
            gear,
            visual: { ...start },
            target: { ...start },
            pullMode: "tracked",
        };
        gear.setUpdateCallback((value) => {
            screen.visual = value;
            applyScreenTransform(el, value);
            this.renderWindowSlots();
            this.refreshOverviewReparentedRaster(value);
            this.applyPanel();
        });
        el.on("pointerdown", (e) => this.beginOverviewCardDrag(e, screen));
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

    /** 启动动画先占一个应用屏；窗口创建后通过 attachWindowToScreen 绑定 */
    addPendingAppScreen() {
        this.cancelGesture();
        const screen = this.createScreen("app");
        const emptyIndex = this.screens.findIndex((s) => s.empty);
        if (emptyIndex >= 0) this.screens.splice(emptyIndex, 0, screen);
        else {
            const launchpadIndex = this.screens.findIndex((s) => s.launchpad);
            this.screens.splice(launchpadIndex >= 0 ? launchpadIndex : this.screens.length, 0, screen);
        }
        screen.used = ++this.usedSeq;
        this.setOverview(false, false);
        this.setFocusById(screen.id, true);
        this.scheduleReorder();
        this.render(true);
        return screen;
    }

    /** 把真实窗口绑到启动动画预先创建的应用屏 */
    attachWindowToScreen(winid: MWinId, screen: ViewScreen) {
        this.cancelGesture();
        screen.empty = false;
        if (!screen.winIds.includes(winid)) screen.winIds.push(winid);
        screen.used = ++this.usedSeq;
        this.win2Screen.set(winid, screen);
        this.setOverview(false, false);
        this.setFocusById(screen.id, true);
        this.scheduleReorder();
        this.render(true);
        return screen;
    }

    /** 托盘面板关闭时回收没有窗口的应用屏 */
    discardPendingScreen(screen: ViewScreen) {
        if (screen.winIds.length > 0) return;
        this.removeScreen(screen);
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
            this.setOverview(false, false);
            this.setFocusById(parentScreen.id, true);
            this.render(true);
            return parentScreen;
        }
        let empty = this.screens.find((s) => s.empty);
        if (!empty) empty = this.createEmptyScreen();
        empty.empty = false;
        if (!empty.winIds.includes(winid)) empty.winIds.push(winid);
        empty.used = ++this.usedSeq;
        this.win2Screen.set(winid, empty);
        this.createEmptyScreen();
        this.setOverview(false, false);
        this.setFocusById(empty.id, true);
        this.scheduleReorder();
        this.render(true);
        return empty;
    }

    /** 在空桌面左边插一张新的应用屏 */
    private createAppScreen() {
        const screen = this.createScreen("app");
        const emptyIndex = this.screens.findIndex((s) => s.empty);
        this.screens.splice(emptyIndex >= 0 ? emptyIndex : this.screens.length, 0, screen);
        screen.used = ++this.usedSeq;
        return screen;
    }

    /**
     * 把窗口移到另一张虚拟屏。目标屏放不下（覆盖超限）时返回 false，窗口留在原屏。
     * 目标屏是空桌面时，它会变成应用屏，并在右边补一个新的空桌面。
     */
    moveWindowToScreen(winid: MWinId, target: ViewScreen, at?: { x: number; y: number }): boolean {
        const source = this.win2Screen.get(winid);
        if (!source || source === target || target.launchpad) return false;
        const el = windowElement(winid);
        const width = el?.offsetWidth ?? 0;
        const height = el?.offsetHeight ?? 0;
        const oldLeft = el?.offsetLeft ?? 0;
        const oldTop = el?.offsetTop ?? 0;
        // 全局拖放时用指针位置当落点，否则沿用窗口原来的屏内位置
        const available = availableStageSize();
        const minX = available.x;
        const minY = available.y;
        const maxX = Math.max(minX, available.x + available.width - width);
        const maxY = Math.max(minY, available.y + available.height - height);
        const spot = this.findFreeSpot(target, winid, {
            x: Math.min(Math.max(minX, at?.x ?? oldLeft), maxX),
            y: Math.min(Math.max(minY, at?.y ?? oldTop), maxY),
            w: width,
            h: height,
        });
        if (!spot) return false;

        const wasEmpty = target.empty;
        if (wasEmpty) target.empty = false;

        const index = source.winIds.indexOf(winid);
        if (index >= 0) source.winIds.splice(index, 1);
        this.win2Screen.set(winid, target);
        if (!target.winIds.includes(winid)) target.winIds.push(winid);
        target.used = ++this.usedSeq;
        this.moveWindowStackToScreen(winid, target);
        const moved = windowElement(winid);
        if (moved) {
            moved.style.left = `${Math.round(spot.x)}px`;
            moved.style.top = `${Math.round(spot.y)}px`;
            moveChildWindows(winid, Math.round(spot.x) - oldLeft, Math.round(spot.y) - oldTop);
        }
        if (wasEmpty) this.createEmptyScreen();
        if (source.winIds.length === 0 && !source.empty && !source.launchpad) {
            this.removeScreen(source, target);
        }
        this.setFocusById(target.id, !this.overview);
        if (this.overview) {
            // 预览里屏幕还缩放着，窗口会在缩小状态下重新绘制；退出预览后要再挂一次
            overviewReparentedWindows.add(winid);
        }
        this.focusWin(winid);
        this.scheduleReorder();
        this.render(true);
        return true;
    }

    /**
     * 把窗口挪到一张新的应用屏。`force` 为 true 时即使独占一屏也换屏；
     * 否则只在源屏还有其它窗口时换屏。
     */
    moveWindowToNewScreen(winid: MWinId, force = false): ViewScreen | undefined {
        const source = this.win2Screen.get(winid);
        if (!source || (!force && source.winIds.length <= 1)) return undefined;
        // 启动流程占着的窗口由启动收尾决定落屏；现在换屏会连启动面板一起搬走
        if (inLaunchFlow(winid)) return undefined;
        const target = this.createAppScreen();
        if (!this.moveWindowToScreen(winid, target)) {
            this.removeScreen(target);
            return undefined;
        }
        return target;
    }

    private moveWindowStackToScreen(winid: MWinId, target: ViewScreen) {
        // DOM 不搬：每个窗口的舞台槽自己换屏，这里只同步逻辑归属
        for (const [child, parent] of windowParents) {
            if (parent !== winid) continue;
            this.win2Screen.set(child, target);
            this.moveWindowStackToScreen(child, target);
        }
    }

    private findFreeSpot(screen: ViewScreen, winid: MWinId, rect: ScreenRect): ScreenRect | undefined {
        const available = availableStageSize();
        const minX = available.x;
        const minY = available.y;
        const maxX = available.x + available.width;
        const maxY = available.y + available.height;
        const fits = (x: number, y: number) =>
            x >= minX &&
            y >= minY &&
            // 窗口本身比可用区还大时允许溢出，只保证左上角在可用区内
            (rect.w > available.width || x + rect.w <= maxX) &&
            (rect.h > available.height || y + rect.h <= maxY) &&
            !rectOverlapsTooMuch(screen, winid, { x, y, w: rect.w, h: rect.h });
        if (fits(rect.x, rect.y)) return rect;
        const cx = Math.round(minX + (available.width - rect.w) / 2);
        const cy = Math.round(minY + (available.height - rect.h) / 2);
        if (fits(cx, cy)) return { x: cx, y: cy, w: rect.w, h: rect.h };
        const step = 48;
        for (let y = minY; y <= maxY - rect.h; y += step) {
            for (let x = minX; x <= maxX - rect.w; x += step) {
                if (fits(x, y)) return { x, y, w: rect.w, h: rect.h };
            }
        }
        return undefined;
    }

    /**
     * 给正在 resize 的窗口找一个覆盖冲突最少的层序。
     * 返回插入位置（0 最底，others.length 最顶）；没有任何零冲突层序时返回 undefined。
     */
    chooseOrderForRect(winid: MWinId, rect: ScreenRect): number | undefined {
        const screen = this.win2Screen.get(winid);
        if (!screen) return 0;
        const others = screen.winIds.filter((id) => id !== winid);
        const rects = new Map<MWinId, ScreenRect>();
        for (const id of others) {
            const other = windowLocalRect(id);
            if (other) rects.set(id, other);
        }
        let bestIndex = 0;
        let bestScore = Number.POSITIVE_INFINITY;
        for (let k = 0; k <= others.length; k++) {
            let score = 0;
            // 窗口在下面这些窗口之上：窗口压住它们
            for (let j = 0; j < k; j++) {
                const other = rects.get(others[j]);
                if (other && coveredRatio(rect, other) > OVERLAP_LIMIT) score++;
            }
            // 窗口在上面这些窗口之下：它们合计压住窗口
            const covered: ScreenRect[] = [];
            for (let j = k; j < others.length; j++) {
                const other = rects.get(others[j]);
                if (!other) continue;
                const x1 = Math.max(rect.x, other.x);
                const y1 = Math.max(rect.y, other.y);
                const x2 = Math.min(rect.x + rect.w, other.x + other.w);
                const y2 = Math.min(rect.y + rect.h, other.y + other.h);
                if (x2 > x1 && y2 > y1) covered.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
            }
            if (covered.length > 0 && unionArea(covered) / Math.max(1, rect.w * rect.h) > OVERLAP_LIMIT) {
                score++;
            }
            if (score < bestScore) {
                bestScore = score;
                bestIndex = k;
            }
        }
        return bestScore === 0 ? bestIndex : undefined;
    }

    /** 把窗口放到指定的层序位置，并同步舞台槽层序 */
    applyWinOrder(winid: MWinId, index: number) {
        const screen = this.win2Screen.get(winid);
        if (!screen) return;
        const others = screen.winIds.filter((id) => id !== winid);
        const next = [...others.slice(0, index), winid, ...others.slice(index)];
        if (next.every((id, i) => screen.winIds[i] === id)) return;
        screen.winIds = next;
        this.renderWindowSlots();
    }

    /**
     * 预览把屏缩小后，期间搬到这张屏的窗口是按缩小尺寸绘制/栅格化的；
     * 屏回到 1x 后重新挂一次元素，让它们按当前缩放重新栅格化（否则顶栏文字会发虚）。
     */
    private refreshOverviewReparentedRaster(value: ViewTransform) {
        if (this.overview || Math.abs(value.scale - 1) > 0.001) return;
        let dirty = false;
        for (const winid of overviewReparentedWindows) {
            const el = windowElement(winid);
            const slot = el ? windowSlots.get(el) : undefined;
            if (!el || !slot) continue;
            // 重新 append 一次，让缩小期间栅格化的内容按 1x 重新绘制
            slot.add(el);
            overviewReparentedWindows.delete(winid);
            dirty = true;
        }
        if (dirty) this.renderWindowSlots();
    }

    private suppressOverviewClickUntil = 0;

    /** 全局预览里拖动卡片：把这张屏最上层的窗口拖到指针下的另一张屏 */
    private beginOverviewCardDrag(e: PointerEvent, source: ViewScreen) {
        if (!this.overview || e.button !== 0 || source.launchpad || source.winIds.length === 0) return;
        if ((e.target as HTMLElement | null)?.closest("[data-desktop-ui='window-close']")) return;
        const startX = e.clientX;
        const startY = e.clientY;
        let moved = false;
        let target: ViewScreen | undefined;
        const clearHighlight = () => {
            for (const screen of this.screens) screen.el.el.removeAttribute("data-drop-target");
        };
        const onMove = (ev: PointerEvent) => {
            if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
            moved = true;
            target = this.screenAtPoint(ev.clientX, ev.clientY, source);
            for (const screen of this.screens) {
                screen.el.el.toggleAttribute("data-drop-target", screen === target);
            }
        };
        const cleanup = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
        const onUp = (ev: PointerEvent) => {
            cleanup();
            clearHighlight();
            if (!moved) return;
            this.suppressOverviewClickUntil = performance.now() + 250;
            if (ev.type === "pointercancel" || !target) return;
            const winid = topWin(source);
            if (!winid) return;
            // 目标卡片的视觉矩形换算回屏内坐标；窗口中心跟随松手位置
            const rect = target.el.el.getBoundingClientRect();
            const stageWidth = windowEl.el.offsetWidth;
            const stageHeight = windowEl.el.offsetHeight;
            const scaleX = rect.width / Math.max(1, stageWidth);
            const scaleY = rect.height / Math.max(1, stageHeight);
            const el = windowElement(winid);
            const width = el?.offsetWidth ?? 0;
            const height = el?.offsetHeight ?? 0;
            this.moveWindowToScreen(winid, target, {
                x: (ev.clientX - rect.left) / Math.max(0.0001, scaleX) - width / 2,
                y: (ev.clientY - rect.top) / Math.max(0.0001, scaleY) - height / 2,
            });
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    }

    private screenAtPoint(x: number, y: number, exclude?: ViewScreen) {
        let best: ViewScreen | undefined;
        let bestZ = Number.NEGATIVE_INFINITY;
        for (const screen of this.screens) {
            if (screen === exclude || screen.launchpad) continue;
            const rect = screen.el.el.getBoundingClientRect();
            if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
            const z = Number(screen.el.el.style.zIndex) || 0;
            if (z > bestZ) {
                bestZ = z;
                best = screen;
            }
        }
        return best;
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
            if (screen !== undefined && screen !== parentScreen) {
                this.detachFromScreen(winid, screen, parentScreen);
            }
            this.win2Screen.set(winid, parentScreen);
            return parentScreen;
        }
        if (screen?.winIds.includes(winid)) return screen;
        return this.addWindowScreen(winid);
    }

    /** 把顶层窗口从屏里摘掉；屏空了就回收。子窗口的映射由调用方维护。 */
    private detachFromScreen(winid: MWinId, screen: ViewScreen, fallback?: ViewScreen) {
        const index = screen.winIds.indexOf(winid);
        if (index >= 0) screen.winIds.splice(index, 1);
        this.win2Screen.delete(winid);
        if (screen.winIds.length === 0 && !screen.empty && !screen.launchpad) {
            this.removeScreen(screen, fallback);
        }
    }

    /** 撤掉一张虚拟屏；当前屏落到 fallback */
    private removeScreen(screen: ViewScreen, fallback?: ViewScreen) {
        this.cancelGesture();
        const index = this.screens.indexOf(screen);
        if (index < 0) return;
        const wasCurrent = screen.id === this.currentId;
        const anchor = this.currentId;
        for (const [other, mapped] of this.win2Screen) {
            if (mapped === screen) this.win2Screen.delete(other);
        }
        screen.gear.moveTo(screen.visual, 0);
        screen.el.remove();
        this.screens.splice(index, 1);
        if (wasCurrent) {
            const next = fallback ?? this.screens[Math.min(index, this.screens.length - 1)] ?? this.screens[0];
            if (next) {
                this.setFocusById(next.id, false);
                const top = topWin(next);
                if (top) this.focusWin(top);
                else this.blurAll();
            }
        } else {
            // 删除的屏在当前屏左边时，当前屏下标会左移；按 id 重新对齐
            this.setFocusById(anchor, false);
        }
        this.render(this.overview);
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
        this.setFocusById(screen.id, animate);
        const target = this.screenFocus(screen);
        if (target !== undefined) this.focusWin(target);
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
        // 搜索选中具体窗口：让它成为该屏记忆的焦点，setCurrentScreen 会按记忆聚焦
        screen.focusWindow = winid;
        this.setOverview(false);
        this.setCurrentScreen(screen.id, true);
    }

    /** 搜索栏用：当前全部虚拟屏（含空桌面、启动台），按空间顺序 */
    listScreens() {
        return this.screens.map((screen) => {
            let title = "空桌面";
            let kind: "empty" | "launchpad" | "window" = "empty";
            let appid = "";
            if (screen.launchpad) {
                title = "启动台";
                kind = "launchpad";
            } else if (screen.winIds.length > 0) {
                kind = "window";
                const top = screen.winIds[screen.winIds.length - 1];
                title =
                    screen.winIds.length > 1
                        ? `${this.windowTitle(top)} +${screen.winIds.length - 1}`
                        : this.windowTitle(top);
                appid = internalWindows.has(top) ? "桌面窗口" : server.server.windows.get(top)?.appid || "";
            }
            return {
                id: screen.id,
                title,
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
            for (const handle of screen.winIds) {
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
        }
        return out;
    }

    switchScreen(id: string) {
        this.setOverview(false);
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
        overviewReparentedWindows.delete(winid);
        const screen = this.win2Screen.get(winid);
        if (!screen) return undefined;
        // 子窗口只从父窗口的屏里摘掉自己：父窗口和虚拟屏都还在，焦点回到父窗口
        if (!screen.winIds.includes(winid)) {
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
        const winIndex = screen.winIds.indexOf(winid);
        screen.winIds.splice(winIndex, 1);
        // 随窗口一起消失的子窗口映射（只摘这棵子树，不影响同屏其它窗口）
        const removeChildren = (parent: MWinId) => {
            for (const [child, mappedParent] of windowParents) {
                if (mappedParent !== parent) continue;
                this.win2Screen.delete(child);
                removeChildren(child);
            }
        };
        removeChildren(winid);
        // 屏里还有别的窗口：只换焦点，不回收屏
        if (screen.winIds.length > 0) {
            if (this.focusHandle === winid) {
                const top = topWin(screen);
                if (top) this.focusWin(top);
                else this.blurAll();
            }
            this.applyAxes();
            return undefined;
        }

        const index = this.screens.indexOf(screen);
        const wasCurrent = screen.id === this.currentId;
        const anchor = this.currentId;
        screen.gear.moveTo(screen.visual, 0);
        screen.el.remove();
        this.screens.splice(index, 1);

        let next: ViewScreen | undefined;
        if (wasCurrent) {
            // 优先回上一个应用，没有就落到右边（通常是空桌面）
            next = this.screens[Math.min(index - 1, this.screens.length - 1)] ?? this.screens[0];
            if (next) {
                this.setFocusById(next.id, !this.overview);
                const top = topWin(next);
                if (top) this.focusWin(top);
                else this.blurAll();
                this.scheduleReorder();
            }
        } else {
            // 屏在当前屏左边时下标会左移
            this.setFocusById(anchor, false);
            if (this.focusHandle === winid) this.blurAll();
        }
        this.render(this.overview || wasCurrent);
        return next;
    }

    /**
     * 进入/退出全局预览。离散命令只改纵轴目标：
     * - 进入：搜索栏可见（稳定 n）走 n-t 直连，隐藏（h）走 n-h-t 线；
     * - 退出：t 是从直连进来的走 t-n，否则 t-h。
     */
    setOverview(on: boolean, animate = true) {
        if (this.overview === on) return;
        this.cancelGesture();
        if (on) {
            if (this.launcherRoute === "line") {
                const running = this.levelGear.getRunningAnimation();
                if (!running.isRunning && Math.abs(this.levelValue + 1) < 0.001) {
                    // 稳定在 n：切到直连，数值从 -1 映射到 0，搜索栏位置不变
                    this.switchLauncherRoute("direct");
                }
            }
            this.cancelReorder();
            cursor.setLocalShape(undefined);
            this.focusPanelGear.moveTo({ opacity: 1 }, animate ? FOCUS_PANEL_FADE : 0);
            this.animateLevel(1, animate, () => this.finishLevelSettle(1));
        } else {
            if (this.launcherRoute === "line") {
                const running = this.levelGear.getRunningAnimation();
                if (this.tOrigin === "n" && !running.isRunning && Math.abs(this.levelValue - 1) < 0.001) {
                    this.switchLauncherRoute("direct");
                }
            }
            this.scheduleReorder();
            this.focusPanelGear.moveTo({ opacity: 0 }, animate ? FOCUS_PANEL_FADE : 0);
            this.animateLevel(0, animate, () => this.finishLevelSettle(0));
        }
        this.syncOverviewChrome();
        this.render(animate);
    }

    toggleOverview() {
        this.setOverview(!this.overview);
    }

    /** 启动器路径切换时换算 level，保证搜索栏视觉不跳 */
    private switchLauncherRoute(next: LauncherRoute) {
        if (this.launcherRoute === next) return;
        if (next === "direct") {
            // 只从稳定 n（line -1）切过来；h(0) 不应走直连
            this.levelValue = clampNumber(this.levelValue, 0, 1);
            this.levelTarget = clampNumber(this.levelTarget, 0, 1);
        } else {
            // 直连只在 n/t 两个端点结算
            this.levelValue = this.levelValue >= 0.5 ? 1 : -1;
            this.levelTarget = this.levelTarget >= 0.5 ? 1 : -1;
        }
        this.launcherRoute = next;
        this.levelGear.moveTo({ v: this.levelValue }, 0);
        this.launcher?.setLevel(this.levelValue, next);
    }

    /** 纵轴落定：直连的临时数值折回 n-h-t 线，稳定态永远在线上 */
    private finishLevelSettle(target: number) {
        if (this.launcherRoute === "direct") {
            if (target >= 0.5) {
                this.tOrigin = "n";
                this.launcherRoute = "line";
                this.levelValue = 1;
                this.levelTarget = 1;
            } else {
                this.launcherRoute = "line";
                this.levelValue = -1;
                this.levelTarget = -1;
            }
            this.levelGear.moveTo({ v: this.levelValue }, 0);
            this.launcher?.setLevel(this.levelValue, this.launcherRoute);
        } else {
            this.levelValue = target;
            this.levelTarget = target;
            if (target >= 0.5) this.tOrigin = "h";
        }
        this.applyAxes();
        // 纵轴落定后再算一次工具栏：进入/退出全局预览后全屏状态可能变了
        this.chromeCallback?.();
    }

    private syncOverviewChrome() {
        windowEl.el.toggleAttribute("data-overview", this.overview);
    }

    private selectFromOverview(id: string) {
        if (performance.now() < this.suppressOverviewClickUntil) return;
        this.commitOverviewSelection(id);
    }

    /** 键盘确认预览里的聚焦屏：直接退出预览并切过去 */
    selectCurrentFromOverview() {
        this.commitOverviewSelection(this.currentId);
    }

    private commitOverviewSelection(id: string) {
        const screen = this.screens.find((s) => s.id === id);
        if (!screen) return;
        // 选中的卡片就是退出时要跟随的焦点屏；面板位置直接由 focus 连续过去
        this.setOverview(false);
        this.setCurrentScreen(screen.id, true);
    }

    /**
     * 预览里用键盘左右移动聚焦面板。
     * 预览完全展开时搜索栏接管键盘，这里只改焦点轴，不把客户端焦点抢回来。
     */
    moveOverviewFocus(delta: number) {
        if (!this.overview) {
            this.moveCurrent(delta);
            return;
        }
        const index = clampNumber(this.currentIndex() + delta, 0, Math.max(0, this.screens.length - 1));
        const screen = this.screens[index];
        if (!screen || index === this.currentIndex()) return;
        this.cancelGesture();
        this.setFocusById(screen.id, true);
        this.render(true);
    }

    startGesture() {
        // 预览里也允许起手，用来识别三指下滑退出
        if (this.gesture || (!this.overview && this.screens.length < 2)) return;
        // 横轴以命令目标为基准：切屏动画没结束时起手，不把“当前屏”停在半路
        this.focusValue = this.focusTarget;
        this.focusGear.moveTo({ v: this.focusTarget }, 0);
        // 纵轴从当前视觉接管：进行中的预览/搜索动画不跳到终点，手势沿当前路径继续
        this.levelGear.moveTo({ v: this.levelValue }, 0);
        windowEl.el.toggleAttribute("data-gesture", true);
        this.gesture = {
            startLevel: this.levelValue,
            startFocus: this.focusValue,
            totalX: 0,
            totalY: 0,
            panelHold: this.overview,
        };
    }

    /** 把纵向位移换算成连续模式坐标，跨过 0 后改用搜索栏的行程；dy 已去死区 */
    private levelFromSwipe(startLevel: number, dy: number) {
        let level = clampNumber(startLevel, -1, 1);
        let remain = -dy; // 正数向上
        const upDistance = this.overviewSwipeDistance();
        const downDistance = this.launcherSwipeDistance();
        // 最多跨两段：[-1,0] 与 [0,1]
        for (let segment = 0; segment < 2 && remain !== 0; segment++) {
            const up = remain > 0;
            const useOverviewDistance = up ? level >= 0 : level > 0;
            const distance = useOverviewDistance ? upDistance : downDistance;
            const boundary = up ? (level >= 0 ? 1 : 0) : level > 0 ? 0 : -1;
            const need = Math.abs(boundary - level) * distance;
            if (Math.abs(remain) <= need) {
                level += remain / distance;
                remain = 0;
                break;
            }
            remain -= Math.sign(remain) * need;
            level = boundary;
            if ((up && level >= 1) || (!up && level <= -1)) {
                level = up ? 1 : -1;
                break;
            }
        }
        return clampNumber(level, -1, 1);
    }

    /** 直连被手势接管时 level 直接是 0..1，不再有负半段 */
    private levelFromDirectSwipe(startLevel: number, dy: number) {
        const travel = this.overviewSwipeDistance();
        return clampNumber(startLevel - dy / travel, 0, 1);
    }

    private overviewSwipeDistance() {
        return Math.max(120, this.stageHeight * OVERVIEW_SWIPE_DISTANCE);
    }

    private launcherSwipeDistance() {
        return Math.max(100, this.stageHeight * LAUNCHER_SWIPE_DISTANCE);
    }

    moveGesture(dx: number, dy: number) {
        const gesture = this.gesture;
        if (!gesture) return;
        gesture.totalX += dx;
        gesture.totalY += dy;
        const dX = Math.sign(gesture.totalX) * Math.max(0, Math.abs(gesture.totalX) - GESTURE_AXIS_DEADZONE);
        const dY = Math.sign(gesture.totalY) * Math.max(0, Math.abs(gesture.totalY) - GESTURE_AXIS_DEADZONE);

        const level =
            this.launcherRoute === "direct"
                ? this.levelFromDirectSwipe(gesture.startLevel, dY)
                : this.levelFromSwipe(gesture.startLevel, dY);
        const focus = clampNumber(
            gesture.startFocus - (dX * gestureSwitchGain) / Math.max(1, this.stageWidth),
            0,
            Math.max(0, this.screens.length - 1),
        );
        this.levelValue = level;
        this.focusValue = focus;

        // 横轴在预览里实时改选中屏；常规/搜索里松手才提交。
        // 总览完全展开（level=1）时搜索栏接管键盘，这里只改选择，不抢客户端焦点。
        if (level > 0) {
            const nextIndex = clampNumber(Math.round(focus), 0, this.screens.length - 1);
            if (nextIndex !== this.currentIndex()) {
                this.focusTarget = nextIndex;
                if (level < 1) {
                    const target = this.screenFocus(this.screens[nextIndex]);
                    if (target !== undefined) this.focusWin(target);
                    else this.blurAll();
                }
            }
            if (!gesture.panelHold) {
                gesture.panelHold = true;
                this.focusPanelGear.moveTo({ opacity: 1 }, FOCUS_PANEL_FADE);
            }
        }

        // 两个轴各自走 0 时长；applyAxes 会同时读到新值
        this.levelGear.moveTo({ v: level }, 0);
        this.focusGear.moveTo({ v: focus }, 0);
        // 手势中 overviewProgress 已经变了：立刻让全屏工具栏响应，不等松手
        this.chromeProgressCallback?.();
    }

    endGesture() {
        const gesture = this.gesture;
        if (!gesture) return;
        this.gesture = undefined;
        windowEl.el.toggleAttribute("data-gesture", false);

        // 横轴：松手按最近位置吸附；常规里 current 到这时才提交
        const targetFocus = clampNumber(Math.round(this.focusValue), 0, this.screens.length - 1);
        const targetScreen = this.screens[targetFocus];
        const changed = targetFocus !== this.currentIndex();
        this.focusTarget = targetFocus;

        // 纵轴：直线按 ±0.5 吸附到 n/h/t；直连只回 n/t
        const targetLevel =
            this.launcherRoute === "direct"
                ? this.levelValue >= 0.5
                    ? 1
                    : 0
                : this.levelValue >= 0.5
                  ? 1
                  : this.levelValue <= -0.5
                    ? -1
                    : 0;
        const wasOverview = this.overview;
        // 只有落回常规才提交 Wayland 焦点；总览/搜索里由搜索栏接管键盘，松手只改选择
        if (targetScreen && changed && targetLevel === 0) {
            const target = this.screenFocus(targetScreen);
            if (target !== undefined) this.focusWin(target);
            else this.blurAll();
        }
        this.levelTarget = targetLevel;
        this.focusPanelGear.moveTo({ opacity: targetLevel >= 0.5 ? 1 : 0 }, FOCUS_PANEL_FADE);
        if (targetLevel >= 0.5) {
            if (!wasOverview) this.cancelReorder();
        } else {
            this.scheduleReorder();
        }
        this.syncOverviewChrome();

        this.animateLevel(targetLevel, true, () => this.finishLevelSettle(targetLevel));
        if (
            this.launcherRoute === "direct" &&
            !this.levelGear.getRunningAnimation().isRunning &&
            Math.abs(this.levelValue - targetLevel) < 0.001
        ) {
            this.finishLevelSettle(targetLevel);
        }
        if (targetScreen) this.setFocusById(targetScreen.id, true);
        this.applyAxes();
    }

    private cancelGesture() {
        const gesture = this.gesture;
        if (!gesture) return;
        this.gesture = undefined;
        windowEl.el.toggleAttribute("data-gesture", false);
        // 停在当前视觉，不跳到命令目标；后续 render/命令会从这里继续吸附
        this.levelGear.moveTo({ v: this.levelValue }, 0);
        this.focusGear.moveTo({ v: this.focusValue }, 0);
        this.focusPanelGear.moveTo({ opacity: this.overview ? 1 : 0 }, 0);
        this.launcher?.setLevel(this.levelValue, this.launcherRoute);
        this.applyAxes();
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
        const anchor = this.currentId;
        if (current) current.used = ++this.usedSeq;
        const empty = this.screens.find((s) => s.empty);
        const launchpad = this.screens.find((s) => s.launchpad);
        const ordered = this.screens.filter((s) => !s.empty && !s.launchpad).toSorted((a, b) => a.used - b.used);
        if (empty) ordered.push(empty);
        if (launchpad) ordered.push(launchpad);
        const changed = ordered.some((s, i) => s !== this.screens[i]);
        this.screens = ordered;
        // 重排会改所有屏的下标；按 id 把 focus 对齐回同一张屏
        this.setFocusById(anchor, false);
        if (changed) this.render(false);
    }

    private normalTargets(focus = this.focusValue) {
        const targets = new Map<string, ViewTransform>();
        this.screens.forEach((screen, index) => {
            targets.set(screen.id, {
                x: (index - focus) * this.stageWidth,
                y: 0,
                scale: 1,
                opacity: 1,
                blur: 0,
            });
        });
        return targets;
    }

    /**
     * 总览 grid：所有虚拟屏都参与，新的从右往左、再从上往下铺。
     * 行列数按屏幕宽高比估算，卡片保持虚拟屏比例。
     */
    private overviewLayout(): OverviewLayout {
        const cards = this.screens.slice().reverse();
        const targets = new Map<string, ViewTransform>();
        const count = cards.length;
        if (count === 0) return { cards, targets, cols: 1, cardWidth: 0, cardHeight: 0, gap: 0 };

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
        return { cards, targets, cols, cardWidth, cardHeight, gap };
    }

    /**
     * 两轴到屏位置。0.8 之前线性跟手；跨过 0.8 后每张屏用固定 200ms 动画重排到 grid，
     * 手势继续移动不再改写目标；拉回 0.8 以下时从当前视觉接着回线性（可打断）。
     */
    private applyScreenLayout(instant = false) {
        // 按钮/快捷键不是跟手输入：直接朝停稳布局走固定时长，避免手势接力逻辑参与
        if (!this.gesture) {
            this.applyDirectScreenLayout(instant);
            return;
        }
        const p = clampNumber(this.levelValue, 0, 1);
        const normal = this.normalTargets(this.focusValue);
        const layout = this.overviewLayout();
        const grid = layout.targets;
        const hidden = { x: -this.stageWidth * 2, y: 0, scale: 1, opacity: 0, blur: 0 };
        const handoff = OVERVIEW_GRID_HANDOFF;
        const gridScale = layout.cards.length > 0 ? layout.cardWidth / this.stageWidth : 1;
        const scale = 1 + (gridScale - 1) * Math.min(1, p / handoff);
        const rowScale = p < handoff ? scale : gridScale;
        const rowGap = OVERVIEW_GAP * (p < handoff ? Math.min(1, p * 4) : 1);
        const centerX = this.stageWidth / 2;
        const centerY = this.stageHeight / 2;

        for (const screen of this.screens) {
            const from = normal.get(screen.id) ?? hidden;
            const linear = {
                x: centerX + (from.x - centerX) * rowScale + (from.x / this.stageWidth) * rowGap,
                y: centerY + (from.y - centerY) * rowScale,
                scale: rowScale,
                opacity: from.opacity,
                blur: from.blur,
            };

            if (p >= handoff) {
                const target = grid.get(screen.id) ?? linear;
                if (instant) {
                    screen.pullMode = "grid";
                    screen.target = target;
                    screen.gear.moveTo(target, 0);
                    continue;
                }
                if (screen.pullMode !== "grid") {
                    screen.pullMode = "grid";
                    screen.target = target;
                    screen.gear.moveTo(target, OVERVIEW_GRID_TRANSITION);
                }
                continue;
            }

            if (instant) {
                screen.pullMode = "tracked";
                screen.target = linear;
                screen.gear.moveTo(linear, 0);
                continue;
            }
            if (screen.pullMode === "grid") {
                // 从 grid 动画中途打断回线性：按上一帧剩余时间续接
                screen.pullMode = "linear";
                const running = screen.gear.getRunningAnimation();
                const rest = running.isRunning ? running.remainingTime : OVERVIEW_GRID_TRANSITION.duration;
                screen.target = linear;
                screen.gear.moveTo(linear, rest);
                continue;
            }
            if (screen.pullMode === "linear") {
                const running = screen.gear.getRunningAnimation();
                if (running.isRunning && running.remainingTime > 0) {
                    screen.target = linear;
                    screen.gear.moveTo(linear, running.remainingTime);
                    continue;
                }
                screen.pullMode = "tracked";
            }
            screen.target = linear;
            screen.gear.moveTo(linear, 0);
        }
    }

    /** 非手势的离散过渡：直接朝停稳布局走 320ms，不经过 0.8 的线性跟手段 */
    private applyDirectScreenLayout(instant: boolean) {
        const targets = this.overview ? this.overviewLayout().targets : this.normalTargets(this.focusTarget);
        const hidden = { x: -this.stageWidth * 2, y: 0, scale: 1, opacity: 0, blur: 0 };
        for (const screen of this.screens) {
            const target = targets.get(screen.id) ?? hidden;
            if (instant) {
                screen.pullMode = "tracked";
                screen.target = target;
                screen.gear.moveTo(target, 0);
                continue;
            }
            const running = screen.gear.getRunningAnimation();
            if (sameTransform(screen.target, target)) {
                if (running.isRunning || sameTransform(screen.visual, target)) continue;
            }
            screen.pullMode = "tracked";
            screen.target = target;
            screen.gear.moveTo(target, SCREEN_TRANSITION);
        }
    }

    /** 聚焦面板位置从两张焦点卡片的当前视觉插值，跟着 grid 重排动画一起走 */
    private applyPanel() {
        if (!this.focusPanelEl || this.screens.length === 0) return;
        const p = clampNumber(this.focusValue, 0, this.screens.length - 1);
        const i0 = Math.floor(p);
        const i1 = Math.min(this.screens.length - 1, Math.ceil(p));
        const t = p - i0;
        const a = this.screens[i0].visual;
        const b = this.screens[i1].visual;
        const value = {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            scale: a.scale + (b.scale - a.scale) * t,
        };
        const panelScale = value.scale * FOCUS_PANEL_SCALE;
        this.focusPanelEl.style({
            transform: `translate3d(${value.x - (this.stageWidth * (panelScale - value.scale)) / 2}px, ${
                value.y - (this.stageHeight * (panelScale - value.scale)) / 2
            }px, 0) scale(${panelScale})`,
        });
    }

    /**
     * 窗口的舞台槽：每个窗口独立拿屏的 transform，不再继承屏 DOM。
     * 屏内坐标仍是布局真相，这里只把它们映射到舞台，并按屏分组分配 z。
     */
    renderWindowSlots() {
        const overviewVisual = this.overviewProgress > 0;
        const activeId = this.currentId;
        for (const screen of this.screens) {
            const base = overviewVisual ? (screen.id === activeId ? 2000 : 1000) : screen.id === activeId ? 1000 : 0;
            let order = 0;
            for (const id of screen.winIds) {
                for (const stackId of windowStackOrder(id)) {
                    const el = windowElement(stackId);
                    const slot = el ? windowSlots.get(el) : undefined;
                    if (!slot) continue;
                    // 启动动画还没收尾：这段 transform 归 launch 所有
                    if (clientWindowFrames.get(stackId)?.launching) {
                        order++;
                        continue;
                    }
                    if (slot.el.dataset.windowScreen !== screen.id) slot.data({ "window-screen": screen.id });
                    applyScreenTransform(slot, screen.visual);
                    slot.style({ zIndex: `${base + 1 + order}` });
                    order++;
                }
            }
        }
        // 还没有真实窗口的启动外壳：槽由屏的 visual 驱动，overview/切屏都能精确跟随
        for (const state of pendingLaunches) {
            if (!state.screen || !this.screens.includes(state.screen)) continue;
            // 已经嵌入/停稳后，外壳或正在淡出的 frame 都跟着屏走，总览缩放精确继承
            if (!state.slotFollowsView && state.phase !== "embedded") continue;
            applyScreenTransform(state.slot, state.screen.visual);
            state.slot.style({ zIndex: "5000" });
        }
    }

    /** 唯一的布局出口：两轴当前值 -> 屏 target -> DOM，启动器/面板/关闭按钮透明度一起更新 */
    private applyAxes(instant = false) {
        this.applyScreenLayout(instant);
        const overviewVisual = this.overviewProgress > 0;
        const activeId = this.currentId;
        for (const screen of this.screens) {
            // 卡片按组排序；窗口槽的 z 在 renderWindowSlots 里跟着同一组 base 分配
            const base = overviewVisual ? (screen.id === activeId ? 2000 : 1000) : screen.id === activeId ? 1000 : 0;
            screen.el.style({ zIndex: `${base}` });
        }
        this.renderWindowSlots();
        this.syncWindowFrameRates();
        this.launcher?.setLevel(this.levelValue, this.launcherRoute);
        this.applyPanel();
        windowEl.el.toggleAttribute("data-overview", this.overview);
        windowEl.el.style.setProperty("--overview-close-opacity", `${this.overviewProgress}`);
    }

    /** 停稳后的屏位置：用命令目标算，不读动画中的当前值 */
    committedScreenTransform(screen: ViewScreen) {
        if (this.levelTarget >= 0.5) return this.overviewLayout().targets.get(screen.id);
        return this.normalTargets(this.focusTarget).get(screen.id);
    }

    /** 屏和两轴都停稳了吗；启动动画用它决定什么时候嵌入虚拟屏 */
    isScreenSettled(screen: ViewScreen) {
        if (this.focusGear.getRunningAnimation().isRunning) return false;
        if (this.levelGear.getRunningAnimation().isRunning) return false;
        if (screen.gear.getRunningAnimation().isRunning) return false;
        return (
            Math.abs(screen.visual.x - screen.target.x) < 0.5 &&
            Math.abs(screen.visual.y - screen.target.y) < 0.5 &&
            Math.abs(screen.visual.scale - screen.target.scale) < 0.001
        );
    }

    render(animate = true, levelTransition = SCREEN_TRANSITION) {
        // 工具栏避让只随显式状态变化算一次，不跟两轴的每一帧
        this.chromeCallback?.();
        // 手势中 moveGesture 直接写两轴；其它状态变化只重算布局，不再起新的轴动画
        if (this.gesture) {
            this.applyAxes(!animate);
            return;
        }
        const target = this.levelTarget;
        // 线路径的 tOrigin 由发起这次过渡的命令/手势负责；render 的补算不能改写它
        const onComplete = this.launcherRoute === "direct" ? () => this.finishLevelSettle(target) : undefined;
        this.animateLevel(target, animate, onComplete, levelTransition);
        if (
            this.launcherRoute === "direct" &&
            !this.levelGear.getRunningAnimation().isRunning &&
            Math.abs(this.levelValue - target) < 0.001
        ) {
            this.finishLevelSettle(target);
        }
        const running = this.focusGear.getRunningAnimation();
        if (!animate) {
            this.focusValue = this.focusTarget;
            this.focusGear.moveTo({ v: this.focusTarget }, 0);
        } else if (!(running.isRunning && running.toValue.v === this.focusTarget)) {
            this.focusGear.moveTo({ v: this.focusTarget }, SCREEN_TRANSITION);
        }
        this.applyAxes(!animate);
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
        // 每张屏记住自己最后聚焦的窗口；退出总览/搜索时按 focus 轴选屏后还给它
        const screen = this.win2Screen.get(rootWindow(winid)) ?? this.win2Screen.get(winid);
        if (screen !== undefined) screen.focusWindow = winid;
        this.raiseWindow(winid);
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

    /** 把窗口所在栈提到屏内最上层；子窗口跟随父窗口一起提升 */
    private raiseWindow(winid: MWinId) {
        const root = rootWindow(winid);
        const screen = this.win2Screen.get(root);
        if (!screen) return;
        // 提升后会压住上层窗口太多时不提升，形成隐式置顶
        const rootIndex = screen.winIds.indexOf(root);
        const rootRect = rootIndex >= 0 ? windowLocalRect(root) : undefined;
        if (rootRect) {
            for (let i = rootIndex + 1; i < screen.winIds.length; i++) {
                const other = windowLocalRect(screen.winIds[i]);
                if (!other) continue;
                if (coveredRatio(rootRect, other) > OVERLAP_LIMIT) return;
            }
        }
        // 焦点所在的父链：同一层里这条链最后提升，被聚焦的对话框才会在兄弟之上
        const focusPath = new Set<MWinId>();
        for (let cur: MWinId | undefined = winid; cur !== undefined; cur = windowParents.get(cur)) focusPath.add(cur);
        const raise = (id: MWinId) => {
            // 只有顶层窗口在 winIds 里；子窗口仍要重新 append，否则父窗口提升后会把子窗口压到下面
            const index = screen.winIds.indexOf(id);
            if (index >= 0 && index !== screen.winIds.length - 1) {
                screen.winIds.splice(index, 1);
                screen.winIds.push(id);
            }
            const children = [...windowParents].flatMap(([child, parent]) => (parent === id ? [child] : []));
            children.sort((a, b) => Number(focusPath.has(a)) - Number(focusPath.has(b)));
            for (const child of children) raise(child);
        };
        raise(root);
        this.renderWindowSlots();
    }

    /** 把顶层窗口按到屏内最下层；子窗口仍在它上面 */
    sendWinToBottom(winid: MWinId) {
        const root = rootWindow(winid);
        const screen = this.win2Screen.get(root);
        if (!screen) return;
        const index = screen.winIds.indexOf(root);
        if (index < 0) return;
        if (index > 0) {
            screen.winIds.splice(index, 1);
            screen.winIds.unshift(root);
        }
        // 整个窗口栈一起沉到最底：父窗口在前，子窗口依次跟在它后面
        this.renderWindowSlots();
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

    private launcherBinding(): LauncherBinding {
        if (this.launcherRoute === "line") {
            return { kind: "line", level: clampNumber(this.levelValue, -1, 1) };
        }
        const towardT = this.levelTarget >= 0.5;
        const progress = clampNumber(this.levelValue, 0, 1);
        return towardT
            ? { kind: "direct", from: "n", to: "t", progress }
            : { kind: "direct", from: "t", to: "n", progress: 1 - progress };
    }

    /** 只读状态快照：testMode 的 `__mydeTest.state()` 用，测试直接断言窗口管理结果 */
    snapshot() {
        return {
            stage: { width: this.stageWidth, height: this.stageHeight },
            available: availableStageSize(),
            screens: this.screens.map((screen) => ({
                id: screen.id,
                windows: [...screen.winIds],
                empty: screen.empty,
                launchpad: screen.launchpad,
                used: screen.used,
                current: screen.id === this.currentId,
                visual: { ...screen.visual },
                target: { ...screen.target },
            })),
            current: this.currentId,
            focus: this.focusHandle,
            axis: {
                level: this.levelValue,
                levelTarget: this.levelTarget,
                focus: this.focusValue,
                focusTarget: this.focusTarget,
                launcherRoute: this.launcherRoute,
            },
            overview: this.overview,
            overviewProgress: this.overviewProgress,
            launches: [...pendingLaunches].map((state) => ({
                appid: state.appid,
                screen: state.screen?.id,
                phase: state.phase,
                frame: state.winHandle,
                replacing: state.replacing,
                revealed: state.revealed,
            })),
            overviewFocus: this.overview || this.overviewProgress > 0 ? this.currentId : undefined,
            gesture: this.gesture
                ? {
                      level: this.levelValue,
                      startLevel: this.gesture.startLevel,
                      totalX: this.gesture.totalX,
                      totalY: this.gesture.totalY,
                      horizontalMode: this.overviewProgress > 0 ? ("overview" as const) : ("screens" as const),
                      offset: (this.currentIndex() - this.focusValue) * this.stageWidth,
                      focusPos: this.focusValue,
                      launcherBinding: this.launcherBinding(),
                  }
                : undefined,
            launcher: this.launcher
                ? {
                      binding: this.launcherBinding(),
                      visible: this.launcher.isVisible(),
                      focused: isLauncherInputFocused(),
                  }
                : undefined,
            windows: [...this.win2Screen].map(([handle, screen]) => {
                const info = server.server.windows.get(handle);
                const rect = windowLocalRect(handle);
                const frame = clientWindowFrames.get(handle);
                return {
                    handle,
                    screen: screen.id,
                    appid: frame?.appid ?? info?.appid ?? "",
                    rect: rect ? { ...rect } : undefined,
                    maximized: info?.states.maximized ?? false,
                    fullscreen: info?.states.fullscreen ?? false,
                    parent: windowParents.get(handle),
                    modal: modalWindows.has(handle),
                    /** 渲染轴的盒/整框动画正在跑（可能发生在启动收尾之后） */
                    resizing:
                        (frame?.boxGear?.getRunningAnimation().isRunning ?? false) ||
                        (frame?.layoutGear?.getRunningAnimation().isRunning ?? false),
                    /** 已经拿到客户端首帧的真实 surface 尺寸（此前是占位尺寸） */
                    painted: frame?.painted ?? false,
                };
            }),
        };
    }

    /** 测试复位：取消手势、退出预览、回到空桌面（窗口由调用方先关掉） */
    resetView() {
        this.cancelGesture();
        this.setOverview(false, false);
        this.cancelReorder();
        this.launcherRoute = "line";
        this.tOrigin = "h";
        this.levelValue = 0;
        this.levelTarget = 0;
        this.levelGear.moveTo({ v: 0 }, 0);
        this.focusPanelGear.moveTo({ opacity: 0 }, 0);
        const empty = this.screens.find((screen) => screen.empty);
        if (empty) this.setFocusById(empty.id, false);
        this.render(false);
        this.cancelReorder();
    }

    /** 测试夹具：把窗口直接放到指定屏的坐标，跳过空位和覆盖检查 */
    placeWindow(winid: MWinId, screenId: string, x: number, y: number) {
        const target = this.screens.find((screen) => screen.id === screenId);
        const source = this.win2Screen.get(winid);
        if (!target || !source || target.launchpad) return false;
        if (source !== target) {
            const index = source.winIds.indexOf(winid);
            if (index >= 0) source.winIds.splice(index, 1);
            this.win2Screen.set(winid, target);
            if (!target.winIds.includes(winid)) target.winIds.push(winid);
            this.moveWindowStackToScreen(winid, target);
            if (source.winIds.length === 0 && !source.empty && !source.launchpad) this.removeScreen(source, target);
            if (target.empty) {
                target.empty = false;
                this.createEmptyScreen();
            }
            target.used = ++this.usedSeq;
        }
        setWindowPosition(winid, x, y);
        this.setFocusById(target.id, false);
        this.render(false);
        return true;
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

    /** 桌面模式开始接管键盘：让客户端全部失焦（core 在 leave 前补 release） */
    beginOverlayKeyboard() {
        if (this.overlayHeldKeys) return;
        this.overlayHeldKeys = true;
        this.blurAll();
    }

    /** 这张屏上次聚焦的窗口；窗口已经不在就退回最上层 */
    private screenFocus(screen: ViewScreen): MWinId | undefined {
        const remembered = screen.focusWindow;
        if (remembered !== undefined && this.win2Screen.get(remembered) === screen) return remembered;
        return topWin(screen);
    }

    /**
     * 桌面模式（总览/搜索栏/锁屏）结束后，按 `focus` 轴选中的屏把焦点还给该屏记忆的窗口。
     * 已有焦点说明点击/启动流程已经选中了窗口，不再抢；仍在总览或搜索里时也不提前还。
     */
    restoreWaylandFocus() {
        // 没真正接管过键盘（例如启动器开到一半就退出）时不补：客户端从头到尾都有焦点
        if (!this.overlayHeldKeys) return;
        if (this.overview || this.levelTarget <= -0.5) return;
        this.overlayHeldKeys = false;
        if (this.focusHandle !== undefined) return;
        const screen = this.screens[this.currentIndex()];
        if (screen === undefined) return;
        const target = this.screenFocus(screen);
        if (target !== undefined) this.focusWin(target);
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
            // 只能是 transform：will-change 里出现 opacity / filter 会让这一屏成为 backdrop root，
            // 屏内窗口的 ext_background_effect 就看不到壁纸和下层窗口了（模糊整块失效）。
            willChange: "transform",
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
    // 停稳在当前屏时不要留一个恒等 transform，避免每个窗口槽都常驻合成层
    const identity = Math.abs(value.x) < 0.001 && Math.abs(value.y) < 0.001 && Math.abs(value.scale - 1) < 0.0001;
    el.style({
        // 屏幕内容整体被预览缩放；覆盖层用倒数抵消，保持固定视觉尺寸
        "--view-inv-scale": `${1 / Math.max(value.scale, 0.0001)}`,
        transform: identity ? "none" : `translate3d(${value.x}px, ${value.y}px, 0) scale(${value.scale})`,
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
    private shouldCenter?: (windowId: string) => boolean;

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

    /** 这个窗口的尺寸变化后是否会自动居中（可用区只有一个窗口时） */
    willCenter(windowId: string) {
        return this.shouldCenter ? this.shouldCenter(windowId) : true;
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

    /** 按当前可用区和窗口外框尺寸算居中位置；启动动画也用它对齐 */
    centeredPosition(windowWidth: number, windowHeight: number) {
        const { x, y, width, height } = this.config.viewport;
        return {
            left: Math.round(x + (width - windowWidth) / 2),
            top: Math.round(y + (height - windowHeight) / 2),
        };
    }

    setShouldCenter(fn: (windowId: string) => boolean) {
        this.shouldCenter = fn;
    }

    centerWindow(windowId: string) {
        if (this.shouldCenter && !this.shouldCenter(windowId)) return;
        const element = this.windowElements.get(windowId);
        if (!element) return;
        const position = this.centeredPosition(element.offsetWidth, element.offsetHeight);
        element.style.left = `${position.left}px`;
        element.style.top = `${position.top}px`;
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
            { id: "search" },
            { id: "launchpad" },
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
            { id: "virtualKeyboard" },
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

/** 触摸点 pointerId → 按下时命中的客户端窗口；整段触摸序列固定在这个窗口上 */
const touchRoutes = new Map<number, PointerHit>();

function pointerKey(p: PointerEvent) {
    return `${p.pointerType || "mouse"}:${p.pointerId ?? 1}`;
}

/** 视口坐标 → 命中窗口的 surface-local 逻辑坐标；窗口已关闭时返回 undefined */
function pointerLocal(hit: PointerHit, p: { x: number; y: number }) {
    const info = server.server.windows.get(hit.handle);
    const rect = info ? render.getXdgSurfaceEle(info.renderId)?.getBoundingClientRect() : undefined;
    if (!info || !rect) return undefined;
    // DOM 是桌面物理 px；Wayland 坐标是 surface-local 逻辑 px
    const scale = info.scale || 1;
    return { x: (p.x - rect.left) / scale, y: (p.y - rect.top) / scale };
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
    dragIcon.move(x, y);
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
    "[data-launcher-input] input::placeholder": {
        color: gTextStyle.color.muted,
    },
    "[data-resize-preview]": {
        width: "var(--resize-preview-width) !important",
        height: "var(--resize-preview-height) !important",
    },
    // 服务端装饰：只有标题栏有底色/模糊；内容区域保持透明，允许客户端透明窗口露出壁纸
    "[data-client-frame][data-decorated]": {
        boxShadow: gShadowStyle.window,
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
    // 桌面自建的内部窗口没有标题栏，关闭按钮同样随预览进度隐藏
    "[data-internal-window] [data-desktop-ui='window-control']": {
        opacity: "calc(1 - var(--overview-close-opacity, 0))",
        transition: "opacity 120ms ease-out",
    },
    "[data-gesture] [data-internal-window] [data-desktop-ui='window-control']": {
        transition: "none",
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
    // 舞台槽本身透明，只有窗口接收指针；overview 里连窗口也关掉，点击整张卡片只用于切换
    "[data-window-slot] > *": {
        pointerEvents: "auto",
    },
    "[data-overview] [data-window-slot] > *": {
        pointerEvents: "none",
    },
    // 总览里卡片上的内容不再接收指针（启动面板等仍挂在卡片里）
    "[data-overview] [data-view-id] > *": {
        pointerEvents: "none",
    },
    // 拖到另一张卡片上时高亮目标屏
    "[data-view-id][data-drop-target]": {
        outline: "2px solid #00aaff",
        outlineOffset: "-2px",
    },
    // 卡片关闭按钮只在全局预览里出现，且要抢在内容禁指针之上
    "[data-desktop-ui='window-close']": {
        opacity: "var(--overview-close-opacity, 0)",
        pointerEvents: "none",
        transition: "opacity 120ms ease-out",
    },
    // 手势中直接跟 level，不再叠加过渡，避免和手指错拍
    "[data-gesture] [data-desktop-ui='window-close']": {
        transition: "none",
    },
    "[data-overview] [data-view-id] [data-desktop-ui='window-close']": {
        pointerEvents: "auto",
    },
    "[data-overview] [data-window-slot] [data-desktop-ui='window-close']": {
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
    let resizeBlockedByOverlap = false;
    let desired: { left: number; top: number; width: number; height: number } | undefined;

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

        // 不越出窗口可用区（顶部工具栏等）
        const available = availableStageSize();
        const minX = available.x;
        const minY = available.y;
        const maxX = available.x + available.width;
        const maxY = available.y + available.height;
        if (left < minX) {
            width += left - minX;
            left = minX;
        }
        if (top < minY) {
            height += top - minY;
            top = minY;
        }
        width = Math.max(minWidth, Math.min(width, maxX - left));
        height = Math.max(minHeight, Math.min(height, maxY - top));

        // 缩放时先改层序，让覆盖冲突最少；没有零冲突层序才停在最后一个合法尺寸
        const overlapFrame = wayland ? clientWindowFrames.get(windowId) : undefined;
        const outerHeight = height + (overlapFrame ? decoratedTitlebarPx(overlapFrame) : 0);
        if (!windowParents.has(windowId)) {
            const order = viewData.chooseOrderForRect(windowId, { x: left, y: top, w: width, h: outerHeight });
            if (order === undefined) {
                resizeBlockedByOverlap = true;
                desired = { left, top, width, height };
                return;
            }
            viewData.applyWinOrder(windowId, order);
        }
        resizeBlockedByOverlap = false;

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
                            if (frame.decorated) applyFrameSurfaceSize(frame, undefined, undefined, false);
                            else
                                setClientFrameLayout(
                                    frame,
                                    current.rect.w * current.scale,
                                    current.rect.h * current.scale,
                                    { animate: false },
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
        // 缩放被同屏窗口挡住，又确实想变大：挪到新虚拟屏后再按目标尺寸下发
        if (
            !windowParents.has(windowId) &&
            resizeBlockedByOverlap &&
            desired &&
            (viewData.screenOf(windowId)?.winIds.length ?? 0) > 1
        ) {
            const moved = viewData.moveWindowToNewScreen(windowId);
            if (moved) {
                const stageWidth = windowEl.el.offsetWidth;
                const stageHeight = windowEl.el.offsetHeight;
                const width = Math.min(desired.width, stageWidth);
                const height = Math.min(desired.height, stageHeight);
                const left = Math.max(0, Math.min(desired.left, stageWidth - width));
                const top = Math.max(0, Math.min(desired.top, stageHeight - height));
                if (wayland) {
                    server.server.notify("window.setSize", windowId, {
                        width: Math.max(1, Math.round(width / scale)),
                        height: Math.max(1, Math.round(height / scale)),
                    });
                } else {
                    el.style.width = `${Math.round(width)}px`;
                    el.style.height = `${Math.round(height)}px`;
                    el.style.left = `${Math.round(left)}px`;
                    el.style.top = `${Math.round(top)}px`;
                }
                const frame = clientWindowFrames.get(windowId);
                if (frame) setClientFramePosition(frame, left, top);
                resized = true;
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
    const slot = ensureWindowSlot(el);
    slot.data({ "window-screen": screen.id });
    slot.add(el);

    pack(el).style({
        position: "absolute",
    });

    if (windowId) {
        if (center) windowCenterManager.addWindow(windowId, el);
        else el.setAttribute("data-window-id", windowId);
    }
    if (viewData) viewData.renderWindowSlots();
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
    /** 启动动画期间由 launch 驱动舞台槽，view 暂不写 transform */
    launching?: boolean;
    /** 已经收到首帧尺寸，启动过渡白底可以撤掉 */
    painted?: boolean;
    /** 还在等客户端窗口：元素已经是 frame，但 handle/content 还没填 */
    pending?: boolean;
    /** 启动遮罩（白底 + 图标 + 取消按钮）；窗口内容在它下面，替换时它淡出 */
    mask?: ElType<HTMLElement>;
    maskSetIcon?: (src: string | undefined) => void;
    /** 没有窗口时的 kill 按钮和窗口出现后的 close 按钮，都在遮罩里 */
    killBtn?: ElType<HTMLElement>;
    closeBtn?: ElType<HTMLElement>;
    /**
     * 盒 resize 动画（渲染轴）。运行期间只有它写外框位置/尺寸，
     * 其它尺寸回调只更新目标并重新瞄准。与启动动画完全独立，可以跨过支配和预览。
     */
    boxGear?: AnimationGear<{ width: number; height: number }>;
    /** 真实目标外框（surface + 标题栏），盒动画的终点 */
    boxTarget?: { width: number; height: number };
    /**
     * 自动 resize 的整框动画：最大化/恢复/全屏/界面缩放/客户端自己改尺寸。
     * 和 boxGear 分开：它同时写位置、尺寸和内容交叉淡化。
     */
    layoutGear?: AnimationGear<{ left: number; top: number; width: number; height: number; fade: number }>;
    layoutTarget?: { left: number; top: number; width: number; height: number };
    /** 自动 resize 结束后是否由居中管理器接管位置 */
    layoutCentered?: boolean;
    /** 这次自动 resize 自己加的居中暂停，结束时要还回去 */
    layoutPausedCentering?: boolean;
    /** setClientFrameLayout 之后紧跟的 setClientFramePosition 应该写进动画目标 */
    layoutPendingPosition?: boolean;
    /** 旧内容快照：和 content 一起拉伸，并随动画淡出 */
    ghost?: { el: ElType<HTMLCanvasElement>; width: number; height: number };
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
/** 预览缩放期间被搬到别的虚拟屏的窗口：屏回到 1x 后要重新挂一次，避免沿用缩小尺寸的栅格 */
const overviewReparentedWindows = new Set<MWinId>();

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

/** 窗口和它的全部子窗口：深度优先，父窗口在前、子窗口按创建顺序跟在后面 */
function windowStackOrder(winid: MWinId): MWinId[] {
    const list: MWinId[] = [];
    const visit = (id: MWinId) => {
        list.push(id);
        for (const [child, parent] of windowParents) {
            if (parent === id) visit(child);
        }
    };
    visit(winid);
    return list;
}

/**
 * 窗口按层叠顺序排列：同一屏内按 winIds 的顶到底，子窗口再排在父窗口之上。
 * 指针/滚动命中必须按这个顺序第一个命中者先得，否则同客户端的父窗口会吃掉对话框的事件。
 */
function windowsTopFirst() {
    return server.server.windows.list().toSorted((a, b) => {
        const screen = viewData.screenOf(a.handle);
        if (screen && screen === viewData.screenOf(b.handle)) {
            const ai = screen.winIds.indexOf(a.handle);
            const bi = screen.winIds.indexOf(b.handle);
            if (ai >= 0 && bi >= 0 && ai !== bi) return bi - ai;
        }
        return windowDepth(b.handle) - windowDepth(a.handle);
    });
}

/** 客户端窗口与内部窗口共用的 DOM 取得方式 */
function windowElement(winid: MWinId): HTMLElement | undefined {
    return clientWindowFrames.get(winid)?.el.el ?? internalWindows.get(winid)?.el.el;
}

/**
 * 每个窗口一个舞台坐标槽：槽本身铺满舞台，只做屏的 transform/裁剪，
 * 窗口仍在槽里用屏内坐标布局。这样窗口不再继承卡片 DOM，但布局代码不用换坐标系。
 */
const windowSlots = new Map<HTMLElement, ElType<HTMLElement>>();

function ensureWindowSlot(el: HTMLElement) {
    let slot = windowSlots.get(el);
    if (slot) return slot;
    slot = view()
        .style({
            position: "absolute",
            left: "0",
            top: "0",
            width: "100%",
            height: "100%",
            transformOrigin: "0 0",
            overflow: "hidden",
            pointerEvents: "none",
        })
        .data({ "window-slot": "" })
        .addInto(windowEl);
    windowSlots.set(el, slot);
    return slot;
}

function removeWindowSlot(el: HTMLElement) {
    const slot = windowSlots.get(el);
    if (!slot) return;
    windowSlots.delete(el);
    if (el.parentElement === slot.el) el.remove();
    slot.remove();
}

function setWindowPosition(winid: MWinId, left: number, top: number): void {
    const frame = clientWindowFrames.get(winid);
    if (frame) {
        setClientFramePosition(frame, left, top);
        return;
    }
    internalWindows.get(winid)?.el.style({ left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
}

/** 覆盖阈值：交集面积 ÷ 较小窗口面积 */
const OVERLAP_LIMIT = 0.8;

type ScreenRect = { x: number; y: number; w: number; h: number };

function windowLocalRect(winid: MWinId): ScreenRect | undefined {
    const el = windowElement(winid);
    if (!el) return undefined;
    return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
}

function intersectionArea(a: ScreenRect, b: ScreenRect): number {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ix * iy;
}

/** 多个矩形的并集面积；用于“被多个上层窗口合计盖住多少” */
function unionArea(rects: ScreenRect[]): number {
    if (rects.length === 0) return 0;
    const xs = [...new Set(rects.flatMap((r) => [r.x, r.x + r.w]))].sort((a, b) => a - b);
    let area = 0;
    for (let i = 0; i < xs.length - 1; i++) {
        const x0 = xs[i];
        const x1 = xs[i + 1];
        if (x1 <= x0) continue;
        const intervals: [number, number][] = [];
        for (const rect of rects) {
            if (rect.x < x1 && rect.x + rect.w > x0) intervals.push([rect.y, rect.y + rect.h]);
        }
        intervals.sort((a, b) => a[0] - b[0]);
        let length = 0;
        let start = Number.NaN;
        let end = Number.NaN;
        for (const [a, b] of intervals) {
            if (Number.isNaN(start)) {
                start = a;
                end = b;
            } else if (a > end) {
                length += end - start;
                start = a;
                end = b;
            } else if (b > end) {
                end = b;
            }
        }
        if (!Number.isNaN(start)) length += end - start;
        area += (x1 - x0) * length;
    }
    return area;
}

function overlapRatio(a: ScreenRect, b: ScreenRect): number {
    const inter = intersectionArea(a, b);
    if (inter <= 0) return 0;
    return inter / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}

/** upper 压住 lower 的比例：交集 ÷ lower 面积；只看上层对下层的遮挡 */
function coveredRatio(upper: ScreenRect, lower: ScreenRect): number {
    return intersectionArea(upper, lower) / Math.max(1, lower.w * lower.h);
}

/** 这块矩形（会放到最上层）放进 screen 后，是否把其它窗口压住过多 */
function rectOverlapsTooMuch(screen: ViewScreen | undefined, winid: MWinId, rect: ScreenRect): boolean {
    if (!screen) return false;
    for (const other of screen.winIds) {
        if (other === winid) continue;
        const r = windowLocalRect(other);
        if (r && coveredRatio(rect, r) > OVERLAP_LIMIT) return true;
    }
    return false;
}

type DodgeMove = { id: MWinId; x: number; y: number };

/**
 * 规划同屏其它窗口的平移，让它们不被 movingRect 压住。
 * 只改位置不改尺寸；有窗口挪不开（被固定或屏内没有空位）时整次规划失败，返回 undefined。
 */
function planDodges(screen: ViewScreen, moving: MWinId, movingRect: ScreenRect): DodgeMove[] | undefined {
    const positions = new Map<MWinId, ScreenRect>();
    for (const id of screen.winIds) {
        const rect = windowLocalRect(id);
        if (rect) positions.set(id, rect);
    }
    // moving 自己的矩形由 movingRect 代表，不参与“躲到哪”的碰撞检查
    positions.delete(moving);

    const moves: DodgeMove[] = [];
    const movingIndex = screen.winIds.indexOf(moving);
    for (const id of screen.winIds) {
        if (id === moving) continue;
        const current = positions.get(id);
        if (!current) continue;
        // 移动窗口在对方下面时不推对方；覆盖只看上层压住下层
        if (movingIndex >= 0 && movingIndex < screen.winIds.indexOf(id)) continue;
        const covered = coveredRatio(movingRect, current);
        if (covered <= OVERLAP_LIMIT) continue;
        const info = server.server.windows.get(id);
        if (info?.states.maximized || info?.states.fullscreen) return undefined;
        const spot = findDodgeSpot(screen, movingRect, current, positions, id);
        if (!spot) return undefined;
        positions.set(id, spot);
        moves.push({ id, x: spot.x, y: spot.y });
    }
    return moves;
}

function findDodgeSpot(
    screen: ViewScreen,
    moving: ScreenRect,
    self: ScreenRect,
    positions: Map<MWinId, ScreenRect>,
    selfId: MWinId,
): ScreenRect | undefined {
    const available = availableStageSize();
    const minX = available.x;
    const minY = available.y;
    const maxX = available.x + available.width;
    const maxY = available.y + available.height;
    const clampX = (x: number) => Math.min(Math.max(minX, Math.round(x)), Math.max(minX, maxX - self.w));
    const clampY = (y: number) => Math.min(Math.max(minY, Math.round(y)), Math.max(minY, maxY - self.h));
    const candidates: ScreenRect[] = [
        { x: clampX(moving.x - self.w), y: self.y, w: self.w, h: self.h },
        { x: clampX(moving.x + moving.w), y: self.y, w: self.w, h: self.h },
        { x: self.x, y: clampY(moving.y - self.h), w: self.w, h: self.h },
        { x: self.x, y: clampY(moving.y + moving.h), w: self.w, h: self.h },
    ];
    const selfIndex = screen.winIds.indexOf(selfId);
    const ok = (rect: ScreenRect) => {
        if (overlapRatio(rect, moving) > 0) return false;
        for (const [id, other] of positions) {
            if (id === selfId) continue;
            // 按层级判断：上层压住下层太多才算冲突
            const otherIndex = screen.winIds.indexOf(id);
            const bad =
                selfIndex > otherIndex
                    ? coveredRatio(rect, other) > OVERLAP_LIMIT
                    : coveredRatio(other, rect) > OVERLAP_LIMIT;
            if (bad) return false;
        }
        return true;
    };
    let best: ScreenRect | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
        if (!ok(candidate)) continue;
        const distance = (candidate.x - self.x) ** 2 + (candidate.y - self.y) ** 2;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate;
        }
    }
    if (best) return best;

    // 四个方向都被挡住时，再按网格找最近的空位
    const step = 48;
    for (let y = minY; y <= maxY - self.h; y += step) {
        for (let x = minX; x <= maxX - self.w; x += step) {
            const candidate = { x, y, w: self.w, h: self.h };
            if (!ok(candidate)) continue;
            const distance = (candidate.x - self.x) ** 2 + (candidate.y - self.y) ** 2;
            if (distance < bestDistance) {
                bestDistance = distance;
                best = candidate;
            }
        }
    }
    return best;
}

function applyDodges(moves: DodgeMove[]) {
    for (const move of moves) {
        const current = windowLocalRect(move.id);
        if (!current) continue;
        setWindowPosition(move.id, move.x, move.y);
        moveChildWindows(move.id, move.x - current.x, move.y - current.y);
    }
}

/** 最大化窗口按最底层算：是否被同屏上层窗口合计盖住超过阈值 */
function maximizeCoveredByOthers(winid: MWinId): boolean {
    const screen = viewData.screenOf(winid);
    if (!screen) return false;
    const available = availableStageSize();
    const maxRect: ScreenRect = { x: available.x, y: available.y, w: available.width, h: available.height };
    const covered: ScreenRect[] = [];
    for (const other of screen.winIds) {
        if (other === winid) continue;
        const rect = windowLocalRect(other);
        if (!rect) continue;
        const x1 = Math.max(maxRect.x, rect.x);
        const y1 = Math.max(maxRect.y, rect.y);
        const x2 = Math.min(maxRect.x + maxRect.w, rect.x + rect.w);
        const y2 = Math.min(maxRect.y + maxRect.h, rect.y + rect.h);
        if (x2 > x1 && y2 > y1) covered.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    }
    if (covered.length === 0) return false;
    return unionArea(covered) / Math.max(1, maxRect.w * maxRect.h) > OVERLAP_LIMIT;
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
    const slot = ensureWindowSlot(frame.el.el);
    slot.data({ "window-screen": screen.id });
    slot.add(frame.el.el);
    frame.el.style({ position: "absolute" });
    viewData.renderWindowSlots();
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
/** 内部 xdg surface DOM 的显示尺寸；渲染层写进去的 CSS 尺寸带小数，比 offset 更准 */
function frameContentDisplaySize(frame: ClientWindowFrame) {
    const styleWidth = Number.parseFloat(frame.content.style.width);
    const styleHeight = Number.parseFloat(frame.content.style.height);
    return {
        width: styleWidth > 0 ? styleWidth : frame.content.offsetWidth,
        height: styleHeight > 0 ? styleHeight : frame.content.offsetHeight,
    };
}

/**
 * 同步真实外框尺寸。启动和自动 resize 期间只更新目标、由动画写盒；
 * 其余情况直接写，或者走一段整框过渡（最大化、全屏、客户端自己改尺寸等）。
 * `allowAnimate=false` 用于手动缩放收尾，避免把手动结果再接一段自动动画。
 */
function applyFrameSurfaceSize(frame: ClientWindowFrame, width?: number, height?: number, allowAnimate = true) {
    if (width !== undefined) frame.surfaceWidth = Math.max(1, width);
    if (height !== undefined) frame.surfaceHeight = Math.max(1, height);
    if (width === undefined && height === undefined) {
        // 服务端 buffer 尺寸可能包含客户端阴影，外框跟内部 surface DOM 走
        const content = frameContentDisplaySize(frame);
        if (content.width > 1 && content.height > 1) {
            frame.surfaceWidth = Math.max(1, content.width);
            frame.surfaceHeight = Math.max(1, content.height);
        }
    }
    const bar = titlebarPx(frame);
    // 真实目标外框；盒动画的终点总是它
    frame.boxTarget = { width: frame.surfaceWidth, height: frame.surfaceHeight + bar };
    // 启动/盒动画期间由盒动画写外框，这里只更新目标并重新瞄准
    if (frame.launching || frame.boxGear) {
        if (frame.boxGear) {
            retimeFrameBox(frame);
        } else {
            const launch = launchStateForFrame(frame);
            if (launch) retimeLaunchSize(launch);
        }
        // 内容的真实尺寸可能刚在同一个任务里更新：立刻按当前盒重算拉伸，
        // 不等下一次动画回调，避免中间一帧按旧尺寸溢出或留边
        const box = currentFrameBox(frame);
        if (box) writeFrameBox(frame, box.left, box.top, box.width, box.height);
        return;
    }
    // 整框过渡中：位置不动，只更新尺寸目标
    if (frame.layoutGear) {
        if (frame.layoutTarget) {
            frame.layoutTarget = {
                ...frame.layoutTarget,
                width: frame.boxTarget.width,
                height: frame.boxTarget.height,
            };
            retimeFrameLayout(frame);
        }
        const box = currentFrameBox(frame);
        if (box) writeFrameBox(frame, box.left, box.top, box.width, box.height);
        return;
    }
    const from = currentFrameBox(frame);
    if (allowAnimate && from && canAnimateFrameLayout(frame)) {
        const target = { left: from.left, top: from.top, width: frame.boxTarget.width, height: frame.boxTarget.height };
        if (Math.abs(from.width - target.width) > 0.5 || Math.abs(from.height - target.height) > 0.5) {
            startFrameLayoutTransition(frame, target, captureFrameGhost(frame));
            return;
        }
    }
    frame.el.style({
        width: `${frame.surfaceWidth}px`,
        height: `${frame.surfaceHeight + bar}px`,
    });
}

/** 正在进行的启动状态（按 frame 反查），用于尺寸回调重新瞄准 */
function launchStateForFrame(frame: ClientWindowFrame): PendingLaunch | undefined {
    for (const state of pendingLaunches) {
        if (state.frame === frame) return state;
    }
    return undefined;
}

/** 盒动画当前写进外框的内联矩形；没有动画时也能读到最后一次布局 */
function currentFrameBox(frame: ClientWindowFrame): LaunchRect | undefined {
    const style = frame.el.el.style;
    const left = Number.parseFloat(style.left);
    const top = Number.parseFloat(style.top);
    const width = Number.parseFloat(style.width);
    const height = Number.parseFloat(style.height);
    if (![left, top, width, height].every((value) => Number.isFinite(value))) return undefined;
    return { left, top, width, height };
}

/**
 * 盒动画写当前外框，内容非等比拉伸到盒内：宽按盒宽、高按盒高减标题栏。
 * 用 transform 缩放（GPU），不重排、不重栅格大 buffer，也不需要裁切/溢出处理。
 */
function writeFrameBox(frame: ClientWindowFrame, left: number, top: number, width: number, height: number) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    frame.el.style({ left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
    // 还没有客户端内容时遮罩铺满 frame，本身就是盒的尺寸，不需要拉伸
    if (frame.pending) return;
    const bar = titlebarPx(frame);
    const natural = frameContentDisplaySize(frame);
    const cw = Math.max(1, natural.width || frame.surfaceWidth);
    const ch = Math.max(1, natural.height || frame.surfaceHeight);
    // 内容基准 left=0、top=bar；origin 在左上角，缩放后正好铺满盒
    frame.content.style.transformOrigin = "0 0";
    frame.content.style.transform = `scale(${w / cw}, ${Math.max(1, h - bar) / ch})`;
    // 旧内容快照和 content 用同一块内容区，各自按自己的自然尺寸拉伸
    const ghost = frame.ghost;
    if (ghost) {
        ghost.el.style({
            top: `${bar}px`,
            transformOrigin: "0 0",
            transform: `scale(${w / ghost.width}, ${Math.max(1, h - bar) / ghost.height})`,
        });
    }
}

/**
 * 盒 resize 重新瞄准：运行中的动画用剩余时间，已经停下就用完整时长。
 * resize 和启动动画互相独立，它可以在支配之后、甚至预览阶段继续跑。
 * 首帧替换时要指定时长，让盒和 mask 淡出同时结束。
 */
function retimeFrameBox(frame: ClientWindowFrame, duration?: number) {
    const gear = frame.boxGear;
    const target = frame.boxTarget;
    if (!gear || !target) return;
    const running = gear.getRunningAnimation();
    const time = duration ?? (running.isRunning ? Math.max(1, running.remainingTime) : LAUNCH_FLIGHT.duration);
    gear.moveTo(target, { duration: time, map: LAUNCH_FLIGHT.map }, () => {
        if (frame.boxGear !== gear) return;
        // 启动还没收尾时保持预览，收尾后由 releaseFrameBox 一次性交还真实尺寸
        if (frame.launching) return;
        releaseFrameBox(frame);
    });
}

/** 结束盒动画：撤掉预览，回到真实尺寸并恢复自动居中 */
function releaseFrameBox(frame: ClientWindowFrame) {
    frame.boxGear = undefined;
    frame.content.removeAttribute("data-resize-preview");
    frame.content.style.removeProperty("--resize-preview-width");
    frame.content.style.removeProperty("--resize-preview-height");
    frame.content.style.transform = "";
    frame.content.style.transformOrigin = "";
    frame.content.style.left = "0px";
    applyClientFrameChrome(frame);
    applyFrameSurfaceSize(frame, undefined, undefined, false);
    windowCenterManager.resumeCentering(frame.handle);
    windowCenterManager.centerWindow(frame.handle);
}

/** 自动 resize 是否该走动画：手动拖拽、启动和已有动画都交给原来的路径 */
function canAnimateFrameLayout(frame: ClientWindowFrame) {
    if (frame.pending || frame.launching || frame.boxGear || frame.layoutGear) return false;
    if (resizingWindowId === frame.handle || resizeSettleTimers.has(frame.handle)) return false;
    return clientWindowFrames.has(frame.handle);
}

/** 截一张当前内容快照，作为自动 resize 交叉淡出的旧层；没画过就跳过淡化 */
function captureFrameGhost(frame: ClientWindowFrame): ClientWindowFrame["ghost"] | undefined {
    const preview = server.server.windows.preview(frame.handle);
    const size = frameContentDisplaySize(frame);
    if (!preview || size.width <= 1 || size.height <= 1) return undefined;
    const el = ele("canvas")
        .attr({ width: preview.width, height: preview.height })
        .style({
            position: "absolute",
            left: "0",
            top: "0",
            width: `${size.width}px`,
            height: `${size.height}px`,
            pointerEvents: "none",
            zIndex: "5",
            transformOrigin: "0 0",
            opacity: "1",
        });
    const ctx = el.el.getContext("2d");
    if (!ctx) {
        el.remove();
        return undefined;
    }
    ctx.drawImage(preview, 0, 0);
    frame.el.add(el);
    return { el, width: size.width, height: size.height };
}

/** 自动 resize：位置、尺寸和内容交叉淡化用同一段时长；结束前居中交给动画，结束后再还回去 */
function startFrameLayoutTransition(
    frame: ClientWindowFrame,
    target: { left: number; top: number; width: number; height: number },
    ghost: ClientWindowFrame["ghost"],
    center = true,
) {
    const from = currentFrameBox(frame);
    if (!from) {
        ghost?.el.remove();
        return;
    }
    frame.ghost = ghost;
    frame.layoutTarget = { ...target };
    // 全屏必须铺到 0,0：不能按窗口可用区（工具栏内缩）重新居中
    frame.layoutCentered = center && windowCenterManager.willCenter(frame.handle);
    if (!windowCenterManager.isPaused(frame.handle)) {
        windowCenterManager.pauseCentering(frame.handle);
        frame.layoutPausedCentering = true;
    }
    if (ghost) {
        frame.content.style.opacity = "0";
        ghost.el.style({ opacity: "1" });
    }
    // 内容尺寸刚改过：先按当前盒拉伸，避免动画第一帧以自然尺寸溢出
    writeFrameBox(frame, from.left, from.top, from.width, from.height);
    const gear = createAnimationGear(
        { left: from.left, top: from.top, width: from.width, height: from.height, fade: 0 },
        { transition: { ...FRAME_LAYOUT_TRANSITION } },
    );
    frame.layoutGear = gear;
    gear.setUpdateCallback((value) => {
        if (frame.layoutGear !== gear) return;
        // 会自动居中的窗口跟着当前尺寸居中，别的窗口按动画目标走
        const position = frame.layoutCentered
            ? windowCenterManager.centeredPosition(value.width, value.height)
            : { left: value.left, top: value.top };
        writeFrameBox(frame, position.left, position.top, value.width, value.height);
        if (!frame.ghost) return;
        frame.ghost.el.style({ opacity: `${1 - value.fade}` });
        frame.content.style.opacity = `${value.fade}`;
    });
    retimeFrameLayout(frame, FRAME_LAYOUT_TRANSITION.duration);
}

/** 自动 resize 重新瞄准：位置/尺寸变了就按剩余时间走完 */
function retimeFrameLayout(frame: ClientWindowFrame, duration?: number) {
    const gear = frame.layoutGear;
    const target = frame.layoutTarget;
    if (!gear || !target) return;
    const running = gear.getRunningAnimation();
    const time =
        duration ?? (running.isRunning ? Math.max(1, running.remainingTime) : FRAME_LAYOUT_TRANSITION.duration);
    gear.moveTo(
        { ...target, fade: 1 },
        {
            duration: time,
            map: FRAME_LAYOUT_TRANSITION.map,
            onComplete: () => finishFrameLayoutTransition(frame),
        },
    );
}

/** 取消自动 resize（关闭/回收时）：只清理状态，不写最终尺寸 */
function cancelFrameLayoutTransition(frame: ClientWindowFrame) {
    frame.layoutGear = undefined;
    frame.layoutTarget = undefined;
    frame.layoutPendingPosition = false;
    frame.layoutPausedCentering = false;
    frame.ghost?.el.remove();
    frame.ghost = undefined;
    frame.content.style.opacity = "";
}

/** 自动 resize 结束：撤掉快照，内容回到正常尺寸布局，位置交给居中管理器 */
function finishFrameLayoutTransition(frame: ClientWindowFrame) {
    if (!frame.layoutGear) return;
    frame.layoutGear = undefined;
    frame.layoutTarget = undefined;
    frame.layoutPendingPosition = false;
    frame.ghost?.el.remove();
    frame.ghost = undefined;
    frame.content.style.opacity = "";
    frame.content.style.transform = "";
    frame.content.style.transformOrigin = "";
    frame.content.style.left = "0px";
    applyClientFrameChrome(frame);
    applyFrameSurfaceSize(frame, undefined, undefined, false);
    if (frame.layoutPausedCentering) {
        frame.layoutPausedCentering = false;
        windowCenterManager.resumeCentering(frame.handle);
    }
}

/**
 * 把启动中还在跑的 resize 交给 frame：之后它只按自己的时钟走，
 * 与启动收尾、支配、预览都无关。返回 false 表示当前没有在跑的 resize。
 */
function adoptBoxGearIntoFrame(state: PendingLaunch, frame: ClientWindowFrame): boolean {
    const gear = state.sizeGear;
    if (!gear?.getRunningAnimation().isRunning) return false;
    const center = launchCenterLocal(state);
    frame.boxGear = gear;
    gear.setUpdateCallback((value) => {
        if (!clientWindowFrames.has(frame.handle)) return;
        writeFrameBox(frame, center.x - value.width / 2, center.y - value.height / 2, value.width, value.height);
    });
    retimeFrameBox(frame);
    return true;
}

/**
 * 桌面主动设定内容尺寸（最大化/恢复/全屏/界面缩放）。
 * 自动 resize 时先截旧内容快照，再改内容尺寸，并起一段位置+尺寸+交叉淡化的整框过渡；
 * 紧随其后的 setClientFramePosition 会把目标位置补进来。
 */
function setClientFrameLayout(
    frame: ClientWindowFrame,
    contentWidth: number,
    contentHeight: number,
    opts: { fullscreen?: boolean; animate?: boolean } = {},
) {
    const fullscreen = opts.fullscreen ?? false;
    const animate = opts.animate !== false && !frame.layoutGear && canAnimateFrameLayout(frame);
    const ghost = animate ? captureFrameGhost(frame) : undefined;
    frame.fullscreen = fullscreen;
    const width = Math.max(1, contentWidth);
    const height = Math.max(1, contentHeight);
    frame.content.style.left = "0px";
    frame.content.style.width = `${width}px`;
    frame.content.style.height = `${height}px`;
    applyClientFrameChrome(frame);
    const bar = titlebarPx(frame);
    frame.surfaceWidth = width;
    frame.surfaceHeight = height;
    frame.boxTarget = { width, height: height + bar };

    // 过渡中又改了布局：保留原快照，只更新目标尺寸
    if (frame.layoutGear) {
        if (frame.layoutTarget) {
            frame.layoutTarget = { ...frame.layoutTarget, width, height: height + bar };
            retimeFrameLayout(frame);
        }
        return;
    }
    // 启动阶段仍由 launch 的盒动画负责
    if (frame.launching || frame.boxGear) {
        ghost?.el.remove();
        applyFrameSurfaceSize(frame, width, height, false);
        return;
    }
    if (animate) {
        const from = currentFrameBox(frame);
        // 尺寸没变就不做整框过渡，避免重复布局时内容闪一下
        if (from && (Math.abs(from.width - width) > 0.5 || Math.abs(from.height - (height + bar)) > 0.5)) {
            frame.layoutPendingPosition = true;
            queueMicrotask(() => {
                frame.layoutPendingPosition = false;
            });
            startFrameLayoutTransition(
                frame,
                { left: from.left, top: from.top, width, height: height + bar },
                ghost,
                !fullscreen,
            );
            return;
        }
    }
    ghost?.el.remove();
    frame.el.style({ width: `${width}px`, height: `${height + bar}px` });
}

function setClientFramePosition(frame: ClientWindowFrame, left: number, top: number) {
    // 紧跟布局设置的位置：补进整框动画目标，和尺寸一起走完
    if (frame.layoutGear && frame.layoutPendingPosition && frame.layoutTarget) {
        frame.layoutTarget = { ...frame.layoutTarget, left, top };
        frame.layoutPendingPosition = false;
        retimeFrameLayout(frame);
        return;
    }
    frame.el.style({ left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
}

function updateClientFrameIcon(frame: ClientWindowFrame, appid: string) {
    frame.icon.clear();
    if (!appid) return;
    void (async () => {
        const desk = await desktopApp(appid);
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
        const available = availableStageSize();
        const width = frame.el.el.offsetWidth;
        const height = frame.el.el.offsetHeight;
        const maxX = Math.max(available.x, available.x + available.width - width);
        const maxY = Math.max(available.y, available.y + available.height - height);
        const left = Math.min(Math.max(available.x, Math.round(ev.clientX - startX + origLeft)), maxX);
        const top = Math.min(Math.max(available.y, Math.round(ev.clientY - startY + origTop)), maxY);
        if (!windowParents.has(handle)) {
            const screen = viewData.screenOf(handle);
            if (screen) {
                const moves = planDodges(screen, handle, { x: left, y: top, w: width, h: height });
                if (!moves) return;
                applyDodges(moves);
            }
        }
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

/** 标题栏、图标、窗口按钮：挂到已有的 frame 元素上，窗口的 handle 由调用方决定 */
function buildFrameChrome(frame: ClientWindowFrame, handle: string) {
    const title = txt("").style({
        flex: "1",
        minWidth: "0",
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        ...gTextStyle.subtitle,
        color: gTextStyle.color.primary,
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
        server.server.notify("window.close", handle),
    ).data({ "client-titlebar-close": "", "client-control": "close" });

    const maximizeIcon = createMaximizeGlyph();
    const restoreIcon = createRestoreGlyph();
    restoreIcon.style({ display: "none" });
    const maximize = createTitlebarControl(
        view()
            .style({ display: "flex", alignItems: "center", justifyContent: "center" })
            .add([maximizeIcon, restoreIcon]),
        () => {
            viewData.focusWin(handle);
            toggleMaximizeWindow(handle);
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
        beginClientFrameMove(frame, handle, e);
    });

    frame.header = header;
    frame.icon = icon;
    frame.title = title;
    frame.controls = [maximize, close];
    frame.maximizeIcon = maximizeIcon;
    frame.restoreIcon = restoreIcon;
    frame.el.add(header);
}

function createClientWindowFrame(info: WindowInfo, content: HTMLElement): ClientWindowFrame {
    const el = view().data({ "client-frame": "", "client-window": info.handle }).style({
        position: "absolute",
        boxSizing: "border-box",
        // 建立一个本窗口的层叠上下文：标题栏/热区的 z-index 只在本窗口内生效，
        // 不能盖到 DOM 顺序更靠上的其它窗口；用 z-index 而不是 isolation，
        // 避免窗口成为 backdrop root 后标题栏的 backdrop-filter 看不到后面的桌面。
        zIndex: "0",
    });
    const frame: ClientWindowFrame = {
        handle: info.handle,
        el,
        header: view(),
        icon: view(),
        title: txt(""),
        content,
        controls: [],
        maximizeIcon: view(),
        restoreIcon: view(),
        decorated: info.decorated,
        fullscreen: false,
        maximized: false,
        appid: "",
        renderId: info.renderId,
        surfaceWidth: 1,
        surfaceHeight: 1,
    };
    buildFrameChrome(frame, info.handle);
    el.add(content);
    updateClientFrameInfo(frame, info);
    applyClientFrameChrome(frame);
    syncClientFrameMaximized(frame, info.states.maximized);
    clientFrameByRenderId.set(info.renderId, frame);
    applyFrameSurfaceSize(frame);
    return frame;
}

/**
 * 从启动第一帧就存在的 frame 元素和 mask；标题栏、窗口按钮等客户端到达后再补。
 * 窗口到达只填 content/handle，元素不换，渲染轴因此从头到尾是同一个。
 */
function createPendingWindowFrame(
    name: string,
    appid: string | undefined,
    iconSrc: string | undefined,
    onCancel: () => void,
): ClientWindowFrame & { killBtn: ElType<HTMLElement>; closeBtn: ElType<HTMLElement> } {
    const el = view().data({ "client-frame": "", "pending-frame": "" }).style({
        position: "absolute",
        boxSizing: "border-box",
        zIndex: "0",
        // 回弹结束后才出现；此前只显示 intro 图标。按整帧缩放，mask 始终铺满，不会露出顶栏
        opacity: "0",
        transformOrigin: "50% 50%",
        transform: "scale(0.86)",
    });
    const mask = createLaunchPanel(name, iconSrc, onCancel, onCancel);
    mask.panel.data({ "desktop-ui": "pending-frame" });
    mask.panel.style({
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
        zIndex: "7",
        opacity: "1",
    });
    el.add(mask.panel);
    const frame = {
        handle: "",
        el,
        header: view(),
        icon: view(),
        title: txt(name || appid || ""),
        content: mask.panel.el,
        controls: [],
        maximizeIcon: view(),
        restoreIcon: view(),
        decorated: false,
        fullscreen: false,
        maximized: false,
        appid: appid ?? "",
        renderId: "",
        surfaceWidth: 1,
        surfaceHeight: 1,
        launching: true,
        pending: true,
        mask: mask.panel,
        maskSetIcon: mask.setIcon,
        killBtn: mask.killBtn,
        closeBtn: mask.closeBtn,
    };
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
                ...gTextStyle.title,
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
        removeWindowSlot(entry.el.el);
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
                getWallpaper: (slot) => wallpaper.src(slot),
                isDefaultWallpaper: (slot) => wallpaper.isDefault(slot),
                getWallpaperError: (slot) => wallpaper.error(slot),
                chooseWallpaper: (slot) => openWallpaperChooser(slot),
                resetWallpaper: (slot) => wallpaper.reset(slot),
                subscribeWallpaper: (callback) => wallpaper.subscribe(callback),
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
                getTouchpadSpeed: () => touchpadSpeed,
                setTouchpadSpeed: (speed) => {
                    touchpadSpeed = normalizePointerSpeed(speed);
                    desktopSetting.nset("touchpadSpeed", touchpadSpeed);
                },
                getTouchpadAcceleration: () => touchpadAcceleration,
                setTouchpadAcceleration: (enabled) => {
                    touchpadAcceleration = enabled;
                    desktopSetting.nset("touchpadAcceleration", enabled);
                },
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

/** 设置窗口里的壁纸选择：复用桌面的文件选择器，只列出图片 */
function openWallpaperChooser(slot: WallpaperSlot) {
    const request: FileChooserRequest = {
        id: `wallpaper:${slot}`,
        appId: "myde.desktop",
        parentWindow: "",
        modal: true,
        title: slot === "desktop" ? "选择桌面壁纸" : "选择锁屏壁纸",
        mode: "open",
        acceptLabel: "选择",
        multiple: false,
        directory: false,
        filters: [{ name: "图片", rules: [{ kind: "mime", pattern: "image/*" }] }],
        choices: [],
        currentName: "",
        files: [],
        cancel: async () => {},
        fail: async () => {},
        onCancel: () => () => {},
        accept: async (selection) => {
            const path = selection.paths[0];
            if (!path) return { ok: false, error: "没有选择图片" };
            try {
                await wallpaper.setPath(slot, path);
                return { ok: true };
            } catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        },
    };
    openInternalWindow({
        id: `internal:wallpaper-chooser:${slot}`,
        title: fileChooserTitle(request),
        icon: fileChooserHeaderIcon(request),
        width: 860,
        height: 580,
        parent: SETTINGS_WINDOW_ID,
        modal: true,
        onClose: () => {
            void request.cancel();
        },
        build: ({ close }) => {
            const content = createFileChooserContent({ request, close });
            return { el: content.el, dispose: content.dispose };
        },
    });
}

type AppIconLaunchInfo = {
    name: string;
    appid?: string;
    icon?: () => Promise<string | undefined>;
    /** 启动前收起所在弹窗（开始菜单、顶部快捷应用） */
    onLaunch?: () => void;
};

function appLauncher(
    iconPath: () => Promise<string>,
    name: string,
    exec: string,
    env?: Record<string, string>,
    appid?: string,
    onLaunch?: () => void,
) {
    const p = appIconEl(exec, env, { name, appid, icon: iconPath, onLaunch });
    loadAppIcon(p, iconPath, name);
    return p;
}

/** 只创建应用图标容器，图标由调用方在需要时再加载 */
function appIconEl(exec?: string, env?: Record<string, string>, launch?: AppIconLaunchInfo) {
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
        p.on("click", () => {
            launch?.onLaunch?.();
            launchApp({
                exec,
                env,
                name: launch?.name || exec,
                appid: launch?.appid,
                icon: launch?.icon,
                sourceEl: p.el,
            });
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

// ── 应用启动动画 ─────────────────────────────────────────────────────────────
// 从图标启动时先在图标位置出现白色面板，下压回弹后跟着新虚拟屏飞入并放大，
// 最后嵌进虚拟屏，等真实窗口出现再替换。屏幕位置每帧从 ViewScreen.visual 读取，
// 所以切屏、总览缩放等变化都会被面板实时跟踪。

type LaunchRect = { left: number; top: number; width: number; height: number };

type AppLaunchRequest = {
    exec: string;
    env?: Record<string, string>;
    name: string;
    appid?: string;
    icon?: () => Promise<string | undefined>;
    sourceEl?: HTMLElement;
    sourceRect?: LaunchRect;
    iconSrc?: string;
};

type LaunchPhase = "press" | "flying" | "embedded" | "replaced";

type PendingLaunch = {
    exec: string;
    appid?: string;
    child?: ReturnType<typeof server.runApp>;
    /** 从启动第一帧就存在的 frame；窗口创建后只填 content/handle，元素不换 */
    frame: ClientWindowFrame;
    /** 启动阶段由 launch 驱动的舞台槽；支配后由 view 写 */
    slot: ElType<HTMLElement>;
    /** 支配后由 view 的屏 transform 接管 */
    slotFollowsView: boolean;
    /** 还没有窗口时的取消按钮：结束进程树 */
    killBtn: ElType<HTMLElement>;
    /** 按下时先缩小的图标；透明后移除，mask 这时才出现 */
    intro?: ElType<HTMLElement>;
    introSetIcon?: (src: string | undefined) => void;
    startRect: LaunchRect;
    phase: LaunchPhase;
    screen?: ViewScreen;
    /** 飞入默认固定在视口坐标；屏幕被其他操作接管后才改为跟随屏 */
    trackScreen: boolean;
    /** 接管瞬间的局部中心与进度，之后继续插值到目标中心 */
    trackFrom?: { p: number; centerX: number; centerY: number };
    flightTarget?: { x: number; y: number; scale: number };
    flightProgress: number;
    /** 当前盒尺寸（渲染轴）；起飞时是图标大小，之后由 resize 独立驱动 */
    flightSize: { width: number; height: number };
    /** 当前盒矩形；固定阶段是视口坐标，接管后是屏内坐标 */
    currentRect?: LaunchRect;
    winHandle?: WinHandle;
    /** 默认窗口尺寸（已乘输出缩放）；窗口出现后换成真实尺寸 */
    targetWidth: number;
    targetHeight: number;
    /** 从 WindowInfo 先算出的窗口外框尺寸（显示 px，含服务端装饰标题栏） */
    windowWidth?: number;
    windowHeight?: number;
    replacing: boolean;
    revealed: boolean;
    claimed: boolean;
    closing: boolean;
    arrivedAt: number;
    /** 取消按钮是否已经开始淡入 */
    cancelShown: boolean;
    flightGear?: AnimationGear<{ p: number }>;
    sizeGear?: AnimationGear<{ width: number; height: number }>;
    /** 接管后的追平进度：从当前局部中心走到目标中心 */
    catchGear?: AnimationGear<{ p: number }>;
    catchProgress: number;
    /** 每帧推进：接管检测 + 支配判定 */
    tickHandle?: number;
};

const pendingLaunches = new Set<PendingLaunch>();

/**
 * 窗口还在启动流程里（面板占位或替换中）。
 * 这时它暂时住在启动面板里，换屏会把面板/窗口一起搬走并回收启动屏，等收尾时再换。
 */
function inLaunchFlow(winid: MWinId): boolean {
    for (const state of pendingLaunches) {
        if (state.winHandle === winid) return true;
    }
    return false;
}
const LAUNCH_PRESS_IN = { duration: 130, map: timingFunction.easeIn };
const LAUNCH_PRESS_OUT = { duration: 180, map: timingFunction.easeOut };
/** 面板飞入按真实屏幕的终点走直线；快进慢停，不跟虚拟屏自己的滑动曲线 */
const LAUNCH_FLIGHT = { duration: 240, map: timingFunction.cubicBezier(0.16, 1, 0.3, 1) };
/** 屏幕被接管后的追平时长：用屏幕自己的过渡时长，手势中也有界 */
const LAUNCH_CATCH_UP = { duration: SCREEN_TRANSITION.duration, map: timingFunction.easeOut };
/** 首帧替换：mask 淡出和盒 resize 共用时长，同时开始、同时结束 */
const LAUNCH_REVEAL = { duration: 180, map: timingFunction.easeInOut };
/** 自动 resize（最大化/恢复/全屏/界面缩放/客户端改尺寸）沿用首帧替换的时长和曲线 */
const FRAME_LAYOUT_TRANSITION = { duration: LAUNCH_REVEAL.duration, map: LAUNCH_REVEAL.map };
/** 空槽取消按钮：不要突然盖在图标上，落地后透明+模糊淡入 */
const LAUNCH_CANCEL_FADE = { duration: 220, map: timingFunction.easeOut };
const CLOSE_FADE = { duration: 220, map: timingFunction.easeOut };

let launchLayer: ElType<HTMLElement> | undefined;
let closeLayer: ElType<HTMLElement> | undefined;

function ensureCloseLayer() {
    if (closeLayer) return closeLayer;
    closeLayer = view()
        .style({
            position: "absolute",
            inset: "0",
            overflow: "hidden",
            pointerEvents: "none",
            // 和虚拟屏同层附近，但在所有屏之上；关闭的窗口不再属于任何屏
            zIndex: "3",
        })
        .addInto(windowElWarp);
    return closeLayer;
}

function fullStageSize() {
    return {
        width: windowEl.el.offsetWidth || window.innerWidth,
        height: windowEl.el.offsetHeight || window.innerHeight,
    };
}

function elementRect(el: HTMLElement): LaunchRect {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * 唯一写盒几何的地方：外壳或 frame 的外框。
 * 固定阶段坐标就是视口坐标；屏幕接管后是屏内坐标，槽的 transform 由屏幕轴提供。
 */
function setLaunchVisual(state: PendingLaunch, rect: LaunchRect) {
    state.currentRect = rect;
    writeFrameBox(state.frame, rect.left, rect.top, rect.width, rect.height);
}

function sourceIconSrc(el: HTMLElement | undefined) {
    return el?.querySelector("img")?.getAttribute("src") || undefined;
}

function ensureLaunchLayer() {
    if (launchLayer) return launchLayer;
    launchLayer = view()
        .style({
            position: "fixed",
            inset: "0",
            overflow: "hidden",
            pointerEvents: "none",
            // 在工具栏/搜索栏之上、锁屏和光标之下
            zIndex: "25",
        })
        .addInto(mainEl);
    return launchLayer;
}

function setPanelRect(panel: ElType<HTMLElement>, rect: LaunchRect) {
    panel.style({
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
    });
}

/**
 * 启动动画用的应用外框尺寸：外壳 data-client-frame 的尺寸可能不准，
 * 以内部 surface DOM 的实际大小为准，再补服务端装饰标题栏高度。
 */
function launchFrameOuterSize(frame: ClientWindowFrame, state?: PendingLaunch) {
    const content = frameContentDisplaySize(frame);
    const fallbackWidth = state?.windowWidth || frame.surfaceWidth || 1;
    const fallbackHeight = state?.windowHeight || frame.surfaceHeight + titlebarPx(frame) || 1;
    return {
        width: Math.max(1, content.width || fallbackWidth),
        height: Math.max(1, content.height > 0 ? content.height + titlebarPx(frame) : fallbackHeight),
    };
}

/** 面板在虚拟屏里的目标矩形：真实窗口出现后贴住窗口，否则居中 800×600（乘输出缩放） */
function launchTargetLocalRect(state: PendingLaunch): LaunchRect {
    const frame = state.frame;
    if (!frame.pending) {
        // 盒动画期间不能读 offsetWidth（那是动画中的值）；用真实目标外框
        const target = frame.boxTarget ?? {
            width: frame.surfaceWidth,
            height: frame.surfaceHeight + titlebarPx(frame),
        };
        const width = Math.max(1, target.width);
        const height = Math.max(1, target.height);
        const position = windowCenterManager.centeredPosition(width, height);
        return { left: position.left, top: position.top, width, height };
    }
    const available = availableStageSize();
    const width = Math.max(1, state.windowWidth ?? state.targetWidth);
    const height = Math.max(1, state.windowHeight ?? state.targetHeight);
    return {
        left: Math.round(available.x + (available.width - width) / 2),
        top: Math.round(available.y + (available.height - height) / 2),
        width,
        height,
    };
}

/** 没有客户端几何的普通窗口先用和启动动画一样的默认尺寸占位 */
function prepareWindowSizeFallback(frame: ClientWindowFrame, info: WindowInfo) {
    const scale = info.scale || screenManager.getScale() || 1;
    frame.surfaceWidth = Math.max(1, Math.round((info.rect.w || 800) * scale));
    frame.surfaceHeight = Math.max(1, Math.round((info.rect.h || 600) * scale));
    applyFrameSurfaceSize(frame);
}

/**
 * 窗口刚创建时先用 WindowInfo 算出显示尺寸，不等首帧 surface：
 * 内容逻辑尺寸乘输出缩放，服务端装饰再加标题栏高度。
 */
function prepareLaunchWindowSize(state: PendingLaunch, frame: ClientWindowFrame, info: WindowInfo) {
    const scale = info.scale || screenManager.getScale() || 1;
    frame.surfaceWidth = Math.max(1, Math.round((info.rect.w || 800) * scale));
    frame.surfaceHeight = Math.max(1, Math.round((info.rect.h || 600) * scale));
    applyFrameSurfaceSize(frame);
    state.windowWidth = frame.surfaceWidth;
    state.windowHeight = frame.surfaceHeight + titlebarPx(frame);
    if (!frame.painted) {
        // 首帧提交前面板是白色，窗口也用白底过渡，交叉淡入时不会露出透明空洞
        frame.el.el.style.background = "#fff";
        frame.el.el.style.borderRadius = "calc(var(--window-radius, 18px) * var(--desktop-ui-scale, 1))";
    }
}

function setLaunchIcon(state: PendingLaunch, src: string | undefined) {
    if (!src || !pendingLaunches.has(state)) return;
    state.frame.maskSetIcon?.(src);
    state.introSetIcon?.(src);
}

function createLaunchPanel(name: string, iconSrc: string | undefined, onKill: () => void, onClose: () => void) {
    const iconLetter = txt((name.trim()[0] || "?").toUpperCase()).style({
        ...gTextStyle.display,
        fontSize: "28px",
        color: gTextStyle.color.secondary,
    });
    const iconImg = ele("img")
        .style({ width: "100%", height: "100%", objectFit: "contain", display: "none" })
        .attr({ alt: "", draggable: false });
    const iconBox = view().style({
        width: "70%",
        height: "70%",
        maxWidth: "calc(96px * var(--desktop-ui-scale, 1))",
        maxHeight: "calc(96px * var(--desktop-ui-scale, 1))",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: "0",
    });
    iconBox.add([iconLetter, iconImg]);

    // 白色底和图标单独一层，替换窗口时和窗口一起淡出，最后面板本身是透明的
    const cover = view().style({
        position: "absolute",
        inset: "0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#fff",
        borderRadius: "inherit",
    });
    cover.add(iconBox);

    const panel = view()
        .style({
            position: "absolute",
            boxSizing: "border-box",
            pointerEvents: "none",
            borderRadius: "calc(var(--window-radius, 18px) * var(--desktop-ui-scale, 1))",
            transformOrigin: "50% 50%",
            willChange: "left, top, width, height, transform",
        })
        .add(cover);

    // 两个固定 DOM，各自绑定事件，不按状态重新指派：
    // 窗口还没出现时是 kill，窗口出现后换成 close（发给客户端）
    const killBtn = createWindowCloseButton({ size: 26, onClick: onKill }).style({
        position: "absolute",
        top: "10px",
        right: "10px",
        display: "none",
        pointerEvents: "auto",
    });
    const closeBtn = createWindowCloseButton({ size: 26, onClick: onClose }).style({
        position: "absolute",
        top: "10px",
        right: "10px",
        display: "none",
        pointerEvents: "auto",
    });
    panel.add([killBtn, closeBtn]);

    const setIcon = (src: string | undefined) => {
        if (!src) return;
        iconImg.attr({ src });
        iconImg.style({ display: "block" });
        iconLetter.style({ display: "none" });
    };
    setIcon(iconSrc);

    return { panel, cover, iconImg, iconLetter, killBtn, closeBtn, setIcon };
}

/** 启动入口：所有应用启动都经过这里。source 用于让动画从点击的图标开始 */
function launchApp(req: AppLaunchRequest) {
    const sourceRect = req.sourceRect ?? (req.sourceEl ? elementRect(req.sourceEl) : undefined);
    const stage = fullStageSize();
    const rect: LaunchRect = sourceRect ?? {
        left: stage.width / 2 - 32,
        top: stage.height / 2 - 32,
        width: 64,
        height: 64,
    };
    const initialIcon = req.iconSrc ?? sourceIconSrc(req.sourceEl);
    const scale = screenManager.getScale();
    let state!: PendingLaunch;
    // 渲染轴从第一帧就存在：frame 元素和遮罩先建好，窗口到达只换 content
    const frame = createPendingWindowFrame(req.name, req.appid, initialIcon, () => void cancelLaunch(state));
    const intro = createLaunchPanel(
        req.name,
        initialIcon,
        () => {},
        () => {},
    );
    const slot = ensureWindowSlot(frame.el.el);
    slot.style({ zIndex: "5000" });
    slot.add(frame.el.el);
    frame.el.style({
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
    });
    state = {
        exec: req.exec,
        appid: req.appid,
        frame,
        slot,
        slotFollowsView: false,
        killBtn: frame.killBtn,
        intro: intro.panel,
        introSetIcon: intro.setIcon,
        startRect: rect,
        phase: "press",
        trackScreen: false,
        flightProgress: 0,
        catchProgress: 0,
        flightSize: { width: rect.width, height: rect.height },
        currentRect: rect,
        targetWidth: 800 * scale,
        targetHeight: 600 * scale,
        replacing: false,
        revealed: false,
        claimed: false,
        closing: false,
        arrivedAt: Date.now(),
        cancelShown: false,
    };
    pendingLaunches.add(state);
    ensureLaunchLayer().add(intro.panel);
    setPanelRect(intro.panel, rect);
    if (!initialIcon && req.icon) {
        void req
            .icon()
            .then((src) => setLaunchIcon(state, src))
            .catch(() => {});
    }

    startLaunchPress(state);

    void (async () => {
        try {
            await server.startXwayland();
            const child = server.runApp(req.exec, { env: req.env });
            state.child = child;
            // 启动失败/提前退出：没有窗口就保留占位面板，并立即露出关闭按钮
            child.once("error", () => showLaunchCancel(state));
            child.once("exit", () => showLaunchCancel(state));
        } catch (error) {
            console.warn(`[launch] 启动 ${req.exec} 失败:`, error);
            showLaunchCancel(state);
        }
    })();
}

function startLaunchPress(state: PendingLaunch) {
    const intro = state.intro;
    const mask = state.frame.mask;
    if (!intro || !mask) {
        startLaunchFlight(state);
        return;
    }
    // 图标先缩小淡出；完全透明时再创建白色面板，让面板从同样的缩小状态淡回来
    const gear = createAnimationGear({ p: 0 }, { transition: LAUNCH_PRESS_IN });
    gear.setUpdateCallback(({ p }) => {
        intro.style({ transform: `scale(${1 - 0.14 * p})`, opacity: `${1 - p}` });
    });
    gear.moveTo({ p: 1 }, LAUNCH_PRESS_IN, () => {
        intro.remove();
        state.intro = undefined;
        state.introSetIcon = undefined;
        if (!pendingLaunches.has(state) || state.closing) return;

        const back = createAnimationGear({ p: 0 }, { transition: LAUNCH_PRESS_OUT });
        back.setUpdateCallback(({ p }) => {
            state.frame.el.style({ opacity: `${p}`, transform: `scale(${0.86 + 0.14 * p})` });
        });
        back.moveTo({ p: 1 }, LAUNCH_PRESS_OUT, () => {
            if (!pendingLaunches.has(state) || state.phase !== "press") return;
            state.frame.el.style({ opacity: "1", transform: "none", transformOrigin: "" });
            startLaunchFlight(state);
        });
    });
}

/** 虚拟屏局部矩形 → 屏幕（视口）矩形 */
function screenRectOf(transform: { x: number; y: number; scale: number }, local: LaunchRect): LaunchRect {
    return {
        left: transform.x + local.left * transform.scale,
        top: transform.y + local.top * transform.scale,
        width: local.width * transform.scale,
        height: local.height * transform.scale,
    };
}

/** 屏幕（视口）矩形 → 虚拟屏局部矩形 */
function localRectOf(transform: { x: number; y: number; scale: number }, rect: LaunchRect): LaunchRect {
    const scale = Math.max(0.0001, transform.scale);
    return {
        left: (rect.left - transform.x) / scale,
        top: (rect.top - transform.y) / scale,
        width: rect.width / scale,
        height: rect.height / scale,
    };
}

/** 创屏滑动以外的操作（手势、总览、切屏按钮等）接管了虚拟屏时，面板才改为跟屏 */
function launchScreenTakenOver(state: PendingLaunch) {
    if (viewData.gestureActive || viewData.overview) return true;
    const target = state.screen ? viewData.committedScreenTransform(state.screen) : undefined;
    const base = state.flightTarget;
    if (!target || !base) return false;
    return (
        Math.abs(target.x - base.x) > 0.5 ||
        Math.abs(target.y - base.y) > 0.5 ||
        Math.abs(target.scale - base.scale) > 0.001
    );
}

function startLaunchFlight(state: PendingLaunch) {
    if (!pendingLaunches.has(state)) return;
    state.phase = "flying";
    state.frame.el.style({ opacity: "1", transform: "none", transformOrigin: "" });
    // 首帧提前到达时 mask 可能已经在淡出，不要把它拉回不透明
    if (!state.replacing) state.frame.mask?.style({ opacity: "1" });
    // 按下期间先不切屏。窗口已经创建就用它自己的屏，否则补一个占位应用屏。
    if (!state.screen) state.screen = viewData.addPendingAppScreen();
    else viewData.setCurrentScreen(state.screen.id, true);

    state.trackScreen = false;
    state.trackFrom = undefined;
    state.flightProgress = 0;
    state.catchProgress = 0;
    state.catchGear = undefined;
    // 目标是屏停稳后的位置，不能读创屏滑动中的 target
    const committed = viewData.committedScreenTransform(state.screen);
    state.flightTarget = committed
        ? { x: committed.x, y: committed.y, scale: committed.scale }
        : { x: state.screen.target.x, y: state.screen.target.y, scale: state.screen.target.scale };

    // 飞行默认固定在视口坐标：盒从图标本身的矩形开始，槽保持恒等，屏在后面滑。
    // 盒不必保持目标比例：内容会非等比拉伸填满，mask 里的图标由 DOM 居中。
    const targetLocal = launchTargetLocalRect(state);
    state.flightSize = {
        width: Math.max(1, state.startRect.width),
        height: Math.max(1, state.startRect.height),
    };
    setLaunchVisual(state, {
        left: state.startRect.left + (state.startRect.width - state.flightSize.width) / 2,
        top: state.startRect.top + (state.startRect.height - state.flightSize.height) / 2,
        width: state.flightSize.width,
        height: state.flightSize.height,
    });
    state.slotFollowsView = false;
    applyScreenTransform(state.slot, { x: 0, y: 0, scale: 1, opacity: 1, blur: 0 });
    state.slot.style({ zIndex: "5000" });

    const gear = createAnimationGear({ p: 0 }, { transition: LAUNCH_FLIGHT });
    state.flightGear = gear;
    gear.setUpdateCallback(({ p }) => {
        state.flightProgress = p;
    });
    const sizeGear = createAnimationGear(
        { width: state.flightSize.width, height: state.flightSize.height },
        { transition: LAUNCH_FLIGHT },
    );
    state.sizeGear = sizeGear;
    sizeGear.setUpdateCallback((value) => {
        if (!pendingLaunches.has(state)) return;
        state.flightSize = value;
    });
    sizeGear.moveTo(
        { width: targetLocal.width, height: targetLocal.height },
        { ...LAUNCH_FLIGHT, onComplete: () => finishLaunchIfReady(state) },
    );
    gear.moveTo({ p: 1 }, LAUNCH_FLIGHT);
    startLaunchTick(state);
}

/** 启动盒的中心（屏内坐标）：窗口最终位置的中心 */
function launchCenterLocal(state: PendingLaunch): { x: number; y: number } {
    const box = launchTargetLocalRect(state);
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** 中心来自飞入（固定或接管后追平），尺寸来自独立的 resize；这里只组合出盒矩形 */
function renderLaunchGeometry(state: PendingLaunch) {
    const screen = state.screen;
    if (!screen || !pendingLaunches.has(state)) return;
    const size = state.flightSize;
    let centerX: number;
    let centerY: number;
    if (state.trackScreen && state.trackFrom) {
        const target = launchCenterLocal(state);
        const t = clampNumber(state.catchProgress, 0, 1);
        centerX = state.trackFrom.centerX + (target.x - state.trackFrom.centerX) * t;
        centerY = state.trackFrom.centerY + (target.y - state.trackFrom.centerY) * t;
    } else {
        const targetLocal = launchTargetLocalRect(state);
        const targetViewport = screenRectOf(state.flightTarget ?? screen.target, targetLocal);
        const startX = state.startRect.left + state.startRect.width / 2;
        const startY = state.startRect.top + state.startRect.height / 2;
        const targetX = targetViewport.left + targetViewport.width / 2;
        const targetY = targetViewport.top + targetViewport.height / 2;
        const p = state.flightProgress;
        centerX = startX + (targetX - startX) * p;
        centerY = startY + (targetY - startY) * p;
    }
    setLaunchVisual(state, {
        left: centerX - size.width / 2,
        top: centerY - size.height / 2,
        width: size.width,
        height: size.height,
    });
}

/** 屏幕被手势/总览/切屏接管：把位置从「视口固定」切到「跟随屏幕」，之后屏幕自己带着盒子走 */
function trackScreenChange(state: PendingLaunch) {
    const screen = state.screen;
    const rect = state.currentRect;
    if (!screen || !rect || state.trackScreen) return;
    const visual = screen.visual;
    // 视口矩形 -> 屏内矩形：切换这一瞬间视觉位置不变
    const local = localRectOf(visual, rect);
    state.trackScreen = true;
    state.flightSize = { width: local.width, height: local.height };
    state.currentRect = local;
    state.trackFrom = {
        p: 0,
        centerX: local.left + local.width / 2,
        centerY: local.top + local.height / 2,
    };
    state.catchProgress = 0;
    applyScreenTransform(state.slot, visual);

    // 飞行还没结束就沿用它的剩余时间，已经结束就用理论追平时长；手势中也有界
    const running = state.flightGear?.getRunningAnimation();
    const duration = running?.isRunning ? Math.max(1, running.remainingTime) : LAUNCH_CATCH_UP.duration;
    const catchGear = createAnimationGear({ p: 0 }, { transition: { duration, map: LAUNCH_CATCH_UP.map } });
    state.catchGear = catchGear;
    catchGear.setUpdateCallback(({ p }) => {
        state.catchProgress = p;
    });
    catchGear.moveTo({ p: 1 }, { duration, map: LAUNCH_CATCH_UP.map });

    // 尺寸也换到屏内单位；旧的尺寸齿轮停写，新的从当前值瞄准最终盒
    state.sizeGear?.setUpdateCallback(() => {});
    const target = launchTargetLocalRect(state);
    const sizeGear = createAnimationGear(
        { width: local.width, height: local.height },
        { transition: { duration, map: LAUNCH_FLIGHT.map } },
    );
    state.sizeGear = sizeGear;
    sizeGear.setUpdateCallback((value) => {
        if (!pendingLaunches.has(state)) return;
        state.flightSize = value;
    });
    sizeGear.moveTo(
        { width: target.width, height: target.height },
        { duration, map: LAUNCH_FLIGHT.map, onComplete: () => finishLaunchIfReady(state) },
    );
}

/** 支配条件：飞行结束；固定坐标阶段还要等屏停稳（停稳后固定位置和屏幕位置重合） */
function launchCanDominate(state: PendingLaunch): boolean {
    if (state.phase !== "flying") return false;
    const gear = state.trackScreen ? state.catchGear : state.flightGear;
    if (gear?.getRunningAnimation().isRunning) return false;
    if (!state.trackScreen && state.screen && !viewData.isScreenSettled(state.screen)) return false;
    return true;
}

/** 每帧推进：检测接管、写盒、判定支配 */
function startLaunchTick(state: PendingLaunch) {
    if (state.tickHandle !== undefined) return;
    const step = () => {
        state.tickHandle = undefined;
        if (!pendingLaunches.has(state) || state.closing) return;
        if (state.phase !== "flying") return;
        const screen = state.screen;
        if (!screen) return;
        if (!state.trackScreen && launchScreenTakenOver(state)) trackScreenChange(state);
        renderLaunchGeometry(state);
        if (launchCanDominate(state)) {
            dominateLaunch(state);
            return;
        }
        state.tickHandle = requestAnimationFrame(step);
    };
    state.tickHandle = requestAnimationFrame(step);
}

/** 支配：槽交给屏幕，盒保持当前值；resize 若没结束就继续挂在 frame 上跑 */
function dominateLaunch(state: PendingLaunch) {
    const frame = state.frame;
    // 启动过程中窗口可能已经被移到别的屏（全屏/手势）；以它当前的屏为准
    const screen = (frame ? viewData.screenOf(frame.handle) : undefined) ?? state.screen;
    if (!screen || !pendingLaunches.has(state)) return;
    state.screen = screen;
    state.phase = "embedded";
    state.flightGear = undefined;
    state.catchGear = undefined;
    state.flightProgress = 1;
    state.catchProgress = 1;
    if (state.tickHandle !== undefined) {
        cancelAnimationFrame(state.tickHandle);
        state.tickHandle = undefined;
    }
    if (!state.trackScreen) {
        // 停稳的当前屏 transform 是恒等，视口坐标就是屏内坐标；写一次保证之后不跳
        state.trackScreen = true;
        const visual = screen.visual;
        const rect = state.currentRect;
        if (rect) {
            const local = localRectOf(visual, rect);
            state.flightSize = { width: local.width, height: local.height };
            setLaunchVisual(state, local);
        }
    }
    state.slot.data({ "window-screen": screen.id });
    applyScreenTransform(state.slot, screen.visual);
    if (frame.pending) {
        // 还没有客户端窗口：mask 留在槽里，后续由 view 的屏 transform 接管
        state.slotFollowsView = true;
        showLaunchCancel(state);
    } else if (state.revealed) {
        // mask 已经替换完：正常把窗口交给屏幕
        state.slotFollowsView = false;
        frame.launching = false;
        // resize 独立：支配后继续由它写盒，和 view 的槽互不冲突
        if (!adoptBoxGearIntoFrame(state, frame)) releaseFrameBox(frame);
    } else {
        // 首帧还没出来：mask 继续盖着，盒也留给首帧的 resize；
        // 槽由 pending 循环带着跟随屏，等替换完成后再交给窗口。
        // 首帧的 resize 可能已经起跑但飞入已结束，这里把它交给 frame 继续写盒。
        state.slotFollowsView = true;
        adoptBoxGearIntoFrame(state, frame);
    }
    finishLaunchIfReady(state);
}

/** 空槽（还没有窗口）落地后露出取消按钮，不必等超时 */
function showLaunchCancel(state: PendingLaunch) {
    if (!pendingLaunches.has(state) || state.replacing || state.closing) return;
    if (state.phase !== "embedded") return;
    revealLaunchCancel(state);
}

function revealLaunchCancel(state: PendingLaunch) {
    if (!pendingLaunches.has(state) || state.cancelShown || state.replacing || state.closing) return;
    state.cancelShown = true;
    state.killBtn.style({
        display: "flex",
        opacity: "0",
        filter: "blur(4px)",
        pointerEvents: "none",
    });
    const gear = createAnimationGear({ p: 0 }, { transition: LAUNCH_CANCEL_FADE });
    gear.setUpdateCallback(({ p }) => {
        if (!pendingLaunches.has(state) || state.replacing || state.closing) return;
        state.killBtn.style({ opacity: `${p}`, filter: p >= 1 ? "none" : `blur(${(1 - p) * 4}px)` });
    });
    gear.moveTo({ p: 1 }, LAUNCH_CANCEL_FADE, () => {
        if (!pendingLaunches.has(state) || state.replacing || state.closing) return;
        state.killBtn.style({ pointerEvents: "auto", filter: "none" });
    });
}

/** 首帧到达：盒 resize 和 mask 替换用同一段时长，同时开始、同时结束 */
function revealLaunch(state: PendingLaunch) {
    const duration = LAUNCH_REVEAL.duration;
    resizeLaunchBox(state, duration);
    beginLaunchReplacement(state, duration);
}

/** 外壳/真实窗口的封面淡出，窗口本身已经在槽里；时长与首帧 resize 相同 */
function beginLaunchReplacement(state: PendingLaunch, duration: number) {
    const frame = state.frame;
    if (!frame || frame.pending || !pendingLaunches.has(state) || state.replacing || state.closing) return;
    state.replacing = true;
    state.killBtn.style({ display: "none", pointerEvents: "none" });
    frame.el.style({ pointerEvents: "none" });

    const mask = frame.mask;
    const transition = { duration, map: LAUNCH_REVEAL.map };
    const gear = createAnimationGear({ fade: 0 }, { transition });
    gear.setUpdateCallback(({ fade }) => {
        if (!pendingLaunches.has(state) || !mask) return;
        mask.style({ opacity: `${1 - fade}` });
    });
    gear.moveTo({ fade: 1 }, transition, () => {
        if (!pendingLaunches.has(state)) return;
        mask?.remove();
        frame.mask = undefined;
        // 内容已经露出来，关闭交给窗口自己的标题栏或应用 UI
        frame.closeBtn?.style({ display: "none", pointerEvents: "none" });
        state.revealed = true;
        finishLaunchIfReady(state);
    });
}

/** 支配并且封面淡完后收尾：撤掉启动状态，焦点交给窗口 */
function finishLaunchIfReady(state: PendingLaunch) {
    if (!pendingLaunches.has(state)) return;
    if (state.phase !== "embedded" || !state.revealed) return;
    const frame = state.frame;
    // 还没有客户端窗口：占位 frame 留在槽里等窗口或取消
    if (frame.pending) return;
    // 启动过程中窗口可能已经被移到别的屏（全屏/最大化）；以它当前的屏为准
    const screen = viewData.screenOf(frame.handle) ?? state.screen;
    if (screen) {
        state.slot.data({ "window-screen": screen.id });
        applyScreenTransform(state.slot, screen.visual);
    }
    frame.launching = false;
    // 没有在跑的 resize 就把预览还回真实尺寸；在跑的话由它自己结束
    if (!frame.boxGear?.getRunningAnimation().isRunning) releaseFrameBox(frame);
    // pointer-events 交给样式表按层/预览状态控制；这里清掉启动期间的内联 none
    frame.el.el.style.removeProperty("pointer-events");
    frame.el.style({ opacity: "1", transform: "none", transformOrigin: "" });
    frame.closeBtn?.style({ display: "none", pointerEvents: "none" });
    // 窗口这时才真正接管屏幕；到这里再激活，客户端已经完成初始化，不会丢掉焦点事件
    viewData.focusWin(frame.handle);
    if (state.tickHandle !== undefined) cancelAnimationFrame(state.tickHandle);
    pendingLaunches.delete(state);
    viewData.renderWindowSlots();
}

/** 目标尺寸变化只重新瞄准盒尺寸；用剩余时间，不拉长结束时刻 */
function retimeLaunchSize(state: PendingLaunch, duration?: number) {
    const gear = state.sizeGear;
    if (!gear) return;
    const target = launchTargetLocalRect(state);
    const running = gear.getRunningAnimation();
    const time = duration ?? (running.isRunning ? Math.max(1, running.remainingTime) : LAUNCH_FLIGHT.duration);
    gear.moveTo(
        { width: target.width, height: target.height },
        { duration: time, map: LAUNCH_FLIGHT.map, onComplete: () => finishLaunchIfReady(state) },
    );
}

/**
 * 首帧到达时把盒 resize 到真实目标，时长和 mask 替换一致。
 * 飞行中仍由飞入的尺寸齿轮写盒；支配后尺寸齿轮已经停写，改用 frame 自己的盒齿轮。
 */
function resizeLaunchBox(state: PendingLaunch, duration: number) {
    const frame = state.frame;
    // 按下阶段还没起飞：飞入的尺寸齿轮马上会从图标直接长到真实目标
    if (state.phase === "press") return;
    const target = launchTargetLocalRect(state);
    if (state.phase === "flying" && !frame.boxGear) {
        retimeLaunchSize(state, duration);
        return;
    }
    if (frame.boxGear) {
        retimeFrameBox(frame, duration);
        return;
    }
    const current = currentFrameBox(frame) ?? {
        left: 0,
        top: 0,
        width: Math.max(1, frame.surfaceWidth),
        height: Math.max(1, frame.surfaceHeight + titlebarPx(frame)),
    };
    // 立即按当前盒重算一次拉伸，替换期间内容不会以自然尺寸溢出
    writeFrameBox(frame, current.left, current.top, current.width, current.height);
    const center = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
    const transition = { duration, map: LAUNCH_FLIGHT.map };
    const gear = createAnimationGear({ width: current.width, height: current.height }, { transition });
    frame.boxGear = gear;
    gear.setUpdateCallback((value) => {
        if (frame.boxGear !== gear || !clientWindowFrames.has(frame.handle)) return;
        writeFrameBox(frame, center.x - value.width / 2, center.y - value.height / 2, value.width, value.height);
    });
    gear.moveTo(
        { width: target.width, height: target.height },
        {
            ...transition,
            onComplete: () => {
                if (frame.boxGear !== gear) return;
                if (frame.launching) return;
                releaseFrameBox(frame);
            },
        },
    );
}

function claimPendingLaunch(info: WindowInfo) {
    let best: PendingLaunch | undefined;
    let bestScore = -Infinity;
    let candidates = 0;
    const appid = info.appid.toLowerCase().replace(/\.desktop$/, "");
    for (const state of pendingLaunches) {
        if (state.claimed || state.phase === "replaced") continue;
        const age = Date.now() - state.arrivedAt;
        let score = appid ? 5 : 10;
        const target = state.appid?.toLowerCase().replace(/\.desktop$/, "");
        if (target && appid) {
            if (appid === target) score = 100;
            else if (appid.endsWith(target) || target.endsWith(appid)) score = 80;
            // 两边都有 appid 却完全对不上：不要用“只剩一个待启动”兜底认领
            else score = -10;
        }
        const execName = state.exec.trim().split(/\s+/)[0]?.split("/").pop()?.toLowerCase();
        if (appid && execName) {
            if (appid === execName) score = Math.max(score, 70);
            else if (appid.includes(execName) || execName.includes(appid)) score = Math.max(score, 60);
        }
        // 两分钟后只有明确 appid/exec 匹配还能认领；托盘面板之后弹出的本应用窗口仍会替换它
        if (age > 120000 && score < 40) continue;
        candidates++;
        if (score > bestScore) {
            best = state;
            bestScore = score;
        }
    }
    if (!best) return undefined;
    // 有明确匹配才在多任务并发时认领；只剩一个待启动项时允许按时间兜底
    if (bestScore >= 40 || (candidates === 1 && bestScore > 0)) {
        best.claimed = true;
        return best;
    }
    return undefined;
}

/** 客户端窗口到达：填进从启动就存在的 frame，只换 content，元素和盒都不换 */
function attachWindowToLaunch(state: PendingLaunch, info: WindowInfo, winEl: HTMLElement) {
    const frame = state.frame;
    state.winHandle = info.handle;
    frame.handle = info.handle;
    frame.renderId = info.renderId;
    frame.decorated = info.decorated;
    frame.pending = false;
    frame.el.data({ "client-window": info.handle });
    frame.el.el.removeAttribute("data-pending-frame");
    clientWindowFrames.set(info.handle, frame);
    clientFrameByRenderId.set(info.renderId, frame);

    frame.content = winEl;
    buildFrameChrome(frame, info.handle);
    frame.el.add(winEl);
    updateClientFrameInfo(frame, info);
    applyClientFrameChrome(frame);
    syncClientFrameMaximized(frame, info.states.maximized);
    prepareLaunchWindowSize(state, frame, info);
    // kill 换成 close：两个固定 DOM 各自绑定，不重新指派事件
    frame.killBtn?.style({ display: "none", pointerEvents: "none" });
    frame.closeBtn?.style({ display: "flex", pointerEvents: "auto" });
    windowCenterManager.addWindow(frame.handle, frame.el.el);
    // 启动期间外框由盒动画写，别让自动居中按动画尺寸不停改位置
    windowCenterManager.pauseCentering(frame.handle);
    // 内容刚填进来时盒可能还在飞行：立刻按当前盒拉伸，避免第一帧以自然尺寸溢出
    const rect = state.currentRect;
    if (rect && frame.launching) writeFrameBox(frame, rect.left, rect.top, rect.width, rect.height);

    if (state.phase === "press") return;
    // 窗口晚到、外壳已经停稳：在跑的 resize 直接交给 frame；替换仍等首帧
    if (state.phase === "embedded") adoptBoxGearIntoFrame(state, frame);
}

/** 渲染层报告首帧尺寸：更新真实外框并去掉过渡白底；尺寸归 resize，独立重新瞄准 */
function notifyLaunchWindowSized(frame: ClientWindowFrame) {
    const state = launchStateForFrame(frame);
    if (!state) return;
    if (frame.surfaceWidth <= 1 || frame.surfaceHeight <= 1) return;
    const firstFrame = !frame.painted;
    // 首帧到了就撤掉启动过渡白底；即使窗口还没有从外壳接管槽也要清，
    // 否则 attach 之后不会再有尺寸回调，白底会一直留着
    frame.painted = true;
    frame.el.el.style.background = "";
    frame.el.el.style.borderRadius = "";
    const outer = launchFrameOuterSize(frame, state);
    state.windowWidth = outer.width;
    state.windowHeight = outer.height;
    // 首帧：mask 替换和盒 resize 同时开始、用同一段时长、同时结束
    if (firstFrame && !state.replacing) {
        revealLaunch(state);
        return;
    }
    // 后续尺寸变化：位置完全不受影响，盒围绕目标中心重新瞄准
    if (frame.boxGear) retimeFrameBox(frame);
    else retimeLaunchSize(state);
}

function notifyLaunchWindowClosed(winid: WinHandle) {
    for (const state of pendingLaunches) {
        if (state.winHandle !== winid) continue;
        state.intro?.remove();
        state.intro = undefined;
        cancelFrameLayoutTransition(state.frame);
        const target = state.frame.el;
        removeWindowSlot(target.el);
        target.remove();
        pendingLaunches.delete(state);
        return;
    }
}

async function killProcessTree(pid: number) {
    try {
        const tree = await MSysApi.appControl.getPidTree(pid);
        const kill = (item: { pid: number; children: typeof tree.children }) => {
            for (const child of item.children) kill(child);
            try {
                MSysApi.appControl.getPid(item.pid).kill();
            } catch {
                /* 已经退出 */
            }
        };
        kill(tree);
    } catch {
        /* 进程表里已经找不到 */
    }
}

/** 取消启动：窗口还没出现就结束进程树，已经出现就发 close，不杀进程 */
function cancelLaunch(state: PendingLaunch) {
    const frame = state.frame;
    // 已经有客户端窗口就发 close，不杀进程；还没有才 kill
    if (!frame.pending) {
        server.server.notify("window.close", frame.handle);
        return;
    }
    forceQuitLaunch(state);
}

/** 强制退出启动出来的进程树（只用于还没有窗口的阶段） */
function forceQuitLaunch(state: PendingLaunch) {
    if (!pendingLaunches.has(state) || state.closing) return;
    state.closing = true;
    state.intro?.remove();
    state.intro = undefined;
    state.killBtn.style({ display: "none" });
    state.frame.el.style({ pointerEvents: "none" });

    const pid = state.child?.pid;
    if (pid !== undefined) {
        void killProcessTree(pid).finally(() => {
            try {
                state.child?.kill("SIGKILL");
            } catch {
                /* 已经退出 */
            }
        });
    }

    const target = state.frame.el;
    const gear = createAnimationGear({ opacity: 1 }, { transition: CLOSE_FADE });
    gear.setUpdateCallback(({ opacity }) => target.style({ opacity: `${opacity}` }));
    gear.moveTo({ opacity: 0 }, CLOSE_FADE, () => {
        if (!pendingLaunches.has(state)) return;
        removeWindowSlot(target.el);
        target.remove();
        pendingLaunches.delete(state);
        if (state.screen) viewData.discardPendingScreen(state.screen);
    });
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
        focusClientWindow(info);
    }
}

/**
 * 触摸序列按 `pointerId` 独立路由：down 命中客户端窗口就整段发给它（`input.touch`），
 * move/up 跟着同一个窗口走；落在桌面 UI 上的触摸不产生 Wayland 事件，由模拟的 pointer 事件处理。
 */
function sendTouchPointerEvent(type: "move" | "down" | "up", p: PointerEvent): PointerHit | undefined {
    const id = p.pointerId ?? 1;
    if (type === "down") {
        if (touchRoutes.has(id)) return undefined;
        const hit = pointerHits(p)[0];
        if (!hit) return undefined;
        const local = pointerLocal(hit, p);
        if (!local) return undefined;
        touchRoutes.set(id, hit);
        server.server.notify("input.touch", hit.handle, { type: "down", id, x: local.x, y: local.y });
        const info = server.server.windows.get(hit.handle);
        if (info) focusClientWindow(info);
        pointerTarget = hit;
        return hit;
    }
    const hit = touchRoutes.get(id);
    if (!hit) return undefined;
    if (type === "move") {
        const local = pointerLocal(hit, p);
        if (!local) {
            touchRoutes.delete(id);
            return undefined;
        }
        server.server.notify("input.touch", hit.handle, { type: "move", id, x: local.x, y: local.y });
        pointerTarget = hit;
        return hit;
    }
    server.server.notify("input.touch", hit.handle, { type: "up", id });
    touchRoutes.delete(id);
    return hit;
}

/** 客户端窗口获得焦点：切走同 client 的其它窗口，并收起输入法指针态 */
function focusClientWindow(info: WindowInfo) {
    viewData.focusWin(info.handle);
    ime?.pointerDown();
    for (const other of server.server.windows.list()) {
        if (other.clientId === info.clientId && other.handle !== info.handle) {
            server.server.notify("window.blur", other.handle);
        }
    }
}

/** 触摸拖拽结束时补上触摸点的 up，客户端不会停在按住状态 */
function endTouchRoute(id: number) {
    const hit = touchRoutes.get(id);
    if (!hit) return;
    touchRoutes.delete(id);
    server.server.notify("input.touch", hit.handle, { type: "up", id });
}

/** 取消某个触摸序列（设备移除、息屏等），`cancel` 语义由 server 落成 wl_touch.cancel */
function cancelTouchRoute(id: number) {
    const hit = touchRoutes.get(id);
    if (!hit) return;
    touchRoutes.delete(id);
    server.server.notify("input.touch", hit.handle, { type: "cancel" });
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
                if (p.pointerType === "touch") endTouchRoute(p.pointerId ?? 1);
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
            if (p.pointerType === "touch") endTouchRoute(p.pointerId ?? 1);
            server.server.notify("dnd.drop", activeDrag.token, target ?? null);
            activeDrag = undefined;
            clipboardStationTool?.setDragActive(false);
            pointerRoutes.delete(key);
            pointerTarget = undefined;
        }
        return undefined;
    }

    // 触摸屏：每个接触点走 wl_touch，不合成鼠标按键
    if (p.pointerType === "touch") return sendTouchPointerEvent(type, p);

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
    /** 原生 evdev 的滚轮序列结束；转发给 Wayland 客户端时作为 axis_stop */
    wheelEnd?: boolean;
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
            stop: p.wheelEnd,
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
        /** 触摸板单指移动的指针速度（libinput 速度设置，-1 ~ 1） */
        touchpadSpeed: 0,
        /** 触摸板单指移动的自适应加速（libinput 曲线） */
        touchpadAcceleration: true,
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

const defaultKeyboardSettings: VkbSettings = {
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

const keyboardSetting = MSetting.init({
    version: "0.0.1",
    nameSpace: "keyboard",
    defaultNsSetting: defaultKeyboardSettings,
});

const keyboardSettings: VkbSettingsAccess = {
    get(): VkbSettings {
        return {
            x: keyboardSetting.nget("x"),
            y: keyboardSetting.nget("y"),
            width: keyboardSetting.nget("width"),
            height: keyboardSetting.nget("height"),
            page: keyboardSetting.nget("page"),
            layout: keyboardSetting.nget("layout"),
            fullVariant: keyboardSetting.nget("fullVariant"),
            splitLayout: keyboardSetting.nget("splitLayout"),
            touchpadKeyboard: keyboardSetting.nget("touchpadKeyboard"),
            collapsed: keyboardSetting.nget("collapsed"),
            recentEmoji: keyboardSetting.nget("recentEmoji"),
            recentUnicode: keyboardSetting.nget("recentUnicode"),
        };
    },
    patch(patch: Partial<VkbSettings>) {
        for (const key of Object.keys(patch) as (keyof VkbSettings)[]) {
            keyboardSetting.nset(key, patch[key] as never);
        }
    },
};

const DEFAULT_WINDOW_RADIUS = 18;
function normalizeWindowRadius(value: unknown) {
    const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_WINDOW_RADIUS;
    return Math.min(24, Math.max(0, Math.round(n)));
}
let windowRadius = normalizeWindowRadius(desktopSetting.nget("windowRadius"));
document.documentElement.style.setProperty("--window-radius", `${windowRadius}px`);

// 输入回调里都会读到，缓存设置避免每次同步读配置文件
let touchpadScrollGain = desktopSetting.nget("touchpadScrollGain") ?? 1;
let touchpadAcceleration = desktopSetting.nget("touchpadAcceleration") ?? true;
let touchpadSpeed = normalizePointerSpeed(desktopSetting.nget("touchpadSpeed"));
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
        if (!el) return;
        // 窗口关闭要淡出，最后提交的内容先留着；外框移除时一起清掉
        if (el.closest("[data-client-frame]")) setTimeout(() => el.remove(), 400);
        else el.remove();
    },
    // 渲染层把 surface 尺寸写进画布的同一任务里同步外框；不用异步的 ResizeObserver
    onXdgSurfaceSize: (xdgId, width, height) => {
        const frame = clientFrameByRenderId.get(xdgId);
        if (!frame) return;
        frame.surfaceWidth = Math.max(1, width);
        frame.surfaceHeight = Math.max(1, height);
        // 外框尺寸统一以内部 surface DOM 为准；buffer 尺寸只作 fallback，未装饰窗口也不用 window.changed 覆盖
        if (!frame.fullscreen) applyFrameSurfaceSize(frame);
        // 子窗口（对话框）的尺寸由客户端决定，首次拿到真实尺寸后重新在父窗口正中摆一次
        placeChildWindow(frame.handle);
        // 启动面板等到首帧真实尺寸后再替换成窗口
        notifyLaunchWindowSized(frame);
    },
});
const server = MSysApi.server({ render });
// 剪贴板字节、历史、持久化都在桌面；server 只发事件、按需要数据
clipboard = initClipboard(server.server);
// 客户端开始拖拽 → 自动展开中转站弹窗，作为拖拽落点；结束时收起拖拽态
let dragIconToken: string | undefined;
server.server.on("dnd.started", (drag) => {
    activeDrag = drag;
    stationHoverAt = 0;
    stationWasHover = false;
    // 新会话先收起上一次可能残留的图标；本次的图标会随后通过 dnd.icon 到达
    if (dragIconToken !== drag.token) {
        dragIconToken = undefined;
        dragIcon.clear();
    }
    clipboardStationTool?.setDragActive(true);
    showClipboardTip?.({ state: "show", anchorEl: clipboardToolEl });
});
// 源客户端的拖拽图标：叠在光标下显示，不改变光标本身
server.server.on("dnd.icon", (token, icon) => {
    if (!icon) {
        if (dragIconToken === token) {
            dragIconToken = undefined;
            dragIcon.clear();
        }
        return;
    }
    dragIconToken = token;
    dragIcon.show(icon.canvas, icon.size, icon.offset, mousePos.x, mousePos.y);
});
server.server.on("dnd.finished", (token) => {
    if (dragIconToken === token) {
        dragIconToken = undefined;
        dragIcon.clear();
    }
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

/** 窗口关闭：先让外框透明度淡出，动画结束再回收虚拟屏并切换过去 */
function closeClientFrameWithFade(wid: WinHandle, frame: ClientWindowFrame) {
    // 关闭优先：停掉自动 resize，避免它继续写已经被搬到关闭层的盒子
    cancelFrameLayoutTransition(frame);

    const connected = frame.el.el.isConnected;
    if (connected) {
        // 先按当前视觉矩形把外框移到关闭层，不再依赖它属于哪个屏/面板；
        // 这样虚拟屏立即回收也不会带走正在淡出的窗口
        const rect = frame.el.el.getBoundingClientRect();
        const layoutWidth = Math.max(1, frame.el.el.offsetWidth);
        const layoutHeight = Math.max(1, frame.el.el.offsetHeight);
        const scale = Math.max(0.0001, rect.width / layoutWidth);
        ensureCloseLayer().add(frame.el);
        removeWindowSlot(frame.el.el);
        frame.el.style({
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${layoutWidth}px`,
            height: `${layoutHeight}px`,
            transformOrigin: "0 0",
            transform: Math.abs(scale - 1) > 0.001 ? `scale(${scale})` : "none",
            zIndex: "1",
            pointerEvents: "none",
        });
        frame.el.el.style.setProperty("--view-inv-scale", `${1 / scale}`);
        frame.el.el.setAttribute("data-closing", "");
    }
    // 屏立刻回收，窗口自己在关闭层上淡出
    viewData.closeWin(wid);

    const raw = frame.el.el.style.opacity;
    const from = raw === "" ? 1 : Number(raw);
    if (!connected || !(from > 0.01)) {
        removeWindowSlot(frame.el.el);
        frame.el.el.remove();
        return;
    }
    const gear = createAnimationGear({ opacity: from }, { transition: CLOSE_FADE });
    gear.setUpdateCallback(({ opacity }) => {
        frame.el.style({ opacity: `${opacity}`, pointerEvents: "none" });
    });
    gear.moveTo({ opacity: 0 }, CLOSE_FADE, () => {
        frame.el.el.remove();
    });
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

    const pending = parent === undefined ? claimPendingLaunch(info) : undefined;
    const screen = pending?.screen
        ? viewData.attachWindowToScreen(wid, pending.screen)
        : viewData.addWindowScreen(wid, parent);
    if (pending) pending.screen = screen;
    // biome-ignore lint/style/noNonNullAssertion: 刚刚创建的，一定有
    const winEl = render.getXdgSurfaceEle(info.renderId)!;
    const frame = pending?.frame ?? createClientWindowFrame(info, winEl);
    if (pending) {
        // 启动 frame 从第一帧就存在：只把 content/handle 填进去，元素和盒都不换
        attachWindowToLaunch(pending, info, winEl);
        addResizeHandles(frame.el.el, wid, true, winEl);
    } else {
        clientWindowFrames.set(wid, frame);
        if (info.rect.w > 0 && info.rect.h > 0) applyFrameSurfaceSize(frame);
        // 还没有客户端几何时先用默认尺寸占位，否则首帧之前会缩成 1×1，多个窗口全叠在正中
        else prepareWindowSizeFallback(frame, info);
        setClientFramePosition(frame, wino.l, wino.t);
        addWindow(screen, frame.el.el, wid, parent === undefined);
        addResizeHandles(frame.el.el, wid, true, winEl);
    }
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
    // 启动认领的窗口等启动收尾时再聚焦：创建时客户端还没初始化完，激活会被丢掉
    if (screen && !pending) viewData.focusWin(wid);
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
    if (frame) clientFrameByRenderId.delete(frame.renderId);
    if (frame) closeClientFrameWithFade(wid, frame);
    else viewData.closeWin(wid);
    notifyLaunchWindowClosed(wid);
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
    for (const [id, hit] of touchRoutes) {
        if (hit.handle === wid) touchRoutes.delete(id);
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
        const available = availableStageSize();
        const width = movingFrame.el.el.offsetWidth;
        const height = movingFrame.el.el.offsetHeight;
        const maxX = Math.max(available.x, available.x + available.width - width);
        const maxY = Math.max(available.y, available.y + available.height - height);
        const newLeft = Math.min(Math.max(available.x, Math.round(mousePos.x - startX + origLeft)), maxX);
        const newTop = Math.min(Math.max(available.y, Math.round(mousePos.y - startY + origTop)), maxY);
        if (!windowParents.has(wid)) {
            const screen = viewData.screenOf(wid);
            if (screen) {
                const moves = planDodges(screen, wid, { x: newLeft, y: newTop, w: width, h: height });
                if (!moves) return;
                applyDodges(moves);
            }
        }
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
            // 屏幕轴还在移动也要立刻开始隐藏工具栏；先置位，
            // 换屏过程里的 render 会先跑一次 sync，不能让它先播放显示动画
            fullscreenChromeEntering = true;
            fullscreenChromeSawOffset = false;
            // 先暂停居中，再换屏：换屏里的 render 会立刻开始全屏过渡
            pauseCenteringForFullscreen(info.handle);
            // 全屏总是换到新虚拟屏
            viewData.moveWindowToNewScreen(info.handle, true);
            // 最大化与全屏互斥；进入全屏时把本地最大化快照一起收敛，避免走恢复分支
            applied.maximized = info.states.maximized;
            syncFullscreenChrome();
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
            } else if (frame.surfaceWidth <= 1 || frame.surfaceHeight <= 1) {
                // 还没拿到内部 surface 尺寸时先用客户端几何占位；之后以实际 DOM 为准
                frame.surfaceWidth = Math.max(1, Math.round(info.rect.w * info.scale));
                frame.surfaceHeight = Math.max(1, Math.round(info.rect.h * info.scale));
                applyFrameSurfaceSize(frame, frame.surfaceWidth, frame.surfaceHeight);
            } else {
                // 几何变化可能只改 set_window_geometry，不触发 buffer 尺寸回调；直接从内部 DOM 再同步一次
                applyFrameSurfaceSize(frame);
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
            // 最大化按最底层算，被上层盖住才换屏
            viewData.sendWinToBottom(info.handle);
            if (maximizeCoveredByOthers(info.handle)) viewData.moveWindowToNewScreen(info.handle);
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
        // 默认文本不可选择；需要复制的内容单独写 userSelect: "text"
        userSelect: "none",
    })
    .addInto();

const defaultWallpaperSrc = fs.readFileAsDataURLSync("/assets/wallpaper/1.svg");
const wallpaper = createWallpaperStore({
    defaultSrc: defaultWallpaperSrc,
    getStoredPath: (slot) => setting.get(slot === "desktop" ? "wallpaper.desktop" : "wallpaper.lock") || undefined,
    setStoredPath: (slot, path) => setting.set(slot === "desktop" ? "wallpaper.desktop" : "wallpaper.lock", path),
    readImage: (path) => MSysApi.nativefs.readImage(path),
});
const bg = wallpaper.bind("desktop", image(defaultWallpaperSrc, "wallpaper")).style({
    width: "100%",
    height: "100%",
    objectFit: "cover",
    objectPosition: "center",
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
    .data({ "desktop-ui": "tools" })
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

const lockScreen = view()
    .class(
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
    )
    .data({ "lock-screen": "1" });

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

const lockScreenAnimate = createAnimationGear({
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
    vkb?.setSuspended(false);
    // 解锁后把键盘焦点还给当前屏；仍在总览/搜索里时不抢
    viewData?.restoreWaylandFocus();
});
state.on("lock", () => {
    stateLock.setState("lock");
    void ime?.blur();
    vkb?.setSuspended(true);
    // 锁屏接管键盘：客户端全部失焦，core 在 leave 前补 release
    viewData?.beginOverlayKeyboard();
});
state.setState("normal");

/** 锁屏密码输入框在下方创建；切换时钟/密码界面时由这里同步焦点和内容 */
let focusLockPassword: (() => void) | undefined;
let clearLockPassword: (() => void) | undefined;
/** 测试读取密码输入；正常桌面不暴露 */
let lockPasswordValue: (() => string) | undefined;

/** 桌面其它区域的焦点（搜索框、内部窗口）不能留在锁屏下面 */
function blurDesktopDomFocus() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

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
    blurDesktopDomFocus();
    clearLockPassword?.();
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
    focusLockPassword?.();
    passwd2lock.start();
    leave(() => {
        passwd2lock.reset();
    });
});
stateLock.on("out", () => {
    blurDesktopDomFocus();
    clearLockPassword?.();
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

/** 桌面内虚拟键盘层：在窗口和工具栏之上、候选窗/锁屏之下 */
const vkbLayer = view().style({
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: "15",
});

/** polkit 认证对话框；装好监听后才会通知 session helper 注册 agent */
const polkitDialog = MSysApi.polkit ? createPolkitDialog(MSysApi.polkit) : undefined;

mainEl.add([
    bg,
    windowElWarp,
    toolsEl,
    vkbLayer,
    imeOverlay,
    ...(polkitDialog ? [polkitDialog.el] : []),
    lockScreen,
    cursorEl,
    screenOffLayer,
]);

const windowEl = view()
    .style({
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        overflow: "hidden",
        // 让窗口层成为独立层叠上下文，聚焦面板的负 z-index 只落到卡片下面
        isolation: "isolate",
    })
    .addInto(windowElWarp);

viewData = new ViewData();

/** 切屏用的滚轮信息；统一输入事件（evdev）和带语义的 DOM WheelEvent 都能直接传入 */
type ScreenWheelEvent = WheelEventSemantics & {
    deltaX?: number;
    deltaY?: number;
};
/** 窗口模式没有设备信息，沿用 100px 一屏累计 */
const SCREEN_WHEEL_STEP = WHEEL_STEP;
/** 没有 wheelStart/wheelEnd 的来源（窗口模式），间隔这么久视为新序列 */
const SCREEN_WHEEL_GAP = 200;
let screenWheelAccum = 0;
let screenWheelAxis: "x" | "y" | undefined;
/** 触摸板本轮序列还剩多少起点死区，与三指手势一致 */
let screenWheelDeadzone = 0;
let screenWheelAt = 0;

function resetScreenWheel() {
    screenWheelAccum = 0;
    screenWheelAxis = undefined;
    screenWheelDeadzone = 0;
}

function isTouchpadWheel(e: ScreenWheelEvent) {
    return e.wheelDevice === "touchpad" || (e.wheelSource !== undefined && e.wheelSource !== "wheel");
}

/**
 * 滚轮切屏/移动预览焦点，等同 Super+←/→。
 * 鼠标一个 wheel 事件切一屏；触摸板按三指手势的换算累计位移，
 * 一屏 = `stageWidth / (2 * switchGestureGain)`，并扣掉同样的起点死区。
 */
function handleScreenWheel(e: ScreenWheelEvent) {
    if (state.getState() !== "normal") return false;
    if (e.wheelEnd) {
        resetScreenWheel();
        return false;
    }
    const now = performance.now();
    if (e.wheelStart === true || now - screenWheelAt > SCREEN_WHEEL_GAP) {
        resetScreenWheel();
        if (isTouchpadWheel(e)) screenWheelDeadzone = GESTURE_AXIS_DEADZONE;
    }
    screenWheelAt = now;

    const dx = e.deltaX ?? 0;
    const dy = e.deltaY ?? 0;
    if (dx === 0 && dy === 0) return false;
    screenWheelAxis ??= Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
    const delta = screenWheelAxis === "x" ? dx : dy;
    if (delta === 0) return false;

    const touchpad = isTouchpadWheel(e);
    // 鼠标一个事件切一屏，不累计距离
    if (!touchpad && (e.wheelDevice === "mouse" || e.wheelSource === "wheel")) {
        screenWheelAccum = 0;
        viewData.moveOverviewFocus(delta > 0 ? 1 : -1);
        return true;
    }

    let amount: number;
    if (touchpad) {
        // 与三指手势一致：先扣起点死区，再按手势的切屏距离换算
        const abs = Math.abs(delta);
        const skip = Math.min(screenWheelDeadzone, abs);
        screenWheelDeadzone -= skip;
        amount = (Math.sign(delta) * (abs - skip)) / viewData.screenSwitchDistance;
    } else {
        amount = delta / SCREEN_WHEEL_STEP;
    }
    if (amount === 0) return false;
    // 反向滚动立即换向，不把上一方向没走完的零头算进来
    if (screenWheelAccum !== 0 && Math.sign(amount) !== Math.sign(screenWheelAccum)) screenWheelAccum = 0;
    screenWheelAccum += amount;
    // 高精度滚轮是 1/120 累加，浮点误差会让刚好一格差一点点
    const steps = Math.trunc(screenWheelAccum + (screenWheelAccum >= 0 ? 1e-6 : -1e-6));
    if (steps === 0) return false;
    screenWheelAccum -= steps;
    if (Math.abs(screenWheelAccum) < 1e-6) screenWheelAccum = 0;
    viewData.moveOverviewFocus(steps);
    return true;
}

// 一屏多窗口时不再自动居中，否则 ResizeObserver 会把它们叠到一起
windowCenterManager.setShouldCenter((id) => (viewData.screenOf(id)?.winIds.length ?? 0) <= 1);
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
        vkb?.relayout();
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
/** 虚拟键盘输出：DOM 输入框走 inputSim，Wayland 客户端走输入法/文本通道 */
function vkbDomEditable(): HTMLElement | undefined {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return undefined;
    if (active.closest("[data-virtual-keyboard]")) return undefined;
    const editable =
        active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable;
    if (!editable) return undefined;
    if (active instanceof HTMLInputElement) {
        const type = active.type;
        if (type === "checkbox" || type === "radio" || type === "button" || type === "submit") return undefined;
        if (type === "range" || type === "color" || type === "file") return undefined;
    }
    // 焦点在 Wayland 窗口时，不要把按键送进残留焦点的内部页面输入框
    if (viewData.getWaylandFocus() !== undefined && !isLauncherInputFocused()) {
        const internal = viewData.focusHandle !== undefined && isInternalWindow(viewData.focusHandle);
        if (!internal) return undefined;
    }
    return active;
}

function vkbInsertDomText(target: HTMLElement, text: string) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        try {
            const start = target.selectionStart ?? target.value.length;
            const end = target.selectionEnd ?? target.value.length;
            target.setRangeText(text, start, end, "end");
            target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        } catch {
            // 部分 input 类型（number 等）不支持光标操作
        }
        return;
    }
    if (target.isContentEditable) {
        target.focus();
        document.execCommand("insertText", false, text);
    }
}

function vkbSendDomKey(target: HTMLElement, press: VkbKeyPress) {
    const modifiers: [string, string][] = [];
    if (press.ctrl) modifiers.push(["ControlLeft", "Control"]);
    if (press.alt) modifiers.push(["AltLeft", "Alt"]);
    if (press.meta) modifiers.push(["MetaLeft", "Meta"]);
    if (press.shift) modifiers.push(["ShiftLeft", "Shift"]);
    const emit = (type: "down" | "up", code: string, key: string) => {
        inputSim.emit({
            kind: "key",
            type,
            code: MInputMap.mapKeyCode(code),
            webCode: code,
            key,
            source: "evdev",
            target,
        });
    };
    for (const [code, key] of modifiers) emit("down", code, key);
    emit("down", press.code, press.key);
    emit("up", press.code, press.key);
    for (const [code, key] of [...modifiers].reverse()) emit("up", code, key);
    // 单行 input 的 Enter 交给页面自己处理；textarea 需要补换行
    if (press.code === "Enter" && target instanceof HTMLTextAreaElement) {
        vkbInsertDomText(target, "\n");
    }
}

/** 把按键送给聚焦的 Wayland 客户端；输入法可用时先经过输入法 */
function vkbSendImeKey(press: VkbKeyPress) {
    const handle = viewData.getWaylandFocus();
    if (handle === undefined) return;
    const mods = {
        shiftKey: press.shift,
        ctrlKey: press.ctrl,
        altKey: press.alt,
        metaKey: press.meta,
    };
    const send = (type: "down" | "up", code: string, key: string, extra?: KeyboardEventInit) => {
        const event = new KeyboardEvent(type === "down" ? "keydown" : "keyup", {
            code,
            key,
            bubbles: true,
            cancelable: true,
            ...mods,
            ...extra,
        });
        const handled = type === "down" ? ime?.handleKeyDown(event) : ime?.handleKeyUp(event);
        if (!handled) {
            server.server.notify(
                "input.key",
                handle,
                MInputMap.mapKeyCode(code),
                type === "down" ? "pressed" : "released",
            );
        }
    };
    const modifiers: [string, string, KeyboardEventInit][] = [];
    if (press.ctrl) modifiers.push(["ControlLeft", "Control", { ctrlKey: true }]);
    if (press.alt) modifiers.push(["AltLeft", "Alt", { altKey: true }]);
    if (press.meta) modifiers.push(["MetaLeft", "Meta", { metaKey: true }]);
    if (press.shift) modifiers.push(["ShiftLeft", "Shift", { shiftKey: true }]);
    for (const [code, key, extra] of modifiers) send("down", code, key, extra);
    send("down", press.code, press.key);
    send("up", press.code, press.key);
    for (const [code, key, extra] of [...modifiers].reverse()) send("up", code, key, extra);
}

/**
 * 直接插入文字（emoji / unicode）。
 * 客户端支持 text-input 时走 `input.text`；否则只有 ASCII 能退回按键。
 */
function vkbInsertText(text: string) {
    const dom = vkbDomEditable();
    if (dom) {
        vkbInsertDomText(dom, text);
        return;
    }
    const handle = viewData.getWaylandFocus();
    if (handle === undefined) return;
    void (async () => {
        try {
            await ime?.commitComposition();
        } catch {
            // 提交失败不影响后面的插入
        }
        let textInputEnabled = false;
        try {
            const state = await server.server.request("textInput.get", handle);
            textInputEnabled = state.enabled;
        } catch {
            textInputEnabled = false;
        }
        if (viewData.getWaylandFocus() !== handle) return;
        if (textInputEnabled) {
            server.server.notify("input.text", handle, text, false);
            return;
        }
        for (const press of asciiPresses(text)) vkbSendImeKey(press);
    })();
}

/** 可打印 ASCII 的按键序列；无法映射的字符跳过 */
function asciiPresses(text: string): VkbKeyPress[] {
    const out: VkbKeyPress[] = [];
    const push = (code: string, key: string, shift: boolean) =>
        out.push({ code, key, shift, ctrl: false, alt: false, meta: false });
    for (const ch of text) {
        if (ch === "\n") {
            push("Enter", "Enter", false);
            continue;
        }
        if (ch === " ") {
            push("Space", " ", false);
            continue;
        }
        if (/^[a-z]$/.test(ch)) {
            push(`Key${ch.toUpperCase()}`, ch, false);
        } else if (/^[A-Z]$/.test(ch)) {
            push(`Key${ch}`, ch, true);
        } else if (/^[0-9]$/.test(ch)) {
            push(`Digit${ch}`, ch, false);
        } else {
            const symbolMap: Record<string, [string, string, boolean]> = {
                ")": ["Digit0", ")", true],
                "!": ["Digit1", "!", true],
                "@": ["Digit2", "@", true],
                "#": ["Digit3", "#", true],
                $: ["Digit4", "$", true],
                "%": ["Digit5", "%", true],
                "^": ["Digit6", "^", true],
                "&": ["Digit7", "&", true],
                "*": ["Digit8", "*", true],
                "(": ["Digit9", "(", true],
                "-": ["Minus", "-", false],
                _: ["Minus", "_", true],
                "=": ["Equal", "=", false],
                "+": ["Equal", "+", true],
                "[": ["BracketLeft", "[", false],
                "{": ["BracketLeft", "{", true],
                "]": ["BracketRight", "]", false],
                "}": ["BracketRight", "}", true],
                "\\": ["Backslash", "\\", false],
                "|": ["Backslash", "|", true],
                ";": ["Semicolon", ";", false],
                ":": ["Semicolon", ":", true],
                "'": ["Quote", "'", false],
                '"': ["Quote", '"', true],
                ",": ["Comma", ",", false],
                "<": ["Comma", "<", true],
                ".": ["Period", ".", false],
                ">": ["Period", ">", true],
                "/": ["Slash", "/", false],
                "?": ["Slash", "?", true],
                "`": ["Backquote", "`", false],
                "~": ["Backquote", "~", true],
            };
            if (symbolMap[ch]) push(...symbolMap[ch]);
        }
    }
    return out;
}

const vkbDispatcher: VkbDispatcher = {
    key: (press) => {
        const dom = vkbDomEditable();
        if (dom) vkbSendDomKey(dom, press);
        else vkbSendImeKey(press);
    },
    text: (text) => vkbInsertText(text),
};

const vkbIme: VkbImeAccess = {
    onStatus(cb) {
        if (!ime) {
            cb({ available: false, label: "—", currentUniqueName: "", entries: [] });
            return () => {};
        }
        return ime.onStatus((status) => {
            const entries = (status.group?.inputMethods ?? [])
                .map((entry) => ({
                    uniqueName: entry.uniqueName,
                    name: entry.name,
                    label: entry.label ?? "",
                    off: entry.uniqueName === "keyboard-us",
                }))
                .sort((a, b) => Number(!!b.off) - Number(!!a.off));
            cb({
                available: status.available,
                label: status.label,
                currentUniqueName: status.current?.uniqueName ?? "",
                entries,
                error: status.error,
            });
        });
    },
    select: (uniqueName) => {
        void ime?.setCurrentIM(uniqueName);
    },
    sync: () => {
        void ime?.sync();
    },
    onCompose: (cb) => ime?.onCompose(cb) ?? (() => {}),
    selectCandidate: (index) => {
        void ime?.selectCandidate(index);
    },
    pageCandidates: (next) => {
        void ime?.pageCandidates(next);
    },
    setCandidatesInKeyboard: (on) => ime?.setCandidatesInKeyboard(on),
};

function createVirtualKeyboard() {
    keyboardTouchpad = new TouchpadMode({
        dispatch: (event) => dispatchInput(event),
        isKeyboardUiAt: (x, y) => vkb?.isKeyboardUiAt(x, y) ?? false,
        getPointer: () => mousePos,
        getScrollConfig: () => ({ naturalScroll, scrollGain: touchpadScrollGain }),
        startDesktopGesture: () => viewData.startGesture(),
        moveDesktopGesture: (dx, dy) => viewData.moveGesture(dx, dy),
        endDesktopGesture: () => viewData.endGesture(),
        gesture: (event, x, y) => sendGestureEvent(event, x, y),
        notifyGesture: (handle, event) => notifyGesture(handle, event),
    });

    vkb = createFullKeyboard({
        layer: vkbLayer.el,
        dispatcher: vkbDispatcher,
        settings: keyboardSettings,
        uiScale,
        ime: vkbIme,
        onOpenChange: (open) => {
            if (!open) keyboardTouchpad?.setActive(false);
            updateVirtualKeyboardTool();
        },
        onTouchpadActiveChange: (active) => keyboardTouchpad?.setActive(active),
        onTouchpadClick: (button) => keyboardTouchpad?.clickButton(button),
        onTouchpadScroll: (deltaY) => keyboardTouchpad?.scrollBy(deltaY),
    });
}

/** 第一次点工具栏按钮时再创建键盘 DOM，避免未使用键盘的桌面承担表情网格等开销 */
function ensureVirtualKeyboard(): FullKeyboardHandle {
    if (!vkb) createVirtualKeyboard();
    // createVirtualKeyboard 会同步赋值 vkb
    return vkb as FullKeyboardHandle;
}

void ime.init();

const initRect = windowEl.el.getBoundingClientRect();
windowCenterManager.setViewport(0, 0, initRect.width, initRect.height);
viewData.setStageSize(initRect.width, initRect.height);

async function confirm(text: string) {
    const p = Promise.withResolvers<boolean>();
    const el = view().style({
        ...gGlassStyle.bg,
        borderRadius: px(gRadius.container),
        padding: px(sSize2.padding + 6),
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
    const gear = createAnimationGear({ v: 0 }, { transition: { duration: 200, map: timingFunction.easeOut } });
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

/** myde-dbus 的 PropertiesChanged 值仍是变体内容数组（如 [false]），兼容直接给标量的实现 */
function changedBool(value: unknown) {
    return (Array.isArray(value) ? value[0] : value) === true;
}

/**
 * 跟踪一组带 connected 状态的设备，只为状态翻转发通知。
 * 列表第一次到达时只记录当前状态，避免启动时把已有设备当成新连接。
 */
function watchConnectedItems<K extends string, V extends { connected: boolean }>(op: {
    list: BindingSource<K[]>;
    item: (key: K) => BindingSource<V>;
    label: (value: V) => string;
    /** 列表里出现了一个尚未连接的新设备；Wi-Fi 扫描会不断发现新 AP，不使用 */
    onAdded?: (label: string) => void;
    onConnect: (label: string) => void;
    onDisconnect: (label: string) => void;
}) {
    const states = new Map<string, { label: string; connected: boolean }>();
    const unsubs = new Map<string, () => void>();
    const pendingAdded = new Set<string>();
    const pendingConnect = new Set<string>();
    const pendingDisconnect = new Set<string>();
    let flushTimer: number | undefined;
    let seeded = false;
    /** 设备切换网络时成对出现断开/连接，延后一点合并，最终留下连接提示 */
    const scheduleFlush = () => {
        if (flushTimer !== undefined) return;
        flushTimer = window.setTimeout(() => {
            flushTimer = undefined;
            for (const label of pendingDisconnect) op.onDisconnect(label);
            for (const label of pendingAdded) op.onAdded?.(label);
            for (const label of pendingConnect) op.onConnect(label);
            pendingDisconnect.clear();
            pendingAdded.clear();
            pendingConnect.clear();
        }, 80);
    };
    const addDisconnect = (label: string) => {
        pendingDisconnect.add(label);
        pendingConnect.delete(label);
        pendingAdded.delete(label);
        scheduleFlush();
    };
    const listUnsub = op.list.getAndSubscribe((ids) => {
        const keep = new Set<string>(ids);
        for (const [key, state] of [...states]) {
            if (keep.has(key)) continue;
            unsubs.get(key)?.();
            unsubs.delete(key);
            states.delete(key);
            if (seeded && state.connected) addDisconnect(state.label);
        }
        for (const key of ids) {
            if (unsubs.has(key)) continue;
            const suppressFirst = !seeded;
            let firstValue = true;
            const unsub = op.item(key).getAndSubscribe((value) => {
                const isFirstValue = firstValue;
                firstValue = false;
                const prev = states.get(key);
                const label = op.label(value);
                states.set(key, { label, connected: value.connected });
                if (isFirstValue && suppressFirst) return;
                if (!prev?.connected && value.connected) {
                    pendingConnect.add(label);
                    pendingDisconnect.delete(label);
                    pendingAdded.delete(label);
                    scheduleFlush();
                } else if (prev?.connected && !value.connected) {
                    addDisconnect(label);
                } else if (isFirstValue && !prev) {
                    pendingAdded.add(label);
                    pendingDisconnect.delete(label);
                    scheduleFlush();
                }
            });
            unsubs.set(key, unsub);
        }
        seeded = true;
    });
    return () => {
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        listUnsub();
        for (const unsubscribe of unsubs.values()) unsubscribe();
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

/** 上一次写入的时间值；秒级刷新时只在值变化时通知订阅者 */
const lastTimeValues = new Map<string, unknown>();
function setTimeValue<K extends keyof RegistrySchema & string>(key: K, value: RegistrySchema[K]) {
    if (lastTimeValues.get(key) === value) return;
    lastTimeValues.set(key, value);
    rawRegistry.setData(key, value);
}

function updateTime(now = new Date()) {
    setTimeValue("time.second", now.getSeconds());
    setTimeValue("time.minute", now.getMinutes());
    setTimeValue("time.hour", now.getHours());
    setTimeValue("time.day", now.getDate());
    setTimeValue("time.month", now.getMonth() + 1);
    setTimeValue("time.weekday", now.getDay());
    setTimeValue("time.year", now.getFullYear());
}

/** 对齐到整秒刷新：秒数跳变不会因为 setInterval 漂移而偶尔重复或跳过 */
function scheduleTimeUpdate() {
    const now = new Date();
    updateTime(now);
    setTimeout(scheduleTimeUpdate, 1000 - now.getMilliseconds());
}
scheduleTimeUpdate();

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

        /** 已保存的 SSID；读不到时返回 null，列表就不按记忆过滤 */
        let savedSsids: Set<string> | null = null;
        let savedSsidsAt = 0;
        const getSavedSsids = async (wifiDevice: wifiDevice) => {
            if (savedSsids && Date.now() - savedSsidsAt < 5000) return savedSsids;
            try {
                savedSsids = new Set((await wifiDevice.getSavedConnections()).map((conn) => conn.ssid));
                savedSsidsAt = Date.now();
            } catch (error) {
                console.warn("wifi: read saved connections failed", error);
            }
            return savedSsids;
        };

        const updateAccessPoints = async () => {
            const wifiDevice = network.getWifiDevices()[0];
            if (!wifiDevice) {
                registry.setData("wifi.accessPoints", []);
                return;
            }

            const [aps, active, saved] = await Promise.all([
                wifiDevice.getAccessPoints(),
                network.getActiveWifiConnection(),
                getSavedSsids(wifiDevice),
            ]);
            const connectedSsid = active?.id;
            const ids: string[] = [];
            const seen = new Set<string>();

            for (const ap of aps) {
                const ssid = await ap.getSsid();
                if (!ssid || seen.has(ssid)) continue;
                // 只列能直接连上的已保存网络，不做密码输入
                if (saved && !saved.has(ssid)) continue;
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
                registry.setData("wifi.enabled", changedBool(changed.WirelessEnabled));
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
                address,
                name: await device.getName(),
                connected: await device.isConnected(),
            });
        };

        const updateDevices = async () => {
            const connected: string[] = [];
            const other: string[] = [];
            for (const device of blue.getDevices()) {
                await updateDevice(device);
                // 列表只放已配对（bonded）的设备，和点击时能直接连接的保持一致
                if (!(await device.isPaired()) && !(await device.isBonded())) continue;
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
                registry.setData("blue.power", changedBool(changed.Powered));
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

type NotificationEntry = NotificationData & { closed: boolean; reason: number; time: number };
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
                time: entry.time,
            });
        };

        const removeNotification = (id: string | number) => {
            const key = String(id);
            if (!notifications.delete(key)) return;
            setList();
        };

        notification.on("new", (n) => {
            const key = String(n.id);
            const entry: NotificationEntry = { ...n, closed: false, reason: 0, time: Date.now() };
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

        registry.setData("media.list", Array.from(mediaControl.keys()) as id<"media.list[]">[]);

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
            registry.setData(registry.buildVarId("media.list[].play", [serverName]), !paused);
            p.onStatusChange(async () => {
                const paused = await p.paused();
                mediaPlaying.set(serverName, !paused);
                registry.setData(registry.buildVarId("media.list[].play", [serverName]), !paused);
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
    "brightness.displays": () => {
        const source = rawRegistry.get("brightness.displays");
        const grid = uBrightnessList();
        const sliders = new Map<string, { el: ElType<HTMLElement>; unsubscribe: () => void }>();

        const unsub = source.getAndSubscribe((ids) => {
            const keep = new Set(ids.map((key) => key as string));
            for (const [key, slider] of [...sliders]) {
                if (keep.has(key)) continue;
                slider.unsubscribe();
                sliders.delete(key);
            }

            for (const key of ids) {
                const mapKey = key as string;
                if (sliders.has(mapKey)) continue;

                const brightnessKey = rawRegistry.buildVarId("brightness.displays[].brightness", [key]);
                const brightnessSource = rawRegistry.get(brightnessKey);
                const setBrightness = MUtils.throttle((v: number) => {
                    brightnessSource.set?.(v * 100)?.catch((error) => {
                        console.warn("[brightness] 设置亮度失败", key, error);
                    });
                }, 50);
                const slider = uBrightnessSlider({
                    onChange: setBrightness,
                    onEnd: () => setBrightness.flush(),
                });

                const itemKey = rawRegistry.buildVarId("brightness.displays[]", [key]);
                const unsubItem = rawRegistry.get(itemKey).getAndSubscribe((v) => {
                    slider.el.style({
                        opacity: v.writable ? "1" : "0.5",
                        pointerEvents: v.writable ? "auto" : "none",
                    });
                });
                const unsubBrightness = brightnessSource.getAndSubscribe((v) => {
                    slider.sv(v / 100);
                });
                sliders.set(mapKey, {
                    el: slider.el,
                    unsubscribe: () => {
                        unsubItem();
                        unsubBrightness();
                    },
                });
            }

            grid.setSliders(ids.map((key) => ({ key: key as string, el: sliders.get(key as string)?.el ?? view() })));
        });
        return {
            id: "brightness.displays",
            type: "dynamic-list",
            el: grid.el,
            unmount: () => {
                unsub();
                for (const slider of sliders.values()) slider.unsubscribe();
                sliders.clear();
            },
        };
    },
};

tools.registerTool("blank", () => {
    return view().style({ flexGrow: 1 });
});
tools.registerTool("showAllView", () => {
    const showAllViewBtn = button(getIconXEl("mutiWinView", { size: 20, width: 24, height: 24 }))
        .data({ tool: "overview" })
        .on("click", () => {
            viewData.toggleOverview();
        });
    return showAllViewBtn;
});
tools.registerTool("search", () => {
    const searchBtn = button(getIconXEl("search", { size: 20, width: 24, height: 24 }))
        .data({ tool: "search" })
        .on("click", () => {
            if (launcher.isVisible()) launcher.close();
            else launcher.open();
        });
    return searchBtn;
});
tools.registerTool("launchpad", () => {
    const launchpadBtn = button(getIconXEl("launcher", { size: 20, width: 24, height: 24 }))
        .data({ tool: "launchpad" })
        .on("click", () => {
            const screen = viewData.launchpadScreen;
            if (screen) viewData.switchScreen(screen.id);
        });
    return launchpadBtn;
});

type DesktopApp = Awaited<ReturnType<typeof MSysApi.getDesktopEntries>>[number];

/** 应用名/本地名的拉丁候选，按应用缓存；应用列表本身由 sys_api 缓存 */
const searchAppVariants = new WeakMap<DesktopApp, string[]>();
/** 搜索栏里的内置设置入口，和应用一起参与匹配 */
const searchSettingsVariants = latinVariants("设置", "settings");
/** 设置入口复用启动台同款图标：X 图标转成 img 可用的 data URL */
const searchSettingsIcon = (() => {
    const svg = getIconX("settings");
    return svg ? `data:image/svg+xml,${encodeURIComponent(svg)}` : undefined;
})();
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
            const app = await desktopApp(appid);
            if (!app?.icon) return undefined;
            return (await MSysApi.getDesktopIcon(app.icon, { theme: setting.get("icon.theme") })) || undefined;
        } catch {
            return undefined;
        }
    };
}

type ScoredSearchResult = { score: number; result: SearchResult };

/** 搜索行执行前先记下图标矩形：closeSearch 会同步清空结果 DOM */
let pendingSearchLaunchSource: { rect?: LaunchRect; iconSrc?: string } | undefined;

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
            const apps = await desktopApps().catch(() => [] as DesktopApp[]);
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
                        run: () => {
                            const source = pendingSearchLaunchSource;
                            launchApp({
                                exec: app.exec,
                                env: app.env,
                                name: app.nameLocal || app.name,
                                appid: app.desktopFile,
                                icon: searchIcon(app.icon),
                                sourceRect: source?.rect,
                                iconSrc: source?.iconSrc,
                            });
                        },
                    },
                });
            }
            const settingsScore = scoreLatin(query, searchSettingsVariants);
            if (settingsScore !== -Infinity) {
                scored.push({
                    score: settingsScore,
                    result: {
                        id: "app:settings",
                        score: settingsScore,
                        title: "设置",
                        badge: "应用",
                        icon: async () => searchSettingsIcon,
                        run: () => openSettingsWindow(),
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

/** 内置处理器：空桌面和启动台；普通虚拟屏由窗口处理器覆盖，不再单列 */
function createScreenSearchProvider(): SearchProvider {
    return {
        id: "screens",
        order: 30,
        limit: 2,
        search(query) {
            const scored: ScoredSearchResult[] = [];
            for (const screen of viewData.listScreens()) {
                if (screen.current || screen.kind === "window") continue;
                const aliases =
                    screen.kind === "launchpad"
                        ? latinVariants("launchpad", "app launcher")
                        : latinVariants("empty desktop");
                const score = scoreLatin(query, [...latinVariants(screen.title), ...aliases]);
                if (score === -Infinity) continue;
                scored.push({
                    score,
                    result: {
                        id: `screen:${screen.id}`,
                        score,
                        title: screen.title,
                        badge: screen.kind === "launchpad" ? "启动台" : "空桌面",
                        icon: searchIconByAppid(screen.appid),
                        run: () => viewData.switchScreen(screen.id),
                    },
                });
            }
            return finishSearch(scored, 2);
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
    /** 格子文字额外样式；启动台放在壁纸上时用白色 + 淡阴影 */
    labelStyle?: Parameters<ReturnType<typeof view>["style"]>[0];
    /** 设置格子的白底容器尺寸，图标按容器减内边距 */
    settingsIconBox: number;
    onSettingsClick: () => void;
    /** 应用启动后收起所在弹窗（开始菜单） */
    onAppLaunch?: () => void;
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
        const iconPath = async () => (await MSysApi.getDesktopIcon(app.icon, op.iconConfig)) || "";
        const iconView = view().addInto(appEl);
        const iconEl = appIconEl(app.exec, app.env, {
            name: app.nameLocal || app.name,
            appid: app.desktopFile,
            icon: iconPath,
            onLaunch: op.onAppLaunch,
        }).style({
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
                ...op.labelStyle,
            }),
        );

        const load = () => loadAppIcon(iconEl, iconPath, app.name, { rasterSize: op.iconSize });
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
                ...op.labelStyle,
            }),
        );
        appEl.on("click", () => op.onSettingsClick());
        return appEl;
    }

    return { createAppTile, createSettingsTile };
}

/** 顶部搜索栏：默认藏在工作区上方，可跟手下拉/上推；结果由 SearchEngine 异步汇总 */
function createLauncher(): LauncherController {
    let stageHeight = Math.max(1, windowEl.el.getBoundingClientRect().height || window.innerHeight);
    /** 桌面 UI 缩放；stageHeight/topInset 是视觉 px，位置计算改用局部 px */
    let scale = uiScale;
    /** 舞台铺满视口，顶部工具栏仍覆盖在上面 */
    let topInset = 0;
    const localStageHeight = () => stageHeight / scale;
    const localTopInset = () => topInset / scale;
    const hiddenTop = -LAUNCHER_SHELL_HEIGHT - 12;
    const normalTop = () => localStageHeight() / 3 - LAUNCHER_SHELL_HEIGHT / 2;
    const topTop = () => OVERVIEW_LAUNCHER_TOP + localTopInset();
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

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
            // 搜索栏在卡片和聚焦面板之上
            zIndex: "4",
            zoom: "var(--desktop-ui-scale, 1)",
        })
        .addInto(windowElWarp);
    // L1 外壳：唯一负责 padding / gap 和毛玻璃的层
    const shell = view("y")
        .style({
            position: "absolute",
            top: `${hiddenTop}px`,
            left: "50%",
            width: "min(560px, calc(80vw / var(--desktop-ui-scale, 1)))",
            padding: px(sSize2.padding),
            boxSizing: "border-box",
            alignItems: "stretch",
            gap: px(sSize2.padding),
            overflow: "hidden",
            borderRadius: px(gRadius.container),
            ...gSurfaceStyle.backdrop,
            opacity: "0",
            transform: "translateX(-50%)",
            visibility: "hidden",
            pointerEvents: "none",
            willChange: "top, opacity, filter",
        })
        .data({ "desktop-ui": "launcher", "launcher-input": "" })
        .addInto(layer);

    // L2 输入面板：L1 只直接放 L2，输入框本身不带层间距
    const inputPanel = ui.barItem().style({
        display: "flex",
        height: px(LAUNCHER_HEIGHT),
        padding: "0 12px",
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
            ...gTextStyle.title,
            fontWeight: gTextStyle.weight.regular,
            color: gTextStyle.color.primary,
        })
        .attr({ placeholder: "搜索应用或窗口" });
    inputPanel.add(field);

    // L2 结果面板：要么隐藏，要么固定 7 × 48；空提示由 uScrollList 居中显示
    const resultsPanel = ui.barItem().style({
        display: "none",
        flexShrink: "0",
    });
    /** 列表当前顶部（单位：条），用于键盘选中时只滚最短距离 */
    let resultListTop = 0;
    const resultList = uScrollList<string>({
        itemSize: SEARCH_RESULT_ITEM_HEIGHT,
        containerSize: SEARCH_RESULT_PANEL_HEIGHT,
        direction: "down",
        crossSize: "100%",
        // 搜索结果不做逐项进出 / 位移动画，避免按键搜索时列表还在补间
        animationDuration: 0,
        // key 带渲染批次：同长度的新搜索结果不会复用旧行
        keyExtractor: (key) => key,
        renderItem: (key) => {
            const entry = resultByKey.get(key);
            if (!entry) return view();
            return createResultEl(entry.result, key);
        },
        onScroll: (index, progress) => {
            resultListTop = index + progress;
        },
        empty: "未找到匹配项",
    });
    resultsPanel.add(resultList.el);
    shell.add([inputPanel, resultsPanel]);
    shell.on("click", () => field.el.focus());

    /** 由 ViewData 的纵轴驱动；这里只负责把 (level, route) 映射成搜索栏位置 */
    let level = 0;
    let route: LauncherRoute = "line";
    let currentOpacity = 0;
    let wasFullyVisible = false;
    const blurInput = () => {
        if (document.activeElement instanceof HTMLElement && document.activeElement.closest("[data-launcher-input]")) {
            document.activeElement.blur();
        }
    };
    const apply = () => {
        const top =
            route === "line"
                ? level <= 0
                    ? lerp(hiddenTop, normalTop(), -level)
                    : lerp(hiddenTop, topTop(), level)
                : lerp(normalTop(), topTop(), clampNumber(level, 0, 1));
        const opacity = route === "line" ? Math.abs(level) : 1;
        currentOpacity = opacity;
        // 隐藏态保持透明 + 模糊：位置轴直接驱动，和淡入淡出同步变清晰
        const blur = (1 - clampNumber(opacity, 0, 1)) * 10;
        shell.style({
            top: `${top}px`,
            opacity: `${opacity}`,
            filter: blur > 0.01 ? `blur(${blur}px)` : "none",
            visibility: opacity > 0 ? "visible" : "hidden",
            pointerEvents: opacity > 0.5 ? "auto" : "none",
        });
        // 只在“刚变成完全可见”时抢焦点；布局每帧都会调 setLevel，不能反复把焦点夺回来
        const fullyVisible = opacity >= 1;
        if (fullyVisible && !wasFullyVisible) {
            if (document.activeElement !== field.el) field.el.focus({ preventScroll: true });
            // 搜索栏接管键盘：客户端全部失焦，core 在 leave 前把按住的键补成 release
            viewData.beginOverlayKeyboard();
        } else if (opacity <= 0.001) {
            blurInput();
            // 回到常规：补回客户端焦点，防止搜索栏/总览收起后没人有焦点
            viewData.restoreWaylandFocus();
        }
        wasFullyVisible = fullyVisible;
    };

    const setLevel = (value: number, nextRoute: LauncherRoute) => {
        route = nextRoute;
        level = nextRoute === "line" ? clampNumber(value, -1, 1) : clampNumber(value, 0, 1);
        apply();
    };

    // ── 搜索结果 ──────────────────────────────────────────────────────────────────────────────
    let results: SearchResult[] = [];
    /** 稳定 key -> 当前结果和下标；key 不变，列表才能识别出「移动」 */
    const resultByKey = new Map<string, { result: SearchResult; index: number }>();
    const keyByIndex: string[] = [];
    /** 已渲染的搜索结果行；按 key 保存，行可以跨重排复用 */
    const resultRowEls = new Map<string, ElType<HTMLElement>>();
    let selectedIndex = 0;
    let querySeq = 0;
    let aiSeq = 0;
    let queryTimer: number | undefined;

    function resultKey(result: SearchResult) {
        return `${result.badge ?? ""}:${result.id}`;
    }

    function setSelected(index: number, ensureVisible = false) {
        if (results.length === 0) return;
        selectedIndex = (index + results.length) % results.length;
        const key = keyByIndex[selectedIndex];
        for (const [rowKey, row] of resultRowEls) {
            row.style({
                background: rowKey === key ? gSurfaceStyle.solid.backgroundColor : "transparent",
            });
        }
        if (!ensureVisible) return;
        // 不修改 scroll-list：用已有的 scrollTo 只滚到能看见选中项
        const top = selectedIndex * SEARCH_RESULT_ITEM_HEIGHT;
        const bottom = top + SEARCH_RESULT_ITEM_HEIGHT;
        const viewTop = resultListTop * SEARCH_RESULT_ITEM_HEIGHT;
        const viewBottom = viewTop + SEARCH_RESULT_PANEL_HEIGHT;
        if (top < viewTop) resultList.scrollTo(top);
        else if (bottom > viewBottom) resultList.scrollTo(bottom - SEARCH_RESULT_PANEL_HEIGHT);
    }

    function hideResults() {
        results = [];
        selectedIndex = 0;
        resultByKey.clear();
        keyByIndex.length = 0;
        resultRowEls.clear();
        resultList.setList([], true);
        resultsPanel.style({ display: "none" });
    }

    function showNotice(text: string) {
        results = [];
        selectedIndex = 0;
        resultByKey.clear();
        keyByIndex.length = 0;
        resultRowEls.clear();
        resultList.setEmpty(text);
        resultList.setList([], true);
        resultsPanel.style({
            display: "flex",
            height: px(SEARCH_RESULT_PANEL_HEIGHT),
        });
    }

    function createResultEl(result: SearchResult, key: string) {
        const selectedKey = keyByIndex[selectedIndex];
        const row = view("x").style({
            height: px(SEARCH_RESULT_ITEM_HEIGHT),
            padding: "0 12px",
            borderRadius: px(gRadius.item),
            boxSizing: "border-box",
            alignItems: "center",
            gap: "10px",
            cursor: "pointer",
            flexShrink: "0",
            background: key === selectedKey ? gSurfaceStyle.solid.backgroundColor : "transparent",
        });
        row.on("pointerenter", () => {
            const entry = resultByKey.get(key);
            if (entry) setSelected(entry.index);
        });
        row.on("click", (e) => {
            const entry = resultByKey.get(key);
            if (!entry) return;
            e.stopPropagation();
            activateResult(entry.index);
        });

        const iconBox = view().style({
            width: "30px",
            height: "30px",
            borderRadius: px(gRadius.icon),
            background: "#ffffff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            flexShrink: "0",
        });
        iconBox.add(
            aLineText()
                .sv((result.title.trim()[0] || "?").toUpperCase())
                .style({
                    ...gTextStyle.captionStrong,
                    color: gTextStyle.color.secondary,
                    width: "100%",
                    textAlign: "center",
                }),
        );
        const iconPromise = result.icon?.();
        if (iconPromise) {
            void iconPromise
                .then((url) => {
                    if (!url || !row.el.isConnected) return;
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
            aLineText()
                .sv(result.title)
                .style({ ...gTextStyle.body, color: gTextStyle.color.primary }),
        );
        if (result.subtitle) {
            textCol.add(
                aLineText()
                    .sv(result.subtitle)
                    .style({ ...gTextStyle.caption, color: gTextStyle.color.secondary }),
            );
        }
        row.add([iconBox, textCol]);
        if (result.badge) row.add(sourceTag(result.badge));
        resultRowEls.set(key, row);
        return row;
    }

    function renderResults(query: string) {
        if (!query.trim()) {
            hideResults();
            return;
        }
        resultByKey.clear();
        keyByIndex.length = 0;
        const keys: string[] = [];
        for (let index = 0; index < results.length; index++) {
            const result = results[index];
            let key = resultKey(result);
            // 同一 provider 内 id 应唯一；真撞车时加下标兜底
            if (resultByKey.has(key)) key = `${key}#${index}`;
            resultByKey.set(key, { result, index });
            keyByIndex[index] = key;
            keys.push(key);
        }
        // 只保留当前结果对应的行；被移除的行让列表自己播放退场
        for (const key of resultRowEls.keys()) {
            if (!resultByKey.has(key)) resultRowEls.delete(key);
        }
        resultList.setEmpty("未找到匹配项");
        resultsPanel.style({ display: "flex" });
        if (results.length === 0) {
            showNotice("未找到匹配项");
            return;
        }
        resultsPanel.style({ height: px(SEARCH_RESULT_PANEL_HEIGHT) });
        // 稳定 key：保留的行由 dynamicScrollList 计算位移动画
        resultList.setList(keys);
        resultList.scrollTo(0);
        resultListTop = 0;
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
        const key = keyByIndex[index];
        // 先量图标，closeSearch 会同步清空结果 DOM；启动动画从这一格开始
        const iconBox = (key ? resultRowEls.get(key) : undefined)?.el.firstElementChild as HTMLElement | undefined;
        const rect = iconBox ? elementRect(iconBox) : undefined;
        pendingSearchLaunchSource = rect ? { rect, iconSrc: sourceIconSrc(iconBox) } : undefined;
        // 确认结果后先收起搜索栏；全局预览里由退出预览的流程恢复停靠位置
        closeSearch();
        void Promise.resolve()
            .then(result.run)
            .catch((error) => console.warn(`[search] 执行 ${result.id} 失败:`, error))
            .finally(() => {
                pendingSearchLaunchSource = undefined;
            });
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
        if (viewData.overview || (route === "line" && level >= 0.9999)) {
            // 全局预览里搜索栏固定显示，不能收进工作区外
            blurInput();
            return;
        }
        viewData.requestLauncherLevel(0);
    }

    function openSearch() {
        if (viewData.overview || currentOpacity >= 0.999) {
            field.el.focus({ preventScroll: true });
            return;
        }
        viewData.requestLauncherLevel(-1);
    }

    /** 把按键文字接进搜索框：全局预览里搜索框没聚焦时，其它按键也交给搜索 */
    function insertText(text: string) {
        openSearch();
        const el = field.el;
        el.focus({ preventScroll: true });
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        el.setRangeText(text, start, end, "end");
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
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
        if (currentOpacity < 0.5) {
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
            setSelected(selectedIndex + (e.code === "ArrowDown" ? 1 : -1), true);
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
        setLevel,
        isVisible: () => currentOpacity >= 0.5,
        blur: blurInput,
        open: openSearch,
        close: closeSearch,
        hasText: () => field.gv.trim().length > 0,
        insertText,
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
    // 启动台直接铺在壁纸上，文字统一白色 + 淡阴影
    const labelStyle = {
        color: gTextStyle.color.inverse,
        textShadow: "0 1px 2px rgba(0, 0, 0, 0.45), 0 0 8px rgba(0, 0, 0, 0.3)",
    };
    const loadingEl = txt("正在加载应用…")
        .style({ padding: "8px", opacity: "0.6", ...labelStyle })
        .addInto(grid);
    const tileFactory = createAppTileFactory({
        iconConfig: { theme: setting.get("icon.theme") },
        root: null,
        tileWidth: 96,
        tileHeight: 104,
        iconSize: 64,
        labelSize: 13,
        labelStyle,
        settingsIconBox: 64,
        onSettingsClick: () => openSettingsWindow(),
    });

    void desktopApps()
        .catch(() => [] as DesktopApp[])
        .then(async (apps) => {
            loadingEl.remove();
            grid.add(tileFactory.createSettingsTile());
            if (apps.length === 0) {
                txt("未找到应用")
                    .style({ padding: "8px", opacity: "0.6", ...labelStyle })
                    .addInto(grid);
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
            borderRadius: `${gRadius.container}px`,
            // 内容滚动交给菜单自身，避免整个桌面参与滚动和重排
            overflowY: "auto",
            alignContent: "flex-start",
            background: "rgba(245, 245, 245, 0.96)",
            backdropFilter: "blur(12px)",
            boxShadow: gShadowStyle.panel,
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
        onAppLaunch: () => showTip({ state: "hide" }),
    });

    // 元数据在空闲时预取；展开时如果注入了测试应用列表，按注入的列表读取
    const prefetchedApps = desktopApps().catch(() => [] as DesktopApp[]);
    let buildPromise: Promise<void> | null = null;
    function build() {
        if (buildPromise) return buildPromise;
        buildPromise = (async () => {
            const apps = testApps ? await desktopApps().catch(() => [] as DesktopApp[]) : await prefetchedApps;
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

tools.registerTool(
    "clock",
    ({ tipEl, showTip }) => {
        const clockEl = view("x")
            .style({ alignItems: "center", padding: `0 ${px(sSize2.paddingx)}`, cursor: "pointer" })
            .data({ tool: "clock" });
        const hh = view();
        const mm = view();
        clockEl.add([hh, nNumber(":"), mm]);
        rawRegistry.get("time.hour").getAndSubscribe((v) => {
            hh.clear().add(nNumber(v.toString().padStart(2, "0")));
        });
        rawRegistry.get("time.minute").getAndSubscribe((v) => {
            mm.clear().add(nNumber(v.toString().padStart(2, "0")));
        });

        const panel = createClockPanel(rawRegistry);
        panel.el.addInto(tipEl);
        clockEl.on("click", () => {
            showTip({ state: "show", anchorEl: clockEl.el });
        });
        return clockEl;
    },
    { selfBackground: true },
);

tools.registerTool("apps", ({ tipEl, showA, showTip, onTipVisibleChange }) => {
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

    desktopApps().then(async (apps) => {
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
                browserApp.desktopFile,
                () => showTip({ state: "hide" }),
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
                fileManagerApp.desktopFile,
                () => showTip({ state: "hide" }),
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
                terminalApp.desktopFile,
                () => showTip({ state: "hide" }),
            ).addInto(appsEl);
        }
    });
    /** appid → 图标；「某应用有哪些窗口」直接从 server 的窗口表算 */
    const nowApps = new Map<string, ElType<HTMLElement>>();
    const pendingApps = new Set<string>();
    /** handle → appid：`window.closed` 时窗口已从表里移除，靠它定位是哪个应用没了窗口 */
    const handleAppid = new Map<WinHandle, string>();
    const autoHide = createAnimationGear({ v: 0 }, { transition: { duration: 400 } });
    autoHide.setUpdateCallback((v) => {
        if (v.v === 1) {
            showTip({ state: "hide" });
        }
    });
    autoHide.addState("reset", { v: 0 }, ["hide"]);
    autoHide.addState("hide", { v: 1 }, ["reset"]);

    // ── 悬浮预览 ──────────────────────────────────────────────────────────────
    // 卡片统一尺寸：窗口缩略图按比例放进固定区域，不同窗口不会再把弹窗撑成不同大小
    const PREVIEW_CARD_WIDTH = 200;
    const PREVIEW_CARD_HEIGHT = 150;
    const PREVIEW_HEADER_HEIGHT = 24;
    const PREVIEW_GAP = 6;
    const PREVIEW_CARD_GAP = 8;
    const PREVIEW_THUMB_HEIGHT = PREVIEW_CARD_HEIGHT - PREVIEW_HEADER_HEIGHT - PREVIEW_GAP;
    const previewColumn = a === "left" || a === "right";

    type PreviewLayer = { el: ElType<HTMLElement>; width: number; height: number };
    type PreviewAnim = {
        from?: PreviewLayer;
        to?: PreviewLayer;
        fromW: number;
        fromH: number;
        toW: number;
        toH: number;
    };

    const preview = view()
        .style({ position: "relative", display: "block", flexShrink: "0", overflow: "hidden" })
        .on("pointerenter", () => {
            autoHide.moveTo("reset");
        })
        .on("pointerleave", () => {
            autoHide.moveTo("hide");
        })
        .addInto(tipEl);

    let currentPreviewAppid: string | undefined;
    let currentPreviewLayer: PreviewLayer | undefined;
    let previewAnim: PreviewAnim | undefined;
    let previewVisible = false;
    onTipVisibleChange((visible) => {
        previewVisible = visible;
    });

    /** 卡片数量决定弹窗内容尺寸；一排窗口越宽，弹窗跟着变宽 */
    function previewSize(count: number) {
        const n = Math.max(1, count);
        return previewColumn
            ? { width: PREVIEW_CARD_WIDTH, height: n * PREVIEW_CARD_HEIGHT + (n - 1) * PREVIEW_CARD_GAP }
            : { width: n * PREVIEW_CARD_WIDTH + (n - 1) * PREVIEW_CARD_GAP, height: PREVIEW_CARD_HEIGHT };
    }

    /** 切换 icon 时旧层淡出、新层淡入，同时插值容器尺寸，避免弹窗瞬移和跳变 */
    const previewGear = createAnimationGear({ p: 1 }, { transition: { duration: 180, map: timingFunction.easeOut } });
    previewGear.setUpdateCallback(({ p }) => {
        const anim = previewAnim;
        if (!anim) return;
        preview.style({
            width: `${anim.fromW + (anim.toW - anim.fromW) * p}px`,
            height: `${anim.fromH + (anim.toH - anim.fromH) * p}px`,
        });
        anim.from?.el.style({ opacity: `${1 - p}` });
        anim.to?.el.style({ opacity: `${p}`, scale: `${0.98 + 0.02 * p}` });
    });
    function finishPreviewAnim() {
        const anim = previewAnim;
        if (!anim) return;
        previewAnim = undefined;
        anim.from?.el.remove();
        anim.to?.el.style({ opacity: "1", scale: "1" });
        preview.style({ width: `${anim.toW}px`, height: `${anim.toH}px` });
        if (anim.to) currentPreviewLayer = anim.to;
    }
    function runPreviewAnim(anim: PreviewAnim) {
        // 打断上一段时先落到它的目标，再从当前画面继续，避免两个旧层叠在一起
        finishPreviewAnim();
        previewAnim = anim;
        previewGear.moveTo({ p: 0 }, 0);
        previewGear.moveTo({ p: 1 }, { duration: 180, map: timingFunction.easeOut }, finishPreviewAnim);
    }
    function setPreviewLayer(layer: PreviewLayer, animate: boolean) {
        finishPreviewAnim();
        const from = currentPreviewLayer;
        if (!animate || !from || !previewVisible) {
            from?.el.remove();
            layer.el.style({ opacity: "1", scale: "1" });
            preview.style({ width: `${layer.width}px`, height: `${layer.height}px` });
            currentPreviewLayer = layer;
            return;
        }
        runPreviewAnim({
            from,
            to: layer,
            fromW: from.width,
            fromH: from.height,
            toW: layer.width,
            toH: layer.height,
        });
    }
    function animatePreviewSize(width: number, height: number) {
        finishPreviewAnim();
        const layer = currentPreviewLayer;
        if (!layer) {
            preview.style({ width: `${width}px`, height: `${height}px` });
            return;
        }
        const fromW = layer.width;
        const fromH = layer.height;
        layer.width = width;
        layer.height = height;
        runPreviewAnim({ fromW, fromH, toW: width, toH: height });
    }

    function createPreviewCard(info: WindowInfo, layerEl: ElType<HTMLElement>) {
        const card = view("y").style({
            width: `${PREVIEW_CARD_WIDTH}px`,
            height: `${PREVIEW_CARD_HEIGHT}px`,
            flexShrink: "0",
            borderRadius: `${gRadius.item}px`,
            overflow: "hidden",
            background: "#ffffff",
            cursor: "pointer",
            position: "relative",
            boxSizing: "border-box",
        });
        const header = view("x").style({
            width: "100%",
            height: `${PREVIEW_HEADER_HEIGHT}px`,
            flexShrink: "0",
            alignItems: "center",
            gap: "4px",
            padding: "0 4px 0 8px",
            boxSizing: "border-box",
        });
        header.add(
            aLineText()
                .sv(info.title || "未命名窗口")
                .style({
                    ...gTextStyle.captionStrong,
                    color: gTextStyle.color.primary,
                    flex: "1",
                    minWidth: "0",
                    width: "auto",
                }),
        );
        header.add(
            createWindowCloseButton({
                size: 20,
                onClick: () => {
                    server.server.notify("window.close", info.handle);
                    // 立刻从预览里拿掉，不用等 window.closed 回来
                    card.remove();
                    finishPreviewAnim();
                    const count = layerEl.el.children.length;
                    if (count === 0) {
                        if (currentPreviewAppid === info.appid) {
                            currentPreviewAppid = undefined;
                            finishPreviewAnim();
                            currentPreviewLayer?.el.remove();
                            currentPreviewLayer = undefined;
                        }
                        showTip({ state: "hide" });
                        return;
                    }
                    if (currentPreviewLayer?.el === layerEl) {
                        const size = previewSize(count);
                        animatePreviewSize(size.width, size.height);
                    }
                },
            }).style({ flexShrink: "0" }),
        );
        const thumb = view().style({
            width: "100%",
            height: `${PREVIEW_THUMB_HEIGHT}px`,
            marginTop: `${PREVIEW_GAP}px`,
            flexShrink: "0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            background: "#f0f0f2",
        });
        const rawCanvas = server.server.windows.preview(info.handle);
        if (rawCanvas && rawCanvas.width > 1 && rawCanvas.height > 1) {
            const fit = fitRect({ w: rawCanvas.width, h: rawCanvas.height }, PREVIEW_CARD_WIDTH, PREVIEW_THUMB_HEIGHT);
            const canvas = ele("canvas")
                .style({ width: `${fit.w}px`, height: `${fit.h}px`, display: "block" })
                .attr({ width: fit.w, height: fit.h });
            const ctx = canvas.el.getContext("2d");
            if (ctx) {
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = "high";
                ctx.drawImage(rawCanvas, 0, 0, rawCanvas.width, rawCanvas.height, 0, 0, fit.w, fit.h);
            }
            thumb.add(canvas);
        } else {
            thumb.add(
                txt("暂无预览").style({
                    ...gTextStyle.caption,
                    color: gTextStyle.color.muted,
                }),
            );
        }
        card.add([header, thumb]);
        card.on("click", () => {
            jump2Win(info.handle);
        });
        return card;
    }

    function buildPreviewLayer(appid: string): PreviewLayer {
        const allWin = server.server.windows.list().filter((w) => w.appid === appid);
        const size = previewSize(allWin.length);
        const el = view().style({
            position: "absolute",
            left: "0",
            top: "0",
            width: `${size.width}px`,
            height: `${size.height}px`,
            display: "flex",
            gap: `${PREVIEW_CARD_GAP}px`,
            flexDirection: previewColumn ? "column" : "row",
            transformOrigin: "center",
            opacity: "1",
            scale: "1",
        });
        for (const info of allWin) el.add(createPreviewCard(info, el));
        preview.add(el);
        return { el, width: size.width, height: size.height };
    }

    async function addAppIcon(appid: string) {
        if (!appid) return;
        // window.changed 会连发多次，await 期间不能放第二个进来（否则图标重复）
        if (nowApps.has(appid) || pendingApps.has(appid)) return;
        pendingApps.add(appid);
        try {
            const desk = await desktopApp(appid);
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
                    const switching = previewVisible && currentPreviewAppid !== appid;
                    if (!previewVisible || currentPreviewAppid !== appid) {
                        const layer = buildPreviewLayer(appid);
                        currentPreviewAppid = appid;
                        setPreviewLayer(layer, previewVisible);
                    }
                    showTip({ state: "show", anchorEl: appEl.el, animate: switching });
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

        const menu = uSystemMenu({
            onLock: () => state.setState("lock"),
            onShutdown: async () => {
                const t = await confirm("确认 关机？");
                if (t) MSysApi.login("shutdown");
            },
            onReboot: async () => {
                const t = await confirm("确认 重启？");
                if (t) MSysApi.login("restart");
            },
            onSuspend: async () => {
                const t = await confirm("确认 挂起？");
                if (t) MSysApi.login("suspend");
            },
        });
        menu.el.addInto(tipEl);

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
        const el = view("x").style({ alignItems: "center" });
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
    ({ tipEl, showTip, showToast, onTipVisibleChange }) => {
        const el = view("x").style({ alignItems: "center" });

        // 顶部显示电池状态
        const batteryIndicator = getIconXEl("battery", { size: 20, width: 24, height: 24 });
        el.add(batteryIndicator.el);

        let batteryPercentage = 0;
        rawRegistry.get("power.battery").getAndSubscribe((v) => {
            batteryPercentage = v;
            batteryIndicator.sv("value", v / 100);
        });

        // 弹出框显示详情
        const panel = createPowerPanel(rawRegistry);
        panel.el.addInto(tipEl);
        onTipVisibleChange(panel.setVisible);

        const notify = (title: string, detail: string) => {
            showToast(uStatusToast({ icon: "battery", title, detail }), { duration: 3000, key: "power" });
        };

        // UPower 新增电池设备（耳机、鼠标、键盘等）或电源设备时提示电量
        const knownPowerPaths = new Set(MSysApi.power.getDevices().map((device) => device.path));
        const powerTypeLabels: Record<string, string> = {
            "Line Power": "交流电源",
            Battery: "电池",
            Ups: "UPS",
            Monitor: "显示器",
            Mouse: "鼠标",
            Keyboard: "键盘",
            Pda: "掌上设备",
            Phone: "手机",
            "Media Player": "播放器",
            Tablet: "平板",
            Computer: "电脑",
            "Gaming Input": "游戏手柄",
            Pen: "触控笔",
            Touchpad: "触摸板",
            Modem: "调制解调器",
            Network: "网络设备",
            Headset: "耳机",
            Speakers: "音箱",
            Headphones: "耳机",
            Video: "视频设备",
            "Other Audio": "音频设备",
            "Remote Control": "遥控器",
            Printer: "打印机",
            Scanner: "扫描仪",
            Camera: "相机",
            Wearable: "穿戴设备",
            Toy: "玩具",
            "Bluetooth Generic": "蓝牙设备",
        };
        MSysApi.power.on("device-added", async (device) => {
            if (knownPowerPaths.has(device.path)) return;
            knownPowerPaths.add(device.path);
            try {
                const type = await device.getType();
                const label = powerTypeLabels[type] ?? "设备";
                if (type === "Line Power") {
                    notify("电源已接入", label);
                    return;
                }
                const percentage = Math.round(await device.getPercentage());
                const model = (await device.getModel()).trim();
                const name = model && model !== "Unknown" ? model : "";
                const title = type === "Battery" || type === "Ups" ? `发现${label}` : `${label}已连接`;
                notify(title, name ? `${name} · ${percentage}%` : `${percentage}%`);
            } catch {
                // 设备在读取过程中移除时忽略
            }
        });
        MSysApi.power.on("device-removed", (path) => {
            knownPowerPaths.delete(path);
        });

        // 充电状态变化：插拔电源、充满后停止充电
        let lastCharging: boolean | undefined;
        rawRegistry.get("power.battery.charging").getAndSubscribe((charging) => {
            const changed = lastCharging !== undefined && lastCharging !== charging;
            lastCharging = charging;
            if (!changed) return;
            notify(charging ? "正在充电" : "已停止充电", `${Math.round(batteryPercentage)}%`);
        });

        el.on("click", () => {
            showTip({ state: "show", anchorEl: el.el });
        });

        return el;
    },
    { selfBackground: true },
);

tools.registerTool(
    "clipboard",
    ({ tipEl, showTip, showToast }) => {
        if (!clipboard) return view().add(txt("剪贴板未就绪"));
        const station = clipboard;
        clipboardStationTool = createClipboardStationTool({
            station,
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

        // 只对新复制进来的条目提示；删除、清空、把历史条目放回剪贴板都不弹
        let known = new Set(station.items.map((item) => item.id));
        station.subscribe(() => {
            const added = station.items.filter((item) => !known.has(item.id));
            known = new Set(station.items.map((item) => item.id));
            const latest = added.find((item) => item.kind === "clipboard");
            if (!latest) return;
            showToast(
                uStatusToast({
                    icon: "clipboard",
                    title: clipboardPreview(latest),
                    detail: `${latest.appid || "未知应用"} · ${clipboardTime(latest.time)}`,
                }),
                { duration: 2200, key: "clipboard" },
            );
        });

        return el;
    },
    { selfBackground: true },
);

tools.registerTool(
    "network",
    ({ tipEl, showTip, showToast, onTipVisibleChange }) => {
        const el = view("x")
            .style({ alignItems: "center" })
            .add(getIconXEl("wifi", { size: 20, width: 24, height: 24 }));
        const notify = (title: string, detail: string) => {
            showToast(uStatusToast({ icon: "wifi", title, detail }), { duration: 3200, key: "network" });
        };
        const panel = createWifiPanel(rawRegistry, {
            toggleWifiAccessPoint: async (ap) => {
                const device = MSysApi.network.getWifiDevices()[0];
                if (!device) return;
                if (ap.connected) await device.disconnect();
                else await device.connect(ap.ssid);
            },
        });
        panel.el.addInto(tipEl);
        onTipVisibleChange(panel.setVisible);

        watchConnectedItems({
            list: rawRegistry.get("wifi.accessPoints"),
            item: (key) => rawRegistry.get(key as "wifi.accessPoints[]"),
            label: (value) => value.ssid,
            onConnect: (ssid) => notify("Wi-Fi 已连接", ssid),
            onDisconnect: (ssid) => notify("Wi-Fi 已断开", ssid),
        });

        el.on("click", () => {
            showTip({ state: "show", anchorEl: el.el });
        });

        return el;
    },
    { selfBackground: true },
);

tools.registerTool(
    "connect",
    ({ tipEl, showTip, showToast, onTipVisibleChange }) => {
        const el = view("x")
            .style({ alignItems: "center" })
            .add(getIconXEl("connect", { size: 20, width: 24, height: 24 }).el);
        const panel = createConnectPanel(rawRegistry, {
            toggleConnectDevice: async (device) => {
                if (device.connected) {
                    await connect.disconnect(device.id);
                } else {
                    await connect.connect(device.id);
                }
            },
        });
        panel.el.addInto(tipEl);
        onTipVisibleChange(panel.setVisible);

        const notify = (title: string, detail: string) => {
            showToast(uStatusToast({ icon: "connect", title, detail }), { duration: 3200, key: "connect" });
        };
        watchConnectedItems({
            list: rawRegistry.get("connect.devices"),
            item: (key) => rawRegistry.get(key as "connect.devices[]"),
            label: (value) => value.name,
            onAdded: (name) => notify("新互联设备", name),
            onConnect: (name) => notify("互联已连接", name),
            onDisconnect: (name) => notify("互联已断开", name),
        });

        el.on("click", () => {
            showTip({ state: "show", anchorEl: el.el });
        });

        return el;
    },
    { selfBackground: true },
);

tools.registerTool(
    "blue",
    ({ tipEl, showTip, showToast, onTipVisibleChange }) => {
        const el = view("x")
            .add(getIconXEl("blue", { size: 20, width: 24, height: 24 }).el)
            .style({ alignItems: "center" });
        const notify = (title: string, detail: string) => {
            showToast(uStatusToast({ icon: "blue", title, detail }), { duration: 3200, key: "blue" });
        };
        const panel = createBluePanel(rawRegistry, {
            toggleBlueDevice: async (device) => {
                let target: blueDevice | undefined;
                for (const candidate of MSysApi.blue.getDevices()) {
                    if ((await candidate.getAddress()) === device.address) {
                        target = candidate;
                        break;
                    }
                }
                if (!target) return;
                if (device.connected) {
                    await target.disconnect();
                    return;
                }
                // 未配对的设备直接 Connect 会以 D-Bus 错误失败，这里只连已配对（bonded）的设备
                if (!(await target.isPaired()) && !(await target.isBonded())) return;
                await target.connect();
            },
        });
        panel.el.addInto(tipEl);
        onTipVisibleChange(panel.setVisible);

        watchConnectedItems({
            list: rawRegistry.get("blue.devices"),
            item: (key) => rawRegistry.get(key as "blue.devices[]"),
            label: (value) => value.name,
            onAdded: (name) => notify("发现蓝牙设备", name),
            onConnect: (name) => notify("蓝牙已连接", name),
            onDisconnect: (name) => notify("蓝牙已断开", name),
        });

        el.on("click", () => {
            showTip({ state: "show", anchorEl: el.el });
        });

        return el;
    },
    { selfBackground: true },
);

tools.registerTool(
    "notifications",
    ({ tipEl, showTip, showToast, hideToast }) => {
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

        // 每条通知是 OSD 列表里独立的一项；同一条通知更新时替换对应项
        const toastKey = (key: string) => `notification:${key}`;
        const removeToastNote = (key: string) => {
            hideToast(toastKey(key));
        };
        const showToastNote = (key: string, note: { title: string; content: string }) => {
            showToast(nNotiToast({ title: note.title, content: note.content }), {
                duration: 4500,
                key: toastKey(key),
            });
        };

        // 每条通知单独订阅，replaces_id 复用同一个 id 时也能再次提示
        const itemUnsubs = new Map<string, () => void>();
        let seeded = false;
        rawRegistry.get("notification.list").getAndSubscribe((ids) => {
            const keep = new Set(ids.map((id) => String(id)));
            for (const [key, unsubscribe] of [...itemUnsubs]) {
                if (keep.has(key)) continue;
                unsubscribe();
                itemUnsubs.delete(key);
                removeToastNote(key);
            }
            for (const id of ids) {
                const key = String(id);
                if (itemUnsubs.has(key)) continue;
                const suppressFirst = !seeded;
                let firstValue = true;
                const unsubscribe = rawRegistry
                    .get(`notification.list.${key}` as "notification.list[]")
                    .getAndSubscribe((value) => {
                        const isFirstValue = firstValue;
                        firstValue = false;
                        if (value.closed) {
                            removeToastNote(key);
                            return;
                        }
                        if (isFirstValue && suppressFirst) return;
                        showToastNote(key, value);
                    });
                itemUnsubs.set(key, unsubscribe);
            }
            seeded = true;
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

tools.registerTool("virtualKeyboard", () => {
    const el = view("x")
        .style({
            width: px(24),
            height: px(28),
            alignItems: "center",
            justifyContent: "center",
            borderRadius: px(gRadius.item),
            cursor: "pointer",
            flexShrink: "0",
        })
        .add(getIconXEl("keyboard", { size: 20, width: 22, height: 22 }));
    el.data({ "virtual-keyboard-tool": "1" });
    el.on("click", () => ensureVirtualKeyboard().toggle());
    vkbToolEl = el;
    updateVirtualKeyboardTool();
    return el;
});

tools.registerTool(
    "volume",
    ({ tipEl, showTip, showToast }) => {
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

        const state = { outputV: 0, outputM: false, inputV: 0, inputM: false };
        // 一次只显示发生变化的那一路：输出或输入，不并排显示两个进度条
        const notify = (kind: "output" | "input") => {
            const row = uLevelRow({ icon: kind === "output" ? "speaker" : "mic" });
            row.sv(kind === "output" ? state.outputV : state.inputV, kind === "output" ? state.outputM : state.inputM);
            showToast(row.el, { duration: 1800, key: "volume" });
        };
        let lastOutputV: number | undefined;
        let lastOutputM: boolean | undefined;
        let lastInputV: number | undefined;
        let lastInputM: boolean | undefined;
        rawRegistry.get("volume.output.default.volume").getAndSubscribe((value) => {
            const changed = lastOutputV !== undefined && lastOutputV !== value;
            lastOutputV = value;
            state.outputV = value;
            if (changed) notify("output");
        });
        rawRegistry.get("volume.output.default.muted").getAndSubscribe((value) => {
            const changed = lastOutputM !== undefined && lastOutputM !== value;
            lastOutputM = value;
            state.outputM = value;
            if (changed) notify("output");
        });
        rawRegistry.get("volume.input.default.volume").getAndSubscribe((value) => {
            const changed = lastInputV !== undefined && lastInputV !== value;
            lastInputV = value;
            state.inputV = value;
            if (changed) notify("input");
        });
        rawRegistry.get("volume.input.default.muted").getAndSubscribe((value) => {
            const changed = lastInputM !== undefined && lastInputM !== value;
            lastInputM = value;
            state.inputM = value;
            if (changed) notify("input");
        });

        return btn;
    },
    { selfBackground: true },
);

tools.registerTool(
    "brightness",
    ({ tipEl, showTip, showToast }) => {
        const btn = button(getIconXEl("sun", { size: 20, width: 24, height: 24 })).on("click", () => {
            showTip();
        });

        const displays = uipool["brightness.displays"]();
        displays.el.addInto(tipEl);

        const toastUnsubs = new Map<string, () => void>();
        rawRegistry.get("brightness.displays").getAndSubscribe((ids) => {
            const keep = new Set(ids.map((id) => String(id)));
            for (const [key, unsub] of [...toastUnsubs]) {
                if (keep.has(key)) continue;
                unsub();
                toastUnsubs.delete(key);
            }
            for (const id of ids) {
                const key = String(id);
                if (toastUnsubs.has(key)) continue;
                let lastValue: number | undefined;
                const brightness = rawRegistry.get(rawRegistry.buildVarId("brightness.displays[].brightness", [key]));
                const unsub = brightness.getAndSubscribe((value) => {
                    const changed = lastValue !== undefined && lastValue !== value;
                    lastValue = value;
                    if (!changed) return;
                    // 只显示最后变化的那块屏幕，一次一个进度条
                    const row = uLevelRow({ icon: "sun" });
                    row.sv(value / 100);
                    showToast(row.el, { duration: 1800, key: "brightness" });
                });
                toastUnsubs.set(key, unsub);
            }
        });

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
    const lockWallpaper = wallpaper.bind("lock", image(defaultWallpaperSrc, "wallpaper")).style({
        width: "100%",
        height: "100%",
        objectFit: "cover",
        objectPosition: "center",
    });
    lockScreenView.style({ width: "100%", height: "100%" }).add([
        lockWallpaper,
        view("y")
            .style({ position: "absolute", ...xPosition(0.5, 0.4), alignItems: "center", gap: px(40) })
            .add([day, clockEl]),
    ]);

    lockScreenPassword.style({ width: "100%", height: "100%", backdropFilter: "blur(40px)" });

    const inputEl = ui.passwd();
    inputEl.placeholder("请输入密码");
    inputEl.el.style({ width: px(sSize(5)), height: px(sSize(1)) });
    focusLockPassword = () => inputEl.focus();
    clearLockPassword = () => inputEl.clear();
    lockPasswordValue = () => inputEl.el.gv;
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

    let lockKeyboardOpen = true;
    const keyboardBtn = view()
        .add(getIconXEl("keyboard", { size: 16, width: sSize(1), height: sSize(1) }))
        .style({
            ...gGlassStyle.justItem,
            width: px(sSize(1)),
            height: px(sSize(1)),
            borderRadius: px(sSize2.radius1),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
        })
        .data({ "lock-keyboard-toggle": "1" })
        .on("click", () => setLockKeyboardOpen(!lockKeyboardOpen));

    lockScreenPassword.add(
        view("x")
            .add([
                keyboardBtn,
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

    // 锁屏键盘：时钟界面 Enter 进密码界面，其它字符直接进密码界面并输入；密码界面 Esc 回时钟；
    // 时钟界面 Esc 熄屏，息屏时任意键先唤回时钟（没有 DPMS 的窗口模式/测试也靠这里兜底）
    window.addEventListener("keydown", (e) => {
        if (state.getState() !== "lock") return;
        const lockState = stateLock.getState();
        if (lockState === "xipin") {
            e.preventDefault();
            e.stopPropagation();
            stateLock.setState("lock");
            return;
        }
        if (lockState === "passwd") {
            if (e.key === "Escape") {
                // 校验进行中不打断，避免结果回来时已经不在密码界面
                if (cheking) return;
                e.preventDefault();
                e.stopPropagation();
                stateLock.setState("lock");
            }
            return;
        }
        if (lockState !== "lock") return;
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            stateLock.setState("passwd");
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            stateLock.setState("xipin");
            return;
        }
        if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
            e.preventDefault();
            e.stopPropagation();
            stateLock.setState("passwd");
            inputEl.inputKey(e.key);
        }
    });

    // 锁屏使用独立 ASCII 键盘：直接写进密码框，不经过输入法
    const asciiKeyboard = createAsciiKeyboard({
        dispatcher: {
            key: (press) => {
                if (press.code === "Backspace" || press.code === "Enter") {
                    inputEl.inputKey(press.code);
                    stateLock.setState("passwd");
                    return;
                }
                if ([...press.key].length === 1) {
                    inputEl.inputKey(press.key);
                    stateLock.setState("passwd");
                }
            },
            text: (text) => {
                for (const ch of text) inputEl.inputKey(ch);
                stateLock.setState("passwd");
            },
        },
    });
    const lockKeyboardWrap = view()
        .style({
            position: "absolute",
            bottom: px(28),
            left: "50%",
            transform: "translateX(-50%)",
            width: "calc(92vw / var(--desktop-ui-scale, 1))",
            maxWidth: px(920),
            height: px(270),
            display: "block",
        })
        .add(asciiKeyboard.el);
    lockScreenPassword.add(lockKeyboardWrap);

    function setLockKeyboardOpen(open: boolean) {
        lockKeyboardOpen = open;
        lockKeyboardWrap.style({ display: open ? "block" : "none" });
        keyboardBtn.style({
            background: open ? "#ffffff" : gGlassStyle.itemInBg.backgroundColor,
        });
    }
    setLockKeyboardOpen(true);
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
        for (const id of [...touchRoutes.keys()]) cancelTouchRoute(id);
        pointerTarget = undefined;
        void setScreenOff(false);
        if (stateLock.getState() === "xipin") stateLock.setState("lock");
        return;
    }
    if (checkBrightnessKey(e)) return;
    if (checkVolumeKey(e)) return;
    if (checkMediaKey(e)) return;
    if (checkContextMenuKey(e)) return;
    // 触控板页激活时，触屏接触点先尝试交给触摸板变换器；落在键盘 UI 上的仍走普通触摸
    if (keyboardTouchpad?.handle(e)) return;
    // 滚轮/触摸板：先按窗口几何命中转发给 Wayland 客户端，再模拟 DOM 事件给桌面 UI。
    // 源信息（触摸板连续滚动、高精度刻度）随统一事件带下来，不能等模拟成 DOM WheelEvent 再取。
    if (e.kind === "pointer" && e.type === "wheel") {
        if (isHostPinch(e)) {
            handleHostPinch(e);
            return;
        }
        // 工具栏全局预览按钮上滚轮，或 Super+滚轮，都等同 Super+←/→。
        // 这类滚轮不转发给客户端，但仍模拟成 DOM wheel，让桌面 UI 统一按 DOM 事件处理。
        const target = e.target instanceof Element ? e.target : document.elementFromPoint(e.x, e.y);
        const overOverview = target instanceof Element && target.closest('[data-tool="overview"]') !== null;
        const screenWheel = overOverview || ((e.metaKey === true || exitModifiers.meta) && !polkitDialog?.isOpen());
        if (!screenWheel) sendScrollEvent(e);
        inputSim.emit({ ...e, metaKey: e.metaKey === true || exitModifiers.meta });
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
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
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

/**
 * inputSim 把所有滚轮统一模拟成 DOM wheel，原生序列语义也挂在事件上。
 * 这里处理全局预览按钮和 Super+滚轮；其它 UI 可以只监听 wheel 读同样的属性。
 */
function onDesktopWheel(e: WheelEvent) {
    if (e.isTrusted) return;
    const target = e.target instanceof Element ? e.target : undefined;
    const overOverview = target !== undefined && target.closest('[data-tool="overview"]') !== null;
    const superWheel = e.metaKey && !polkitDialog?.isOpen();
    if (!overOverview && !superWheel) return;
    e.preventDefault();
    e.stopPropagation();
    handleScreenWheel(e as SemanticWheelEvent);
}
window.addEventListener("wheel", onDesktopWheel, { capture: true, passive: false });

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
/** 正在进入全屏：屏幕轴还在把窗口送到全屏屏上，也要立刻隐藏工具栏 */
let fullscreenChromeEntering = false;
/** 进入全屏后的第一次偏移（换屏动画）已经出现，等它停稳再结束“进入中” */
let fullscreenChromeSawOffset = false;
/** 全屏屏还在移动时的逐帧复核 */
let fullscreenChromeRecheck: number | undefined;
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
        setClientFrameLayout(frame, out.width, out.height, { fullscreen: true });
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

const fullscreenChromeGear = createAnimationGear(
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

/**
 * 视图（当前屏 / 全局预览 / 手势）或窗口状态变化后，重新计算全屏模式。
 * 进入全屏时不等窗口重排，先启动隐藏动画；全屏一旦被总览/手势/切屏带偏，
 * 立即显示工具栏，等停稳回到全屏屏后再隐藏。
 */
function syncFullscreenChrome(animate = true, reflow = true) {
    const currentFullscreen = currentScreenFullscreen();
    const winid = viewData.currentWinId();
    const screen = winid === undefined ? undefined : viewData.screenOf(winid);
    const overviewing = viewData.overview || viewData.overviewProgress > 0.001;
    const gesturing = viewData.gestureActive;
    // 只看这块屏的视觉位置：结构变化引起的 focus 齿轮不算“被带偏”
    const atNormalView =
        !!screen &&
        Math.abs(screen.visual.x) < 0.5 &&
        Math.abs(screen.visual.y) < 0.5 &&
        Math.abs(screen.visual.scale - 1) < 0.001;

    if (!currentFullscreen || overviewing || gesturing) {
        fullscreenChromeEntering = false;
        fullscreenChromeSawOffset = false;
    } else if (fullscreenChromeEntering) {
        // 进入全屏的换屏动画可能晚一帧才开始：先记住“已经偏移”，
        // 等它真正停稳再结束，期间始终保持隐藏
        if (!atNormalView) fullscreenChromeSawOffset = true;
        if (atNormalView && fullscreenChromeSawOffset) {
            fullscreenChromeEntering = false;
            fullscreenChromeSawOffset = false;
        }
    }
    const hide = currentFullscreen && !overviewing && !gesturing && (fullscreenChromeEntering || atNormalView);
    if (currentFullscreen)
        console.log(
            "FS",
            JSON.stringify({
                atNormalView,
                entering: fullscreenChromeEntering,
                saw: fullscreenChromeSawOffset,
                hide,
                hidden: fullscreenChromeHidden,
                overviewing,
                gesturing,
                vis: screen?.visual,
            }),
        );

    if (fullscreenChromeHidden !== hide) {
        fullscreenChromeHidden = hide;
        // 动画一开始就不再让工具栏接收输入；恢复时立即重新可用
        toolsEl.el.inert = hide;
        fullscreenChromeGear.moveTo({ mix: hide ? 1 : 0 }, animate ? undefined : 0);
    }
    // 工具栏先动，窗口重排放在后面：隐藏动画不再等布局
    if (currentFullscreen && reflow) {
        // 客户端后续的 set_window_geometry 可能把元素尺寸写回旧值，进入/停留全屏时都重新铺满
        syncFullscreenWindowBoxes();
    }
    // 全屏屏还在移动/手势中：逐帧复核，停稳后该隐藏的再隐藏（复核不重复重排窗口）
    if (currentFullscreen && !overviewing && (!atNormalView || gesturing)) scheduleFullscreenChromeRecheck();
}

/** 全屏屏移动期间的轻量复核：只重算工具栏状态，不重复铺窗口 */
function scheduleFullscreenChromeRecheck() {
    if (fullscreenChromeRecheck !== undefined) return;
    fullscreenChromeRecheck = requestAnimationFrame(() => {
        fullscreenChromeRecheck = undefined;
        syncFullscreenChrome(true, false);
    });
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
        // 桌面命令不会回 window.changed；最大化按最底层算，被上层盖住才换屏
        viewData.sendWinToBottom(winid);
        if (maximizeCoveredByOthers(winid)) viewData.moveWindowToNewScreen(winid);
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
        // 先把全屏状态发给 server，再换屏：换屏里的 render 会按全屏状态直接开始隐藏工具栏
        const out = fullOutputSize();
        fullscreenChromeEntering = true;
        fullscreenChromeSawOffset = false;
        server.server.notify("window.fullscreen", winid, {
            width: Math.max(1, Math.floor(out.width / info.scale)),
            height: Math.max(1, Math.floor(out.height / info.scale)),
        });
        // 先暂停居中，再换屏：换屏里的 render 会立刻开始全屏过渡
        pauseCenteringForFullscreen(winid);
        // 全屏总是换到新虚拟屏
        viewData.moveWindowToNewScreen(winid, true);
        // 桌面命令不发 window.changed，这里自己更新本地快照
        if (applied) {
            applied.fullscreen = true;
            applied.maximized = false;
        }
        syncFullscreenChrome();
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
viewData.setChromeProgressCallback(() => syncFullscreenChrome(true, false));
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
    if (isSecondaryTouch(e)) {
        // 副手指也要进入 Wayland：它可能是双指缩放/平移的另一半
        if (!e.isTrusted) sendPointerEvent("move", e);
        return;
    }
    mouseMove(e.x, e.y, e);
});
// 指针按下/抬起在 window capture 统一处理：路由层不再局限于窗口元素，
// 这样才能记录「按下在桌面 UI 上」的指针序列，避免抬起时漏给下面的客户端。
window.addEventListener(
    "pointerdown",
    (e) => {
        if (e.isTrusted) return;
        sendPointerEvent("down", e);
    },
    true,
);
window.addEventListener(
    "pointerup",
    (e) => {
        if (e.isTrusted) return;
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
        // 搜索按钮自己负责开关搜索栏，不能被“点击外部隐藏”先关掉再重新打开
        const isSearchToggle = !!target?.closest('[data-tool="search"]');
        if (!isSearchToggle && !target?.closest("[data-launcher-input]")) {
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
    // 认证对话框是模态的：字符由输入框自己处理，其余按键不再触发桌面快捷键或转给客户端
    if (polkitDialog?.isOpen()) {
        e.preventDefault();
        return;
    }
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
        // Super+Tab 是预览开关：搜索框拿到焦点后也要能直接退出，不能留给输入框忽略
        if (!e.repeat && e.code === "Tab" && matchBindings(e, DESKTOP_BINDINGS)) {
            e.preventDefault();
            viewData.toggleOverview();
            return;
        }
        if (!e.repeat && e.code === "Escape") {
            e.preventDefault();
            viewData.setOverview(false);
            return;
        }
        // Super+←/→ 沿虚拟屏移动聚焦面板；搜索框有内容时普通 ←/→ 留给输入框移动光标
        const arrow = e.code === "ArrowLeft" ? 1 : e.code === "ArrowRight" ? -1 : 0;
        if (!e.repeat && arrow !== 0) {
            const superArrow = matchBindings(e, DESKTOP_BINDINGS);
            const plainArrow = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && !launcher.hasText();
            if (superArrow || plainArrow) {
                e.preventDefault();
                viewData.moveOverviewFocus(arrow);
                return;
            }
        }
        // 回车确认聚焦的屏；搜索框有内容时回车交给搜索结果
        if (!e.repeat && (e.code === "Enter" || e.code === "NumpadEnter") && !launcher.hasText()) {
            e.preventDefault();
            viewData.selectCurrentFromOverview();
            return;
        }
        if (isLauncherInputFocused() || isInternalWindow(viewData.focusHandle)) return;
        // 其它可打印键交给搜索框：先聚焦并插入，之后继续输入由输入框自己接收
        if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
            e.preventDefault();
            launcher.insertText(e.key);
            return;
        }
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
    if (polkitDialog?.isOpen()) {
        e.preventDefault();
        return;
    }
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
const dragIcon = new DragIcon(mainEl);
cursor.setScale(uiScale);
dragIcon.setScale(uiScale);

/** 桌面 UI 跟随屏幕缩放；窗口模式/winit 下 screenManager 固定 1x，宿主 DPR 负责缩放 */
function applyUiScale(scale: number) {
    const value = Number.isFinite(scale) && scale > 0 ? scale : 1;
    uiScale = value;
    document.documentElement.style.setProperty("--desktop-ui-scale", String(value));
    if (!uiScaleReady) return;
    // 先更新带 zoom 的子树，再按视觉尺寸重新测量工具栏占位
    launcher.setUiScale(value);
    cursor.setScale(value);
    dragIcon.setScale(value);
    ime?.setUiScale(value);
    vkb?.setUiScale(value);
    measureChromeInsets();
    // 标题栏高度跟着界面缩放走；内容尺寸由渲染层按新 scale 更新，frame 再从内容盒子同步
    for (const [handle, frame] of clientWindowFrames) {
        const info = server.server.windows.get(handle);
        if (!info || info.states.maximized || info.states.fullscreen) continue;
        applyClientFrameChrome(frame);
        // 还没有客户端几何（首帧之前是 0×0）时保持当前外框，不能按 0 摆成 1×1
        if (frame.decorated || info.rect.w <= 0 || info.rect.h <= 0) applyFrameSurfaceSize(frame);
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

    // ── 滚轮序列：原生 evdev 能给出开始/结束，桌面据此区分鼠标格数与触摸板距离 ──
    let wheelActive = false;
    let wheelEndTimer: ReturnType<typeof setTimeout> | undefined;
    const clearWheelEnd = () => {
        if (wheelEndTimer === undefined) return;
        clearTimeout(wheelEndTimer);
        wheelEndTimer = undefined;
    };
    const beginWheel = () => {
        const start = !wheelActive;
        wheelActive = true;
        clearWheelEnd();
        return start;
    };
    const endWheel = (device: "mouse" | "touchpad") => {
        clearWheelEnd();
        if (!wheelActive) return;
        wheelActive = false;
        emit({
            kind: "pointer",
            type: "wheel",
            x: pointerPos.x,
            y: pointerPos.y,
            deltaX: 0,
            deltaY: 0,
            wheelSource: device === "touchpad" ? "finger" : "wheel",
            wheelDevice: device,
            wheelEnd: true,
            source: "evdev",
        });
    };
    /** 鼠标滚轮没有显式抬手，连续滚动停顿后补一个 end；触摸板由 scrollEnd 立即结束 */
    const endWheelLater = (device: "mouse" | "touchpad") => {
        clearWheelEnd();
        const timer = setTimeout(() => {
            wheelEndTimer = undefined;
            endWheel(device);
        }, WHEEL_SEQUENCE_DELAY);
        (timer as { unref?: () => void }).unref?.();
        wheelEndTimer = timer;
    };

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
                  acceleration: {
                      enabled: () => touchpadAcceleration,
                      speed: () => touchpadSpeed,
                  },
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
        const start = beginWheel();
        emit({
            kind: "pointer",
            type: "wheel",
            x: pointerPos.x,
            y: pointerPos.y,
            deltaX: deltaX * sign * touchpadScrollGain,
            deltaY: deltaY * sign * touchpadScrollGain,
            wheelSource: "finger",
            wheelDevice: "touchpad",
            wheelStart: start || undefined,
            source: "evdev",
        });
    });
    touchpadInput?.on("scrollEnd", () => {
        if (info.phys) touchpadScrolling.delete(info.phys);
        endWheel("touchpad");
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
            const device = touchpad ? "touchpad" : "mouse";
            const wheelSource = device === "touchpad" ? "finger" : "wheel";
            const start = beginWheel();
            emit({
                kind: "pointer",
                type: "wheel",
                x: pointerPos.x,
                y: pointerPos.y,
                deltaX,
                deltaY,
                wheelSource,
                wheelDevice: device,
                // 鼠标按格数切屏，触摸板按 delta 距离切屏
                wheelStepsX: device === "mouse" ? value120X / 120 : undefined,
                wheelStepsY: device === "mouse" ? value120Y / 120 : undefined,
                value120X: wheelSource === "wheel" ? value120X : undefined,
                value120Y: wheelSource === "wheel" ? value120Y : undefined,
                wheelStart: start || undefined,
                source: "evdev",
            });
            endWheelLater(device);
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
        clearWheelEnd();
        endWheel(touchpad ? "touchpad" : "mouse");
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

desktopApps().then((e) => {
    for (const x of e) {
        MSysApi.getDesktopIcon(x.icon, {
            theme: setting.get("icon.theme"),
        });
    }
}); // 预加载

// 同步初始化到这里结束：快捷键、输入聚合层和工具栏都已就绪。
// 自动化测试等这个标记再发输入，避免首帧输入落在初始化完成之前被丢掉。
document.documentElement.dataset.desktopReady = "1";

// 测试入口：启动动画测试直接调用 launchApp，避免依赖启动器搜索和临时 .desktop。
// touchpadFeed 把假触摸板的 evdev 原始事件接进真实的 evdev → TouchpadInput → ViewData 链路，
// state 返回只读快照；只在 testMode 下挂到 globalThis，正常桌面不存在这个入口。
if ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.testMode === "on") {
    type TestTouchpadEvent = { type: "abs" | "rel" | "key"; code: number; value: number } | { type: "sync" };

    /** 假触摸板：实现 useEvdevDevice/TouchpadInput 用到的设备接口，事件由测试逐帧喂入 */
    const createTestTouchpad = () => {
        const info: DeviceInfo = {
            path: "test:touchpad",
            name: "myde test touchpad",
            type: "touchpad",
            vendor: 0,
            product: 0,
            version: 0,
            capabilities: {
                eventTypes: [],
                keyCodes: [
                    InputEventCodes.BTN_TOUCH,
                    InputEventCodes.BTN_TOOL_FINGER,
                    InputEventCodes.BTN_TOOL_DOUBLETAP,
                    InputEventCodes.BTN_TOOL_TRIPLETAP,
                    InputEventCodes.BTN_TOOL_QUADTAP,
                ],
                relAxes: [],
                absAxes: [
                    InputEventCodes.ABS_MT_SLOT,
                    InputEventCodes.ABS_MT_TRACKING_ID,
                    InputEventCodes.ABS_MT_POSITION_X,
                    InputEventCodes.ABS_MT_POSITION_Y,
                ],
                hasKeyboard: false,
                hasMouse: false,
                hasTouchpad: true,
                hasTouchscreen: false,
            },
            absInfo: {
                [InputEventCodes.ABS_MT_POSITION_X]: { min: 0, max: 4000, fuzz: 0, flat: 0, resolution: 100 },
                [InputEventCodes.ABS_MT_POSITION_Y]: { min: 0, max: 4000, fuzz: 0, flat: 0, resolution: 100 },
            },
            errors: [],
        };
        const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
        const dev = {
            info,
            reading: false,
            on(name: string, callback: (...args: unknown[]) => void): void {
                const set = handlers.get(name) ?? new Set<(...args: unknown[]) => void>();
                handlers.set(name, set);
                set.add(callback);
            },
            removeAllListeners(): void {
                handlers.clear();
            },
            startReading() {
                dev.reading = true;
                return { ok: true, value: undefined };
            },
            stopReading() {
                dev.reading = false;
                return { ok: true, value: undefined };
            },
            isReading(): boolean {
                return dev.reading;
            },
            emit(name: string, ...args: unknown[]): void {
                for (const callback of [...(handlers.get(name) ?? [])]) callback(...args);
            },
        };
        const manager = { getDevice: (path: string) => (path === info.path ? dev : undefined) };
        const dispose = useEvdevDevice(
            manager as unknown as InputManager,
            dispatchInput,
            inputPointerPos,
            info.path,
            new Map<string, number>(),
            new Set<string>(),
            new Map<string, number>(),
            new Set<string>(),
        );
        return { dev, dispose };
    };

    let testTouchpad: ReturnType<typeof createTestTouchpad> | undefined;

    /** 测试里点关闭按钮时先记录关窗请求，不依赖客户端进程的 peer end 时序 */
    const closeRequests: WinHandle[] = [];
    const rawNotify = server.server.notify.bind(server.server) as (key: string, ...args: unknown[]) => void;
    server.server.notify = ((key: string, ...args: unknown[]) => {
        if (key === "window.close") closeRequests.push(args[0] as WinHandle);
        rawNotify(key, ...args);
    }) as unknown as typeof server.server.notify;

    const touchpadFeed = (events: TestTouchpadEvent[]) => {
        testTouchpad ??= createTestTouchpad();
        const { dev } = testTouchpad;
        for (const event of events) {
            if (event.type === "sync") dev.emit("sync");
            else if (event.type === "abs") dev.emit("absolute", event.code, event.value);
            else if (event.type === "rel") dev.emit("relative", event.code, event.value);
            else dev.emit("key", event.code, event.value);
        }
        return events.length;
    };

    /** 替换桌面看到的应用列表；启动台立即重建，开始菜单在首次展开时读取 */
    const setApps = (apps: DesktopApp[] | undefined) => {
        testApps = apps;
        const launchpad = viewData.launchpadScreen;
        if (launchpad && launchpadContentEl) {
            launchpadContentEl.remove();
            launchpadContentEl = createLaunchpadContent();
            launchpad.el.add(launchpadContentEl);
            launchpadContentEl.style({
                top: `${wino.t}px`,
                left: `${wino.l}px`,
                right: `${wino.r}px`,
                bottom: `${wino.b}px`,
            });
        }
    };

    (globalThis as Record<string, unknown>).__mydeTest = {
        launchApp: (req: AppLaunchRequest) => launchApp(req),
        closeWindows: () => {
            for (const frame of [...clientWindowFrames.values()]) {
                server.server.notify("window.close", frame.handle);
            }
        },
        closeWindow: (handle: WinHandle) => server.server.notify("window.close", handle),
        forceCloseWindows: () => {
            for (const frame of [...clientWindowFrames.values()]) closeClientFrameWithFade(frame.handle, frame);
        },
        closeLaunchPanels: () => {
            for (const state of [...pendingLaunches]) forceQuitLaunch(state);
        },
        applyUiScale: (scale: number) => applyUiScale(scale),
        state: () => viewData.snapshot(),
        lock: () => ({
            state: state.getState(),
            sub: stateLock.getState(),
            password: lockPasswordValue?.() ?? "",
        }),
        setApps: (apps?: DesktopApp[]) => setApps(apps),
        setReorderDelay: (ms: number) => {
            reorderDelay = normalizeReorderDelay(ms);
        },
        setAnimationSpeed: (value: number) => setAnimationSpeed(value),
        closeRequests: () => [...closeRequests],
        clearCloseRequests: () => {
            closeRequests.length = 0;
        },
        resetView: () => {
            for (const frame of [...clientWindowFrames.values()]) server.server.notify("window.close", frame.handle);
            for (const frame of [...clientWindowFrames.values()]) closeClientFrameWithFade(frame.handle, frame);
            for (const state of [...pendingLaunches]) forceQuitLaunch(state);
            viewData.resetView();
            closeRequests.length = 0;
        },
        forceCloseWindow: (handle: WinHandle) => {
            const frame = clientWindowFrames.get(handle);
            if (frame) closeClientFrameWithFade(handle, frame);
        },
        placeWindow: (handle: WinHandle, screenId: string, x: number, y: number) =>
            viewData.placeWindow(handle, screenId, x, y),
        touchpadFeed,
        touchpadDetach: () => {
            testTouchpad?.dispose();
            testTouchpad = undefined;
        },
    };
}
