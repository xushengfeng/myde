import { addClass, addStyle, button, check, ele, type ElType, image, pack, setProperty, spacer, view } from "dkh-ui";

import type { DesktopIconConfig, WaylandClient, WaylandWinId } from "../../../src/desktop-api";
import { txt } from "dkh-ui";
import { AnimationGear, timingFunction } from "myde-ui";
import { aLineText, bButton, iItem, mMedia, nNotiList, px, sSize, sSize2, tTrayMenu, ui, uPasswdInput } from "./ui";
import { dynamicScrollList } from "./scroll-list";
import { Registry } from "./registry";
import type { MenuItem } from "../../../src/sys_api/menu";

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
}

type tmpRegistry = Registry<RegistrySchema>;

// 具体的键类型
type BooleanRegistryKeys = "wifi.enabled" | "blue.power";
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
        window.addEventListener("pointerdown", (e) => {
            const target = e.target as HTMLElement;
            if (tipel.gv === true && !tipel.el.contains(target)) {
                e.stopImmediatePropagation();
                tipel.sv("hide");
                gear.moveTo("hide");
            }
        });
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
                return el;
            },
        };
    }
}

type MWinId = string & { __brand: "MWinId" };

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

class ViewData {
    private views: View[] = [];
    private win2View = new Map<MWinId, View>();
    private winid2ClientId = new Map<MWinId, { clientId: string; winId: WaylandWinId }>();
    focusClient: string | undefined;
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
    bindWinidClientid(winid: MWinId, clientId: string, winId: WaylandWinId) {
        this.winid2ClientId.set(winid, { clientId, winId });
    }
    closeWin(winid: MWinId) {
        this.win2View.delete(winid);
        this.checkAndRmView();
    }
    focusWin(winid: MWinId) {
        const id = this.winid2ClientId.get(winid);
        if (!id) {
            console.warn("cant find clientid", winid);
            return;
        }
        this.focusClient = id.clientId;
        for (const [cid, c] of server.server.clients) {
            for (const [wid] of c.getWindows()) {
                if (cid === id.clientId && wid === id.winId) {
                    c.win(wid)?.focus();
                } else {
                    c.win(wid)?.blur();
                }
            }
        }
    }
    blurAll() {
        this.focusClient = undefined;
        for (const c of server.server.clients.values()) {
            for (const w of c.getWindows().keys()) c.win(w)?.blur();
        }
    }
    private checkAndRmView() {
        const allAliveViews = new Set(this.win2View.values());
        this.views = this.views.filter((v) => allAliveViews.has(v));
    }
    static winId(clientId: string, windowId: WaylandWinId) {
        return `${clientId}-${windowId}` as MWinId;
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
            { id: "power" },
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
        next: [{ n: "lock" }, { n: "out" }],
    },
    out: { next: [] },
});

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
    mouseEl.style({ top: `${y}px`, left: `${x}px` });
    sendPointerEvent("move", new PointerEvent("pointermove", { clientX: x, clientY: y }));
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

