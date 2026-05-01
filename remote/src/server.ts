import { SConnect } from "../../src/remote_connect/sconnect";
import { PeerjsAdapter } from "../../src/remote_connect/peerjs_adapter";

type MessageHandler = (peerId: string, data: string) => void;
type DisconnectHandler = (peerId: string) => void;
type ConnectHandler = (peerId: string, pin: string) => void;

export interface PeerInfo {
    id: string;
    connect: SConnect;
    type: "launcher" | "render";
    toplevelId: string | null;
}

export class PeerManager {
    private peers = new Map<string, PeerInfo>();
    private connect: SConnect | null = null;
    private serverId: string;
    private myPin = "";

    private onMessageHandler: MessageHandler | null = null;
    private onDisconnectHandler: DisconnectHandler | null = null;
    private onConnectHandler: ConnectHandler | null = null;

    constructor(serverId: string) {
        this.serverId = serverId;
    }

    async start() {
        const adapter = new PeerjsAdapter({ debug: 0 });
        this.connect = new SConnect(adapter);
        await this.connect.init(this.serverId);
        this.myPin = this.connect.updatePIN();

        this.connect.on("pairRequest", async (req) => {
            console.log(`[server] pairRequest from ${req.remoteDeviceId}`);
            if (this.onConnectHandler) {
                this.onConnectHandler(req.remoteDeviceId, this.myPin);
            }
            try {
                const credential = await req.waitForPairing();
                console.log(`[server] pairing with ${req.remoteDeviceId} succeeded`);
                this.registerPeer(req.remoteDeviceId);
            } catch (err) {
                console.error(`[server] pairing failed:`, err);
            }
        });

        this.connect.on("disconnect", () => {
            console.log(`[server] disconnected`);
            for (const [id] of this.peers) {
                this.peers.delete(id);
                if (this.onDisconnectHandler) this.onDisconnectHandler(id);
            }
        });
    }

    private registerPeer(peerId: string) {
        if (!this.connect) return;

        const peerInfo: PeerInfo = {
            id: peerId,
            connect: this.connect,
            type: "launcher",
            toplevelId: null,
        };
        this.peers.set(peerId, peerInfo);

        this.connect.on("message", (payload: string) => {
            try {
                const msg = JSON.parse(payload);
                if (msg.type === "register") {
                    peerInfo.type = msg.clientType || "launcher";
                    peerInfo.toplevelId = msg.toplevelId || null;
                }
            } catch {}
            if (this.onMessageHandler) {
                this.onMessageHandler(peerId, payload);
            }
        });
    }

    getMyPin(): string {
        return this.myPin;
    }
    getServerId(): string {
        return this.serverId;
    }
    getPeer(id: string): PeerInfo | undefined {
        return this.peers.get(id);
    }
    getAllPeers(): PeerInfo[] {
        return Array.from(this.peers.values());
    }

    sendMessage(peerId: string, message: any): void {
        const peer = this.peers.get(peerId);
        if (peer) peer.connect.send(JSON.stringify(message)).catch(() => {});
    }

    broadcast(message: any, toplevelId?: string | null): void {
        if (!this.connect) return;
        const msgStr = JSON.stringify(message);
        for (const [_id, peer] of this.peers) {
            if (peer.type === "launcher") {
                this.connect.send(msgStr).catch(() => {});
            } else if (peer.type === "render" && (!toplevelId || peer.toplevelId === toplevelId)) {
                this.connect.send(msgStr).catch(() => {});
            }
        }
    }

    setOnMessage(handler: MessageHandler) {
        this.onMessageHandler = handler;
    }
    setOnDisconnect(handler: DisconnectHandler) {
        this.onDisconnectHandler = handler;
    }
    setOnConnect(handler: ConnectHandler) {
        this.onConnectHandler = handler;
    }

    destroy() {
        for (const [_id, peer] of this.peers) peer.connect.disconnect();
        this.peers.clear();
        if (this.connect) {
            this.connect.disconnect();
            this.connect = null;
        }
    }
}

export function createConnectionUI(manager: PeerManager) {
    const style = document.createElement("style");
    style.textContent = `
        .conn-panel{position:fixed;bottom:16px;right:16px;background:#1e1e1e;color:#ccc;border:1px solid #333;border-radius:8px;padding:14px 18px;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;z-index:99999;min-width:260px;box-shadow:0 4px 20px rgba(0,0,0,.5)}
        .conn-panel h3{margin:0 0 8px;font-size:14px;color:#fff}
        .conn-panel .row{display:flex;justify-content:space-between;margin-bottom:4px}
        .conn-panel .label{color:#888}
        .conn-panel .val{color:#4caf50;font-family:monospace;user-select:all}
        .conn-panel .peers-section{margin-top:10px;border-top:1px solid #333;padding-top:8px}
        .conn-panel .peer-item{display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px}
        .conn-panel .peer-id{font-family:monospace;color:#aaa;flex:1;overflow:hidden;text-overflow:ellipsis}
        .conn-panel .peer-type{margin:0 8px;padding:1px 6px;border-radius:3px;font-size:11px}
        .conn-panel .peer-type.launcher{background:#1b5e20;color:#a5d6a7}
        .conn-panel .peer-type.render{background:#0d47a1;color:#90caf9}
        .conn-panel .disconnect-btn{background:none;border:1px solid #555;color:#ef5350;border-radius:3px;padding:1px 6px;cursor:pointer;font-size:11px}
        .conn-panel .disconnect-btn:hover{background:#b71c1c22}
        .conn-panel .empty{color:#555;font-size:12px}
    `;
    document.head.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "conn-panel";
    document.body.appendChild(panel);

    function render() {
        const peers = manager.getAllPeers();
        let peersHtml = '<div class="empty">No connected peers</div>';
        if (peers.length > 0) {
            peersHtml = peers
                .map(
                    (p) => `
                <div class="peer-item">
                    <span class="peer-id" title="${p.id}">${p.id.slice(0, 12)}…</span>
                    <span class="peer-type ${p.type}">${p.type}</span>
                    <button class="disconnect-btn" data-id="${p.id}">×</button>
                </div>`,
                )
                .join("");
        }
        panel.innerHTML = `
            <h3>Connection</h3>
            <div class="row"><span class="label">Server ID</span><span class="val">${manager.getServerId()}</span></div>
            <div class="row"><span class="label">PIN</span><span class="val">${manager.getMyPin() || "…"}</span></div>
            <div class="peers-section"><div class="row"><span class="label">Peers (${peers.length})</span></div>${peersHtml}</div>
        `;
        panel.querySelectorAll(".disconnect-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const id = (btn as HTMLElement).dataset.id;
                if (id) {
                    const peer = manager.getPeer(id);
                    if (peer) peer.connect.disconnect();
                }
            });
        });
    }

    manager.setOnConnect(() => render());
    manager.setOnDisconnect(() => render());
    render();
}
