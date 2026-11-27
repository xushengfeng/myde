import { describe, expect, it } from "vitest";
import type { DndPeer, WaylandWinId } from "../module";
import { newFd } from "../utils/fd";
import { DndHub } from "./dnd_hub";

const WIN = 2 as WaylandWinId;

type Sent = { id: number; event: string; args: Record<string, unknown> };

function makePeer(clientId: string) {
    const sent: Sent[] = [];
    const forwarded: { sourceId: number; mime: string; fd: number }[] = [];
    let detached = 0;
    let nextId = 100;
    const peer = {
        clientId,
        objects: {
            create: () => nextId++,
            getOption: () => ({ version: 3 }),
            setData: () => {},
        },
        sendNow: (id: number, event: string, args: Record<string, unknown>) => sent.push({ id, event, args }),
        dataDevices: () => [11],
        nextSerial: () => 7,
        hitTest: (_winId: number, p: { x: number; y: number }) => ({
            surface: 20,
            xdgSurface: 21,
            x: p.x + 1,
            y: p.y + 2,
            role: "main" as const,
        }),
        sendDataSource: (sourceId: number, mime: string, fd: number) => {
            forwarded.push({ sourceId, mime, fd });
            return true;
        },
        readDataSource: async () => new TextEncoder().encode("hello"),
        detachLocalDrag: () => {
            detached++;
        },
        endLocalDrag: () => {},
    } as unknown as DndPeer;
    return {
        peer,
        sent,
        forwarded,
        detached: () => detached,
    };
}

function makeHub() {
    const started: string[] = [];
    const icons: { token: string; icon: unknown }[] = [];
    const finished: { token: string; reason: string }[] = [];
    const requests: { id: string; mime: string }[] = [];
    const hub = new DndHub({
        started: (info) => started.push(info.token),
        icon: (token, icon) => icons.push({ token, icon }),
        finished: (token, reason) => finished.push({ token, reason }),
        requestData: async (id, mime) => {
            requests.push({ id, mime });
            return new TextEncoder().encode("desktop");
        },
    });
    return { hub, started, icons, finished, requests };
}

function events(sent: Sent[], name: string) {
    return sent.filter((e) => e.event === name);
}

describe("DndHub", () => {
    it("跨 client move/drop：目标接 offer，fd 转发给源", () => {
        const { hub, started, finished } = makeHub();
        const a = makePeer("A");
        const b = makePeer("B");
        hub.attach(a.peer);
        hub.attach(b.peer);

        const token = hub.startClient("A", "app", "seat0", 12, ["text/plain"], 1);
        expect(started).toEqual([token]);

        hub.move(token, { clientId: "B", winId: WIN, x: 10, y: 10 });
        expect(a.detached()).toBe(1);
        const enter = events(b.sent, "wl_data_device.enter")[0];
        expect(enter).toBeDefined();
        expect(enter.args).toMatchObject({ surface: 20, x: 11, y: 12 });
        const offerId = enter.args.id as number;

        hub.forClient("B").targetActions(token, offerId, 1, 1);
        hub.forClient("B").targetActions(token, offerId, 1, 1);
        hub.forClient("B").targetActions(token, offerId, 1, 1);
        expect(events(b.sent, "wl_data_offer.action")).toHaveLength(1);
        expect(events(a.sent, "wl_data_source.action")).toHaveLength(1);
        hub.drop(token, { clientId: "B", winId: WIN, x: 10, y: 10 });
        expect(events(b.sent, "wl_data_device.drop")).toHaveLength(1);
        expect(events(a.sent, "wl_data_source.dnd_drop_performed")).toHaveLength(1);

        const { fd } = newFd("");
        hub.forClient("B").targetReceive(token, offerId, "text/plain", fd);
        expect(a.forwarded[0]).toMatchObject({ sourceId: 12, mime: "text/plain" });

        hub.forClient("B").targetFinish(token, offerId);
        expect(events(a.sent, "wl_data_source.dnd_finished")).toHaveLength(1);
        expect(finished).toEqual([{ token, reason: "finished" }]);
    });

    it("桌面作为源：receive 时通过 requestData 取字节", () => {
        const { hub, requests, finished } = makeHub();
        const b = makePeer("B");
        hub.attach(b.peer);

        const token = hub.startDesktop("item-1", ["text/plain;charset=utf-8"]);
        hub.move(token, { clientId: "B", winId: WIN, x: 0, y: 0 });
        const offerId = events(b.sent, "wl_data_device.enter")[0].args.id as number;

        hub.forClient("B").targetReceive(token, offerId, "text/plain;charset=utf-8", newFd("").fd);
        expect(requests).toEqual([{ id: "item-1", mime: "text/plain;charset=utf-8" }]);

        hub.forClient("B").targetFinish(token, offerId);
        expect(finished).toEqual([{ token, reason: "finished" }]);
    });

    it("move(null) 发 leave，cancel 给源发 cancelled", () => {
        const { hub, finished } = makeHub();
        const a = makePeer("A");
        const b = makePeer("B");
        hub.attach(a.peer);
        hub.attach(b.peer);

        const token = hub.startClient("A", "app", "seat0", 12, ["text/plain"], 1);
        hub.move(token, { clientId: "B", winId: WIN, x: 1, y: 1 });
        hub.move(token, null);
        expect(events(b.sent, "wl_data_device.leave")).toHaveLength(1);

        hub.cancel(token);
        expect(events(a.sent, "wl_data_source.cancelled")).toHaveLength(1);
        expect(finished).toEqual([{ token, reason: "cancelled" }]);
    });

    it("drop(null) 是“窗口外释放”：发 drop_performed + finished，不发 cancelled", () => {
        const { hub, finished } = makeHub();
        const a = makePeer("A");
        hub.attach(a.peer);

        const token = hub.startClient("A", "app", "seat0", 12, ["text/plain"], 1);
        hub.drop(token, null);

        expect(events(a.sent, "wl_data_source.dnd_drop_performed")).toHaveLength(1);
        expect(events(a.sent, "wl_data_source.dnd_finished")).toHaveLength(1);
        expect(events(a.sent, "wl_data_source.cancelled")).toHaveLength(0);
        expect(finished).toEqual([{ token, reason: "finished" }]);
    });

    it("源图标按 source 映射到会话，会话结束后丢弃", () => {
        const { hub, icons } = makeHub();
        const a = makePeer("A");
        hub.attach(a.peer);

        const token = hub.startClient("A", "app", "seat0", 12, ["text/plain"], 1);
        const icon = {
            canvas: { width: 16, height: 16 } as OffscreenCanvas,
            size: { width: 16, height: 16 },
            offset: { x: 0, y: 0 },
        };
        hub.icon("A", 12, icon);
        expect(icons).toEqual([{ token, icon }]);

        hub.icon("A", 999, icon);
        expect(icons).toHaveLength(1);

        hub.cancel(token);
        hub.icon("A", 12, icon);
        expect(icons).toHaveLength(1);
    });
});
