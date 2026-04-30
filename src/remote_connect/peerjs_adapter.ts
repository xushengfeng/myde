import type { UntrustedSignalingAdapter } from "./sconnect_type";
import Peer, { type DataConnection } from "peerjs";

type PairRequestHandler = (remoteDeviceId: string, message: Uint8Array) => void;

export class PeerjsAdapter implements UntrustedSignalingAdapter {
    private peer: Peer | null = null;
    private connection: DataConnection | null = null;
    private messageHandler: ((data: Uint8Array) => void) | null = null;
    private closeHandler: (() => void) | null = null;
    private errorHandler: ((err: Error) => void) | null = null;
    private pairRequestHandler: PairRequestHandler | null = null;
    private pendingConnections: Map<string, DataConnection> = new Map();

    constructor(
        private options?: { debug?: number },
        public supportNativeEncryption = true,
    ) {}

    get trustIdentity(): false {
        return false;
    }

    async init(myId: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.peer = new Peer(myId, {
                debug: this.options?.debug ?? 0,
            });

            this.peer.on("open", (id) => {
                console.log(`PeerJS initialized with ID: ${id}`);
                resolve();
            });

            this.peer.on("error", (err) => {
                console.error("PeerJS error:", err);
                if (this.errorHandler) {
                    this.errorHandler(new Error(err.message));
                }
                reject(err);
            });

            this.peer.on("disconnected", () => {
                console.log("PeerJS disconnected");
                if (this.closeHandler) {
                    this.closeHandler();
                }
            });

            this.peer.on("connection", (conn) => {
                this.handleIncomingConnection(conn);
            });
        });
    }

    async connect(id: string): Promise<void> {
        if (!this.peer) {
            throw new Error("PeerJS not initialized. Call init() first.");
        }

        // 如果已经有连接，直接返回
        if (this.connection && this.connection.peer === id) {
            return;
        }

        return new Promise((resolve, reject) => {
            const peer = this.peer;
            if (!peer) {
                reject(new Error("PeerJS not initialized"));
                return;
            }

            const conn = peer.connect(id, {
                reliable: true,
                serialization: "binary",
            });

            conn.on("open", () => {
                this.setupConnection(conn);
                resolve();
            });

            conn.on("error", (err) => {
                console.error("Connection error:", err);
                if (this.errorHandler) {
                    this.errorHandler(new Error(String(err)));
                }
                reject(err);
            });
        });
    }

    async send(data: Uint8Array): Promise<void> {
        const connection = this.connection;
        if (!connection) {
            throw new Error("No active connection. Call connect() first.");
        }

        return new Promise((resolve, reject) => {
            try {
                connection.send(data);
                resolve();
            } catch (err) {
                if (this.errorHandler) {
                    this.errorHandler(err instanceof Error ? err : new Error(String(err)));
                }
                reject(err);
            }
        });
    }

    /**
     * 发送配对请求到对方
     */
    async sendPairRequest(remoteDeviceId: string, data: Uint8Array): Promise<void> {
        if (!this.peer) {
            throw new Error("PeerJS not initialized. Call init() first.");
        }

        return new Promise((resolve, reject) => {
            const peer = this.peer;
            if (!peer) {
                reject(new Error("PeerJS not initialized"));
                return;
            }

            const conn = peer.connect(remoteDeviceId, {
                reliable: true,
                serialization: "binary",
            });

            conn.on("open", () => {
                // 发送配对请求数据
                conn.send(data);
                // 保存到待处理连接
                this.pendingConnections.set(remoteDeviceId, conn);
                resolve();
            });

            conn.on("error", (err) => {
                console.error("Pair request connection error:", err);
                if (this.errorHandler) {
                    this.errorHandler(new Error(String(err)));
                }
                reject(err);
            });
        });
    }

    close(): void {
        if (this.connection) {
            this.connection.close();
            this.connection = null;
        }
        // 关闭所有待处理连接
        for (const conn of this.pendingConnections.values()) {
            conn.close();
        }
        this.pendingConnections.clear();
    }

    onMessage(handler: (data: Uint8Array) => void): void {
        this.messageHandler = handler;
    }

    onClose(handler: () => void): void {
        this.closeHandler = handler;
    }

    onError(handler: (err: Error) => void): void {
        this.errorHandler = handler;
    }

    onPairRequest(handler: PairRequestHandler): void {
        this.pairRequestHandler = handler;
    }

    /**
     * 处理传入的连接
     */
    private handleIncomingConnection(conn: DataConnection): void {
        conn.on("open", () => {
            // 检查是否是配对请求
            let isPairRequest = false;
            let pairRequestData: Uint8Array | null = null;

            conn.on("data", (data) => {
                const uint8Data = this.normalizeData(data);

                // 检查是否是配对请求消息（第一个字节为 0x01）
                if (uint8Data[0] === 0x01 && !isPairRequest) {
                    isPairRequest = true;
                    pairRequestData = uint8Data;

                    // 解析发送方 ID
                    const senderIdLength = new DataView(uint8Data.buffer, uint8Data.byteOffset).getUint16(1);
                    const senderId = new TextDecoder().decode(uint8Data.subarray(3, 3 + senderIdLength));

                    // 保存连接以便后续使用
                    this.pendingConnections.set(senderId, conn);

                    // 触发配对请求处理器
                    if (this.pairRequestHandler) {
                        this.pairRequestHandler(senderId, uint8Data);
                    }

                    // 设置后续消息处理
                    conn.on("data", (后续数据) => {
                        if (this.messageHandler) {
                            this.messageHandler(this.normalizeData(后续数据));
                        }
                    });
                } else if (!isPairRequest) {
                    // 不是配对请求，设置为普通消息连接
                    this.setupConnection(conn);
                    if (this.messageHandler) {
                        this.messageHandler(uint8Data);
                    }
                }
            });

            conn.on("close", () => {
                console.log("Connection closed");
                this.pendingConnections.delete(conn.peer);
                if (this.connection === conn) {
                    this.connection = null;
                }
                if (this.closeHandler) {
                    this.closeHandler();
                }
            });

            conn.on("error", (err) => {
                console.error("Connection error:", err);
                if (this.errorHandler) {
                    this.errorHandler(new Error(String(err)));
                }
            });
        });
    }

    /**
     * 设置普通数据连接
     */
    private setupConnection(conn: DataConnection): void {
        this.connection = conn;

        conn.on("data", (data) => {
            if (this.messageHandler) {
                this.messageHandler(this.normalizeData(data));
            }
        });

        conn.on("close", () => {
            console.log("Connection closed");
            this.connection = null;
            if (this.closeHandler) {
                this.closeHandler();
            }
        });

        conn.on("error", (err) => {
            console.error("Connection error:", err);
            if (this.errorHandler) {
                this.errorHandler(new Error(String(err)));
            }
        });
    }

    /**
     * 标准化数据格式
     */
    private normalizeData(data: unknown): Uint8Array {
        if (data instanceof Uint8Array) {
            return data;
        }
        if (data instanceof ArrayBuffer) {
            return new Uint8Array(data);
        }
        if (typeof data === "string") {
            return new TextEncoder().encode(data);
        }
        // 尝试转换其他类型
        return new Uint8Array(data as ArrayBuffer);
    }
}
