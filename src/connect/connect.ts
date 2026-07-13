import { SConnect } from "myde-remote-connect";
import type { SignalingAdapter } from "myde-remote-connect/types";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type PointId = string & { __label: "PointId" };
/** 可达的id */
type TargetId = string & { __label: "TargetId" };
/** 直连的id */
type PointDeviceId = TargetId & { isPoint: true };

export const AnyTarget = "anytarget";
export type AnyTargetType = typeof AnyTarget;
type MetaType = {
    targetId: TargetId[] | AnyTargetType;
    path: TargetId[];
    pathHint?: { target: TargetId; path: TargetId[] };
    sourceId?: TargetId;
    messageId?: string;
};

export class Connect {
    private adapter: () => SignalingAdapter;

    private connectionConfig = new Map<
        PointDeviceId,
        { from: PointId; to: PointId; remoteDeviceName: string; cert: string }
    >();
    private connection: Map<
        PointDeviceId,
        {
            connect: SConnect;
            ready: boolean;
        }
    > = new Map();
    private cert: Map<string, { myPrivateKey: Uint8Array; myPublicKey: Uint8Array; remotePublicKey: Uint8Array }> =
        new Map();

    private globalMapHint = new ConnectMap();

    private myId: PointDeviceId = crypto.randomUUID() as PointDeviceId;
    constructor(op: {
        id: string;
        adapter: () => SignalingAdapter;
    }) {
        this.myId = op.id as PointDeviceId;
        this.adapter = op.adapter;
    }

    static pointDeviceId(id: string): PointDeviceId {
        return id as PointDeviceId;
    }
    static pointId(id: string): PointId {
        return id as PointId;
    }
    static targetId(id: string): TargetId {
        return id as TargetId;
    }

    setConnectionConfig(op: {
        targetId: PointDeviceId;
        from: PointId;
        to: PointId;
        remoteDeviceName: string;
        cert: string;
    }) {
        this.connectionConfig.set(op.targetId, {
            from: op.from,
            to: op.to,
            remoteDeviceName: op.remoteDeviceName,
            cert: op.cert,
        });
    }

    async init() {
        for (const [targetId, c] of this.connectionConfig) {
            const connect = new SConnect(this.adapter());
            await connect.init(c.from, c.to);
            this.connection.set(targetId, {
                connect,
                ready: false,
            });
            connect.on("connectRequest", (rq) => {
                const entry = Array.from(this.connectionConfig).find(([_, c]) => c.to === rq.remoteDeviceId);
                if (!entry) {
                    throw new Error(`No connection config for pointId: ${rq.remoteDeviceId}`);
                }
                const [targetId, config] = entry;

                // todo 交互
                const cert = this.cert.get(config.cert);
                if (!cert) {
                    rq.accept();
                } else
                    rq.acceptWithCre({
                        myPrivateKey: cert.myPrivateKey,
                        myPublicKey: cert.myPublicKey,
                        remotePublicKey: cert.remotePublicKey,
                        createdAt: Date.now(),
                    });

                this.connection.set(targetId, {
                    connect,
                    ready: true,
                });

                this.bindConnectEvent({ targetId, connect });
            });
        }

        this.addHandler(({ json }) => {
            if (json.serverName === "connect.connect") {
                const baseId = json.baseId;
                const connectId = json.connectId;
                this.globalMapHint.createPair(baseId, connectId);
            }
            if (json.serverName === "connect.globalMap") {
                const pairs: [string, string][] = json.pairs;
                for (const [a, b] of pairs) {
                    this.globalMapHint.createPair(a, b);
                }
            }
            if (json.serverName === "connect.disconnect") {
                const baseId = json.baseId;
                const connectId = json.connectId;
                this.globalMapHint.destroyPair(baseId, connectId);
            }
        });
    }

    bindConnectEvent(op: { targetId: PointDeviceId; connect: SConnect }) {
        const config = this.connectionConfig.get(op.targetId);
        if (!config) {
            throw new Error(`No connection config for targetId: ${op.targetId}`);
        }
        const connect = op.connect;
        connect.on("data", (data: ArrayBuffer) => {
            // todo
            const { json, bins } = this.parse(data);
            if ("_" in json) {
                const meta = json._ as MetaType;
                const myid = this.myId;
                if (meta.targetId === AnyTarget || meta.targetId.includes(myid))
                    for (const handler of this.messageHandlers) {
                        handler({ fromName: config.remoteDeviceName, json, bins });
                    }
                if (meta.path.includes(myid)) return;
                meta.path.push(myid);
                const ndata = this.build(json, bins);
                let nextId: PointDeviceId | null = null;
                if (meta.pathHint) {
                    const thisIndex = meta.pathHint.path.indexOf(myid);
                    if (thisIndex >= 0) {
                        nextId = meta.pathHint.path[thisIndex + 1] as PointDeviceId;
                    }
                }
                for (const id of this.avalableConnections()) {
                    if (id !== op.targetId && (nextId === null || id === nextId))
                        this.sendMessage({ targetId: id, message: ndata });
                }
            }
        });
        connect.on("disconnect", () => {
            this.connection.delete(op.targetId);
            this.sendTo({
                targetId: AnyTarget,
                json: { serverName: "connect.disconnect", baseId: this.myId, connectId: op.targetId },
            });
            this.globalMapHint.destroyPair(this.myId, op.targetId);
        });
    }

