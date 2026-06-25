import { button, image, pack, txt, view } from "dkh-ui";

import type { WaylandWinId } from "../../../src/desktop-api";
import type { blueDevice } from "../../../src/sys_api/blue";

const { MSysApi, MInputMap, MUtils } = myde;

type WinState = {
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
};

type MWinId = string & { __brand: "MWinId" };

const windowStates = new Map<MWinId, WinState>();
const windowElements = new Map<MWinId, HTMLElement>();
let currentZIndex = 1;
let focusClientId: string | undefined;
let focusWinId: WaylandWinId | undefined;

function createWindowId(clientId: string, windowId: WaylandWinId): MWinId {
    return `${clientId}-${windowId}` as MWinId;
}

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
        const rect = mainEl.el.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
    });

    client.on("windowCreated", (windowId, renderId) => {
        const wid = createWindowId(clientId, windowId);
        const winEl = render.getXdgSurfaceEle(renderId);

        if (winEl) {
            windowElements.set(wid, winEl);

            const mainRect = mainEl.el.getBoundingClientRect();
            const state: WinState = {
                x: (mainRect.width - 800) / 2,
                y: (mainRect.height - 600) / 2,
                width: 800,
                height: 600,
                zIndex: currentZIndex++,
            };
            windowStates.set(wid, state);

            pack(winEl).style({
                position: "absolute",
                left: `${state.x}px`,
                top: `${state.y}px`,
                width: `${state.width}px`,
                height: `${state.height}px`,
                zIndex: `${state.zIndex}`,
                borderRadius: "8px",
                overflow: "hidden",
                boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
            });

            const titleBar = view()
                .style({
                    height: "32px",
                    background: "rgba(240,240,240,0.9)",
                    borderBottom: "1px solid #ddd",
                    display: "flex",
                    alignItems: "center",
                    padding: "0 8px",
                    userSelect: "none",
                })
                .add(winEl);

            txt(client.win(windowId)?.getTitle() || "Window")
                .style({ flex: "1", fontSize: "13px", color: "#333" })
                .addInto(titleBar);

            button("×")
                .style({
                    width: "24px",
                    height: "24px",
                    borderRadius: "50%",
                    background: "#ff5f57",
                    border: "none",
                    cursor: "pointer",
                    fontSize: "14px",
                    lineHeight: "24px",
                    textAlign: "center",
                })
                .on("click", () => client.win(windowId)?.close())
                .addInto(titleBar);

            mainEl.add(winEl);
            focusWindow(clientId, windowId);
        }
    });

    client.on("windowClosed", (windowId) => {
        const wid = createWindowId(clientId, windowId);
        windowStates.delete(wid);
        windowElements.delete(wid);
        updateTaskbar();
    });

    client.on("windowStartMove", (windowId) => {
        const xwin = client.win(windowId);
        if (!xwin) return;

        const winEl = render.getXdgSurfaceEle(xwin.point.renderId());
        if (!winEl) return;

        const startX = mousePos.x;
        const startY = mousePos.y;
        const rect = winEl.getBoundingClientRect();
        const origLeft = rect.left;
        const origTop = rect.top;

        function onPointerMove() {
            const newLeft = Math.round(mousePos.x - startX + origLeft);
            const newTop = Math.round(mousePos.y - startY + origTop);
            if (winEl) {
                winEl.style.left = `${newLeft}px`;
                winEl.style.top = `${newTop}px`;
            }
        }

        function cleanup() {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
        }

        function onPointerUp() {
            cleanup();
        }

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp, { once: true });
    });

    client.on("windowMaximized", (windowId) => {
        const xwin = client.win(windowId);
        if (!xwin) return;

        const winEl = render.getXdgSurfaceEle(xwin.point.renderId());
        if (!winEl) return;

        const mainRect = mainEl.el.getBoundingClientRect();
        pack(winEl).style({
            width: `${mainRect.width}px`,
            height: `${mainRect.height - 48}px`,
            left: "0px",
            top: "0px",
        });
        xwin.maximize(mainRect.width, mainRect.height - 48);
    });

    client.on("windowUnMaximized", (windowId) => {
        const xwin = client.win(windowId);
        if (!xwin) return;

        const winEl = render.getXdgSurfaceEle(xwin.point.renderId());
        if (!winEl) return;

        pack(winEl).style({
            width: "800px",
            height: "600px",
            left: "0px",
            top: "0px",
        });
        xwin.unmaximize(800, 600);
    });

    client.on("close", () => {
        updateTaskbar();
    });
});

