import { SConnect } from "../../../src/remote_connect";
import { PeerjsAdapter } from "../../../src/remote_connect/peerjs_adapter";

interface ServerMsg {
    type: string;
    canvasId?: string;
    width?: number;
    height?: number;
    data?: number[];
    parentId?: string;
    x?: number;
    y?: number;
    offsetX?: number;
    offsetY?: number;
    surfaceId?: string;
    surfaceType?: string;
    popupId?: string;
    toplevelId?: string;
    toplevels?: Array<{ id: string; surfaceId: string }>;
}

function getOrCreateDeviceId(): string {
    let id = localStorage.getItem("myde-remote-device-id");
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("myde-remote-device-id", id);
    }
    return id;
}

class App {
    private connect: SConnect;
    private myDeviceId: string;
    private myPin = "";
    private connected = false;
    private focusedToplevelId: string | null = null;

    private canvasMap = new Map<string, HTMLCanvasElement>();
    private surfaceMap = new Map<string, { el: HTMLElement; toplevelId: string | null }>();
    private toplevelEls = new Map<string, HTMLElement>();

    constructor() {
        this.myDeviceId = getOrCreateDeviceId();
        this.connect = new SConnect(new PeerjsAdapter());
        this.buildUI();
        this.initConnect();
        this.setupGlobalKeys();
    }

    // ==================== UI ====================

    private buildUI() {
        const style = document.createElement("style");
        style.textContent = `
            * { margin:0; padding:0; box-sizing:border-box; }
            body { background:#111; color:#ccc; font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; overflow-x:hidden; }
            #conn { background:#1a1a1a; padding:16px; border-bottom:1px solid #333; }
            #conn.collapsed { padding:6px 16px; }
            #conn-head { display:flex; align-items:center; gap:12px; cursor:pointer; }
            #conn-head h2 { font-size:15px; flex:1; }
            #conn-body { margin-top:12px; display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end; }
            #conn.collapsed #conn-body { display:none; }
            .f { display:flex; flex-direction:column; gap:3px; }
            .f label { font-size:11px; color:#888; }
            .f input { padding:6px 10px; border:1px solid #444; border-radius:4px; background:#2a2a2a; color:#fff; font-size:13px; font-family:monospace; }
            .f input:focus { outline:none; border-color:#2196F3; }
            .f input.pin { width:100px; }
            .id-row { display:flex; gap:20px; }
            .id-row .v { font-family:monospace; color:#4caf50; user-select:all; }
            .id-row label { font-size:11px; color:#888; }
            button { padding:6px 14px; border:1px solid #444; border-radius:4px; background:#2a2a2a; color:#fff; cursor:pointer; font-size:13px; }
            button:hover { background:#3a3a3a; }
            #status { font-size:12px; padding:3px 8px; border-radius:4px; }
            #status.on { background:rgba(76,175,80,.25); color:#4caf50; }
            #status.off { background:rgba(244,67,54,.2); color:#f44336; }
            #wins { display:flex; flex-wrap:wrap; gap:8px; padding:12px; align-items:flex-start; }
            .tile { background:#000; border:1px solid #333; border-radius:6px; overflow:hidden; flex:0 0 auto; }
            .tile.active { border-color:#2196F3; }
            .tile .bar { background:#1e1e1e; padding:3px 8px; font-size:11px; color:#aaa; display:flex; justify-content:space-between; align-items:center; }
            .tile .bar button { padding:0 5px; font-size:11px; background:none; border:1px solid #555; color:#ef5350; }
            .tile .carea { position:relative; overflow:hidden; }
            .tile .carea canvas { display:block; position:absolute; }
        `;
        document.head.appendChild(style);

        document.body.innerHTML = `
            <div id="conn">
                <div id="conn-head"><h2>MyDE Remote</h2><span id="status" class="off">Disconnected</span></div>
                <div id="conn-body">
                    <div class="id-row">
                        <div><label>My ID</label><div class="v" id="my-id">...</div></div>
                        <div><label>PIN</label><div class="v" id="my-pin">...</div></div>
                    </div>
                    <div class="f"><label>Remote ID</label><input id="rid" placeholder="server device ID"></div>
                    <div class="f"><label>Remote PIN</label><input id="rpin" class="pin" placeholder="6-digit" maxlength="6"></div>
                    <button id="cbtn">Connect</button>
                    <div class="f"><label>Run App</label><div style="display:flex;gap:6px"><input id="cmd" placeholder="e.g. weston-terminal"><button id="rbtn">Run</button></div></div>
                </div>
            </div>
            <div id="wins"></div>
        `;

        const ridInput = document.getElementById("rid") as HTMLInputElement;
        ridInput.value = localStorage.getItem("myde-remote-id") || "";

        document.getElementById("conn-head")!.onclick = () => {
            if (this.connected) document.getElementById("conn")!.classList.toggle("collapsed");
        };
        const go = () => {
            const id = (document.getElementById("rid") as HTMLInputElement).value.trim();
            const pin = (document.getElementById("rpin") as HTMLInputElement).value.trim();
            if (id && pin) {
                localStorage.setItem("myde-remote-id", id);
                this.connectToServer(id, pin);
            }
        };
        document.getElementById("cbtn")!.onclick = go;
        document.getElementById("rpin")!.onkeydown = (e) => {
            if (e.key === "Enter") go();
        };
        const run = () => {
            const inp = document.getElementById("cmd") as HTMLInputElement;
            if (inp.value.trim()) {
                this.connect.send(JSON.stringify({ type: "runApp", command: inp.value.trim() }));
                inp.value = "";
            }
        };
        document.getElementById("rbtn")!.onclick = run;
        document.getElementById("cmd")!.onkeydown = (e) => {
            if (e.key === "Enter") run();
        };
    }