    async connect(op: { targetId: PointDeviceId }) {
        const connect = this.connection.get(op.targetId)?.connect;
        if (!connect) {
            throw new Error(`No connection for targetId: ${op.targetId}`);
        }

        const r = await connect.tryConnect();
        if (r.success === false) {
            throw new Error(`Failed to connect to targetId: ${op.targetId}`);
        }
        this.connection.set(op.targetId, {
            connect,
            ready: true,
        });
        this.sendTo({
            targetId: AnyTarget,
            json: { serverName: "connect.connect", baseId: this.myId, connectId: op.targetId },
        });
        // todo 添加包括自己的广播省去一个重复书写
        this.globalMapHint.createPair(this.myId, op.targetId);
        // 新节点需要了解已有的网络结构
        this.sendTo({
            targetId: [op.targetId],
            json: {
                serverName: "connect.globalMap",
                pairs: this.globalMapHint.exportPairs(),
            },
        });

        this.bindConnectEvent({ targetId: op.targetId, connect });
    }
    async disconnect(op: { targetId: PointDeviceId }) {
        const connect = this.connection.get(op.targetId)?.connect;
        if (!connect) {
            return;
        }
        connect.disconnect();
    }

    private async sendMessage(op: { targetId: PointDeviceId; message: ArrayBuffer }) {
        const conn = this.connection.get(op.targetId);
        if (!conn) {
            throw new Error(`No connection for targetId: ${op.targetId}`);
        }
        if (!conn.ready) {
            return;
        }

        await conn.connect.sendBinary(op.message);
    }
    private avalableConnections(): PointDeviceId[] {
        const ids: PointDeviceId[] = [];
        for (const [id, conn] of this.connection) {
            if (conn.ready) {
                ids.push(id);
            }
        }
        return ids;
    }
    private async sendMessageToAll(op: { message: ArrayBuffer }) {
        for (const id of this.avalableConnections()) {
            await this.sendMessage({ targetId: id, message: op.message });
        }
    }

    ///
    private build(json: any, bins: ArrayBuffer[]): ArrayBuffer {
        return buildMessage(json, bins);
    }
    private parse(message: ArrayBuffer): { json: any; bins: ArrayBuffer[] } {
        return parseMessage(message);
    }

    private messageHandlers = new Set<(args: { fromName: string; json: any; bins: ArrayBuffer[] }) => void>();

    addHandler(handler: (args: { fromName: string; json: any; bins: ArrayBuffer[] }) => void) {
        this.messageHandlers.add(handler);
        return () => {
            this.messageHandlers.delete(handler);
        };
    }
    addCallBackHandler(
        handler: (args: {
            fromName: string;
            json: any;
            bins: ArrayBuffer[];
        }) =>
            | { json: any; bins: ArrayBuffer[] }
            | undefined
            | Promise<{ json: any; bins: ArrayBuffer[] }>
            | Promise<undefined>,
    ) {
        return this.addHandler(async (args) => {
            const result = await handler(args);
            if (!result) return;
            const meta = args.json._ as MetaType;
            if (!meta.messageId) {
                console.warn("No messageId in meta, cannot send response");
                return;
            }
            if (!meta.sourceId) {
                console.warn("No sourceId in meta, cannot send response");
                return;
            }
            result.json._ = {
                messageId: meta.messageId,
            };
            this.sendTo({ targetId: [meta.sourceId], json: result.json, bins: result.bins });
        });
    }
    async sendTo(op: { targetId: TargetId[] | AnyTargetType; json: any; bins?: ArrayBuffer[] }) {
        if (op.targetId.length === 1) {
            const targetId = op.targetId[0];
            const path = this.globalMapHint.findPath(this.myId, targetId) as TargetId[];
            const json = {
                ...op.json,
                _: {
                    ...op.json._,
                    targetId: op.targetId,
                    path: [this.myId],
                    pathHint: { target: targetId, path },
                } as MetaType,
            };
            const index = path.indexOf(this.myId);
            const nextHop = path[index + 1];
            if (index >= 0 && nextHop) {
                await this.sendMessage({
                    targetId: nextHop as PointDeviceId,
                    message: this.build(json, op.bins ?? []),
                });
            } else {
                console.warn(`No next hop found for targetId: ${targetId}`);
                await this.sendMessageToAll({ message: this.build(json, op.bins ?? []) });
            }
        } else {
            const json = {
                ...op.json,
                _: {
                    ...op.json._,
                    targetId: op.targetId,
                    path: [this.myId],
                } as MetaType,
            };
            await this.sendMessageToAll({ message: this.build(json, op.bins ?? []) });
        }
    }
    async sendToAndReceive(op: {
        targetId: TargetId;
        json: any;
        bins?: ArrayBuffer[];
    }): Promise<{ json: any; bins: ArrayBuffer[] }> {
        const messageId = crypto.randomUUID();
        this.sendTo({
            targetId: [op.targetId],
            json: { ...op.json, _: { ...op.json._, messageId, sourceId: this.myId } },
            bins: op.bins,
        });
        const p = Promise.withResolvers<{ json: any; bins: ArrayBuffer[] }>();
        const clean = this.addHandler((args) => {
            const meta = args.json._ as MetaType;
            if (meta.messageId === messageId) {
                p.resolve({ json: args.json, bins: args.bins });
            }
        });
        return p.promise.finally(() => clean());
    }
    getGlobalMap(): [string, string][] {
        return this.globalMapHint.exportPairs();
    }
}

