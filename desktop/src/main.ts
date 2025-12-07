import { button, type ElType, image, pack, setProperty, view } from "dkh-ui";

import type { DesktopIconConfig, WaylandClient } from "../../src/renderer/desktop-api";
import { txt } from "dkh-ui";

const { MSysApi, MRootDir, MInputMap } = window.myde;

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

class Tools {
    tools: Map<string, () => ElType<HTMLElement>>;
    constructor() {
        this.tools = new Map();
    }
    registerTool(name: string, tool: () => ElType<HTMLElement>) {
        this.tools.set(name, tool);
    }
    getTool(name: string) {
        return this.tools.get(name);
    }
}

const viewData: View[] = [];

const planteData: Plant[] = [
    { id: "0", posi: "top", items: [{ id: "showAllView" }, { id: "clock" }], glow: true },
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

function newView() {
    const v: View = { ox: viewData.length, oy: 0 };
    viewData.push(v);
    return v;
}
function newViewEl(v: View) {
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

function addWindow(el: HTMLElement) {
    const v = newView();
    const pel = newViewEl(v);
    pel.add(el);
    setViewScorll({ x: v.ox, y: v.oy });

    pack(el).style({
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%,-50%)",
    });
}

function appIcon(iconPath: string, name: string, exec: string) {
    const p = view().style({
        width: "48px",
        height: "48px",
        borderRadius: "12px",
        padding: "6px",
        overflow: "hidden",
        background: "#ffffff",
        flexShrink: 0,
    });
    if (iconPath)
        image(iconPath, name)
            .style({
                width: "100%",
                height: "100%",
                objectFit: "cover",
            })
            .addInto(p);
    p.on("click", () => {
        console.log("exec", exec);
        server.runApp(exec);
    });
    return p;
}

function sendPointerEvent(type: "move" | "down" | "up", p: PointerEvent) {
    if (viewAllShowing) return;
    for (const [_id, client] of server.server.clients) {
        for (const [winId, _win] of client.getWindows()) {
            const xwin = client.win(winId);
            if (!xwin) continue;
            const inWin = xwin.point.inWin(p);
            if (!inWin) continue;
            const rect = xwin.point.rootWinEl().getBoundingClientRect();
            xwin.point.sendPointerEvent(
                type,
                new PointerEvent(p.type, { ...p, clientX: p.x - rect.left, clientY: p.y - rect.top }),
            );
            if (type === "down") {
                xwin.focus();
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
            const inWin = xwin.point.inWin(p);
            if (!inWin) continue;
            xwin.point.sendScrollEvent({
                p: p,
            });
        }
    }
}

// @ts-expect-error
window.dy = () => dyj电源键.fire();

const server = MSysApi.server();

server.server.on("newClient", (client, clientId) => {
    clientData.set(clientId, { client });
    client.setLogConfig({ receive: [], send: [] });
    client.onSync("windowBound", () => {
        const rect = windowEl.el.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
    });
    client.on("windowCreated", (windowId, el) => {
        console.log(`Client ${clientId} created window ${windowId}`);
        addWindow(el);
        client.win(windowId)?.setWinBoxData({ width: 800, height: 600 });
        client.win(windowId)?.focus();
    });
    client.on("windowClosed", (windowId, el) => {
        console.log(`Client ${clientId} deleted window ${windowId}`);
        el.remove();
    });
    client.on("windowStartMove", (windowId) => {
        const xwin = client.win(windowId);
        if (!xwin) return;

        const winEl = xwin.point.rootWinEl();
        const rect = winEl.getBoundingClientRect();

        // todo track point
        const startX = mousePos.x;
        const startY = mousePos.y;

        const origLeft = rect.left;
        const origTop = rect.top;

        function onPointerMove() {
            const newLeft = Math.round(mousePos.x - startX + origLeft);
            const newTop = Math.round(mousePos.y - startY + origTop);
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

        const winEl = xwin.point.rootWinEl();
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

        const winEl = xwin.point.rootWinEl();
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
});
server.server.on("clientClose", (_, clientId) => {
    clientData.delete(clientId);
});

const clientData = new Map<string, { client: WaylandClient }>();

const mainEl = view().style({ width: "100vw", height: "100vh" }).addInto();

const bg = image(`${MRootDir}/assets/wallpaper/1.svg`, "wallpaper").style({
    width: "100%",
    height: "100%",
    objectFit: "cover",
});

const windowElWarp = view().style({
    position: "absolute",
});

const toolsBottom = view();
const toolsTop = view();
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
    toolTip.clear().add(button("确认进入").on("click", () => nextTrigger("out"), { once: true }));
    const t = setTimeout(() => {
        nextTrigger("lock");
    }, 3000);
    leave(() => {
        clearTimeout(t);
    });
});
stateLock.on("out", () => {
    toolTip.clear();
    state.setState("normal");
});

mainEl.add([bg, toolsBottom, windowElWarp, toolsTop, topest, toolTip]);

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

const ob = new ResizeObserver((e) => {
    for (const entry of e) {
        const rect = entry.contentRect;
        viewWidth.setValue(`${rect.width}px`);
        viewHeight.setValue(`${rect.height}px`);
    }
});

ob.observe(windowEl.el);

tools.registerTool("showAllView", () => {
    const showAllViewBtn = button("≡").on("click", () => {
        viewAllShowing = !viewAllShowing;
        viewAll(viewAllShowing);
    });
    return showAllViewBtn;
});

tools.registerTool("startMenuFullScreen", () => {
    const iconConfig: DesktopIconConfig = {
        theme: "breeze",
    };
    const startMenuBtn = view()
        .style({
            width: "48px",
            height: "48px",
            borderRadius: "12px",
            background: "#00aaff",
        })
        .on("click", async () => {
            const menu = view("x", "wrap")
                .style({
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: "100%",
                    height: "100%",
                    padding: "20px",
                    background: "rgba(255, 255, 255, 0.4)",
                    backdropFilter: "blur(24px)",
                    zIndex: 1000,
                    overflowY: "scroll",
                })
                .addInto(mainEl);
            menu.on("click", (_, el) => {
                if (el.el === menu.el) {
                    menu.remove();
                }
            });
            for (const app of await MSysApi.getDesktopEntries()) {
                const appEl = view("y")
                    .style({
                        width: "80px",
                        height: "80px",
                        alignItems: "center",
                        justifyContent: "flex-start",
                    })
                    .addInto(menu);
                const iconView = view().addInto(appEl);
                MSysApi.getDesktopIcon(app.icon, iconConfig).then((_iconPath) => {
                    const iconPath = _iconPath || "";
                    iconView.add(
                        appIcon(iconPath, app.name, app.exec).style({
                            width: "40px",
                            height: "40px",
                            borderRadius: "8px",
                            background: "#ffffff",
                        }),
                    );
                });
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

tools.registerTool("apps", () => {
    const appsEl = view().style({
        display: "flex",
        flexDirection: "inherit",
    });

    const iconConfig: DesktopIconConfig = {
        theme: "breeze",
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
            const iconPath =
                (await MSysApi.getDesktopIcon(browserApp.icon, iconConfig)) || `${MRootDir}/assets/icons/browser.png`;
            appIcon(iconPath, browserApp.name, browserApp.exec).addInto(appsEl);
        }
        if (fileManagerApp) {
            const iconPath =
                (await MSysApi.getDesktopIcon(fileManagerApp.icon, iconConfig)) ||
                `${MRootDir}/assets/icons/file-manager.png`;
            appIcon(iconPath, fileManagerApp.name, fileManagerApp.exec).addInto(appsEl);
        }
        if (terminalApp) {
            const iconPath =
                (await MSysApi.getDesktopIcon(terminalApp.icon, iconConfig)) || `${MRootDir}/assets/icons/terminal.png`;
            appIcon(iconPath, terminalApp.name, terminalApp.exec).addInto(appsEl);
        }
    });
    return appsEl;
});

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
        plantEl.style(d === "x" ? { width: "100%" } : { height: "100%" });
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
        plantEl.add(tt());
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

body.on("pointermove", (e) => {
    mouseMove(e.x, e.y);
});
body.on("pointerdown", (e) => {
    sendPointerEvent("down", e);
});
body.on("pointerup", (e) => {
    sendPointerEvent("up", e);
});

body.on("keydown", (e) => {
    if (e.repeat) return;
    for (const client of server.server.clients.values()) {
        client.keyboard.sendKey(MInputMap.mapKeyCode(e.code), "pressed");
    }
});
body.on("keyup", (e) => {
    if (e.repeat) return;
    for (const client of server.server.clients.values()) {
        client.keyboard.sendKey(MInputMap.mapKeyCode(e.code), "released");
    }
});

body.on("wheel", (e) => {
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