    private setStatus(s: string, ok: boolean) {
        const el = document.getElementById("status")!;
        el.textContent = s;
        el.className = ok ? "on" : "off";
    }

    // ==================== Connect ====================

    private async initConnect() {
        await this.connect.init(this.myDeviceId);
        this.myPin = this.connect.updatePIN();
        document.getElementById("my-id")!.textContent = this.myDeviceId;
        document.getElementById("my-pin")!.textContent = this.myPin;
    }

    private async connectToServer(remoteId: string, remotePin: string) {
        const p = await this.connect.pairInit({ myDeviceId: this.myDeviceId, remoteDeviceId: remoteId });
        this.myPin = p.pin;
        document.getElementById("my-pin")!.textContent = this.myPin;
        p.inputOtherPin(remotePin);
        try {
            await p.waitForPairing();
            this.connected = true;
            this.setStatus("Connected", true);
            document.getElementById("conn")!.classList.add("collapsed");
            this.onConnected();
        } catch (err) {
            console.error("pairing failed:", err);
            this.setStatus("Pairing Failed", false);
        }
    }

    private onConnected() {
        this.connect.send(JSON.stringify({ type: "register", clientType: "launcher" }));
        this.connect.on("message", (s: string) => this.onServerMsg(s));
        this.connect.on("disconnect", () => {
            this.connected = false;
            this.setStatus("Disconnected", false);
            document.getElementById("conn")!.classList.remove("collapsed");
            setTimeout(() => {
                const id = (document.getElementById("rid") as HTMLInputElement).value;
                const pin = (document.getElementById("rpin") as HTMLInputElement).value;
                if (id && pin) this.connectToServer(id, pin);
            }, 3000);
        });
        this.connect.on("error", (e) => {
            console.error(e);
            this.setStatus("Error", false);
        });

        // 重连恢复：为已有窗口请求状态
        for (const tid of this.toplevelEls.keys()) {
            this.connect.send(JSON.stringify({ type: "requestToplevelState", toplevelId: tid }));
        }
    }

    // ==================== Server messages ====================

