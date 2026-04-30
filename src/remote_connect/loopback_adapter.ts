import type { TrustedSignalingAdapter, UntrustedSignalingAdapter } from "./sconnect_type";

type MessageHandler = (data: Uint8Array) => void;
type CloseHandler = () => void;
type ErrorHandler = (err: Error) => void;
type PairRequestHandler = (remoteDeviceId: string, message: Uint8Array) => void;

/**
 * 受信任的本地回环信令适配器，用于测试。
 * 外部已验证身份，不加密。
 */
export class LoopbackAdapter implements TrustedSignalingAdapter {
    trustIdentity = true as const;
    supportNativeEncryption = false as const;

    private peer: LoopbackAdapter | null = null;
    private messageHandler: MessageHandler | null = null;
    private closeHandler: CloseHandler | null = null;
    private pairRequestHandler: PairRequestHandler | null = null;

    static createPair(): [LoopbackAdapter, LoopbackAdapter] {
        const a = new LoopbackAdapter();
        const b = new LoopbackAdapter();
        a.peer = b;
        b.peer = a;
        return [a, b];
    }

    async init(_myId: string): Promise<void> {}

    async connect(_id: string): Promise<void> {}

    async send(data: Uint8Array): Promise<void> {
        if (!this.peer) {
            throw new Error("No peer connected");
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.peer.messageHandler) {
            this.peer.messageHandler(new Uint8Array(data));
        }
    }

    /**
     * 发送配对请求到对方（触发对方的 pairRequestHandler）
     */
    async sendPairRequest(remoteDeviceId: string, data: Uint8Array): Promise<void> {
        if (!this.peer) {
            throw new Error("No peer connected");
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.peer.pairRequestHandler) {
            this.peer.pairRequestHandler(remoteDeviceId, new Uint8Array(data));
        }
    }

    close(): void {
        if (this.peer?.closeHandler) {
            this.peer.closeHandler();
        }
        this.peer = null;
    }

    onMessage(handler: MessageHandler): void {
        this.messageHandler = handler;
    }

    onClose(handler: CloseHandler): void {
        this.closeHandler = handler;
    }

    onError(_handler: ErrorHandler): void {}

    onPairRequest(handler: PairRequestHandler): void {
        this.pairRequestHandler = handler;
    }
}

/**
 * 不受信任的本地回环适配器，用于测试。
 * 需要内部 PAKE 验证，可选加密。
 */
export class UntrustedLoopbackAdapter implements UntrustedSignalingAdapter {
    trustIdentity = false as const;
    supportNativeEncryption: boolean;

    private peer: UntrustedLoopbackAdapter | null = null;
    private messageHandler: MessageHandler | null = null;
    private closeHandler: CloseHandler | null = null;
    private pairRequestHandler: PairRequestHandler | null = null;

    constructor(supportNativeEncryption = true) {
        this.supportNativeEncryption = supportNativeEncryption;
    }

    static createPair(supportNativeEncryption = true): [UntrustedLoopbackAdapter, UntrustedLoopbackAdapter] {
        const a = new UntrustedLoopbackAdapter(supportNativeEncryption);
        const b = new UntrustedLoopbackAdapter(supportNativeEncryption);
        a.peer = b;
        b.peer = a;
        return [a, b];
    }

    async init(_myId: string): Promise<void> {}

    async connect(_id: string): Promise<void> {}

    async send(data: Uint8Array): Promise<void> {
        if (!this.peer) {
            throw new Error("No peer connected");
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.peer.messageHandler) {
            this.peer.messageHandler(new Uint8Array(data));
        }
    }

    /**
     * 发送配对请求到对方（触发对方的 pairRequestHandler）
     */
    async sendPairRequest(remoteDeviceId: string, data: Uint8Array): Promise<void> {
        if (!this.peer) {
            throw new Error("No peer connected");
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.peer.pairRequestHandler) {
            this.peer.pairRequestHandler(remoteDeviceId, new Uint8Array(data));
        }
    }

    close(): void {
        if (this.peer?.closeHandler) {
            this.peer.closeHandler();
        }
        this.peer = null;
    }

    onMessage(handler: MessageHandler): void {
        this.messageHandler = handler;
    }

    onClose(handler: CloseHandler): void {
        this.closeHandler = handler;
    }

    onError(_handler: ErrorHandler): void {}

    onPairRequest(handler: PairRequestHandler): void {
        this.pairRequestHandler = handler;
    }
}
