import { SConnect } from "myde-remote-connect";
import type { SignalingAdapter } from "myde-remote-connect/types";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type PointId = string & { __label: "PointId" };
/** 直连的id */
type PointDeviceId = string & { __label: "DeviceId" };
/** 可达的id */
type TargetId = string & { __label: "TargetId" };

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
        }
    > = new Map();
    private cert: Map<string, { myPrivateKey: Uint8Array; myPublicKey: Uint8Array; remotePublicKey: Uint8Array }> =
        new Map();
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
            });
        }
    }

    async connect(op: { targetId: PointDeviceId }) {
        const config = this.connectionConfig.get(op.targetId);
        if (!config) {
            throw new Error(`No connection config for targetId: ${op.targetId}`);
        }
        const connect = this.connection.get(op.targetId)?.connect;
        if (!connect) {
            throw new Error(`No connection for targetId: ${op.targetId}`);
        }
        connect.on("connectRequest", (rq) => {
            // todo 交互
            const cert = this.cert.get(config.cert);
            if (!cert) {
                console.error(`No cert for ${config.cert}`);
                rq.reject();
                return;
            }
            rq.accept({
                myPrivateKey: cert.myPrivateKey,
                myPublicKey: cert.myPublicKey,
                remotePublicKey: cert.remotePublicKey,
                createdAt: Date.now(),
                myDeviceId: this.myId,
                remoteDeviceId: op.targetId,
            });
        });
        const r = await connect.tryConnect();
        if (r.success === false) {
            throw new Error(`Failed to connect to targetId: ${op.targetId}`);
        }

        connect.on("data", (data: ArrayBuffer) => {
            // todo
            const { json, bins } = this.parse(data);
            if ("_" in json) {
                if (json._.targetId === this.myId)
                    for (const handler of this.messageHandlers) {
                        handler({ fromName: config.remoteDeviceName, json, bins });
                    }
                else {
                    if (json._.path.includes(this.myId)) return;
                    json._.path.push(this.myId);
                    const ndata = this.build(json, bins);
                    for (const [id] of this.connection) {
                        if (id !== op.targetId) this.sendMessage({ targetId: id, message: ndata });
                    }
                }
            }
        });
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

        await conn.connect.sendBinary(op.message);
    }
    private async sendMessageToAll(op: { message: ArrayBuffer }) {
        for (const [id] of this.connection) {
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
    async sendTo(op: { targetId: TargetId; json: any; bins?: ArrayBuffer[] }) {
        // todo 寻路而不是遍历所有节点
        const json = {
            ...op.json,
            _: {
                targetId: op.targetId,
                path: [this.myId],
            },
        };
        await this.sendMessageToAll({ message: this.build(json, op.bins ?? []) });
    }
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
