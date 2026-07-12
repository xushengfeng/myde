import { LoopbackAdapterManager } from "myde-remote-connect/loopback_adapter_manager";
import { describe, expect, it } from "vitest";
import { AnyTarget, buildMessage, Connect, ConnectMap, parseMessage } from "./connect";

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

const maps = {
    2: await buildMap([["A", "B"]]),
    "3-": await buildMap([
        ["A", "B"],
        ["B", "C"],
    ]),
    "3o": await buildMap([
        ["A", "B"],
        ["B", "C"],
        ["C", "A"],
    ]),
    "4x": await buildMap([
        ["A", "B"],
        ["B", "C"],
        ["C", "D"],
        ["D", "A"],
        ["A", "C"],
        ["B", "D"],
    ]),
    "<>": await buildMap([
        ["A", "B"],
        ["B", "C"],
        ["B", "D"],
        ["B", "E"],
        ["B", "F"],
        ["C", "G"],
        ["D", "G"],
        ["E", "G"],
        ["F", "G"],
    ]),
    "-<>-<>-": await buildMap([
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
    ]),
};

async function testConnection(a: Connect, b: Connect, aid: string, bid: string) {
    const p = Promise.withResolvers<string>();
    const clean = b.addHandler((args) => {
        // if (args.json._.targetId !== bid) return;
        p.resolve(args.json.message);
    });
    const m = `hello from ${aid} to ${bid}`;
    await a.sendTo({
        targetId: [Connect.targetId(bid)],
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
            const map = maps[2];
            expect(map.size).toBe(2);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("3点串", async () => {
            const map = maps["3-"];
            expect(map.size).toBe(3);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("3点环", async () => {
            const map = maps["3o"];
            expect(map.size).toBe(3);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("4点立方", async () => {
            const map = maps["4x"];
            expect(map.size).toBe(4);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("多束", async () => {
            const map = maps["<>"];
            expect(map.size).toBe(7);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("多环", async () => {
            const map = maps["-<>-<>-"];
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
    });
    describe("广播", () => {
        function testBroadcast(a: Connect, aid: string, map: Map<string, Connect>) {
            const ps = Array.from(map.entries())
                .filter(([id]) => id !== aid)
                .map(([id, b]) => {
                    const p = Promise.withResolvers<string>();
                    const clean = b.addHandler((args) => {
                        p.resolve(args.json.message);
                    });
                    const timeout = setTimeout(() => {
                        p.reject(new Error(`${id} wait ${aid} but timeout`));
                    }, 400);
                    p.promise.finally(() => {
                        clearTimeout(timeout);
                    });
                    return p.promise.finally(clean);
                });
            a.sendTo({
                targetId: AnyTarget,
                json: { message: `hello from ${aid} to any` },
            });
            return Promise.all(ps);
        }
        it("2点", async () => {
            const map = maps[2];
            expect(map.size).toBe(2);
            for (const [id, c] of map) {
                await testBroadcast(c, id, map);
            }
        });
        it("3点串", async () => {
            const map = maps["3-"];
            expect(map.size).toBe(3);
            for (const [id, c] of map) {
                await testBroadcast(c, id, map);
            }
        });
        it("3点环", async () => {
            const map = maps["3o"];
            expect(map.size).toBe(3);
            for (const [id, c] of map) {
                await testBroadcast(c, id, map);
            }
        });
        it("4点立方", async () => {
            const map = maps["4x"];
            expect(map.size).toBe(4);
            for (const [id, c] of map) {
                await testBroadcast(c, id, map);
            }
        });
        it("多束", async () => {
            const map = maps["<>"];
            expect(map.size).toBe(7);
            for (const [id, c] of map) {
                await testBroadcast(c, id, map);
            }
        });
        it("多环", async () => {
            const map = maps["-<>-<>-"];
            for (const [id, c] of map) {
                await testBroadcast(c, id, map);
            }
        });
    });
});

describe("connect map", () => {
    it("should create and destroy pairs correctly", () => {
        const connectMap = new ConnectMap();
        connectMap.createPair("A", "B");
        connectMap.createPair("A", "C");
        connectMap.createPair("B", "D");

        expect(connectMap.getNeighbors("A")).toEqual(["B", "C"]);
        expect(connectMap.getNeighbors("B")).toEqual(["A", "D"]);
        expect(connectMap.getNeighbors("C")).toEqual(["A"]);
        expect(connectMap.getNeighbors("D")).toEqual(["B"]);

        connectMap.destroyPair("A", "B");
        expect(connectMap.getNeighbors("A")).toEqual(["C"]);
        expect(connectMap.getNeighbors("B")).toEqual(["D"]);
    });

    it("should find paths correctly", () => {
        const connectMap = new ConnectMap();
        connectMap.createPair("A", "B");
        connectMap.createPair("B", "C");
        connectMap.createPair("C", "D");
        connectMap.createPair("A", "D");

        const path1 = connectMap.findPath("A", "D");
        expect(path1[0]).toBe("A");
        expect(path1.at(-1)).toBe("D");
        const path2 = connectMap.findPath("B", "D");
        expect(path2[0]).toBe("B");
        expect(path2.at(-1)).toBe("D");
        const path3 = connectMap.findPath("C", "A");
        expect(path3[0]).toBe("C");
        expect(path3.at(-1)).toBe("A");
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