    private onServerMsg(raw: string) {
        try {
            const m: ServerMsg = JSON.parse(raw);
            switch (m.type) {
                case "toplevelList":
                    if (m.toplevels) {
                        const ids = new Set(m.toplevels.map((t) => t.id));
                        for (const id of this.toplevelEls.keys()) if (!ids.has(id)) this.removeToplevel(id);
                        for (const t of m.toplevels) this.ensureToplevel(t.id);
                    }
                    break;
                case "asToplevel":
                    if (m.surfaceId) this.ensureToplevel(m.surfaceId);
                    break;
                case "destroyXdgSurfaceEle":
                    if (m.surfaceId) {
                        this.destroySurface(m.surfaceId);
                        this.removeToplevel(m.surfaceId);
                    }
                    break;
                case "bindCanvas":
                    if (m.canvasId) this.createCanvas(m.canvasId, m.toplevelId);
                    break;
                case "canvas":
                    if (m.canvasId && m.width && m.height && m.data)
                        this.updateCanvas(m.canvasId, m.width, m.height, m.data);
                    break;
                case "destroyCanvas":
                    if (m.canvasId) this.destroyCanvas(m.canvasId);
                    break;
                case "setCanvasAnchor":
                    if (m.canvasId && m.parentId) this.setCanvasAnchor(m.canvasId, m.parentId);
                    break;
                case "setCanvasOffset":
                case "setBufferOffset":
                    if (m.canvasId && m.x !== undefined && m.y !== undefined)
                        this.setCanvasOffset(m.canvasId, m.x, m.y);
                    break;
                case "createXdgSurfaceEle":
                    if (m.surfaceId && m.canvasId) this.createSurface(m.surfaceId, m.canvasId, m.toplevelId);
                    break;
                case "setXdgSurfaceGeo":
                    if (m.surfaceId && m.width && m.height && m.offsetX !== undefined && m.offsetY !== undefined)
                        this.setSurfaceGeo(m.surfaceId, m.width, m.height, m.offsetX, m.offsetY);
                    break;
                case "addPopupToXdgSurface":
                    if (m.popupId && m.toplevelId) this.addPopup(m.popupId, m.toplevelId);
                    break;
                case "setPopupPosi":
                    if (m.popupId && m.x !== undefined && m.y !== undefined) this.setPopupPosi(m.popupId, m.x, m.y);
                    break;
            }
        } catch {}
    }

    // ==================== Toplevel ====================

    private ensureToplevel(tid: string) {
        if (this.toplevelEls.has(tid)) return;
        const tile = document.createElement("div");
        tile.className = "tile";
        tile.innerHTML = `<div class="bar"><span>${tid.slice(0, 12)}…</span><button>×</button></div><div class="carea"></div>`;
        tile.querySelector("button")!.onclick = () =>
            this.connect.send(JSON.stringify({ type: "closeWindow", toplevelId: tid }));
        tile.onpointerdown = () => {
            this.focusedToplevelId = tid;
            for (const [id, t] of this.toplevelEls) t.classList.toggle("active", id === tid);
        };
        this.setupTileInput(tile.querySelector(".carea") as HTMLElement, tid);
        this.toplevelEls.set(tid, tile);
        document.getElementById("wins")!.appendChild(tile);

        if (this.connected) {
            this.connect.send(JSON.stringify({ type: "requestToplevelState", toplevelId: tid }));
        }
    }

    private removeToplevel(tid: string) {
        const el = this.toplevelEls.get(tid);
        if (el) {
            el.remove();
            this.toplevelEls.delete(tid);
        }
        if (this.focusedToplevelId === tid) this.focusedToplevelId = null;
    }

    private area(tid?: string | null): HTMLElement | null {
        if (!tid) return null;
        const t = this.toplevelEls.get(tid);
        return t ? (t.querySelector(".carea") as HTMLElement) : null;
    }

    // ==================== Canvas / Surface ====================

    private createCanvas(cid: string, tid?: string) {
        if (this.canvasMap.has(cid)) return;
        const c = document.createElement("canvas");
        c.style.position = "absolute";
        this.canvasMap.set(cid, c);
        this.area(tid)?.appendChild(c);
    }

