import { LoopbackAdapterManager } from "myde-remote-connect/loopback_adapter_manager";
import { describe, expect, it } from "vitest";
import { buildMessage, Connect, parseMessage } from "./connect";

async function buildMap(map: [p1: string, p2: string][]) {
    const adapterManager = new LoopbackAdapterManager();
    const ids = new Set<string>();
    for (const [p1, p2] of map) {
        ids.add(p1);
        ids.add(p2);
    }
    const m: Map<string, Connect> = new Map(
        Array.from(ids).map((id) => [id, new Connect({ id, adapter: () => adapterManager.newAdapter() })]),
    );
    for (const [i, [p1, p2]] of map.entries()) {
        const id1 = `${i}-${p1}`;
        const id2 = `${i}-${p2}`;
        m.get(p1)?.setConnectionConfig({
            targetId: Connect.pointDeviceId(p2),
            from: Connect.pointId(id1),
            to: Connect.pointId(id2),
            remoteDeviceName: p2,
            cert: "",
        });
        m.get(p2)?.setConnectionConfig({
            targetId: Connect.pointDeviceId(p1),
            from: Connect.pointId(id2),
            to: Connect.pointId(id1),
            remoteDeviceName: p1,
            cert: "",
        });
    }
    for (const c of m.values()) {
        await c.init();
    }
    for (const [p1, p2] of map) {
        await m.get(p1)?.connect({ targetId: Connect.pointDeviceId(p2) });
        await m.get(p2)?.connect({ targetId: Connect.pointDeviceId(p1) });
    }
    return m;
}

async function testConnection(a: Connect, b: Connect, aid: string, bid: string) {
    const p = Promise.withResolvers<string>();
    const clean = b.addHandler((args) => {
        if (args.json._.targetId !== bid) return;
        p.resolve(args.json.message);
    });
    const m = `hello from ${aid} to ${bid}`;
    await a.sendTo({
        targetId: Connect.targetId(bid),
        json: { message: m },
    });
    const timeout = setTimeout(() => {
        p.reject(new Error(`${bid} wait ${aid} but timeout`));
    }, 400);

    const msg = await p.promise;
    clean();
    clearTimeout(timeout);
    expect(msg).toBe(m);
}

describe("connect", () => {
    describe("发送消息到指定目标，不限直连", () => {
        it("2点", async () => {
            const map = await buildMap([["A", "B"]]);
            expect(map.size).toBe(2);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("3点串", async () => {
            const map = await buildMap([
                ["A", "B"],
                ["B", "C"],
            ]);
            expect(map.size).toBe(3);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("3点环", async () => {
            const map = await buildMap([
                ["A", "B"],
                ["B", "C"],
                ["C", "A"],
            ]);
            expect(map.size).toBe(3);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("4点立方", async () => {
            const map = await buildMap([
                ["A", "B"],
                ["B", "C"],
                ["C", "D"],
                ["D", "A"],
                ["A", "C"],
                ["B", "D"],
            ]);
            expect(map.size).toBe(4);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("多束", async () => {
            const map = await buildMap([
                ["A", "B"],
                ["B", "C"],
                ["B", "D"],
                ["B", "E"],
                ["B", "F"],
                ["C", "G"],
                ["D", "G"],
                ["E", "G"],
                ["F", "G"],
            ]);
            expect(map.size).toBe(7);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("多环", async () => {
            const map = await buildMap([
                ["A", "B"],
                ["B", "C1"],
                ["C1", "D"],
                ["B", "C2"],
                ["C2", "D"],
                ["D", "C3"],
                ["C3", "E"],
                ["D", "C4"],
                ["C4", "E"],
                ["E", "F"],
                ["F", "C5"],
                ["C5", "G"],
                ["F", "C6"],
                ["C6", "G"],
                ["G", "H"],
            ]);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
    });
});

describe("message", () => {
    it("should build and parse message correctly", () => {
        const json = { type: "test", data: "Hello, World!" };
        const m = buildMessage(json, []);
        const parsed = parseMessage(m);
        expect(parsed.json).toEqual(json);
        expect(parsed.bins.length).toBe(0);
    });
    it("should build and parse message with binary data correctly", () => {
        const json = { type: "test", data: "Hello, World!" };
        const bin1 = new Uint8Array([1, 2, 3]).buffer;
        const bin2 = new Uint8Array([4, 5, 6]).buffer;
        const m = buildMessage(json, [bin1, bin2]);
        const parsed = parseMessage(m);
        expect(parsed.json).toEqual(json);
        expect(parsed.bins.length).toBe(2);
        expect(new Uint8Array(parsed.bins[0])).toEqual(new Uint8Array(bin1));
        expect(new Uint8Array(parsed.bins[1])).toEqual(new Uint8Array(bin2));
    });
});
