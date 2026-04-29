import type { UntrustedSignalingAdapter } from "./sconnect_type";
import Peer, { type DataConnection } from "peerjs";

export class PeerjsAdapter implements UntrustedSignalingAdapter {
    private peer: Peer | null = null;
    private connection: DataConnection | null = null;
    private messageHandler: ((data: Uint8Array) => void) | null = null;
    private closeHandler: (() => void) | null = null;
    private errorHandler: ((err: Error) => void) | null = null;

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
                this.setupConnection(conn);
            });
        });
    }

    async connect(id: string): Promise<void> {
        if (!this.peer) {
            throw new Error("PeerJS not initialized. Call init() first.");
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

    close(): void {
        if (this.connection) {
            this.connection.close();
            this.connection = null;
        }
        if (this.peer) {
            this.peer.destroy();
            this.peer = null;
        }
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

    private setupConnection(conn: DataConnection): void {
        this.connection = conn;

        conn.on("data", (data) => {
            if (this.messageHandler && data instanceof Uint8Array) {
                this.messageHandler(data);
            } else if (this.messageHandler && data instanceof ArrayBuffer) {
                this.messageHandler(new Uint8Array(data));
            } else if (this.messageHandler && typeof data === "string") {
                this.messageHandler(new TextEncoder().encode(data));
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
}