function viewAll(s: boolean) {
    if (s) {
        windowElWarp.style({
            transition: "all 0.3s ease-in-out",
            transform: "scale(0.25)",
        });
    } else {
        windowElWarp.style({
            transition: "all 0.3s ease-in-out",
            transform: "none",
        });
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

function appLauncher(iconPath: () => Promise<string>, name: string, exec: string) {
    const p = appIcon(iconPath, name);
    p.on("click", () => {
        console.log("exec", exec);
        server.runApp(exec);
    });
    return p;
}

function appIcon(iconPath: () => Promise<string>, name: string) {
    const p = view().style({
        width: "48px",
        height: "48px",
        borderRadius: "12px",
        padding: "6px",
        overflow: "hidden",
        background: "#ffffff",
        flexShrink: 0,
    });
    iconPath().then((iconPath) => {
        if (iconPath)
            image(iconPath, name)
                .style({
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                })
                .addInto(p);
    });
    return p;
}

function sendPointerEvent(type: "move" | "down" | "up", p: PointerEvent) {
    if (viewAllShowing) return;
    for (const [_id, client] of server.server.clients) {
        for (const [winId, _win] of client.getWindows()) {
            const xwin = client.win(winId);
            if (!xwin) continue;
            const rect = render.getXdgSurfaceEle(xwin.point.renderId())?.getBoundingClientRect();
            if (!rect) continue;
            const nx = p.x - rect.left;
            const ny = p.y - rect.top;
            const inWin = xwin.point.inWin({ x: nx, y: ny });
            if (!inWin) continue;
            xwin.point.sendPointerEvent(
                type,
                new PointerEvent(p.type, { ...p, clientX: p.x - rect.left, clientY: p.y - rect.top }),
            );
            if (type === "down") {
                xwin.focus();
                viewData.focusWin(ViewData.winId(_id, winId));
                for (const [otherWinId, _otherWin] of client.getWindows()) {
                    if (otherWinId !== winId) {
                        client.win(otherWinId)?.blur();
                    }
                }
            }
            break;
        }
    }
}

function sendScrollEvent(p: WheelEvent) {
    if (viewAllShowing) return;
    for (const [_, client] of server.server.clients) {
        for (const [winId, _win] of client.getWindows()) {
            const xwin = client.win(winId);
            if (!xwin) continue;
            const rootEl = render.getXdgSurfaceEle(xwin.point.renderId());
            if (!rootEl) continue;
            const rect = rootEl.getBoundingClientRect();
            const nx = p.x - rect.left;
            const ny = p.y - rect.top;
            const inWin = xwin.point.inWin({ x: nx, y: ny });
            if (!inWin) continue;
            xwin.point.sendScrollEvent({
                p: p,
            });
        }
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

server.server.on("newClient", (client, clientId) => {
    client.setLogConfig({ receive: [], send: [] });
    client.onSync("windowBound", () => {
        const rect = windowEl.el.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
    });
    client.on("windowCreated", (windowId, renderId) => {
        console.log(`Client ${clientId} created window ${windowId}`, renderId);
        const v = viewData.newView();
        const wid = ViewData.winId(clientId, windowId);
        viewData.moveWinToView(wid, v);
        viewData.bindWinidClientid(wid, clientId, windowId);
        // biome-ignore lint/style/noNonNullAssertion: 刚刚创建的，一定有
        addWindow(v, render.getXdgSurfaceEle(renderId)!, wid);
        viewData.focusWin(wid);
        client.win(windowId)?.setWinBoxData({ width: 800, height: 600 });
        client.win(windowId)?.focus();
    });
    client.on("windowClosed", (windowId) => {
        console.log(`Client ${clientId} deleted window ${windowId}`);
        const winid = ViewData.winId(clientId, windowId);
        viewData.closeWin(winid);
    });
    client.on("windowStartMove", (windowId) => {
        const xwin = client.win(windowId);
        if (!xwin) return;

        const winEl = render.getXdgSurfaceEle(xwin.point.renderId());
        if (!winEl) return;
        const rect = winEl.getBoundingClientRect();

        const wid = ViewData.winId(clientId, windowId);
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
    client.on("windowMaximized", (windowId) => {
        const xwin = client.win(windowId);
        if (!xwin) return;

        const winEl = render.getXdgSurfaceEle(xwin.point.renderId());
        if (!winEl) return;
        const width = windowEl.el.offsetWidth;
        const height = windowEl.el.offsetHeight;
        pack(winEl).style({
            width: `${width}px`,
            height: `${height}px`,
            left: "0px",
            top: "0px",
        });
        xwin.maximize(width, height);
    });
    client.on("windowUnMaximized", (windowId) => {
        const xwin = client.win(windowId);
        if (!xwin) return;

        const winEl = render.getXdgSurfaceEle(xwin.point.renderId());
        if (!winEl) return;
        const width = 800;
        const height = 600;
        pack(winEl).style({
            width: `${width}px`,
            height: `${height}px`,
            left: "0px",
            top: "0px",
        });
        xwin.unmaximize(width, height);
    });
    client.on("windowResized", (windowId, width, height) => {
        const wid = ViewData.winId(clientId, windowId);
        const winEl = render.getXdgSurfaceEle(client.win(windowId)?.point.renderId() ?? "");
        if (winEl) {
            pack(winEl).style({
                width: `${width}px`,
                height: `${height}px`,
            });
            if (windowCenterManager.isEnabled() && !windowCenterManager.isPaused(wid)) {
                windowCenterManager.centerWindow(wid);
            }
        }
    });
});
server.server.on("clientClose", (client, clientId) => {
    for (const [winId, _] of client.getWindows()) {
        const winid = ViewData.winId(clientId, winId);
        viewData.closeWin(winid);
    }
});

const mainEl = view().style({ width: "100vw", height: "100vh", fontFamily: "sans-serif" }).addInto();

const bg = image(fs.readFileAsDataURLSync("/assets/wallpaper/1.svg"), "wallpaper").style({
    width: "100%",
    height: "100%",
    objectFit: "cover",
});

const windowElWarp = view().style({
    position: "absolute",
});

const toolsBottom = view();
const toolsTop = view()
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
tools.setTipEl(toolsTop.el);

const fullscreen = view();

const topest = view(); // 也是通知控制栏、锁屏
const toolTip = view();

state.setState("normal");
state.on("normal", () => {
    toolTip.style({ transform: "translateY(-100%)", transition: "0.4s" });
});
state.on("lock", () => {
    stateLock.setState("xipin");
});

stateLock.on("xipin", ({ nextTrigger }) => {
    toolTip
        .clear()
        .style({
            width: "100vw",
            height: "100vh",
            position: "fixed",
            top: "0",
            left: "0",
            background: "rgb(0,0,0)",
            transform: "translateY(0)",
        })
        .on("click", () => nextTrigger("lock"), { once: true });
});
stateLock.on("lock", ({ nextTrigger, leave }) => {
    toolTip
        .clear()
        .style({ background: "white" })
        .add("时间等")
        .on("click", () => nextTrigger("passwd"), { once: true });
    const t = setTimeout(() => {
        nextTrigger("xipin");
    }, 3000);
    leave(() => {
        clearTimeout(t);
    });
});
stateLock.on("passwd", ({ nextTrigger, leave }) => {
    const inputEl = uPasswdInput();
    inputEl.placeholder("请输入密码");
    inputEl.el.style({ width: px(sSize(5)), height: px(sSize(1)) });
    const timer = new Timer(30000);
    let cheking = false;
    async function check() {
        if (cheking) return;
        cheking = true;
        inputEl.disable(true);
        const r = await myde.MSysApi.verifyUserPassword(inputEl.el.gv);
        if (r) nextTrigger("out");
        else {
            inputEl.clear();
            inputEl.disable(false);
            inputEl.placeholder("密码错误，请重试"); // todo pam code
            cheking = false;
        }
    }

    toolTip.clear().add([inputEl.el, button("确认进入").on("click", check)]);

    inputEl.el.on("change", () => {
        check();
    });
    inputEl.el.on("input", () => {
        timer.reset();
        timer.start();
    });

    timer.on(() => {
        nextTrigger("lock");
    });
    timer.start();
    leave(() => {
        timer.reset();
    });
});
stateLock.on("out", () => {
    toolTip.clear();
    state.setState("normal");
});

mainEl.add([bg, windowElWarp, toolsBottom, toolsTop, fullscreen, topest, toolTip]);

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
            toolsTop.add(el);
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

MSysApi.power
    .init()
    .then(async () => {
        const power = MSysApi.power;
        const registry = rawRegistry;
        await power.init();

        // 获取初始电量数据
        let batteryPercentage = 0;
        for (const t of power.getDevices()) {
            if ((await t.getPowerSupply()) && ((await t.getType()) === "Battery" || (await t.getType()) === "Ups")) {
                batteryPercentage = await t.getPercentage();
                break;
            }
        }
        registry.setData("power.battery", batteryPercentage);

        // TODO: 监听属性变化并调用 registry.setData("power.battery", newValue)

        registry.setData(
            "power.devices",
            power.getDevices().map((device) => `power.devices.${device.path}` as id<"power.devices[]">),
        );

        // TODO: 监听设备添加/移除并调用 registry.setData("power.devices", newDevices)

        // todo 监听
        for (const device of power.getDevices()) {
            const name = (await device.getModel()) || "Unknown";
            const percentage = await device.getPercentage();
            const status = await device.getState();

            const id = `power.devices.${device.path}` as "power.devices[]";
            // todo 可以绑定id<"power.devices[]">
            registry.setData(id, { name, percentage, status });
        }
    })
    .catch((e) => console.error("power init error", e));

MSysApi.network
    .init()
    .then(async () => {
        const network = MSysApi.network;
        const registry = rawRegistry;
        await network.init();

        // 设置初始无线网络状态
        registry.setData("wifi.enabled", await network.isWirelessEnabled());

        registry.setSetCallback("wifi.enabled", (v) => network.setWirelessEnabled(v));

        // TODO: 监听属性变化并调用 registry.setData("wifi.enabled", newValue)

        const wifiDevice = network.getWifiDevices()[0];
        if (!wifiDevice) return;

        const aps = await wifiDevice.getAccessPoints();
        let c = "";
        const ids: string[] = [];
        for (const ap of aps) {
            const ssid = await ap.getSsid();
            if (!ssid) continue;
            if (await ap.isActive()) {
                c = ssid;
                continue;
            }
            ids.push(ssid);
        }
        registry.setData(
            "wifi.accessPoints",
            Array.from(new Set(c ? [c, ...ids] : ids)).map(
                (i) => `wifi.accessPoints.${i}` as id<"wifi.accessPoints[]">,
            ),
        );

        // TODO: 监听接入点变化并调用 registry.setData("wifi.accessPoints", newAccessPoints)

        for (const ap of await wifiDevice.getAccessPoints()) {
            const ssid = await ap.getSsid();
            if (!ssid) continue;

            // 获取初始接入点状态
            const active = await network.getActiveWifiConnection();
            registry.setData(`wifi.accessPoints.${ssid}` as "wifi.accessPoints[]", {
                ssid: ssid,
                connected: active?.id === ssid,
            });

            // TODO: 监听接入点状态变化并调用 registry.setData(...)
        }
    })
    .catch((e) => console.error("network init error", e));

MSysApi.blue
    .init()
    .then(async () => {
        const blue = MSysApi.blue;
        const registry = rawRegistry;
        await blue.init();

        registry.setData("blue.power", await blue.isPowered());
        registry.setSetCallback("blue.power", (v) => blue.setPowered(v));

        // TODO: 监听 D-Bus PropertiesChanged 并调用 registry.setData("blue.power", newValue)

        const c: string[] = [];
        const l: string[] = [];
        // connect变化时也更新
        for (const d of blue.getDevices()) {
            if (await d.isTrusted()) {
                if (await d.isConnected()) c.push(await d.getAddress());
                else l.push(await d.getAddress());
            }
        }
        registry.setData(
            "blue.devices",
            c.concat(l).map((i) => `blue.devices.${i}` as id<"blue.devices[]">),
        );

        // TODO: 监听设备添加/移除并调用 registry.setData("blue.devices", newDevices)

        for (const d of blue.getDevices()) {
            const name = await d.getName();
            const connected = await d.isConnected();
            registry.setData(`blue.devices.${await d.getAddress()}` as "blue.devices[]", {
                name,
                connected,
            });

            // TODO: 监听设备状态变化并调用 registry.setData(...)
        }
    })
    .catch((e) => console.error("blue init error", e));

const notifications = new Map<string, { title: string; content: string; id: string }>();

MSysApi.notification
    .init()
    .then(() => {
        const registry = rawRegistry;
        MSysApi.notification.on("new", (n) => {
            const id = crypto.randomUUID();
            notifications.set(id, { content: n.body, title: n.summary, id });

            registry.setData("notification.list", Array.from(notifications.keys()) as id<"notification.list[]">[]);

            registry.setData(`notification.list.${id}` as "notification.list[]", {
                title: n.summary,
                content: n.body,
            });
            registry.setSetCallback(`notification.list.${id}.delete` as "notification.list[].delete", () => {
                notifications.delete(id);
                registry.setData("notification.list", Array.from(notifications.keys()) as id<"notification.list[]">[]);
                return Promise.resolve();
            });
        });
    })
    .catch((e) => console.error("notification init error", e));

const mediaControl = new Set<string>();
MSysApi.media
    .init()
    .then(() => {
        const media = MSysApi.media;
        const registry = rawRegistry;

        media.on("new-player", async (p) => {
            const serverName = p.getServerName();
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

            setInterval(() => {
                p.getCurrentTime().then((v) => {
                    registry.setData(registry.buildVarId("media.list[].currentTime", [serverName]), v);
                });
            }, 100);
            registry.setSetCallback(registry.buildVarId("media.list[].currentTime", [serverName]), (v) => {
                p.setCurrentTime(v);
                return Promise.resolve();
            });
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
        const t = tray.tarysService.get(k);
        if (!t) return;
        rawRegistry.setData(rawRegistry.buildVarId("tray.list[]", [k]), {
            icon:
                (await t.getIcon({
                    theme: setting.get("icon.theme"),
                })) || "",
            title: await t.title(),
            itemIsMenu: await t.itemIsMenu(),
        });
        t.getMenu().then((menu) => {
            rawRegistry.setData(rawRegistry.buildVarId("tray.list[].menu", [k]), menu);
        });
        t.ev.on("menuUpdate", async () => {
            t.getMenu().then((menu) => {
                rawRegistry.setData(rawRegistry.buildVarId("tray.list[].menu", [k]), menu);
            });
        });
        rawRegistry.setSetCallback(rawRegistry.buildVarId("tray.list[].active", [k]), () => {
            t.activate();
            return Promise.resolve();
        });
    }
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
    const showAllViewBtn = button("≡").on("click", () => {
        viewAllShowing = !viewAllShowing;
        viewAll(viewAllShowing);
    });
    return showAllViewBtn;
});

tools.registerTool("startMenuFullScreen", ({ tipEl, showTip }) => {
    const iconConfig: DesktopIconConfig = {
        theme: setting.get("icon.theme"),
    };
    const menu = view("x", "wrap")
        .style({
            width: "80vw",
            height: "80vh",
            padding: "20px",
            borderRadius: "20px",
            overflowY: "scroll",
        })
        .addInto(mainEl);
    MSysApi.getDesktopEntries().then(async (apps) => {
        for (const app of apps) {
            await scheduler.yield();
            const appEl = view("y")
                .style({
                    width: "80px",
                    height: "80px",
                    alignItems: "center",
                    justifyContent: "flex-start",
                })
                .addInto(menu);
            const iconView = view().addInto(appEl);
            iconView.add(
                appLauncher(
                    async () => (await MSysApi.getDesktopIcon(app.icon, iconConfig)) || "",
                    app.name,
                    app.exec,
                ).style({
                    width: "40px",
                    height: "40px",
                }),
            );
            appEl.add(
                txt(app.nameLocal).style({
                    fontSize: "12px",
                    maxWidth: "80%",
                    overflow: "hidden",
                    textAlign: "center",
                }),
            );
        }
    });
    tipEl.innerHTML = "";
    menu.addInto(tipEl);
    const startMenuBtn = view()
        .style({
            width: "48px",
            height: "48px",
            borderRadius: "12px",
            background: "#00aaff",
        })
        .on("click", async () => {
            showTip({ state: "toggle" });
        });
    return startMenuBtn;
});

tools.registerTool("clock", () => {
    const clockEl = txt("00:00");
    function updateTime() {
        const now = new Date();
        const hours = now.getHours().toString().padStart(2, "0");
        const minutes = now.getMinutes().toString().padStart(2, "0");
        clockEl.sv(`${hours}:${minutes}`);
    }
    updateTime();
    setInterval(updateTime, 60000);
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
    const nowApps = new Map<string, { iconEl: ElType<HTMLElement>; clients: Set<WaylandClient> }>();
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
    async function addAppIcon(c: WaylandClient) {
        const appid = c.getAppid();
        if (!appid) return;
        if (nowApps.has(appid)) {
            // biome-ignore lint/style/noNonNullAssertion: ---
            nowApps.get(appid)!.clients.add(c);
            return;
        }
        const desk = await MSysApi.getDesktopEntry(appid);
        const iconPath = async () => (await MSysApi.getDesktopIcon(desk?.icon || "", iconConfig)) || "";
        const appEl = appIcon(iconPath, desk?.name || appid);
        appsEl.add(appEl);
        nowApps.set(appid, { iconEl: appEl, clients: new Set([c]) });
        appEl.on("click", () => {
            const data = nowApps.get(appid);
            if (!data) return;
            const allWin = Array.from(data.clients).flatMap((c) => Array.from(c.getWindows()));
            if (allWin.length === 0) return;
            const focusedWinIndex = allWin.findIndex(([_, w]) => w.actived);
            if (focusedWinIndex === -1) {
                jump2Win(ViewData.winId(c.id, allWin[0][0]));
            } else {
                const nextIndex = (focusedWinIndex + 1) % allWin.length;
                jump2Win(ViewData.winId(c.id, allWin[nextIndex][0]));
            }
        });
        appEl
            .on("pointerenter", () => {
                const data = nowApps.get(appid);
                if (!data) return;
                autoHide.moveTo("reset");
                preview.clear();
                if (a === "left" || a === "right") {
                    preview.style({ flexDirection: "column" });
                } else {
                    preview.style({ flexDirection: "row" });
                }
                const allWin = Array.from(data.clients).flatMap((c) =>
                    Array.from(c.getWindows()).map((x) => ({ ...x[1], id: x[0], c })),
                );

                preview.clear().add(
                    allWin.map((x) => {
                        const el = view();
                        const titleText = x.c.win(x.id)?.getTitle() || "";
                        el.add(txt(titleText));
                        const canvas = ele("canvas").addInto(el);
                        const win = x.c.win(x.id);
                        if (!win) return undefined;
                        const rawCanvas = win.getPreview();
                        const { w, h } = fitRect({ w: rawCanvas.width, h: rawCanvas.height }, 200, 150);
                        canvas.attr({ width: w, height: h });
                        // biome-ignore lint/style/noNonNullAssertion: ---
                        const ctx = canvas.el.getContext("2d")!;
                        ctx.drawImage(rawCanvas, 0, 0, rawCanvas.width, rawCanvas.height, 0, 0, w, h);
                        el.on("click", () => {
                            jump2Win(ViewData.winId(x.c.id, x.id));
                        });
                        return el;
                    }),
                );
                showTip({ state: "show", anchorEl: appEl.el });
            })
            .on("pointerleave", () => {
                autoHide.moveTo("hide");
            });
    }
    for (const [_id, c] of server.server.clients) {
        addAppIcon(c);
        bindC(c);
    }
    function checkAndTryRm(id: string) {
        const app = nowApps.get(id);
        if (!app) return;
        if (
            Array.from(app.clients)
                .map((i) => i.getWindows().size)
                .reduce((a, b) => a + b, 0) === 0
        ) {
            app.iconEl.remove();
            nowApps.delete(id);
        }
    }
    function bindC(c: WaylandClient) {
        c.on("appid", () => {
            addAppIcon(c);
        });
        c.on("close", () => {
            const appid = c.getAppid();
            if (!appid) return;
            const app = nowApps.get(appid);
            if (app) {
                app.clients.delete(c);
                checkAndTryRm(appid);
            }
        });
        c.on("windowClosed", () => {
            const appid = c.getAppid();
            if (!appid) return;
            checkAndTryRm(appid);
        });
    }
    server.server.on("newClient", (c, _id) => {
        bindC(c);
    });
    return appsEl;
});

tools.registerTool(
    "login",
    ({ tipEl, showTip }) => {
        const el = view().add("电源");

        ui.bar([
            ui.barItem().add(
                iItem({ type: "h", size: 1 }).add(
                    bButton("锁屏", () => {
                        state.setState("lock");
                    }),
                ),
            ),
            ui.barItem().add([
                iItem({ type: "h", size: 1 }).add(
                    bButton("关机", async () => {
                        const t = await confirm("确认 关机？");
                        if (t) MSysApi.login("shutdown");
                    }),
                ),
                iItem({ type: "h", size: 1 }).add(
                    bButton("重启", async () => {
                        const t = await confirm("确认 重启？");
                        if (t) MSysApi.login("restart");
                    }),
                ),
                iItem({ type: "h", size: 1 }).add(
                    bButton("挂起", async () => {
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
        const btn = button("🎵").on("click", () => {
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
        const el = view("x");

        // 顶部显示电池状态
        const batteryIndicator = uipool["power.battery"]();
        el.add(batteryIndicator.el);

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
        const el = view("x").add("网络");
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
    "blue",
    ({ tipEl, showTip }) => {
        const el = view("x").add("蓝牙");
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
        const btn = button("🔔").on("click", () => {
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

const wino = { t: 0, l: 0, r: 0, b: 0 };
for (const p of planteData) {
    const plantEl = view().style({ position: "absolute" }).addInto(toolsBottom);
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
    body: {
        userSelect: "none",
    },
});

body.on("pointermove", (e) => {
    mouseMove(e.x, e.y);
});
windowEl.on("pointerdown", (e) => {
    sendPointerEvent("down", e);
});
windowEl.on("pointerup", (e) => {
    sendPointerEvent("up", e);
});

body.on("keydown", (e) => {
    if (state.getState() === "normal") {
        e.preventDefault();
        if (e.repeat) return;
        for (const [id, client] of server.server.clients) {
            if (id !== viewData.focusClient) continue;
            client.keyboard.sendKey(MInputMap.mapKeyCode(e.code), "pressed");
        }
    }
});
body.on("keyup", (e) => {
    if (state.getState() === "normal") {
        e.preventDefault();
        if (e.repeat) return;
        for (const [id, client] of server.server.clients) {
            if (id !== viewData.focusClient) continue;
            client.keyboard.sendKey(MInputMap.mapKeyCode(e.code), "released");
        }
    }
});

windowEl.on("wheel", (e) => {
    sendScrollEvent(e);
});

const mouseEl = view().addInto().style({
    position: "fixed",
    width: "10px",
    height: "10px",
    background: "rgba(0,0,0,0.5)",
    outline: "1px solid #fff",
    borderRadius: "50%",
    pointerEvents: "none",
    top: "0px",
    left: "0px",
    transform: "translate(-50%, -50%)",
    zIndex: 9999,
});

MSysApi.getDesktopEntries().then((e) => {
    for (const x of e) {
        MSysApi.getDesktopIcon(x.icon, {
            theme: setting.get("icon.theme"),
        });
    }
}); // 预加载