/** 路径规划 */
export class ConnectMap {
    private map: Map<string, Set<string>> = new Map();
    createPair(a: string, b: string) {
        const setA = this.map.get(a) || new Set();
        setA.add(b);
        this.map.set(a, setA);
        const setB = this.map.get(b) || new Set();
        setB.add(a);
        this.map.set(b, setB);
    }
    destroyPair(a: string, b: string) {
        const setA = this.map.get(a);
        if (setA) {
            setA.delete(b);
            if (setA.size === 0) this.map.delete(a);
        }
        const setB = this.map.get(b);
        if (setB) {
            setB.delete(a);
            if (setB.size === 0) this.map.delete(b);
        }
    }
    exportPairs(): [string, string][] {
        const pairs: [string, string][] = [];
        for (const [a, neighbors] of this.map) {
            for (const b of neighbors) {
                if (a < b) {
                    pairs.push([a, b]);
                }
            }
        }
        return pairs;
    }
    getNeighbors(id: string): string[] {
        return Array.from(this.map.get(id) || []);
    }
    findPath(from: string, to: string): string[] {
        if (from === to) return [from];
        const visited = new Set<string>([from]);
        const parent = new Map<string, string>();
        const queue: string[] = [from];
        while (queue.length > 0) {
            // biome-ignore lint/style/noNonNullAssertion: len>0
            const current = queue.shift()!;
            const neighbors = this.map.get(current) || new Set();
            for (const neighbor of neighbors) {
                if (visited.has(neighbor)) continue;
                visited.add(neighbor);
                parent.set(neighbor, current);
                if (neighbor === to) {
                    const path: string[] = [to];
                    let node = to;
                    while (parent.has(node)) {
                        // biome-ignore lint/style/noNonNullAssertion: has
                        node = parent.get(node)!;
                        path.push(node);
                    }
                    return path.reverse();
                }
                queue.push(neighbor);
            }
        }
        return [];
    }
    // todo 权重与智能规划
    // todo 多目标规划
    // todo 防止拥挤
}

export function buildMessage(json: any, bins?: ArrayBuffer[]): ArrayBuffer {
    const jsonStr = JSON.stringify(json);
    const jsonBytes = textEncoder.encode(jsonStr);
    const bin = [jsonBytes, ...(bins ?? [])];
    const totalLength = bin.reduce((sum, b) => sum + b.byteLength + 4, 0);
    const buffer = new ArrayBuffer(totalLength + 4);
    const view = new DataView(buffer);
    let offset = 0;
    view.setUint32(offset, bin.length, true);
    offset += 4;
    for (const b of bin) {
        view.setUint32(offset, b.byteLength, true);
        offset += 4;
        new Uint8Array(buffer, offset, b.byteLength).set(new Uint8Array(b));
        offset += b.byteLength;
    }
    return buffer;
}
export function parseMessage(message: ArrayBuffer): { json: any; bins: ArrayBuffer[] } {
    const view = new DataView(message);
    let offset = 0;
    const binCount = view.getUint32(offset, true);
    offset += 4;
    const bins: ArrayBuffer[] = [];
    for (let i = 0; i < binCount; i++) {
        const length = view.getUint32(offset, true);
        offset += 4;
        const buffer = message.slice(offset, offset + length);
        bins.push(buffer);
        offset += length;
    }
    const json = JSON.parse(textDecoder.decode(bins[0]));
    return { json, bins: bins.slice(1) };
}