function focusWindow(clientId: string, windowId: WaylandWinId) {
    focusClientId = clientId;
    focusWinId = windowId;

    for (const [cid, client] of Array.from(server.server.clients)) {
        for (const [wid] of Array.from(client.getWindows())) {
            if (cid === clientId && wid === windowId) {
                client.win(wid)?.focus();
            } else {
                client.win(wid)?.blur();
            }
        }
    }

    const mWinId = createWindowId(clientId, windowId);
    const state = windowStates.get(mWinId);
    if (state) {
        state.zIndex = currentZIndex++;
        const el = windowElements.get(mWinId);
        if (el) {
            el.style.zIndex = `${state.zIndex}`;
        }
    }

    updateTaskbar();
}

function sendPointerEvent(type: "move" | "down" | "up", p: PointerEvent) {
    for (const [clientId, client] of Array.from(server.server.clients)) {
        for (const [winId] of Array.from(client.getWindows())) {
            const xwin = client.win(winId);
            if (!xwin) continue;

            const rect = render.getXdgSurfaceEle(xwin.point.renderId())?.getBoundingClientRect();
            if (!rect) continue;

            const nx = p.x - rect.left;
            const ny = p.y - rect.top;

            if (xwin.point.inWin({ x: nx, y: ny })) {
                xwin.point.sendPointerEvent(type, new PointerEvent(p.type, { ...p, clientX: nx, clientY: ny }));

                if (type === "down") {
                    focusWindow(clientId, winId);
                }
                break;
            }
        }
    }
}

function sendScrollEvent(p: WheelEvent) {
    for (const [, client] of Array.from(server.server.clients)) {
        for (const [winId] of Array.from(client.getWindows())) {
            const xwin = client.win(winId);
            if (!xwin) continue;

            const rootEl = render.getXdgSurfaceEle(xwin.point.renderId());
            if (!rootEl) continue;

            const rect = rootEl.getBoundingClientRect();
            const nx = p.x - rect.left;
            const ny = p.y - rect.top;

            if (xwin.point.inWin({ x: nx, y: ny })) {
                xwin.point.sendScrollEvent({ p });
            }
        }
    }
}

const mousePos = { x: 0, y: 0 };

const mouseEl = view()
    .style({
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
        zIndex: "9999",
    })
    .addInto();

const mainEl = view()
    .style({
        width: "100vw",
        height: "100vh",
        position: "relative",
        overflow: "hidden",
    })
    .addInto();

view()
    .style({ background: "linear-gradient(135deg, #e0e0e0, #f5f5f5)", width: "100%", height: "100%" })
    .addInto(mainEl);

const taskbar = view()
    .style({
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: "48px",
        background: "rgba(240,240,240,0.9)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: "8px",
        borderTop: "1px solid #ddd",
    })
    .addInto(mainEl);

button("≡")
    .style({
        width: "36px",
        height: "36px",
        borderRadius: "8px",
        border: "none",
        background: "#00aaff",
        cursor: "pointer",
        fontSize: "18px",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
    })
    .on("click", () => {
        openLauncher();
    })
    .addInto(taskbar);

const taskbarApps = view()
    .style({
        display: "flex",
        gap: "4px",
        flex: "1",
    })
    .addInto(taskbar);
const networkBtn = txt("网络").style({ fontSize: "13px", color: "#333", cursor: "pointer" }).addInto(taskbar);

const blueBtn = txt("蓝牙").style({ fontSize: "13px", color: "#333", cursor: "pointer" }).addInto(taskbar);

const powerBtn = txt("").style({ fontSize: "13px", color: "#333", cursor: "pointer" }).addInto(taskbar);

const trayEl = view().style({ display: "flex", gap: "4px" }).addInto(taskbar);

const clock = txt("")
    .style({
        fontSize: "13px",
        color: "#333",
    })
    .addInto(taskbar);

