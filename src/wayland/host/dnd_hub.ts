import type { DragEndReason, DragStartInfo } from "../api";
import type { DndHubApi, DndPeer, DragIconFrame, HitTestResult, WaylandObjectId2, WaylandWinId } from "../module";

const fs = require("node:fs") as typeof import("node:fs");

const DND_ACTION_COPY = 1;
const DND_ACTION_MOVE = 2;

type SessionSource =
    | { kind: "client"; clientId: string; sourceId: number; appid: string }
    | { kind: "desktop"; itemId: string; appid: string };

type Target = {
    clientId: string;
    dataDeviceId: WaylandObjectId2<"wl_data_device">;
    offerId: WaylandObjectId2<"wl_data_offer">;
    surface: number;
    x: number;
    y: number;
    accepted?: string;
    targetActions: number;
    preferredAction: number;
    selectedAction: number;
    /** 已经发给目标的 action；只在变化时重发，避免客户端 set_actions/action 对拍 */
    reportedAction?: number;
};

type Session = {
    id: string;
    seat: string;
    mimes: string[];
    sourceActions: number;
    source: SessionSource;
    target?: Target;
    dropped: boolean;
    finishTimer?: NodeJS.Timeout;
    /** 桌面开始驱动后，源客户端自己的同 client 目标被撤掉 */
    localDetached: boolean;
};

function actionNames(mask: number): ("copy" | "move")[] {
    const actions: ("copy" | "move")[] = [];
    if ((mask & DND_ACTION_COPY) !== 0) actions.push("copy");
    if ((mask & DND_ACTION_MOVE) !== 0) actions.push("move");
    return actions;
}

function chooseAction(sourceActions: number, targetActions: number, preferred: number): number {
    if (targetActions === 0) return 0;
    if (preferred !== 0 && (preferred & targetActions) !== 0 && (preferred & sourceActions) !== 0) return preferred;
    if ((sourceActions & DND_ACTION_COPY) !== 0 && (targetActions & DND_ACTION_COPY) !== 0) return DND_ACTION_COPY;
    if ((sourceActions & DND_ACTION_MOVE) !== 0 && (targetActions & DND_ACTION_MOVE) !== 0) return DND_ACTION_MOVE;
    return 0;
}

/**
 * 跨客户端拖拽会话。
 *
 * 源客户端的 `start_drag` 仍保留同 client 的本地目标作为回退；桌面一旦调用
 * `dnd.move`，这里就撤掉本地目标并接管目标发现。目标事件（offer accept /
 * set_actions / receive / finish）由目标连接的 core 转发回来。
 */
export class DndHub implements DndHubApi {
    private peers = new Map<string, DndPeer>();
    private sessions = new Map<string, Session>();
    private bySource = new Map<string, string>();

    constructor(
        private op: {
            started(info: DragStartInfo): void;
            /** 源图标新帧/撤销；token 是该会话的只读 token */
            icon(token: string, icon: DragIconFrame | null): void;
            finished(token: string, reason: DragEndReason): void;
            requestData(id: string, mime: string): Promise<Uint8Array | null>;
        },
    ) {}

    attach(peer: DndPeer): void {
        this.peers.set(peer.clientId, peer);
    }

    detach(clientId: string): void {
        this.peers.delete(clientId);
        for (const session of [...this.sessions.values()]) {
            if (session.source.kind === "client" && session.source.clientId === clientId) {
                this.finish(session.id, "cancelled", false);
            } else if (session.target?.clientId === clientId) {
                this.finish(session.id, "cancelled", true);
            }
        }
    }

