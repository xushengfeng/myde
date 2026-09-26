import type {} from "../../../src/desktop-api";
import { RemoteRender } from "./remote-render";

const { MSysApi, MInputMap, MSetting } = myde;

const nSetting = MSetting.init<{
    "remote.myId": string;
    "remote.peers": {
        id: string;
        lastConnected: number;
        type: "launcher" | "render";
    }[];
}>({
    version: "0.0.1",
    defaultNsSetting: {
        "remote.myId": "",
        "remote.peers": [],
    },
});

const myId = nSetting.nget("remote.myId") || crypto.randomUUID();
nSetting.nset("remote.myId", myId);

const connect = myde.MConnect(myId);
await connect.init();
console.log("connect load");

const render = new RemoteRender(connect);
const server = MSysApi.server({ render: render });

function handleInputEvent(event: any, toplevelId: string | null) {
    switch (event.type) {
        case "pointermove":
            sendPointerEvent("move", event, toplevelId);
            break;
        case "pointerdown":
            sendPointerEvent("down", event, toplevelId);
            break;
        case "pointerup":
            sendPointerEvent("up", event, toplevelId);
            break;
        case "wheel":
            sendScrollEvent(event, toplevelId);
            break;
        case "keydown":
            sendKeyEvent("pressed", event.code);
            break;
        case "keyup":
            sendKeyEvent("released", event.code);
            break;
    }
}

/** 按服务端全局窗口表收集要处理的窗口 */
function windowsOfClient(clientId: string) {
    return server.server.windows.list().filter((w) => w.clientId === clientId);
}

function sendPointerEvent(
    type: "move" | "down" | "up",
    p: { x: number; y: number; button?: number },
    toplevelId: string | null,
) {
    const handled = new Set<string>();
    for (const info of server.server.windows.list()) {
        // 每个客户端只处理第一个命中的窗口
        if (handled.has(info.clientId)) continue;
        if (toplevelId && info.renderId !== toplevelId) continue;
        if (p.x < 0 || p.x >= info.rect.w || p.y < 0 || p.y >= info.rect.h) continue;
        handled.add(info.clientId);

        server.server.notify("input.pointer", info.handle, {
            type,
            x: p.x,
            y: p.y,
            button: p.button || 0,
        });

        if (type === "down") {
            server.server.notify("window.focus", info.handle);
            server.server.notify("clipboard.offer", info.handle);
            for (const other of windowsOfClient(info.clientId)) {
                if (other.handle !== info.handle) server.server.notify("window.blur", other.handle);
            }
        }
    }
}

function sendScrollEvent(p: { deltaX: number; deltaY: number }, toplevelId: string | null) {
    const handled = new Set<string>();
    for (const info of server.server.windows.list()) {
        if (handled.has(info.clientId)) continue;
        if (toplevelId && info.renderId !== toplevelId) continue;
        handled.add(info.clientId);

        server.server.notify("input.scroll", info.handle, {
            deltaX: p.deltaX,
            deltaY: p.deltaY,
            deltaZ: 0,
        });
    }
}

function sendKeyEvent(state: "pressed" | "released", code: string) {
    const keyCode = MInputMap.mapKeyCode(code);
    const handled = new Set<string>();
    for (const info of server.server.windows.list()) {
        if (handled.has(info.clientId)) continue;
        handled.add(info.clientId);
        server.server.notify("input.key", info.handle, keyCode, state);
    }
}

function closeWindow(toplevelId: string) {
    const info = server.server.windows.list().find((w) => w.renderId === toplevelId);
    if (info) server.server.notify("window.close", info.handle);
}

connect.addHandler((args) => {
    console.log(args);

    if (args.json.serverName === "displayServer") {
        const msg = args.json;
        switch (msg.type) {
            case "inputEvent":
                handleInputEvent(msg.event, msg.event.toplevelId || null);
                break;

            case "runApp":
                if (msg.command) {
                    server.runApp(msg.command);
                }
                break;

            case "closeWindow":
                if (msg.toplevelId) {
                    closeWindow(msg.toplevelId);
                }
                break;

            case "requestToplevelState":
                if (msg.toplevelId) {
                    render.sendStateForToplevel(msg.toplevelId);
                }
                break;
        }
    }
});

const r = await connect.startPairing();
console.log("Pairing started", r.pointId, r.pin);
r.onPair((p) => {
    p.waitForPair().then((res) => {
        console.log("Paired with", res);
    });
});