function updateClock() {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, "0");
    const minutes = now.getMinutes().toString().padStart(2, "0");
    clock.sv(`${hours}:${minutes}`);
}

updateClock();
setInterval(updateClock, 60000);

async function openLauncher() {
    const menu = view("x", "wrap")
        .style({
            position: "absolute",
            left: "0",
            top: "0",
            width: "100%",
            height: "calc(100% - 48px)",
            padding: "20px",
            background: "rgba(255, 255, 255, 0.4)",
            backdropFilter: "blur(24px)",
            zIndex: "1000",
            overflowY: "scroll",
        })
        .addInto(mainEl);

    menu.on("click", (_, el) => {
        if (el.el === menu.el) {
            menu.remove();
        }
    });

    for (const app of await MSysApi.getDesktopEntries()) {
        await new Promise((r) => setTimeout(r, 0));
        const appEl = view("y")
            .style({
                width: "80px",
                height: "80px",
                alignItems: "center",
                justifyContent: "flex-start",
                cursor: "pointer",
            })
            .addInto(menu);

        const iconView = view()
            .style({
                width: "48px",
                height: "48px",
                borderRadius: "12px",
                padding: "6px",
                overflow: "hidden",
                background: "#ffffff",
                flexShrink: "0",
            })
            .addInto(appEl);

        const iconUrl = (await MSysApi.getDesktopIcon(app.icon, {})) || "";
        if (iconUrl) {
            image(iconUrl, app.name)
                .style({
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                })
                .addInto(iconView);
        }

        appEl.add(
            txt(app.nameLocal).style({ fontSize: "12px", maxWidth: "80%", overflow: "hidden", textAlign: "center" }),
        );

        appEl.on("click", () => {
            server.runApp(app.exec);
            menu.remove();
        });
    }
}

function updateTaskbar() {
    taskbarApps.clear();

    for (const [clientId, client] of Array.from(server.server.clients)) {
        for (const [winId, win] of Array.from(client.getWindows())) {
            const appid = client.getAppid();
            const title = win.title || appid || "Window";
            const isFocused = clientId === focusClientId && winId === focusWinId;

            button(title)
                .style({
                    height: "36px",
                    padding: "0 12px",
                    borderRadius: "6px",
                    border: "none",
                    background: isFocused ? "rgba(0,0,0,0.1)" : "transparent",
                    cursor: "pointer",
                    fontSize: "12px",
                    color: "#333",
                    maxWidth: "120px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                })
                .on("click", () => {
                    focusWindow(clientId, winId);
                })
                .addInto(taskbarApps);
        }
    }
}

document.addEventListener("pointermove", (e) => {
    mousePos.x = e.clientX;
    mousePos.y = e.clientY;
    mouseEl.style({ top: `${e.clientY}px`, left: `${e.clientX}px` });
    sendPointerEvent("move", e);
});

mainEl.on("pointerdown", (e) => {
    sendPointerEvent("down", e);
});

mainEl.on("pointerup", (e) => {
    sendPointerEvent("up", e);
});

document.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    for (const [id, client] of Array.from(server.server.clients)) {
        if (id !== focusClientId) continue;
        client.keyboard.sendKey(MInputMap.mapKeyCode(e.code), "pressed");
    }
});

document.addEventListener("keyup", (e) => {
    if (e.repeat) return;
    for (const [id, client] of Array.from(server.server.clients)) {
        if (id !== focusClientId) continue;
        client.keyboard.sendKey(MInputMap.mapKeyCode(e.code), "released");
    }
});

mainEl.on("wheel", (e) => {
    sendScrollEvent(e);
});

MSysApi.network.init().then(async () => {
    const activeWifi = await MSysApi.network.getActiveWifiConnection();
    if (activeWifi) {
        networkBtn.sv(`🔗 ${activeWifi.id}`);
    }
    networkBtn.on("click", async () => {
        const list = view("y").addInto(mainEl);
        list.style({
            position: "absolute",
            bottom: "56px",
            left: "12px",
            background: "rgba(255,255,255,0.9)",
            padding: "8px",
            borderRadius: "8px",
            minWidth: "200px",
        });
        if (activeWifi) {
            view("x").style({ whiteSpace: "pre" }).addInto(list).add(`🔗 ${activeWifi.id}`);
        }
        const devices = MSysApi.network.getWifiDevices();
        for (const n of await devices[0].getAccessPoints()) {
            const name = (await n.getSsid()) || "Unknown";
            if (name === activeWifi?.id) continue;
            view("x").style({ whiteSpace: "pre" }).addInto(list).add(`${name}`);
        }
        const close = () => {
            list.remove();
        };
        list.on("pointerdown", (e) => {
            e.stopPropagation();
        });
        mainEl.on("pointerdown", close, { once: true });
    });
});

