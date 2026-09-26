import { button, image, pack, txt, view } from "dkh-ui";

import type { WinHandle } from "../../../src/desktop-api";
import type { blueDevice } from "../../../src/sys_api/blue";

const { MSysApi, MInputMap, MUtils } = myde;

type WinState = {
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
    /** 桌面已应用的最大化状态 —— 用来从 `window.changed` 里认出客户端的 maximize/unmaximize 请求 */
    maximized: boolean;
};

/** 全局窗口身份：服务端 handle */
const windowStates = new Map<WinHandle, WinState>();
const windowElements = new Map<WinHandle, HTMLElement>();
let currentZIndex = 1;
let focusHandle: WinHandle | undefined;

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

// 桌面可用空间：server 在 xdg_surface.get_toplevel 的同步 handler 里取
server.server.respond("surfaceBounds.request", () => {
    const rect = mainEl.el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
});

server.server.on("client.opened", (clientId) => {
    server.server.clients.get(clientId)?.setLogConfig({ receive: [], send: [] });
});

server.server.on("window.created", (info) => {
    const wid = info.handle;
    const mainRect = mainEl.el.getBoundingClientRect();
    const state: WinState = {
        x: (mainRect.width - 800) / 2,
        y: (mainRect.height - 600) / 2,
        width: 800,
        height: 600,
        zIndex: currentZIndex++,
        maximized: false,
    };
    windowStates.set(wid, state);

    const winEl = render.getXdgSurfaceEle(info.renderId);
    if (winEl) {
        windowElements.set(wid, winEl);

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

        txt(info.title || "Window")
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
            .on("click", () => server.server.notify("window.close", wid))
            .addInto(titleBar);

        mainEl.add(winEl);
        focusWindow(wid);
    }
});

server.server.on("window.closed", (wid) => {
    windowStates.delete(wid);
    windowElements.delete(wid);
    updateTaskbar();
});

server.server.on("window.startMove", (wid) => {
    const winEl = windowElements.get(wid);
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

// window.changed 承载 rect / states / title / appid 的变化；这里只认客户端发起的 maximize/unmaximize
server.server.on("window.changed", (info) => {
    const state = windowStates.get(info.handle);
    if (!state || state.maximized === info.states.maximized) return;
    state.maximized = info.states.maximized;
    const winEl = windowElements.get(info.handle);
    if (!winEl) return;

    if (info.states.maximized) {
        const mainRect = mainEl.el.getBoundingClientRect();
        pack(winEl).style({
            width: `${mainRect.width}px`,
            height: `${mainRect.height - 48}px`,
            left: "0px",
            top: "0px",
        });
        server.server.notify("window.maximize", info.handle, {
            width: mainRect.width,
            height: mainRect.height - 48,
        });
    } else {
        pack(winEl).style({
            width: "800px",
            height: "600px",
            left: "0px",
            top: "0px",
        });
        server.server.notify("window.unmaximize", info.handle, { width: 800, height: 600 });
    }
});

server.server.on("client.closed", () => {
    updateTaskbar();
});

function focusWindow(handle: WinHandle) {
    focusHandle = handle;

    // 目标聚焦、其余失焦，全部经 server 下发
    for (const info of server.server.windows.list()) {
        if (info.handle === handle) server.server.notify("window.focus", info.handle);
        else server.server.notify("window.blur", info.handle);
    }

    const state = windowStates.get(handle);
    if (state) {
        state.zIndex = currentZIndex++;
        const el = windowElements.get(handle);
        if (el) {
            el.style.zIndex = `${state.zIndex}`;
        }
    }

    updateTaskbar();
}

/** 指针下的窗口：按 z 序取最上面那个；命中判定用 info.rect（几何原点即窗口元素左上角） */
function windowAtPoint(p: { x: number; y: number }): WinHandle | undefined {
    const hits: { handle: WinHandle; zIndex: number }[] = [];

    for (const info of server.server.windows.list()) {
        const rect = render.getXdgSurfaceEle(info.renderId)?.getBoundingClientRect();
        if (!rect) continue;

        const nx = p.x - rect.left;
        const ny = p.y - rect.top;
        if (nx < 0 || nx >= info.rect.w || ny < 0 || ny >= info.rect.h) continue;

        hits.push({ handle: info.handle, zIndex: windowStates.get(info.handle)?.zIndex ?? 0 });
    }

    if (hits.length === 0) return undefined;
    hits.sort((a, b) => b.zIndex - a.zIndex);
    return hits[0].handle;
}

function sendPointerEvent(type: "move" | "down" | "up", p: PointerEvent) {
    const handle = windowAtPoint(p);
    if (handle === undefined) return;
    const info = server.server.windows.get(handle);
    if (!info) return;
    const rect = render.getXdgSurfaceEle(info.renderId)?.getBoundingClientRect();
    if (!rect) return;

    server.server.notify("input.pointer", handle, {
        type,
        x: p.x - rect.left,
        y: p.y - rect.top,
        button: p.button,
    });

    if (type === "down") {
        focusWindow(handle);
    }
}

function sendScrollEvent(p: WheelEvent) {
    const handle = windowAtPoint(p);
    if (handle === undefined) return;

    server.server.notify("input.scroll", handle, {
        deltaX: p.deltaX,
        deltaY: p.deltaY,
        deltaZ: p.deltaZ,
    });
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

    for (const info of server.server.windows.list()) {
        const title = info.title || info.appid || "Window";
        const isFocused = info.handle === focusHandle;

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
                focusWindow(info.handle);
            })
            .addInto(taskbarApps);
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
    if (focusHandle === undefined) return;
    server.server.notify("input.key", focusHandle, MInputMap.mapKeyCode(e.code), "pressed");
});

document.addEventListener("keyup", (e) => {
    if (e.repeat) return;
    if (focusHandle === undefined) return;
    server.server.notify("input.key", focusHandle, MInputMap.mapKeyCode(e.code), "released");
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
