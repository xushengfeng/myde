import type {} from "../../src/desktop-api";
import { RemoteRender } from "./remote-render";
import { PeerManager, createConnectionUI } from "./server";

const { MSysApi, MInputMap, MConnect, MSetting } = myde;

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

class RemoteDesktop {
    private render: RemoteRender;
    private server: ReturnType<typeof MSysApi.server>;
    private peerManager: PeerManager;

    constructor() {
        this.peerManager = new PeerManager(myId);
        this.render = new RemoteRender(this.peerManager);
        this.server = MSysApi.server({ render: this.render });

        this.peerManager.setOnConnect((peerId, pin) => {
            console.log(`Peer ${peerId} connecting, PIN: ${pin}`);
        });

        this.peerManager.setOnMessage((peerId, data) => {
            this.handleMessage(peerId, data);
        });

        this.peerManager.setOnDisconnect((peerId) => {
            console.log(`Peer ${peerId} disconnected`);
            const peers = nSetting.nget("remote.peers") || [];
            const idx = peers.findIndex((p) => p.id === peerId);
            if (idx !== -1) {
                peers[idx].lastConnected = Date.now();
                nSetting.nset("remote.peers", peers);
            }
        });

        this.peerManager.start().then(() => {
            console.log(`Remote desktop ready, ID: ${myId}`, this.peerManager.getMyPin());
            createConnectionUI(this.peerManager);
        });

        this.setupServerEvents();
    }

    private setupServerEvents() {
        this.server.server.on("newClient", (client, clientId) => {
            console.log(`New wayland client: ${clientId}`);

            client.onSync("windowBound", () => {
                return { width: 1920, height: 1080 };
            });

            client.on("windowCreated", (windowId, renderId) => {
                console.log(`Client ${clientId} created window ${windowId}`);
                client.win(windowId)?.focus();
            });

            client.on("windowClosed", (windowId) => {
                console.log(`Client ${clientId} closed window ${windowId}`);
            });

            client.on("windowMaximized", (windowId) => {
                const xwin = client.win(windowId);
                if (!xwin) return;
                xwin.maximize(1920, 1080);
            });
        });

        this.server.server.on("clientClose", (_, clientId) => {
            console.log(`Wayland client ${clientId} disconnected`);
        });
    }

    private handleMessage(peerId: string, data: string) {
        try {
            const msg = JSON.parse(data);
            const peer = this.peerManager.getPeer(peerId);
            if (!peer) return;

            switch (msg.type) {
                case "inputEvent":
                    this.handleInputEvent(msg.event, msg.event.toplevelId || null);
                    break;

                case "runApp":
                    if (msg.command) {
                        this.server.runApp(msg.command);
                    }
                    break;

                case "closeWindow":
                    if (msg.toplevelId) {
                        this.closeWindow(msg.toplevelId);
                    }
                    break;

                case "register":
                    if (peer.type === "launcher") {
                        this.render.sendToplevelListToPeer(peerId);
                    } else if (peer.toplevelId) {
                        this.render.sendStateForToplevel(peerId, peer.toplevelId);
                    }

                    const peers = nSetting.nget("remote.peers") || [];
                    const existing = peers.findIndex((p) => p.id === peerId);
                    const record = {
                        id: peerId,
                        lastConnected: Date.now(),
                        type: peer.type,
                    };
                    if (existing !== -1) {
                        peers[existing] = record;
                    } else {
                        peers.push(record);
                    }
                    nSetting.nset("remote.peers", peers);
                    break;

                case "requestToplevelState":
                    if (msg.toplevelId) {
                        this.render.sendStateForToplevel(peerId, msg.toplevelId);
                    }
                    break;
            }
        } catch (error) {
            console.error("Error handling message:", error);
        }
    }

    private handleInputEvent(event: any, toplevelId: string | null) {
        switch (event.type) {
            case "pointermove":
                this.sendPointerEvent("move", event, toplevelId);
                break;
            case "pointerdown":
                this.sendPointerEvent("down", event, toplevelId);
                break;
            case "pointerup":
                this.sendPointerEvent("up", event, toplevelId);
                break;
            case "wheel":
                this.sendScrollEvent(event, toplevelId);
                break;
            case "keydown":
                this.sendKeyEvent("pressed", event.code);
                break;
            case "keyup":
                this.sendKeyEvent("released", event.code);
                break;
        }
    }

    private sendPointerEvent(
        type: "move" | "down" | "up",
        p: { x: number; y: number; button?: number },
        toplevelId: string | null,
    ) {
        for (const [_id, client] of this.server.server.clients) {
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

    private sendScrollEvent(p: { deltaX: number; deltaY: number }, toplevelId: string | null) {
        for (const [_, client] of this.server.server.clients) {
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

    private sendKeyEvent(state: "pressed" | "released", code: string) {
        const keyCode = MInputMap.mapKeyCode(code);
        for (const [_id, client] of this.server.server.clients) {
            client.keyboard.sendKey(keyCode, state);
        }
    }

    private closeWindow(toplevelId: string) {
        for (const [_id, client] of this.server.server.clients) {
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
}

new RemoteDesktop();