    forClient(clientId: string) {
        return {
            targetAccept: (token: string, offerId: number, mime: string) => this.targetAccept(token, offerId, mime),
            targetActions: (token: string, offerId: number, actions: number, preferred: number) =>
                this.targetActions(token, offerId, actions, preferred),
            targetReceive: (token: string, offerId: number, mime: string, fd: number) =>
                this.targetReceive(token, offerId, mime, fd),
            targetFinish: (token: string, offerId: number) => this.targetFinish(token, offerId),
            targetGone: (token: string, offerId: number) => this.targetGone(token, offerId),
            sourceActions: (sourceId: number, actions: number) => this.sourceActions(clientId, sourceId, actions),
            detachLocalDrag: () => this.peers.get(clientId)?.detachLocalDrag(),
        };
    }

    startClient(
        clientId: string,
        appid: string,
        seat: string,
        sourceId: number,
        mimes: string[],
        sourceActions: number,
    ): string {
        const token = `dnd-${crypto.randomUUID()}`;
        this.sessions.set(token, {
            id: token,
            seat,
            mimes: [...mimes],
            sourceActions,
            source: { kind: "client", clientId, sourceId, appid },
            dropped: false,
            localDetached: false,
        });
        this.bySource.set(`${clientId}:${sourceId}`, token);
        this.op.started({
            token,
            clientId,
            appid,
            seat,
            mimes: [...mimes],
            actions: actionNames(sourceActions),
        });
        return token;
    }

    startDesktop(itemId: string, mimes: string[], sourceActions = DND_ACTION_COPY): string {
        const token = `dnd-${crypto.randomUUID()}`;
        this.sessions.set(token, {
            id: token,
            seat: "seat0",
            mimes: [...mimes],
            sourceActions,
            source: { kind: "desktop", itemId, appid: "" },
            dropped: false,
            localDetached: true,
        });
        return token;
    }

    sourceActions(clientId: string, sourceId: number, actions: number): void {
        const session = this.sessionOfSource(clientId, sourceId);
        if (!session) return;
        if (session.sourceActions === actions) return;
        session.sourceActions = actions;
        const target = session.target;
        if (!target) return;
        this.send(target.clientId, target.offerId, "wl_data_offer.source_actions", { source_actions: actions });
        this.negotiate(session);
    }

    /** 源图标 surface 的新帧（或解绑）；只在会话仍存在时转给桌面 */
    icon(clientId: string, sourceId: number, icon: DragIconFrame | null): void {
        const session = this.sessionOfSource(clientId, sourceId);
        if (!session) return;
        this.op.icon(session.id, icon);
    }

    sourceFinished(clientId: string, sourceId: number, reason: DragEndReason): void {
        const token = this.bySource.get(`${clientId}:${sourceId}`);
        if (token === undefined) return;
        this.finish(token, reason, false);
    }

    read(token: string, mime: string): Promise<Uint8Array | null> {
        const session = this.sessions.get(token);
        if (!session?.mimes.includes(mime)) return Promise.resolve(null);
        if (session.source.kind === "desktop") return this.op.requestData(session.source.itemId, mime);
        const peer = this.peers.get(session.source.clientId);
        if (!peer) return Promise.resolve(null);
        return peer.readDataSource(session.source.sourceId, mime);
    }

    move(token: string, target: { clientId: string; winId: WaylandWinId; x: number; y: number } | null): void {
        const session = this.sessions.get(token);
        if (!session) return;
        if (!target) {
            this.leave(session);
            return;
        }
        const peer = this.peers.get(target.clientId);
        if (!peer) {
            this.leave(session);
            return;
        }
        const hit = peer.hitTest(target.winId, { x: target.x, y: target.y });
        if (!hit) {
            this.leave(session);
            return;
        }
        if (session.dropped) return;
        if (session.target && session.target.clientId === target.clientId && session.target.surface === hit.surface) {
            session.target.x = hit.x;
            session.target.y = hit.y;
            this.send(target.clientId, session.target.dataDeviceId, "wl_data_device.motion", {
                time: Date.now(),
                x: hit.x,
                y: hit.y,
            });
            return;
        }

        if (session.source.kind === "client" && !session.localDetached) {
            this.peers.get(session.source.clientId)?.detachLocalDrag();
            session.localDetached = true;
        }
        this.leave(session);
        this.enter(session, peer, hit);
    }

