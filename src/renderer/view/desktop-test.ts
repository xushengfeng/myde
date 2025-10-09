const fs = require("node:fs") as typeof import("node:fs");
const child_process = require("node:child_process") as typeof import("node:child_process");

import { getDesktopEntries, getDesktopIcon } from "../sys_api/application";

import { button, ele, image, pack, txt, view, initDKH, input, addStyle } from "dkh-ui";
import { type WaylandClient, WaylandServer } from "./view";
import { InputEventCodes } from "../input_codes/types";

function sendPointerEvent(type: "move" | "down" | "up", p: PointerEvent) {
    for (const [id, client] of server.clients) {
        const data = clientData.get(id);
        if (!data) {
            return;
        }
        for (const surface of client.getAllSurfaces()) {
            const rect = surface.el.getBoundingClientRect();
            if (p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom) {
                if (!data.in) {
                    data.in = true;
                    client.sendPointerEvent(
                        "in",
                        new PointerEvent(p.type, { ...p, clientX: p.x - rect.left, clientY: p.y - rect.top }),
                        surface.id,
                    );
                    client.keyboard.focusSurface(surface.id);
                }
                client.sendPointerEvent(
                    type,
                    new PointerEvent(p.type, { ...p, clientX: p.x - rect.left, clientY: p.y - rect.top }),
                    surface.id,
                );
            }
        }
    }
}

function sendScrollEvent(p: WheelEvent) {
    for (const [_, client] of server.clients) {
        for (const surface of client.getAllSurfaces()) {
            const rect = surface.el.getBoundingClientRect();
            if (p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom) {
                client.sendScrollEvent({ p: p });
            }
        }
    }
}

function runApp(execPath: string, args: string[] = []) {
    console.log(`Running application: ${execPath}`);

    const subprocess = child_process.spawn(execPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            HOME: deEnv.HOME,
            WAYLAND_DEBUG: "1",
            XDG_SESSION_TYPE: "wayland",
            XDG_RUNTIME_DIR: server.socketDir,
            WAYLAND_DISPLAY: server.socketName,
            ...(Number.isNaN(xServerNum) ? {} : { DISPLAY: `:${xServerNum}` }),
        },
    });

    const logData: string[] = [];

    subprocess.stdout.on("data", (data) => {
        console.log(`Subprocess ${execPath} stdout:\n${data.toString("utf8")}`);
        logData.push(data.toString("utf8"));
    });

    subprocess.stderr.on("data", (data) => {
        const dataStr = data.toString("utf8");
        const m = dataStr.match(/\{Default Queue\}(.+?)#/)?.[1];
        if (m) {
            const p = (m as string).replace("->", "").trim();
            if (!server.isProtocolSupported(p)) {
                console.error(`Unknown protocol in debug output: ${p}`);
            }
        }
        console.log(`Subprocess ${execPath} stderr:\n${data.toString("utf8")}`);
        logData.push(data.toString("utf8"));
    });

    subprocess.on("error", (err) => {
        console.error("Failed to start subprocess:", err);
    });

    subprocess.on("exit", (code, signal) => {
        console.log(`Subprocess ${execPath} exited with code ${code} and signal ${signal}`);
    });

    view()
        .add(
            button(`log ${execPath}`).on("click", () => {
                console.log(logData.map((line) => line.trim()).join("\n"));
            }),
        )
        .addInto();
}

const server = new WaylandServer();

server.on("newClient", (client, clientId) => {
    clientData.set(clientId, { client, in: false });
    client.on("windowCreated", (windowId, el) => {
        console.log(`Client ${clientId} created window ${windowId}`);
        body.add(el);
    });
    client.on("windowClosed", (windowId, el) => {
        console.log(`Client ${clientId} deleted window ${windowId}`);
        el.remove();
    });
});
server.on("clientClose", (_, clientId) => {
    clientData.delete(clientId);
});

const deEnv = JSON.parse(new URLSearchParams(location.search).get("env") ?? "{}");

const clientData = new Map<string, { client: WaylandClient; in: boolean }>();

let xServerNum = NaN;

const mouseEL = view().addInto().style({
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

function mouseMove(x: number, y: number) {
    mouseEL.style({ top: `${y}px`, left: `${x}px` });
    sendPointerEvent("move", new PointerEvent("pointermove", { clientX: x, clientY: y }));
}

initDKH({ pureStyle: true });

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
    for (const client of server.clients.values()) {
        client.keyboard.sendKey(mapKeyCode(e.key), "pressed");
    }
});
body.on("keyup", (e) => {
    if (e.repeat) return;
    for (const client of server.clients.values()) {
        client.keyboard.sendKey(mapKeyCode(e.key), "released");
    }
});

body.on("wheel", (e) => {
    sendScrollEvent(e);
});

function mapKeyCode(key: string): number {
    if (key.length === 1) {
        return InputEventCodes[`KEY_${key.toUpperCase()}`] || 0;
    }
    return 0;
}

body.style({
    background: 'url("file:///usr/share/wallpapers/ScarletTree/contents/images/5120x2880.png") center/cover no-repeat',
    height: "100vh",
    cursor: "none",
});

addStyle({
    "*": {
        cursor: "none !important",
    },
});

button("self")
    .on("click", () => {
        runApp(process.argv[0], process.argv.slice(1));
    })
    .addInto();

view()
    .add(
        [
            "google-chrome-stable",
            "firefox-nightly",
            "wayland-info",
            "weston-flower",
            "weston-simple-damage",
            "weston-simple-shm",
            "weston-simple-egl",
            "weston-simple-dmabuf-egl",
            "weston-simple-dmabuf-feedback",
            "weston-editor",
            "weston-clickdot",
            "weston-subsurfaces",
            "glxgears",
            "kwrite",
        ].map((app) =>
            button(app)
                .style({ padding: "4px 8px", background: "#fff" })
                .on("click", () => {
                    const execPath = `/usr/bin/${app}`;
                    runApp(execPath);
                }),
        ),
    )
    .addInto();

view()
    .add(
        input().on("change", (e, el) => {
            const command = el.gv;
            runApp(`/usr/bin/${command}`);
        }),
    )
    .addInto();

view()
    .add(
        button("xwayland").on("click", () => {
            for (let i = 0; i < 100; i++) {
                const socketPath = `/tmp/.X11-unix/X${i}`;
                if (!fs.existsSync(socketPath)) {
                    xServerNum = i;
                    runApp("/usr/bin/Xwayland", [`:${xServerNum}`]);
                    break;
                }
            }
        }),
    )
    .addInto();

const allApps = getDesktopEntries(["zh_CN", "zh", "zh-Hans"]);
console.log("Found desktop entries:", allApps);
const apps: typeof allApps = [];
const appNameSet = new Set<string>();

for (const app of allApps) {
    if (!appNameSet.has(app.name)) {
        appNameSet.add(app.name);
        // apps.push(app);
    }
}

view("y")
    .add(
        apps.map((app) => {
            const iconPath = getDesktopIcon(app.icon) || "";
            return view("x")
                .add([
                    iconPath ? image(`file://${iconPath}`, app.name).style({ width: "24px" }) : "",
                    txt(app.nameLocal),
                ])
                .on("click", () => {
                    const exec = app.exec.split(" ")[0]; // 简单处理参数
                    runApp(exec, app.exec.split(" ").slice(1));
                });
        }),
    )
    .addInto();