    private updateCanvas(cid: string, w: number, h: number, data: number[]) {
        if (w <= 0 || h <= 0 || !data?.length) return;
        const c = this.canvasMap.get(cid);
        if (!c?.isConnected) return;
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (ctx) ctx.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
    }

    private destroyCanvas(cid: string) {
        const c = this.canvasMap.get(cid);
        if (c) {
            c.remove();
            this.canvasMap.delete(cid);
        }
    }

    private setCanvasAnchor(cid: string, pid: string) {
        const c = this.canvasMap.get(cid),
            p = this.canvasMap.get(pid);
        if (c && p) p.parentElement?.appendChild(c);
    }

    private setCanvasOffset(cid: string, x: number, y: number) {
        const c = this.canvasMap.get(cid);
        if (c) {
            c.style.left = `${x}px`;
            c.style.top = `${y}px`;
        }
    }

    private createSurface(sid: string, cid: string, tid?: string) {
        const canvas = this.canvasMap.get(cid);
        const el = document.createElement("div");
        el.style.position = "absolute";
        if (canvas) el.appendChild(canvas);
        this.surfaceMap.set(sid, { el, toplevelId: tid || null });
        this.area(tid)?.appendChild(el);
    }

    private destroySurface(sid: string) {
        const s = this.surfaceMap.get(sid);
        if (s) {
            s.el.remove();
            this.surfaceMap.delete(sid);
        }
    }

    private setSurfaceGeo(sid: string, w: number, h: number, ox: number, oy: number) {
        const s = this.surfaceMap.get(sid);
        if (!s) return;
        s.el.style.width = `${w}px`;
        s.el.style.height = `${h}px`;
        const c = s.el.querySelector("canvas");
        if (c) {
            c.style.left = `-${ox}px`;
            c.style.top = `-${oy}px`;
        }
        if (s.toplevelId) {
            const a = this.area(s.toplevelId);
            if (a) {
                a.style.width = `${w}px`;
                a.style.height = `${h}px`;
            }
        }
    }

    private addPopup(pid: string, tid: string) {
        const el = document.createElement("div");
        el.style.position = "absolute";
        el.id = pid;
        this.area(tid)?.appendChild(el);
    }

    private setPopupPosi(pid: string, x: number, y: number) {
        const el = document.getElementById(pid);
        if (el) {
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
        }
    }

    // ==================== Input ====================

    private setupTileInput(area: HTMLElement, tid: string) {
        const send = (ev: any) => {
            ev.toplevelId = tid;
            this.connect.send(JSON.stringify({ type: "inputEvent", event: ev }));
        };
        const rel = (e: PointerEvent | WheelEvent) => {
            const r = area.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        };
        area.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            const p = rel(e);
            send({ type: "pointerdown", x: p.x, y: p.y, button: (e as PointerEvent).button });
        });
        area.addEventListener("pointerup", (e) => {
            const p = rel(e);
            send({ type: "pointerup", x: p.x, y: p.y, button: (e as PointerEvent).button });
        });
        area.addEventListener("pointermove", (e) => {
            const p = rel(e);
            send({ type: "pointermove", x: p.x, y: p.y });
        });
        area.addEventListener(
            "wheel",
            (e) => {
                e.preventDefault();
                send({ type: "wheel", deltaX: (e as WheelEvent).deltaX, deltaY: (e as WheelEvent).deltaY });
            },
            { passive: false },
        );
    }

    private setupGlobalKeys() {
        document.addEventListener("keydown", (e) => {
            if (!this.connected || !this.focusedToplevelId) return;
            this.connect.send(
                JSON.stringify({
                    type: "inputEvent",
                    event: { type: "keydown", code: e.code, key: e.key, toplevelId: this.focusedToplevelId },
                }),
            );
        });
        document.addEventListener("keyup", (e) => {
            if (!this.connected || !this.focusedToplevelId) return;
            this.connect.send(
                JSON.stringify({
                    type: "inputEvent",
                    event: { type: "keyup", code: e.code, key: e.key, toplevelId: this.focusedToplevelId },
                }),
            );
        });
    }
}

document.addEventListener("DOMContentLoaded", () => new App());
