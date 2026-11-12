import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoopbackAdapterManager, UntrustedLoopbackAdapterManager } from "myde-remote-connect/loopback_adapter_manager";
import { describe, expect, it } from "vitest";
import { AnyTarget, buildMessage, Connect, ConnectMap, type PairResult, parseMessage } from "./connect";
import { FileConnectStorage } from "./file_storage";
import { MemoryConnectStorage } from "./storage";

async function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    }
    await sleep(50); // 收到连接图信息
    return m;
}

const maps = {
    2: () => buildMap([["A", "B"]]),
    "3-": () =>
        buildMap([
            ["A", "B"],
            ["B", "C"],
        ]),
    "3o": () =>
        buildMap([
            ["A", "B"],
            ["B", "C"],
            ["C", "A"],
        ]),
    "4x": () =>
        buildMap([
            ["A", "B"],
            ["B", "C"],
            ["C", "D"],
            ["D", "A"],
            ["A", "C"],
            ["B", "D"],
        ]),
    "<>": () =>
        buildMap([
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
    "-<>-<>-": () =>
        buildMap([
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
        if (args.json.message) p.resolve(args.json.message);
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

describe("认证", () => {
    it("没有认证的渠道", async () => {
        const adapterManager = new UntrustedLoopbackAdapterManager();
        const a = new Connect({ id: "A", adapter: () => adapterManager.newAdapter() });
        const b = new Connect({ id: "B", adapter: () => adapterManager.newAdapter() });
        await a.init();
        await b.init();
        const ac = await a.startPairing();
        const bc = await b.startPairing();

        const ap = Promise.withResolvers<PairResult>();

        const br = await bc.connect(ac.pointId);
        ac.onPair((rq) => {
            rq.waitForPair().then((pair) => {
                ap.resolve(pair);
            });
        });
        br.inputOtherPin(ac.pin);
        const [arr, brr] = await Promise.all([ap.promise, br.waitForPair()]);
        expect(arr.targetId).toBe("B");
        expect(brr.targetId).toBe("A");
        expect(arr.from).toBe(brr.to);
        expect(arr.to).toBe(brr.from);
        expect(arr.myPublicKey).toEqual(brr.remotePublicKey);
        expect(arr.remotePublicKey).toEqual(brr.myPublicKey);
        await sleep(50);
        await testConnection(a, b, "A", "B");
    });
});

describe("持久化", () => {
    it("自动生成并保存 id", () => {
        const storage = new MemoryConnectStorage();
        const adapter = () => {
            throw new Error("adapter not used");
        };
        const a = new Connect({ adapter, storage });
        const id = a.getId();
        expect(id).toBeTruthy();

        const b = new Connect({ adapter, storage });
        expect(b.getId()).toBe(id);

        const newId = b.refreshId();
        expect(newId).not.toBe(id);
        const c = new Connect({ adapter, storage });
        expect(c.getId()).toBe(newId);
    });

    it("startPairing 不等待信令连接就返回 pointId 和 pin", async () => {
        const connect = new Connect({
            adapter: () => ({
                trustIdentity: true,
                supportNativeEncryption: false,
                init: () => new Promise<void>(() => {}),
                connect: async () => {},
                send: async () => {},
                close: () => {},
                onMessage: () => {},
                onClose: () => {},
                onError: () => {},
            }),
            storage: new MemoryConnectStorage(),
        });
        const session = await Promise.race([connect.startPairing(), sleep(100).then(() => undefined)]);
        expect(session).toBeDefined();
        if (!session) throw new Error("startPairing waited for signaling");
        expect(session.pointId).toBeTruthy();
        expect(session.pin).toMatch(/^\d{6}$/);
    });

    it("重启后保留 id 和配对凭据", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myde-connect-test-"));
        try {
            const storageA = new FileConnectStorage(path.join(dir, "a.json"));
            const storageB = new FileConnectStorage(path.join(dir, "b.json"));
            const manager = new UntrustedLoopbackAdapterManager();
            const a = new Connect({ id: "A", adapter: () => manager.newAdapter(), storage: storageA });
            const b = new Connect({ id: "B", adapter: () => manager.newAdapter(), storage: storageB });
            await a.init();
            await b.init();

            const ac = await a.startPairing();
            const bc = await b.startPairing();
            const ap = Promise.withResolvers<PairResult>();
            const br = await bc.connect(ac.pointId);
            ac.onPair((rq) => {
                rq.waitForPair().then((pair) => ap.resolve(pair));
            });
            br.inputOtherPin(ac.pin);
            await Promise.all([ap.promise, br.waitForPair()]);
            await sleep(50);

            expect(a.getSavedConnections().length).toBe(1);
            expect(b.getSavedConnections().length).toBe(1);

            const manager2 = new UntrustedLoopbackAdapterManager();
            const a2 = new Connect({ adapter: () => manager2.newAdapter(), storage: storageA });
            const b2 = new Connect({ adapter: () => manager2.newAdapter(), storage: storageB });
            expect(a2.getId()).toBe("A");
            expect(b2.getId()).toBe("B");
            await a2.init();
            await b2.init();
            expect(a2.getSavedConnections().length).toBe(1);
            await a2.connect({ targetId: Connect.pointDeviceId("B") });
            await sleep(50);
            await testConnection(a2, b2, "A", "B");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("临时连接不写入存储", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myde-connect-test-"));
        try {
            const storageA = new FileConnectStorage(path.join(dir, "a.json"));
            const storageB = new FileConnectStorage(path.join(dir, "b.json"));
            const manager = new UntrustedLoopbackAdapterManager();
            const a = new Connect({ id: "A", adapter: () => manager.newAdapter(), storage: storageA });
            const b = new Connect({ id: "B", adapter: () => manager.newAdapter(), storage: storageB });
            await a.init();
            await b.init();

            const ac = await a.startPairing({ remember: false });
            const bc = await b.startPairing({ remember: false });
            const br = await bc.connect(ac.pointId);
            ac.onPair((rq) => {
                rq.waitForPair().catch(() => {});
            });
            br.inputOtherPin(ac.pin);
            await br.waitForPair();
            await sleep(50);

            expect(a.getSavedConnections()).toEqual([]);
            expect(b.getSavedConnections()).toEqual([]);

            const a2 = new Connect({ adapter: () => manager.newAdapter(), storage: storageA });
            await a2.init();
            expect(a2.getSavedConnections()).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("connect", () => {
    describe("发送消息到指定目标，不限直连", () => {
        it("2点", async () => {
            const map = await maps[2]();
            expect(map.size).toBe(2);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("3点串", async () => {
            const map = await maps["3-"]();
            expect(map.size).toBe(3);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("3点环", async () => {
            const map = await maps["3o"]();
            expect(map.size).toBe(3);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("4点立方", async () => {
            const map = await maps["4x"]();
            expect(map.size).toBe(4);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("多束", async () => {
            const map = await maps["<>"]();
            expect(map.size).toBe(7);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testConnection(c, tc, id, tid);
                }
            }
        });
        it("多环", async () => {
            const map = await maps["-<>-<>-"]();
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
            const map = await maps[2]();
            expect(map.size).toBe(2);
            for (const [id, c] of map) {
                await testBroadcast(c, id, map);
            }
        });
        it("3点串", async () => {
            const map = await maps["3-"]();
            expect(map.size).toBe(3);
            for (const [id, c] of map) {
                await testBroadcast(c, id, map);
            }
        });
        it("3点环", async () => {
            const map = await maps["3o"]();
            expect(map.size).toBe(3);
            for (const [id, c] of map) {
                await testBroadcast(c, id, map);
            }
        });
        it("4点立方", async () => {
            const map = await maps["4x"]();
            expect(map.size).toBe(4);
            for (const [id, c] of map) {
                await testBroadcast(c, id, map);
            }
        });
        it("多束", async () => {
            const map = await maps["<>"]();
            expect(map.size).toBe(7);
            for (const [id, c] of map) {
                await testBroadcast(c, id, map);
            }
        });
        it("多环", async () => {
            const map = await maps["-<>-<>-"]();
            for (const [id, c] of map) {
                await testBroadcast(c, id, map);
            }
        });
    });
    describe("回调", () => {
        async function testCallback(a: Connect, b: Connect, aid: string, bid: string) {
            const clean = b.addCallBackHandler((args) => {
                if (args.json.action === "reverse") {
                    return {
                        json: { message: args.json.message.split("").reverse().join("") },
                        bins: [],
                    };
                } else if (args.json.action === "multiply") {
                    return {
                        json: { message: args.json.message.repeat(2) },
                        bins: [],
                    };
                }
                return undefined;
            });
            await a.sendTo({
                targetId: [Connect.targetId(bid)],
                json: { message: `other` },
            });
            const m = a.sendToAndReceive({
                targetId: Connect.targetId(bid),
                json: { action: "reverse", message: `hello from ${aid} to ${bid}` },
            });
            const m2 = a.sendToAndReceive({
                targetId: Connect.targetId(bid),
                json: { action: "multiply", message: `hello from ${aid} to ${bid}` },
            });
            const [rm, rm2] = await Promise.all([m, m2]);
            clean();

            expect(rm.json.message).toEqual(`hello from ${aid} to ${bid}`.split("").reverse().join(""));
            expect(rm2.json.message).toEqual(`hello from ${aid} to ${bid}`.repeat(2));
        }
        it("2点", async () => {
            const map = await maps[2]();
            expect(map.size).toBe(2);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testCallback(c, tc, id, tid);
                }
            }
        });
        it("3点串", async () => {
            const map = await maps["3-"]();
            expect(map.size).toBe(3);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testCallback(c, tc, id, tid);
                }
            }
        });
        it("3点环", async () => {
            const map = await maps["3o"]();
            expect(map.size).toBe(3);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testCallback(c, tc, id, tid);
                }
            }
        });
        it("4点立方", async () => {
            const map = await maps["4x"]();
            expect(map.size).toBe(4);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testCallback(c, tc, id, tid);
                }
            }
        });
        it("多束", async () => {
            const map = await maps["<>"]();
            expect(map.size).toBe(7);
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testCallback(c, tc, id, tid);
                }
            }
        });
        it("多环", async () => {
            const map = await maps["-<>-<>-"]();
            for (const [id, c] of map) {
                for (const [tid, tc] of map) {
                    if (id !== tid) await testCallback(c, tc, id, tid);
                }
            }
        });
    });
    describe("连接全局图", () => {
        it("2点", async () => {
            const map = await maps[2]();
            for (const [_, c] of map) {
                const globalMap = c.getGlobalMap();
                const allPoints = new Set(globalMap.flat());
                expect(allPoints.size).toBe(map.size);
                expect(globalMap.length).toBe(1);
            }
        });
        it("3点串", async () => {
            const map = await maps["3-"]();
            for (const [_, c] of map) {
                const globalMap = c.getGlobalMap();
                const allPoints = new Set(globalMap.flat());
                expect(allPoints.size).toBe(map.size);
                expect(globalMap.length).toBe(2);
            }
        });
        it("3点环", async () => {
            const map = await maps["3o"]();
            for (const [_, c] of map) {
                const globalMap = c.getGlobalMap();
                const allPoints = new Set(globalMap.flat());
                expect(allPoints.size).toBe(map.size);
                expect(globalMap.length).toBe(3);
            }
        });
        it("4点立方", async () => {
            const map = await maps["4x"]();
            for (const [_, c] of map) {
                const globalMap = c.getGlobalMap();
                const allPoints = new Set(globalMap.flat());
                expect(allPoints.size).toBe(map.size);
                expect(globalMap.length).toBe(6);
            }
        });
        it("多束", async () => {
            const map = await maps["<>"]();
            for (const [_, c] of map) {
                const globalMap = c.getGlobalMap();
                const allPoints = new Set(globalMap.flat());
                expect(allPoints.size).toBe(map.size);
                expect(globalMap.length).toBe(9);
            }
        });
        it("多环", async () => {
            const map = await maps["-<>-<>-"]();
            for (const [_, c] of map) {
                const globalMap = c.getGlobalMap();
                const allPoints = new Set(globalMap.flat());
                expect(allPoints.size).toBe(map.size);
                expect(globalMap.length).toBe(15);
            }
        });
    });
    describe("介绍连接", () => {
        it("不用认证渠道", async () => {
            const map = await buildMap([
                ["A", "B"],
                ["B", "C"],
            ]);
            for (const [_, c] of map) {
                const globalMap = c.getGlobalMap();
                expect(globalMap).not.toContainEqual(["A", "C"]);
            }
            await map.get("A")?.connect2({ targetId: Connect.targetId("C") });
            await sleep(10);
            for (const [_, c] of map) {
                const globalMap = c.getGlobalMap();
                expect(globalMap).toContainEqual(["A", "C"]);
            }
        });
        async function pairConnect(a: Connect, b: Connect) {
            const ac = await a.startPairing();
            const bc = await b.startPairing();

            const ap = Promise.withResolvers<PairResult>();

            const br = await bc.connect(ac.pointId);
            ac.onPair((rq) => {
                rq.waitForPair().then((pair) => {
                    ap.resolve(pair);
                });
            });
            br.inputOtherPin(ac.pin);
            await Promise.all([ap.promise, br.waitForPair()]);
        }
        it("认证渠道", async () => {
            const adapterManager = new UntrustedLoopbackAdapterManager();
            const a = new Connect({ id: "A", adapter: () => adapterManager.newAdapter() });
            const b = new Connect({ id: "B", adapter: () => adapterManager.newAdapter() });
            const c = new Connect({ id: "C", adapter: () => adapterManager.newAdapter() });
            await a.init();
            await b.init();
            await c.init();
            await pairConnect(a, b);
            await pairConnect(b, c);
            for (const x of [a, b, c]) {
                const globalMap = x.getGlobalMap();
                expect(globalMap).not.toContainEqual(["A", "C"]);
            }
            await sleep(10);
            await a.connect2({ targetId: Connect.targetId("C") });
            await sleep(10);
            for (const x of [a, b, c]) {
                const globalMap = x.getGlobalMap();
                expect(globalMap).toContainEqual(["A", "C"]);
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
