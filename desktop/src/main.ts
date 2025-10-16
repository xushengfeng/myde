import { image, view } from "dkh-ui";

import type { WaylandClient } from "../../src/renderer/desktop-api";
import { txt } from "dkh-ui";

const { sysApi, rootDir } =
    // @ts-expect-error
    window.myde as typeof import("../../src/renderer/desktop-api").default;

function addWindow(el: HTMLElement) {
    windowEl.add(el);
    const winRect = el.getBoundingClientRect();
    const desktopRect = windowEl.el.getBoundingClientRect();
    console.log(winRect, desktopRect);

    el.style.position = "absolute";
    setTimeout(() => {
        el.style.top = `${(desktopRect.height - winRect.height) / 2}px`;
        el.style.left = `${(desktopRect.width - winRect.width) / 2}px`;
    }, 100);
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

const server = sysApi.server();

server.server.on("newClient", (client, clientId) => {
    clientData.set(clientId, { client });
    client.on("windowCreated", (windowId, el) => {
        console.log(`Client ${clientId} created window ${windowId}`);
        addWindow(el);
        client.win(windowId)?.focus();
    });
    client.on("windowClosed", (windowId, el) => {
        console.log(`Client ${clientId} deleted window ${windowId}`);
        el.remove();
    });
});
server.server.on("clientClose", (_, clientId) => {
    clientData.delete(clientId);
});

const clientData = new Map<string, { client: WaylandClient }>();

const mainEl = view().style({ width: "100vw", height: "100vh" }).addInto();

image(`${rootDir}/assets/wallpaper/1.svg`, "wallpaper")
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
        background: "rgba(255, 255, 255, 0.1)",
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
    .on("click", () => {
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
        for (const app of sysApi.getDesktopEntries()) {
            const iconPath = sysApi.getDesktopIcon(app.icon) || `${rootDir}/assets/icons/application.png`;
            const appEl = view("y")
                .style({
                    width: "80px",
                    height: "80px",
                    alignItems: "center",
                    justifyContent: "flex-start",
                })
                .addInto(menu);
            appIcon(iconPath, app.name, app.exec)
                .style({
                    width: "40px",
                    height: "40px",
                    borderRadius: "8px",
                    background: "#ffffff",
                })
                .addInto(appEl);
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

const apps = sysApi.getDesktopEntries();

const browserApp =
    apps.find((app) => app.name === "Google Chrome") ||
    apps.find((app) => app.name === "Firefox") ||
    apps.find((app) => app.name === "Microsoft Edge");
const fileManagerApp =
    apps.find((app) => app.name === "org.gnome.Nautilus") || apps.find((app) => app.name === "Dolphin");
const terminalApp = apps.find((app) => app.name === "org.gnome.Terminal") || apps.find((app) => app.name === "Konsole");

if (browserApp) {
    const iconPath = sysApi.getDesktopIcon(browserApp.icon) || `${rootDir}/assets/icons/browser.png`;
    appIcon(iconPath, browserApp.name, browserApp.exec).addInto(dockEl);
}
if (fileManagerApp) {
    const iconPath = sysApi.getDesktopIcon(fileManagerApp.icon) || `${rootDir}/assets/icons/file-manager.png`;
    appIcon(iconPath, fileManagerApp.name, fileManagerApp.exec).addInto(dockEl);
}
if (terminalApp) {
    const iconPath = sysApi.getDesktopIcon(terminalApp.icon) || `${rootDir}/assets/icons/terminal.png`;
    appIcon(iconPath, terminalApp.name, terminalApp.exec).addInto(dockEl);
}
