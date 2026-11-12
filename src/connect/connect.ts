import { SConnect } from "myde-remote-connect";
import type { SignalingAdapter } from "myde-remote-connect/types";
import { EventEmitter } from "../event-emitter/event-emitter";
import { type ConnectStorage, MemoryConnectStorage } from "./storage";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export type PairResult = {
    myPrivateKey: Uint8Array;
    myPublicKey: Uint8Array;
    remotePublicKey: Uint8Array;
    from: string;
    to: string;
    targetId: string;
};

export type PairRequestArg = {
    remoteDeviceId: string;
    reject: () => void;
    waitForPair: () => Promise<PairResult>;
};

export type PairRequestHandler = (a: PairRequestArg) => void;

export type PairConnectResult = Omit<PairRequestArg, "reject"> & {
    inputOtherPin: (pin: string) => void;
};

export type PairingSession = {
    pointId: string;
    pin: string;
    connect: (remoteId: string, op?: { remember?: boolean }) => Promise<PairConnectResult>;
    onPair: (handle: PairRequestHandler) => void;
};

/** 一个连接在桌面侧可见的快照，类似 NetworkManager 的 connection/device 信息。 */
export type ConnectConnection = {
    targetId: string;
    from: string;
    to: string;
    remoteDeviceName: string;
    /** 是否写入持久化存储；false 为临时连接 */
    remembered: boolean;
    connected: boolean;
    createdAt?: number;
    lastConnected?: number;
};

export type ConnectEvents = {
    "connection-added": [connection: ConnectConnection];
    "connection-removed": [targetId: string];
    "connection-changed": [connection: ConnectConnection];
    connected: [targetId: string];
    disconnected: [targetId: string];
    "id-changed": [id: string];
    error: [error: Error];
};

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

type Cert = {
    myPrivateKey: Uint8Array;
    myPublicKey: Uint8Array;
    remotePublicKey: Uint8Array;
    createdAt: number;
    lastConnected?: number;
};

type ConnectionConfig = {
    from: PointId;
    to: PointId;
    remoteDeviceName: string;
    credentialId: string;
    remembered: boolean;
};

type PersistedConnectState = {
    version: 1;
    id: string;
    links: {
        targetId: string;
        from: string;
        to: string;
        remoteDeviceName: string;
        credentialId: string;
        remembered: boolean;
    }[];
    credentials: {
        id: string;
        myPrivateKey: string;
        myPublicKey: string;
        remotePublicKey: string;
        createdAt: number;
        lastConnected?: number;
    }[];
};

const STORAGE_VERSION = 1;
const STORAGE_KEY = "myde-connect";

function encodeBase64(data: Uint8Array): string {
    let text = "";
    for (const byte of data) text += String.fromCharCode(byte);
    return btoa(text);
}

function decodeBase64(value: string): Uint8Array {
    const text = atob(value);
    const data = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i);
    return data;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

export class Connect extends EventEmitter<ConnectEvents> {
    private adapter: () => SignalingAdapter;
    private storage: ConnectStorage;

    private connectionConfig = new Map<PointDeviceId, ConnectionConfig>();
    private connection: Map<
        PointDeviceId,
        {
            connect: SConnect;
            ready: boolean;
        }
    > = new Map();
    private cert: Map<string, Cert> = new Map();

    private globalMapHint = new ConnectMap();

    private myId: PointDeviceId;
    private initialized = false;
    private initializedConnect = new WeakSet<SConnect>();