MSysApi.blue.init().then(async () => {
    const state = await MSysApi.blue.isPowered();
    blueBtn.sv(state ? "蓝牙" : "蓝牙(关)");
    blueBtn.on("click", async () => {
        const list = view("y").addInto(mainEl);
        list.style({
            position: "absolute",
            bottom: "56px",
            left: "80px",
            background: "rgba(255,255,255,0.9)",
            padding: "8px",
            borderRadius: "8px",
            minWidth: "200px",
        });
        const powered = await MSysApi.blue.isPowered();
        txt(powered ? "已开启" : "已关闭").addInto(list);
        const c: blueDevice[] = [];
        const uc: blueDevice[] = [];
        for (const d of MSysApi.blue.getDevices()) {
            if (await d.isConnected()) c.push(d);
            else if (await d.isTrusted()) uc.push(d);
        }
        for (const d of c) {
            const name = (await d.getName()) || "Unknown";
            view("x").addInto(list).add(`🔗 ${name}`);
        }
        for (const d of uc) {
            const name = (await d.getName()) || "Unknown";
            view("x").addInto(list).add(`🔌 ${name}`);
        }
        const close = () => {
            list.remove();
        };
        list.on("pointerdown", (e) => {
            e.stopPropagation();
        });
        mainEl.on("pointerdown", close, { once: true });
    });
});

MSysApi.power.init().then(async () => {
    for (const t of MSysApi.power.getDevices()) {
        if ((await t.getPowerSupply()) && ((await t.getType()) === "Battery" || (await t.getType()) === "Ups")) {
            const percentage = await t.getPercentage();
            powerBtn.sv(`🔋${percentage}%`);
        }
    }
    powerBtn.on("click", async () => {
        const list = view("y").addInto(mainEl);
        list.style({
            position: "absolute",
            bottom: "56px",
            right: "12px",
            background: "rgba(255,255,255,0.9)",
            padding: "8px",
            borderRadius: "8px",
            minWidth: "200px",
        });
        for (const t of MSysApi.power.getDevices()) {
            const name = (await t.getModel()) || "Unknown";
            const percentage = await t.getPercentage();
            const status = await t.getState();
            view("x").addInto(list).add(`${name}: ${percentage}% (${status})`);
        }
        const close = () => {
            list.remove();
        };
        list.on("pointerdown", (e) => {
            e.stopPropagation();
        });
        mainEl.on("pointerdown", close, { once: true });
    });
});

MSysApi.tray.init().then(async () => {
    for (const t of Array.from(MSysApi.tray.tarysService.values())) {
        const icon = view().addInto(trayEl);
        image((await t.getIcon({})) || "", await t.title())
            .style({ width: "24px", height: "24px", objectFit: "cover" })
            .addInto(icon);
        icon.on("click", async () => {
            const menu = await t.getMenu();
            if (!menu) return;
            const menuEl = view("y").addInto(mainEl);
            menuEl.style({
                position: "absolute",
                bottom: "56px",
                right: "12px",
                background: "rgba(255,255,255,0.9)",
                padding: "8px",
                borderRadius: "8px",
            });
            for (const item of menu) {
                const itemEl = view("x").style({ whiteSpace: "pre" }).addInto(menuEl);
                if (item.iconUrl) {
                    image((await item.iconUrl({})) ?? "", "icon")
                        .style({ width: "16px", height: "16px", objectFit: "cover" })
                        .addInto(itemEl);
                }
                txt(item.label).addInto(itemEl);
                itemEl.on("click", () => {
                    item.click();
                    menuEl.remove();
                });
            }
        });
    }
});

server.runApp("weston-terminal");
