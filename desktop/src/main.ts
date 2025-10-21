import { image, pack, view } from "dkh-ui";

import type { WaylandClient } from "../../src/renderer/desktop-api";
import { txt } from "dkh-ui";

const { MSysApi, MRootDir, MInputMap } = window.myde;

// 全局记录当前鼠标坐标（与页面视口坐标系一致）
const mousePos = { x: 0, y: 0 } as { x: number; y: number };

function mouseMove(x: number, y: number) {
    // 更新全局鼠标坐标
    mousePos.x = x;
    mousePos.y = y;
    mouseEl.style({ top: `${y}px`, left: `${x}px` });
    sendPointerEvent("move", new PointerEvent("pointermove", { clientX: x, clientY: y }));
}

function addWindow(el: HTMLElement) {
    windowEl.add(el);

    el.style.position = "absolute";
    setTimeout(() => {
        const winRect = el.getBoundingClientRect();
        const desktopRect = windowEl.el.getBoundingClientRect();
        el.style.top = `${(desktopRect.height - winRect.height) / 2}px`;
        el.style.left = `${(desktopRect.width - winRect.width) / 2}px`;
    }, 400);
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

image(`${MRootDir}/assets/wallpaper/1.svg`, "wallpaper")
    .style({
        width: "100%",
        height: "100%",
        objectFit: "cover",
    })
    .addInto(mainEl);

const windowEl = view()
    .style({
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
    })
    .addInto(mainEl);

const dockEl = view()
    .style({
        position: "absolute",
        bottom: "20px",
        left: "50%",
        transform: "translateX(-50%)",
        height: "64px",
        padding: "0 10px",
        background: "rgba(255, 255, 255, 0.6)",
        borderRadius: "22px",
        display: "flex",
        alignItems: "center",
        gap: "10px",
        backdropFilter: "blur(10px)",
    })
    .addInto(mainEl);

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
            MSysApi.getDesktopIcon(app.icon).then((_iconPath) => {
                const iconPath = _iconPath || `${MRootDir}/assets/icons/application.png`;
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
startMenuBtn.addInto(dockEl);

const apps = await MSysApi.getDesktopEntries();

console.log(apps);

const browserApp =
    apps.find((app) => app.name === "Google Chrome") ||
    apps.find((app) => app.name === "Firefox") ||
    apps.find((app) => app.name === "Microsoft Edge");
const fileManagerApp =
    apps.find((app) => app.name === "org.gnome.Nautilus") || apps.find((app) => app.name === "Dolphin");
const terminalApp = apps.find((app) => app.name === "org.gnome.Terminal") || apps.find((app) => app.name === "Konsole");

if (browserApp) {
    const iconPath = (await MSysApi.getDesktopIcon(browserApp.icon)) || `${MRootDir}/assets/icons/browser.png`;
    appIcon(iconPath, browserApp.name, browserApp.exec).addInto(dockEl);
}
if (fileManagerApp) {
    const iconPath = (await MSysApi.getDesktopIcon(fileManagerApp.icon)) || `${MRootDir}/assets/icons/file-manager.png`;
    appIcon(iconPath, fileManagerApp.name, fileManagerApp.exec).addInto(dockEl);
}
if (terminalApp) {
    const iconPath = (await MSysApi.getDesktopIcon(terminalApp.icon)) || `${MRootDir}/assets/icons/terminal.png`;
    appIcon(iconPath, terminalApp.name, terminalApp.exec).addInto(dockEl);
}

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