    drop(token: string, target: { clientId: string; winId: WaylandWinId; x: number; y: number } | null): void {
        const session = this.sessions.get(token);
        if (!session) return;
        if (!target) {
            // 没有目标但也不是用户取消：对应 X11 的 NO_TARGET。
            // 给源发 action=none + dnd_drop_performed + dnd_finished，而不是 cancelled，
            // GTK/Firefox 才会把 dragend 当成“窗口外释放”去撕标签。
            this.leave(session);
            if (session.source.kind === "client") {
                this.send(session.source.clientId, session.source.sourceId, "wl_data_source.action", {
                    dnd_action: 0,
                });
                this.send(session.source.clientId, session.source.sourceId, "wl_data_source.dnd_drop_performed", {});
            }
            this.finish(token, "finished", true);
            return;
        }
        this.move(token, target);
        const t = session.target;
        if (!t) {
            this.finish(token, "cancelled", true);
            return;
        }
        session.dropped = true;
        this.send(t.clientId, t.offerId, "wl_data_offer.action", { dnd_action: t.selectedAction });
        t.reportedAction = t.selectedAction;
        this.send(t.clientId, t.dataDeviceId, "wl_data_device.drop", {});
        this.sendSourceAction(session, t.selectedAction);
        if (session.source.kind === "client") {
            this.send(session.source.clientId, session.source.sourceId, "wl_data_source.dnd_drop_performed", {});
        }
        // 目标不 finish 时兜底
        const timer = setTimeout(() => this.finish(token, "finished", true), 2000);
        (timer as { unref?: () => void }).unref?.();
        session.finishTimer = timer;
    }

    cancel(token: string): void {
        this.finish(token, "cancelled", true);
    }

    private sessionOfSource(clientId: string, sourceId: number): Session | undefined {
        const token = this.bySource.get(`${clientId}:${sourceId}`);
        return token === undefined ? undefined : this.sessions.get(token);
    }

    private enter(session: Session, peer: DndPeer, hit: HitTestResult): void {
        const dataDeviceId = peer.dataDevices(session.seat)[0];
        if (dataDeviceId === undefined) return;
        const offerId = peer.objects.create("wl_data_offer", peer.objects.getOption(dataDeviceId)?.version);
        peer.objects.setData(offerId, {
            mimeTypes: [...session.mimes],
            drag: true,
            dndSessionId: session.id,
        });
        this.send(peer.clientId, dataDeviceId, "wl_data_device.data_offer", { id: offerId });
        for (const mime of session.mimes) {
            this.send(peer.clientId, offerId, "wl_data_offer.offer", { mime_type: mime });
        }
        this.send(peer.clientId, offerId, "wl_data_offer.source_actions", { source_actions: session.sourceActions });
        this.send(peer.clientId, dataDeviceId, "wl_data_device.enter", {
            serial: peer.nextSerial(),
            surface: hit.surface,
            x: hit.x,
            y: hit.y,
            id: offerId,
        });
        session.target = {
            clientId: peer.clientId,
            dataDeviceId,
            offerId,
            surface: hit.surface,
            x: hit.x,
            y: hit.y,
            targetActions: 0,
            preferredAction: 0,
            selectedAction:
                (session.sourceActions & DND_ACTION_COPY) !== 0
                    ? DND_ACTION_COPY
                    : (session.sourceActions & DND_ACTION_MOVE) !== 0
                      ? DND_ACTION_MOVE
                      : 0,
        };
    }

    private leave(session: Session): void {
        const target = session.target;
        if (!target) return;
        this.send(target.clientId, target.dataDeviceId, "wl_data_device.leave", {});
        session.target = undefined;
    }