    constructor(op: {
        id?: string;
        adapter: () => SignalingAdapter;
        storage?: ConnectStorage;
    }) {
        super();
        this.adapter = op.adapter;
        this.storage = op.storage ?? new MemoryConnectStorage();
        this.myId = (op.id ?? crypto.randomUUID()) as PointDeviceId;
        this.loadState(op.id);
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

    /** 读取本机设备 id。没有时在构造阶段已经生成并保存。 */
    getId(): string {
        return this.myId;
    }

    /**
     * 刷新本机设备 id。已连接的节点需要重新连接后才能看到新 id，
     * 因此有活动连接时拒绝刷新。
     */
    refreshId(): string {
        if (this.avalableConnections().length > 0) {
            throw new Error("Cannot refresh id while connected");
        }
        for (const peer of this.globalMapHint.getNeighbors(this.myId)) {
            this.globalMapHint.destroyPair(this.myId, peer);
        }
        this.myId = crypto.randomUUID() as PointDeviceId;
        this.saveState();
        this.emit("id-changed", this.myId);
        return this.myId;
    }

    private loadState(overrideId?: string) {
        const raw = this.storage.getItem(STORAGE_KEY);
        let state: PersistedConnectState | undefined;
        if (raw) {
            try {
                state = JSON.parse(raw) as PersistedConnectState;
            } catch (error) {
                console.warn("connect: failed to parse stored state", error);
            }
        }
        if (state && state.version !== STORAGE_VERSION) {
            console.warn(`connect: unsupported storage version ${state.version}`);
            state = undefined;
        }

        if (state) {
            for (const link of state.links ?? []) {
                this.connectionConfig.set(link.targetId as PointDeviceId, {
                    from: link.from as PointId,
                    to: link.to as PointId,
                    remoteDeviceName: link.remoteDeviceName,
                    credentialId: link.credentialId,
                    remembered: link.remembered !== false,
                });
            }
            for (const credential of state.credentials ?? []) {
                this.cert.set(credential.id, {
                    myPrivateKey: decodeBase64(credential.myPrivateKey),
                    myPublicKey: decodeBase64(credential.myPublicKey),
                    remotePublicKey: decodeBase64(credential.remotePublicKey),
                    createdAt: credential.createdAt,
                    lastConnected: credential.lastConnected,
                });
            }
        }

        const id = overrideId ?? state?.id;
        if (id) this.myId = id as PointDeviceId;
        if (!state || state.id !== this.myId) this.saveState();
    }

    private saveState() {
        const links: PersistedConnectState["links"] = [];
        const credentialIds = new Set<string>();
        for (const [targetId, config] of this.connectionConfig) {
            if (!config.remembered) continue;
            links.push({
                targetId,
                from: config.from,
                to: config.to,
                remoteDeviceName: config.remoteDeviceName,
                credentialId: config.credentialId,
                remembered: true,
            });
            if (config.credentialId) credentialIds.add(config.credentialId);
        }

        const credentials: PersistedConnectState["credentials"] = [];
        for (const id of credentialIds) {
            const credential = this.cert.get(id);
            if (!credential) continue;
            credentials.push({
                id,
                myPrivateKey: encodeBase64(credential.myPrivateKey),
                myPublicKey: encodeBase64(credential.myPublicKey),
                remotePublicKey: encodeBase64(credential.remotePublicKey),
                createdAt: credential.createdAt,
                lastConnected: credential.lastConnected,
            });
        }

        this.storage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                version: STORAGE_VERSION,
                id: this.myId,
                links,
                credentials,
            } satisfies PersistedConnectState),
        );
    }

    setConnectionConfig(op: {
        targetId: PointDeviceId;
        from: PointId;
        to: PointId;
        remoteDeviceName: string;
        cert: string;
        remember?: boolean;
    }) {
        this.upsertConnectionConfig(op.targetId, {
            from: op.from,
            to: op.to,
            remoteDeviceName: op.remoteDeviceName,
            credentialId: op.cert,
            remembered: op.remember ?? true,
        });
    }

    private upsertConnectionConfig(targetId: PointDeviceId, config: ConnectionConfig) {
        const old = this.connectionConfig.get(targetId);
        const existed = old !== undefined;
        this.connectionConfig.set(targetId, config);
        if (
            old?.credentialId &&
            old.credentialId !== config.credentialId &&
            !this.isCredentialInUse(old.credentialId)
        ) {
            this.cert.delete(old.credentialId);
        }
        this.saveState();
        const connection = this.getConnection(targetId);
        if (!connection) return;
        if (existed) this.emit("connection-changed", connection);
        else this.emit("connection-added", connection);
    }

    getConnection(targetId: string): ConnectConnection | undefined {
        const id = targetId as PointDeviceId;
        const config = this.connectionConfig.get(id);
        if (!config) return undefined;
        const credential = config.credentialId ? this.cert.get(config.credentialId) : undefined;
        return {
            targetId: id,
            from: config.from,
            to: config.to,
            remoteDeviceName: config.remoteDeviceName,
            remembered: config.remembered,
            connected: this.connection.get(id)?.ready === true,
            createdAt: credential?.createdAt,
            lastConnected: credential?.lastConnected,
        };
    }

    /** 所有已知连接，包括临时连接。 */
    getConnections(): ConnectConnection[] {
        const result: ConnectConnection[] = [];
        for (const targetId of this.connectionConfig.keys()) {
            const connection = this.getConnection(targetId);
            if (connection) result.push(connection);
        }
        return result;
    }

    /** 已记住的连接，对应 NetworkManager 的 saved connections。 */
    getSavedConnections(): ConnectConnection[] {
        return this.getConnections().filter((connection) => connection.remembered);
    }

    /** 当前已建立的连接。 */
    getActiveConnections(): ConnectConnection[] {
        return this.getConnections().filter((connection) => connection.connected);
    }

    isConnected(targetId: string): boolean {
        return this.connection.get(targetId as PointDeviceId)?.ready === true;
    }

    /** 临时连接可以随时提升为记忆连接，反之亦然。 */
    setRemember(targetId: string, remembered: boolean) {
        const id = targetId as PointDeviceId;
        const config = this.connectionConfig.get(id);
        if (!config) throw new Error(`No connection config for targetId: ${targetId}`);
        config.remembered = remembered;
        this.saveState();
        const connection = this.getConnection(id);
        if (connection) this.emit("connection-changed", connection);
    }

    getState() {
        return {
            id: this.myId,
            connections: this.getConnections(),
            savedConnections: this.getSavedConnections(),
            activeConnections: this.getActiveConnections(),
            globalMap: this.getGlobalMap(),
        };
    }

    async init() {
        if (this.initialized) return;
        this.initialized = true;

        for (const [targetId, config] of this.connectionConfig) {
            const { connect, trusted } = await this.createConnect(config.from, config.to);
            this.connection.set(targetId, {
                connect,
                ready: false,
            });
            this.connectInit(connect, trusted);
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
        this.addCallBackHandler(async ({ json }) => {
            if (json.serverName === "connect.new") {
                const connectId = crypto.randomUUID();
                const remember = json.remember !== false;
                const { connect, trusted } = await this.createConnect(
                    Connect.pointId(connectId),
                    Connect.pointId(json.pointId),
                );
                const pin = connect.updatePIN();
                connect.on("pairRequest", (rq) => {
                    rq.waitForPairing()
                        .then((pair) => {
                            const certId = crypto.randomUUID();
                            this.cert.set(certId, {
                                myPrivateKey: pair.myPrivateKey,
                                myPublicKey: pair.myPublicKey,
                                remotePublicKey: pair.remotePublicKey,
                                createdAt: pair.createdAt ?? Date.now(),
                                lastConnected: Date.now(),
                            });
                            this.upsertConnectionConfig(json.sourceId as PointDeviceId, {
                                from: Connect.pointId(connectId),
                                to: Connect.pointId(json.pointId),
                                remoteDeviceName: "unknown",
                                credentialId: certId,
                                remembered: remember,
                            });
                            this.afterConnect({ targetId: json.sourceId, connect });
                        })
                        .catch((error) => {
                            this.emit("error", error instanceof Error ? error : new Error(String(error)));
                        });
                });
                this.connectInit(connect, trusted);
                return { json: { connectId, pin }, bins: [] };
            }
            return undefined;
        });
    }

    private async createConnect(from: PointId, to?: PointId) {
        const adapter = this.adapter();
        const connect = new SConnect(adapter);
        await connect.init(from, to);
        return { connect, trusted: adapter.trustIdentity };
    }

    private connectInit(connect: SConnect, trusted: boolean) {
        connect.on("connectRequest", (rq) => {
            const entry = Array.from(this.connectionConfig).find(([_, config]) => config.to === rq.remoteDeviceId);
            if (!entry) {
                rq.reject();
                return;
            }
            const [targetId, config] = entry;

            const markReady = (credential?: Cert) => {
                const current = this.connectionConfig.get(targetId);
                if (!current) return;
                if (credential && current.credentialId) {
                    this.updateCredential(current.credentialId, credential);
                }
                this.afterConnect({ targetId, connect });
            };

            if (config.credentialId) {
                const credential = this.cert.get(config.credentialId);
                if (!credential) {
                    rq.reject();
                    return;
                }
                rq.acceptWithCre({
                    myPrivateKey: credential.myPrivateKey,
                    myPublicKey: credential.myPublicKey,
                    remotePublicKey: credential.remotePublicKey,
                    createdAt: credential.createdAt,
                })
                    .then((result) => {
                        if (result.success) {
                            markReady({
                                myPrivateKey: result.credential.myPrivateKey,
                                myPublicKey: result.credential.myPublicKey,
                                remotePublicKey: result.credential.remotePublicKey,
                                createdAt: result.credential.createdAt,
                                lastConnected: result.credential.lastConnected,
                            });
                        }
                    })
                    .catch((error) => {
                        this.emit("error", error instanceof Error ? error : new Error(String(error)));
                    });
            } else if (trusted) {
                rq.accept();
                markReady();
            } else {
                rq.reject();
            }
        });
        connect.on("error", (error) => {
            this.emit("error", error);
        });
    }

    private updateCredential(
        credentialId: string,
        credential: {
            myPrivateKey: Uint8Array;
            myPublicKey: Uint8Array;
            remotePublicKey: Uint8Array;
            createdAt?: number;
            lastConnected?: number;
        },
    ) {
        const old = this.cert.get(credentialId);
        this.cert.set(credentialId, {
            myPrivateKey: credential.myPrivateKey,
            myPublicKey: credential.myPublicKey,
            remotePublicKey: credential.remotePublicKey,
            createdAt: credential.createdAt ?? old?.createdAt ?? Date.now(),
            lastConnected: credential.lastConnected ?? Date.now(),
        });
        this.saveState();
    }

    /** 用于不信任的渠道，如网络连接，需要PIN码配对 */
    async startPairing(op?: { remember?: boolean }): Promise<PairingSession> {
        const defaultRemember = op?.remember ?? true;
        const connectId = crypto.randomUUID();
        const adapter = this.adapter();
        const connect = new SConnect(adapter);
        const trusted = adapter.trustIdentity;

        // 先返回 pointId/PIN，信令连接在后台完成，避免 PeerJS 网络慢时界面一直“准备中”。
        let initError: Error | undefined;
        const ready = connect.init(Connect.pointId(connectId)).catch((error) => {
            initError = error instanceof Error ? error : new Error(String(error));
            this.emit("error", initError);
        });

        let h: PairRequestHandler = () => {};
        connect.on("pairRequest", (rq) => {
            h({
                remoteDeviceId: rq.remoteDeviceId,
                reject: () => rq.reject(),
                waitForPair: async () => {
                    const cert = await rq.waitForPairing();
                    const targetId = (await askMeta()).targetId;
                    const result = {
                        myPrivateKey: cert.myPrivateKey,
                        myPublicKey: cert.myPublicKey,
                        remotePublicKey: cert.remotePublicKey,
                        from: connectId,
                        to: rq.remoteDeviceId,
                        targetId,
                    };
                    afterConnect(result, defaultRemember);
                    return result;
                },
            });
        });

        const session = {
            connect: async (remoteId: string, connectOp?: { remember?: boolean }): Promise<PairConnectResult> => {
                const remember = connectOp?.remember ?? defaultRemember;
                await withTimeout(ready, 15000, "信令服务器连接超时");
                if (initError) throw initError;
                const p = await connect.pairInit({ myDeviceId: connectId, remoteDeviceId: remoteId });
                return {
                    remoteDeviceId: remoteId,
                    inputOtherPin: (pin: string) => {
                        p.inputOtherPin(pin);
                    },
                    waitForPair: async () => {
                        const cert = await p.waitForPairing();
                        const targetId = (await askMeta()).targetId;
                        const result = {
                            myPrivateKey: cert.myPrivateKey,
                            myPublicKey: cert.myPublicKey,
                            remotePublicKey: cert.remotePublicKey,
                            from: connectId,
                            to: remoteId,
                            targetId,
                        };
                        afterConnect(result, remember);
                        return result;
                    },
                };
            },
            pointId: connectId,
            pin: connect.updatePIN(),
            onPair: (handle: PairRequestHandler) => {
                h = handle;
            },
        } satisfies PairingSession;

        const metaRq = Promise.withResolvers<{
            targetId: string;
        }>();
        connect.on("data", (data: ArrayBuffer) => {
            const { json } = this.parse(data);
            if (json.type === "askMeta") {
                connect.sendBinary(this.build({ type: "reMeta", myId: this.myId }, []));
            }
            if (json.type === "reMeta") {
                metaRq.resolve({ targetId: json.myId });
            }
        });

        const askMeta = () => {
            connect.sendBinary(this.build({ type: "askMeta" }, []));
            return metaRq.promise;
        };
        const afterConnect = (result: PairResult, remember: boolean) => {
            const certId = crypto.randomUUID();
            this.cert.set(certId, {
                myPrivateKey: result.myPrivateKey,
                myPublicKey: result.myPublicKey,
                remotePublicKey: result.remotePublicKey,
                createdAt: Date.now(),
                lastConnected: Date.now(),
            });
            this.upsertConnectionConfig(result.targetId as PointDeviceId, {
                from: Connect.pointId(result.from),
                to: Connect.pointId(result.to),
                remoteDeviceName: "unknown",
                credentialId: certId,
                remembered: remember,
            });
            this.afterConnect({ targetId: result.targetId as PointDeviceId, connect });
        };

        this.connectInit(connect, trusted);
        return session;
    }

    async connect(op: { targetId: string } | string) {
        const targetId = (typeof op === "string" ? op : op.targetId) as PointDeviceId;
        const connection = this.connection.get(targetId);
        const config = this.connectionConfig.get(targetId);
        if (!connection) {
            throw new Error(`No connection for targetId: ${targetId}`);
        }

        const credential = config?.credentialId ? this.cert.get(config.credentialId) : undefined;
        const result = await connection.connect.tryConnect(
            credential
                ? {
                      myPrivateKey: credential.myPrivateKey,
                      myPublicKey: credential.myPublicKey,
                      remotePublicKey: credential.remotePublicKey,
                      createdAt: credential.createdAt,
                  }
                : undefined,
        );
        if (result.success === false) {
            const reason = "reason" in result ? result.reason : undefined;
            throw new Error(`Failed to connect to targetId: ${targetId}${reason ? ` (${reason})` : ""}`);
        }

        if (config?.credentialId && result.credential.myPrivateKey.length > 0) {
            this.updateCredential(config.credentialId, result.credential);
        }
        this.afterConnect({ targetId, connect: connection.connect });
    }

    private afterConnect(op: { targetId: PointDeviceId; connect: SConnect }) {
        const connect = op.connect;
        const targetId = op.targetId;
        const wasReady = this.connection.get(targetId)?.ready === true;
        this.connection.set(targetId, {
            connect,
            ready: true,
        });

        const config = this.connectionConfig.get(targetId);
        if (!config) {
            throw new Error(`No connection config for targetId: ${targetId}`);
        }

        if (!this.initializedConnect.has(connect)) {
            this.initializedConnect.add(connect);
            this.initDataHandler(targetId, connect, config);
        }

        if (!wasReady) {
            this.sendTo({
                targetId: AnyTarget,
                json: { serverName: "connect.connect", baseId: this.myId, connectId: targetId },
            });
            this.globalMapHint.createPair(this.myId, targetId);
            this.sendTo({
                targetId: [targetId],
                json: {
                    serverName: "connect.globalMap",
                    pairs: this.globalMapHint.exportPairs(),
                },
            });
        }

        this.saveState();
        if (!wasReady) {
            this.emit("connected", targetId);
            const connection = this.getConnection(targetId);
            if (connection) this.emit("connection-changed", connection);
        }
    }

    private initDataHandler(targetId: PointDeviceId, connect: SConnect, config: ConnectionConfig) {
        connect.on("data", (data: ArrayBuffer) => {
            const { json, bins } = this.parse(data);
            if ("_" in json) {
                const meta = json._ as MetaType;
                const myId = this.myId;
                if (meta.targetId === AnyTarget || meta.targetId.includes(myId)) {
                    for (const handler of this.messageHandlers) {
                        handler({ fromName: config.remoteDeviceName, json, bins });
                    }
                }
                if (meta.path.includes(myId)) return;
                meta.path.push(myId);
                const nextData = this.build(json, bins);
                let nextId: PointDeviceId | null = null;
                if (meta.pathHint) {
                    const thisIndex = meta.pathHint.path.indexOf(myId);
                    if (thisIndex >= 0) {
                        nextId = meta.pathHint.path[thisIndex + 1] as PointDeviceId;
                    }
                }
                for (const id of this.avalableConnections()) {
                    if (id !== targetId && (nextId === null || id === nextId)) {
                        this.sendMessage({ targetId: id, message: nextData });
                    }
                }
            }
        });
        connect.on("disconnect", () => {
            this.connection.delete(targetId);
            this.sendTo({
                targetId: AnyTarget,
                json: { serverName: "connect.disconnect", baseId: this.myId, connectId: targetId },
            });
            this.globalMapHint.destroyPair(this.myId, targetId);
            this.emit("disconnected", targetId);
            const connection = this.getConnection(targetId);
            if (connection) this.emit("connection-changed", connection);
            this.saveState();
        });
    }

    async disconnect(op: { targetId: string } | string) {
        const targetId = (typeof op === "string" ? op : op.targetId) as PointDeviceId;
        const connect = this.connection.get(targetId)?.connect;
        if (!connect) return;
        connect.disconnect();
    }

    /** 删除连接配置及配对凭证；先断开再删除。 */
    removeConnection(targetId: string) {
        const id = targetId as PointDeviceId;
        const connect = this.connection.get(id)?.connect;
        connect?.disconnect();
        this.connection.delete(id);

        const config = this.connectionConfig.get(id);
        if (!config) return;
        this.connectionConfig.delete(id);
        if (config.credentialId && !this.isCredentialInUse(config.credentialId)) {
            this.cert.delete(config.credentialId);
        }
        this.globalMapHint.destroyPair(this.myId, id);
        this.saveState();
        this.emit("connection-removed", id);
    }

    private isCredentialInUse(credentialId: string): boolean {
        for (const config of this.connectionConfig.values()) {
            if (config.credentialId === credentialId) return true;
        }
        return false;
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
            | Promise<undefined>
            | Promise<{ json: any; bins: ArrayBuffer[] } | undefined>,
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
    async connect2(op: { targetId: string; remember?: boolean }) {
        const targetId = op.targetId as PointDeviceId;
        if (op.targetId === this.myId) return;
        if (this.connection.has(targetId)) return;
        if (this.connectionConfig.has(targetId)) {
            await this.connect({ targetId });
            return;
        }

        const path = this.globalMapHint.findPath(this.myId, op.targetId);
        if (path.length < 2) {
            throw new Error(`No path to targetId: ${op.targetId}`);
        }
        const remember = op.remember ?? true;
        const thisConnectId = crypto.randomUUID();
        const targetConnect = await this.sendToAndReceive({
            targetId: op.targetId as TargetId,
            json: {
                serverName: "connect.new",
                pointId: thisConnectId,
                sourceId: this.myId,
                remember,
            },
        });
        const targetConnectId = targetConnect.json.connectId as PointDeviceId;
        const pin = targetConnect.json.pin as string;

        const { connect, trusted } = await this.createConnect(
            Connect.pointId(thisConnectId),
            Connect.pointId(targetConnectId),
        );
        const result = await connect.tryConnect();
        if (result.success === false) {
            const pairing = await connect.pairInit({
                myDeviceId: thisConnectId,
                remoteDeviceId: targetConnectId,
            });
            pairing.inputOtherPin(pin);
            const credential = await pairing.waitForPairing();
            const certId = crypto.randomUUID();
            this.cert.set(certId, {
                myPrivateKey: credential.myPrivateKey,
                myPublicKey: credential.myPublicKey,
                remotePublicKey: credential.remotePublicKey,
                createdAt: credential.createdAt ?? Date.now(),
                lastConnected: Date.now(),
            });
            this.upsertConnectionConfig(targetId, {
                from: Connect.pointId(thisConnectId),
                to: Connect.pointId(targetConnectId),
                remoteDeviceName: "unknown",
                credentialId: certId,
                remembered: remember,
            });
        } else {
            const certId = result.credential.myPrivateKey.length > 0 && remember ? crypto.randomUUID() : "";
            if (certId) {
                this.cert.set(certId, {
                    myPrivateKey: result.credential.myPrivateKey,
                    myPublicKey: result.credential.myPublicKey,
                    remotePublicKey: result.credential.remotePublicKey,
                    createdAt: result.credential.createdAt,
                    lastConnected: result.credential.lastConnected ?? Date.now(),
                });
            }
            this.upsertConnectionConfig(targetId, {
                from: Connect.pointId(thisConnectId),
                to: Connect.pointId(targetConnectId),
                remoteDeviceName: "unknown",
                credentialId: certId,
                remembered: remember,
            });
        }

        this.connectInit(connect, trusted);
        this.afterConnect({ targetId, connect });
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
