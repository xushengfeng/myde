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

function sendPointerEvent(
    type: "move" | "down" | "up",
    p: { x: number; y: number; button?: number },
    toplevelId: string | null,
) {
    for (const [_id, client] of server.server.clients) {
        for (const [winId, _win] of client.getWindows()) {
            const xwin = client.win(winId);
            if (!xwin) continue;

            const renderId = xwin.point.renderId();

            if (toplevelId && renderId !== toplevelId) continue;

            const inWin = xwin.point.inWin({ x: p.x, y: p.y });
            if (!inWin) continue;

            xwin.point.sendPointerEvent(
                type,
                new PointerEvent(`pointer${type}`, {
                    clientX: p.x,
                    clientY: p.y,
                    button: p.button || 0,
                }),
            );

            if (type === "down") {
                xwin.focus();
                client.offerTo();
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

function sendScrollEvent(p: { deltaX: number; deltaY: number }, toplevelId: string | null) {
    for (const [_, client] of server.server.clients) {
        for (const [winId, _win] of client.getWindows()) {
            const xwin = client.win(winId);
            if (!xwin) continue;

            const renderId = xwin.point.renderId();

            if (toplevelId && renderId !== toplevelId) continue;

            xwin.point.sendScrollEvent({
                p: new WheelEvent("wheel", {
                    deltaX: p.deltaX,
                    deltaY: p.deltaY,
                }),
            });

            break;
        }
    }
}

function sendKeyEvent(state: "pressed" | "released", code: string) {
    const keyCode = MInputMap.mapKeyCode(code);
    for (const [_id, client] of server.server.clients) {
        client.keyboard.sendKey(keyCode, state);
    }
}

function closeWindow(toplevelId: string) {
    for (const [_id, client] of server.server.clients) {
        for (const [winId, _win] of client.getWindows()) {
            const xwin = client.win(winId);
            if (!xwin) continue;

            const renderId = xwin.point.renderId();
            if (renderId === toplevelId) {
                xwin.close();
                return;
            }
        }
    }
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
