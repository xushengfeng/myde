const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

import { getDesktopEntries, getDesktopIcon } from "../sys_api/application";
import { myde } from "../desktop-api";

import { button, image, pack, txt, view, initDKH, input, addStyle } from "dkh-ui";
import type { WaylandClient } from "./view";
import { InputEventCodes } from "../input_codes/types";

function sendPointerEvent(type: "move" | "down" | "up", p: PointerEvent) {
    for (const [_id, client] of server.clients) {
        for (const [winId, _win] of client.getWindows()) {
            const xwin = client.win(winId);
            if (!xwin) continue;
            const inWin = xwin.point.inWin(p);
            if (!inWin) continue;
            const rect = xwin.point.rootEl().getBoundingClientRect();
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
    for (const [_, client] of server.clients) {
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

function runApp(execPath: string, args: string[] = []) {
    console.log(`Running application: ${execPath}`);

    const subprocess = serverX.runApp(`${execPath} ${args.join(" ")}`);

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

const serverX = myde.sysApi.server({ dev: true });
const server = serverX.server;

server.on("newClient", (client, clientId) => {
    clientData.set(clientId, { client });
    client.on("windowCreated", (windowId, el) => {
        console.log(`Client ${clientId} created window ${windowId}`);
        body.add(el);
        client.win(windowId)?.focus();
    });
    client.on("windowClosed", (windowId, el) => {
        console.log(`Client ${clientId} deleted window ${windowId}`);
        el.remove();
    });
});
server.on("clientClose", (_, clientId) => {
    clientData.delete(clientId);
});

const clientData = new Map<string, { client: WaylandClient }>();

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
        client.keyboard.sendKey(mapKeyCode(e.code), "pressed");
    }
});
body.on("keyup", (e) => {
    if (e.repeat) return;
    for (const client of server.clients.values()) {
        client.keyboard.sendKey(mapKeyCode(e.code), "released");
    }
});

body.on("wheel", (e) => {
    sendScrollEvent(e);
});

function mapKeyCode(code: string): number {
    const codeMap: Record<string, number> = {
        Space: InputEventCodes.KEY_SPACE,
        Enter: InputEventCodes.KEY_ENTER,
        Backspace: InputEventCodes.KEY_BACKSPACE,
        Tab: InputEventCodes.KEY_TAB,
        Escape: InputEventCodes.KEY_ESC,
        ShiftLeft: InputEventCodes.KEY_LEFTSHIFT,
        ShiftRight: InputEventCodes.KEY_RIGHTSHIFT,
        ControlLeft: InputEventCodes.KEY_LEFTCTRL,
        ControlRight: InputEventCodes.KEY_RIGHTCTRL,
        AltLeft: InputEventCodes.KEY_LEFTALT,
        AltRight: InputEventCodes.KEY_RIGHTALT,
        MetaLeft: InputEventCodes.KEY_LEFTMETA,
        MetaRight: InputEventCodes.KEY_RIGHTMETA,
        Minus: InputEventCodes.KEY_MINUS,
        Equal: InputEventCodes.KEY_EQUAL,
        BracketLeft: InputEventCodes.KEY_LEFTBRACE,
        BracketRight: InputEventCodes.KEY_RIGHTBRACE,
        Backslash: InputEventCodes.KEY_BACKSLASH,
        Semicolon: InputEventCodes.KEY_SEMICOLON,
        Quote: InputEventCodes.KEY_APOSTROPHE,
        Backquote: InputEventCodes.KEY_GRAVE,
        Comma: InputEventCodes.KEY_COMMA,
        Period: InputEventCodes.KEY_DOT,
        Slash: InputEventCodes.KEY_SLASH,
        CapsLock: InputEventCodes.KEY_CAPSLOCK,
        Delete: InputEventCodes.KEY_DELETE,
        End: InputEventCodes.KEY_END,
        Home: InputEventCodes.KEY_HOME,
        Insert: InputEventCodes.KEY_INSERT,
        PageDown: InputEventCodes.KEY_PAGEDOWN,
        PageUp: InputEventCodes.KEY_PAGEUP,
        ScrollLock: InputEventCodes.KEY_SCROLLLOCK,
        Pause: InputEventCodes.KEY_PAUSE,
        PrintScreen: InputEventCodes.KEY_PRINT,
        NumLock: InputEventCodes.KEY_NUMLOCK,
    };
    if (code in codeMap) return codeMap[code];

    if (code.startsWith("Key")) {
        return InputEventCodes[`KEY_${code.at(-1)}`] || 0;
    }
    if (code.startsWith("Digit")) {
        return InputEventCodes[`KEY_${code.slice(5)}`] || 0;
    }
    if (code.startsWith("Arrow")) {
        return InputEventCodes[`KEY_${code.slice(5).toUpperCase()}`] || 0;
    }
    if (code.startsWith("Numpad")) {
        const numpadKey = code.slice(6);
        if (!Number.isNaN(Number(numpadKey))) {
            return InputEventCodes[`KEY_KP_${numpadKey}`] || 0;
        } else if (numpadKey === "Add") {
            return InputEventCodes.KEY_KPPLUS;
        } else if (numpadKey === "Subtract") {
            return InputEventCodes.KEY_KPMINUS;
        } else if (numpadKey === "Multiply") {
            return InputEventCodes.KEY_KPASTERISK;
        } else if (numpadKey === "Divide") {
            return InputEventCodes.KEY_KPSLASH;
        } else if (numpadKey === "Decimal") {
            return InputEventCodes.KEY_KPDOT;
        } else if (numpadKey === "Enter") {
            return InputEventCodes.KEY_KPENTER;
        }
    }
    if (code.startsWith("F")) {
        const fnNumber = Number(code.slice(1));
        if (!Number.isNaN(fnNumber) && fnNumber >= 1 && fnNumber <= 24) {
            return InputEventCodes[`KEY_F${fnNumber}`] || 0;
        }
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
            "gtk4-demo",
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
        ["queue-test"].map((app) =>
            button(app)
                .style({ padding: "4px 8px", background: "#fff" })
                .on("click", () => {
                    const execPath = path.join(__dirname, "../..", "test/offical", `wayland/build/tests/${app}`);
                    runApp(execPath);
                }),
        ),
    )
    .addInto();

view()
    .add(
        input().on("change", (_e, el) => {
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