    private targetAccept(token: string, offerId: number, mime: string): void {
        const session = this.sessions.get(token);
        const target = session?.target;
        if (!session || !target || target.offerId !== offerId) return;
        target.accepted = mime;
    }

    private targetActions(token: string, offerId: number, actions: number, preferred: number): void {
        const session = this.sessions.get(token);
        const target = session?.target;
        if (!session || !target || target.offerId !== offerId) return;
        if (target.targetActions === actions && target.preferredAction === preferred) return;
        target.targetActions = actions;
        target.preferredAction = preferred;
        this.negotiate(session);
    }

    private negotiate(session: Session): void {
        const target = session.target;
        if (!target) return;
        const action = chooseAction(session.sourceActions, target.targetActions, target.preferredAction);
        target.selectedAction = action;
        if (target.reportedAction === action) return;
        target.reportedAction = action;
        this.send(target.clientId, target.offerId, "wl_data_offer.action", { dnd_action: action });
        this.sendSourceAction(session, action);
    }

    private targetReceive(token: string, offerId: number, mime: string, fd: number): void {
        const session = this.sessions.get(token);
        const target = session?.target;
        if (!session || !target || target.offerId !== offerId) {
            this.closeFd(fd);
            return;
        }
        target.accepted = mime;
        if (session.source.kind === "client") {
            const peer = this.peers.get(session.source.clientId);
            const ok = peer?.sendDataSource(session.source.sourceId, mime, fd) ?? false;
            this.closeFd(fd);
            if (!ok) console.warn("dnd: source client is gone");
            return;
        }
        void this.op
            .requestData(session.source.itemId, mime)
            .then((bytes) => {
                if (bytes && bytes.length > 0) {
                    fs.writeFileSync(fd, bytes);
                }
            })
            .finally(() => this.closeFd(fd));
    }

    private targetFinish(token: string, offerId: number): void {
        const session = this.sessions.get(token);
        if (!session || session.target?.offerId !== offerId) return;
        this.finish(token, "finished", true);
    }

    private targetGone(token: string, offerId: number): void {
        const session = this.sessions.get(token);
        if (!session || session.target?.offerId !== offerId) return;
        this.finish(token, session.dropped ? "finished" : "cancelled", true);
    }

    private sendSourceAction(session: Session, action: number): void {
        if (session.source.kind !== "client") return;
        this.send(session.source.clientId, session.source.sourceId, "wl_data_source.action", {
            dnd_action: action,
        });
    }

    private finish(token: string, reason: DragEndReason, notifySource: boolean): void {
        const session = this.sessions.get(token);
        if (!session) return;
        this.sessions.delete(token);
        if (session.source.kind === "client") {
            this.bySource.delete(`${session.source.clientId}:${session.source.sourceId}`);
        }
        if (session.finishTimer) clearTimeout(session.finishTimer);
        const target = session.target;
        session.target = undefined;
        if (notifySource && session.source.kind === "client") {
            if (reason === "finished") {
                this.send(session.source.clientId, session.source.sourceId, "wl_data_source.dnd_finished", {});
            } else {
                this.send(session.source.clientId, session.source.sourceId, "wl_data_source.cancelled", {});
            }
        }
        // GTK/Firefox 的 DnD 兜底：finish/cancelled 之后补一个左键释放，
        // 否则源窗口可能一直停在 drag 状态（Wayland DnD 不经过 wl_pointer.button）。
        if (session.source.kind === "client") {
            this.peers.get(session.source.clientId)?.endLocalDrag();
        }
        if (target && reason === "cancelled") {
            this.send(target.clientId, target.dataDeviceId, "wl_data_device.leave", {});
        }
        this.op.finished(token, reason);
    }

    private send(clientId: string, id: number, event: string, args: Record<string, unknown>): void {
        this.peers.get(clientId)?.sendNow(id, event, args);
    }

    private closeFd(fd: number): void {
        try {
            fs.closeSync(fd);
        } catch {
            // ignore
        }
    }
}
