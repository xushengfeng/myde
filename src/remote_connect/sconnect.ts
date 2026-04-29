import type {
    ChannelOptions,
    ConnectResult,
    Credential,
    CredentialPublicInfo,
    SecureChannel,
    SignalingAdapter,
} from "./sconnect_type";
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { spake2 } = require("spake2") as {
    spake2: (options?: Record<string, unknown>) => Spake2Instance;
};

interface Spake2Instance {
    startClient: (
        clientIdentity: string,
        serverIdentity: string,
        password: string,
        salt: string,
    ) => Promise<Spake2State>;
    startServer: (clientIdentity: string, serverIdentity: string, verifier: unknown) => Promise<Spake2State>;
    computeVerifier: (
        password: string,
        salt: string,
        clientIdentity: string,
        serverIdentity: string,
    ) => Promise<unknown>;
}

interface Spake2State {
    getMessage: () => Uint8Array;
    finish: (incomingMessage: Uint8Array) => Spake2SharedSecret;
}

interface Spake2SharedSecret {
    toBuffer: () => Buffer;
}

interface KeyPair {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
}

type SecureChannelEvents = {
    ready: () => void;
    message: (payload: string) => void;
    binary: (data: ArrayBuffer) => void;
    disconnect: () => void;
    error: (err: Error) => void;
    credentialRotated: (updatedCredential: Credential) => void;
    credentialInvalidated: (remoteDeviceId: string) => void;
};

export class SConnect implements SecureChannel {
    private signalAdapter: SignalingAdapter;
    private options: Required<ChannelOptions>;
    private noise: Noise | null = null;
    private sendCipher: Cipher | null = null;
    private receiveCipher: Cipher | null = null;
    private isReady = false;
    private eventHandlers: Map<string, Set<(...args: unknown[]) => void>> = new Map();
    private rawMessageHandler: (data: Uint8Array) => void;

    // 设备身份
    private myDeviceId = "";
    private myKeyPair: KeyPair | null = null;

    constructor(signalAdapter: SignalingAdapter, options?: ChannelOptions) {
        this.signalAdapter = signalAdapter;
        this.options = {
            handshakeTimeout: options?.handshakeTimeout ?? 30000,
            maxPinAttempts: options?.maxPinAttempts ?? 5,
        };

        this.rawMessageHandler = (data) => this.handleRawMessage(data);
        this.signalAdapter.onMessage(this.rawMessageHandler);
        this.signalAdapter.onClose(() => this.handleDisconnect());
        this.signalAdapter.onError((err) => this.emit("error", err));
    }

    /**
     * 初始化通道，设置本设备身份。
     * 必须在 tryConnect 或 pairInit 之前调用。
     */
    async init(myDeviceId: string, keyPair?: KeyPair): Promise<Uint8Array> {
        this.myDeviceId = myDeviceId;
        await this.signalAdapter.init(myDeviceId);

        if (keyPair) {
            this.myKeyPair = keyPair;
        } else {
            this.myKeyPair = await this.generateKeyPair();
        }

        return this.myKeyPair.publicKey;
    }

    async tryConnect(credential: CredentialPublicInfo | Credential): Promise<ConnectResult> {
        if (!this.myDeviceId) {
            throw new Error("Call init() first");
        }

        try {
            await this.signalAdapter.connect(credential.remoteDeviceId);

            if (this.signalAdapter.trustIdentity) {
                // 受信任信道：外部已验证身份，直接明文通信
                this.isReady = true;
                this.emit("ready");
                return {
                    success: true,
                    credential: {
                        ...credential,
                        myPrivateKey: "myPrivateKey" in credential ? credential.myPrivateKey : new Uint8Array(),
                        myPublicKey: this.myKeyPair?.publicKey ?? new Uint8Array(),
                        remotePublicKey:
                            "remotePublicKey" in credential ? credential.remotePublicKey : new Uint8Array(),
                        createdAt: "createdAt" in credential ? credential.createdAt : Date.now(),
                        lastConnected: Date.now(),
                    },
                };
            }

            // 不受信任信道：需要验证
            if ("myPrivateKey" in credential && credential.myPrivateKey) {
                // 有 Credential，使用 Noise IK 握手
                // 根据设备 ID 决定角色：小的作为发起方，大的作为响应方
                const isInitiator = this.myDeviceId < credential.remoteDeviceId;
                if (isInitiator) {
                    return await this.performIKInitiator(credential as Credential);
                }
                return await this.performIKResponder(credential as Credential);
            }

            // 无 Credential，需要配对
            return { success: false, reason: "NEEDS_PAIRING" };
        } catch (error) {
            console.error("tryConnect failed:", error);
            return { success: false };
        }
    }

    pairInit(credential: CredentialPublicInfo): {
        pin: string;
        inputOtherPin: (pin: string) => void;
        waitForPairing: () => Promise<Credential>;
    } {
        if (!this.myDeviceId) {
            throw new Error("Call init() first");
        }

        const pin = this.generatePin();
        let resolvePairing: (credential: Credential) => void;
        let rejectPairing: (error: Error) => void;
        let pinAttempts = 0;

        const pairingPromise = new Promise<Credential>((resolve, reject) => {
            resolvePairing = resolve;
            rejectPairing = reject;
        });

        const inputOtherPin = (remotePin: string) => {
            pinAttempts++;
            if (pinAttempts > this.options.maxPinAttempts) {
                rejectPairing(new Error("Maximum PIN attempts exceeded"));
                return;
            }

            if (!this.validatePin(remotePin)) {
                this.emit("error", new Error("Invalid PIN format"));
                return;
            }

            this.performPAKEExchange(credential, pin, remotePin).then(resolvePairing).catch(rejectPairing);
        };

        return {
            pin,
            inputOtherPin,
            waitForPairing: () => pairingPromise,
        };
    }

    disconnect(): void {
        this.isReady = false;
        this.sendCipher = null;
        this.receiveCipher = null;

        if (this.noise) {
            if (typeof this.noise.destroy === "function") {
                this.noise.destroy();
            }
            this.noise = null;
        }

        this.signalAdapter.close();
        this.emit("disconnect");
    }

    async send(payload: string): Promise<void> {
        if (!this.isReady) {
            throw new Error("Channel not ready");
        }

        const data = new TextEncoder().encode(payload);

        if (!this.sendCipher) {
            await this.signalAdapter.send(data);
        } else {
            const encrypted = this.sendCipher.encrypt(data);
            await this.signalAdapter.send(new Uint8Array(encrypted));
        }
    }

    async sendBinary(data: ArrayBuffer | Uint8Array): Promise<void> {
        if (!this.isReady) {
            throw new Error("Channel not ready");
        }

        const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

        if (!this.sendCipher) {
            await this.signalAdapter.send(buffer);
        } else {
            const encrypted = this.sendCipher.encrypt(buffer);
            await this.signalAdapter.send(new Uint8Array(encrypted));
        }
    }

    on<K extends keyof SecureChannelEvents>(event: K, callback: SecureChannelEvents[K]): void {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, new Set());
        }
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            handlers.add(callback as (...args: unknown[]) => void);
        }
    }

    off(event: string, callback: (...args: unknown[]) => void): void {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            handlers.delete(callback);
        }
    }

    async rotateCredential(): Promise<void> {
        if (!this.isReady) {
            throw new Error("Channel not ready");
        }

        try {
            const newKeyPair = await this.generateKeyPair();
            const rotationMessage = JSON.stringify({
                type: "credential_rotation",
                publicKey: Array.from(newKeyPair.publicKey),
            });

            await this.send(rotationMessage);
        } catch (error) {
            this.emit("error", error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    // ================= PAKE 配对 =================

    private async performPAKEExchange(
        credential: CredentialPublicInfo,
        myPin: string,
        remotePin: string,
    ): Promise<Credential> {
        await this.signalAdapter.connect(credential.remoteDeviceId);

        const isClient = credential.myDeviceId < credential.remoteDeviceId;

        if (isClient) {
            return this.pakeClient(credential, myPin);
        }
        return this.pakeServer(credential, remotePin);
    }

    private async pakeClient(credential: CredentialPublicInfo, myPin: string): Promise<Credential> {
        const spake = spake2({
            mhf: { n: 1024, r: 8, p: 16 },
            kdf: { AAD: "sconnect-pairing" },
        });

        const clientState = await spake.startClient(
            credential.myDeviceId,
            credential.remoteDeviceId,
            myPin,
            credential.myDeviceId + credential.remoteDeviceId,
        );

        // 发送: SPAKE2 消息 + 我方公钥
        const clientMsg = clientState.getMessage();
        const myPublicKey = this.myKeyPair?.publicKey ?? new Uint8Array();
        const msgWithKey = new Uint8Array(2 + clientMsg.length + myPublicKey.length);
        new DataView(msgWithKey.buffer).setUint16(0, clientMsg.length);
        msgWithKey.set(clientMsg, 2);
        msgWithKey.set(myPublicKey, 2 + clientMsg.length);
        await this.signalAdapter.send(msgWithKey);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Pairing timeout"));
            }, this.options.handshakeTimeout);

            const messageHandler = (data: Uint8Array) => {
                try {
                    // 解析: 2字节SPAKE2长度 + SPAKE2消息 + 对方公钥
                    const spakeLen = new DataView(data.buffer, data.byteOffset).getUint16(0);
                    const spakeMsg = data.subarray(2, 2 + spakeLen);
                    const remotePublicKey = data.subarray(2 + spakeLen);

                    const sharedSecret = clientState.finish(Buffer.from(spakeMsg));

                    clearTimeout(timeout);
                    this.signalAdapter.onMessage(this.rawMessageHandler);

                    this.initializeEncryption(sharedSecret.toBuffer());

                    const fullCredential: Credential = {
                        ...credential,
                        myPrivateKey: this.myKeyPair?.privateKey ?? new Uint8Array(),
                        myPublicKey,
                        remotePublicKey: new Uint8Array(remotePublicKey),
                        createdAt: Date.now(),
                        lastConnected: Date.now(),
                    };

                    this.isReady = true;
                    this.emit("ready");
                    resolve(fullCredential);
                } catch (err) {
                    clearTimeout(timeout);
                    reject(err);
                }
            };

            this.signalAdapter.onMessage(messageHandler);
        });
    }

    private async pakeServer(credential: CredentialPublicInfo, remotePin: string): Promise<Credential> {
        const spake = spake2({
            mhf: { n: 1024, r: 8, p: 16 },
            kdf: { AAD: "sconnect-pairing" },
        });

        const verifier = await spake.computeVerifier(
            remotePin,
            credential.remoteDeviceId + credential.myDeviceId,
            credential.remoteDeviceId,
            credential.myDeviceId,
        );

        const serverState = await spake.startServer(credential.remoteDeviceId, credential.myDeviceId, verifier);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Pairing timeout"));
            }, this.options.handshakeTimeout);

            const messageHandler = (data: Uint8Array) => {
                try {
                    // 解析: 2字节SPAKE2长度 + SPAKE2消息 + 对方公钥
                    const spakeLen = new DataView(data.buffer, data.byteOffset).getUint16(0);
                    const spakeMsg = data.subarray(2, 2 + spakeLen);
                    const remotePublicKey = data.subarray(2 + spakeLen);

                    // 发送: 2字节SPAKE2长度 + SPAKE2消息 + 我方公钥
                    const serverMsg = serverState.getMessage();
                    const myPublicKey = this.myKeyPair?.publicKey ?? new Uint8Array();
                    const msgWithKey = new Uint8Array(2 + serverMsg.length + myPublicKey.length);
                    new DataView(msgWithKey.buffer).setUint16(0, serverMsg.length);
                    msgWithKey.set(serverMsg, 2);
                    msgWithKey.set(myPublicKey, 2 + serverMsg.length);
                    this.signalAdapter.send(msgWithKey);

                    const sharedSecret = serverState.finish(Buffer.from(spakeMsg));

                    clearTimeout(timeout);
                    this.signalAdapter.onMessage(this.rawMessageHandler);

                    this.initializeEncryption(sharedSecret.toBuffer());

                    const fullCredential: Credential = {
                        ...credential,
                        myPrivateKey: this.myKeyPair?.privateKey ?? new Uint8Array(),
                        myPublicKey,
                        remotePublicKey: new Uint8Array(remotePublicKey),
                        createdAt: Date.now(),
                        lastConnected: Date.now(),
                    };

                    this.isReady = true;
                    this.emit("ready");
                    resolve(fullCredential);
                } catch (err) {
                    clearTimeout(timeout);
                    reject(err);
                }
            };

            this.signalAdapter.onMessage(messageHandler);
        });
    }

    // ================= Noise IK 握手 =================

    /**
     * 作为发起方进行 Noise IK 握手
     */
    private async performIKInitiator(credential: Credential): Promise<ConnectResult> {
        try {
            // IK 模式需要：自己的静态密钥对 + 对方的静态公钥
            const keyPair = this.myKeyPair;
            if (!keyPair) throw new Error("No key pair");
            const myKeyPair = {
                publicKey: Buffer.from(keyPair.publicKey),
                secretKey: Buffer.from(keyPair.privateKey),
            };
            this.noise = new Noise("IK", true, myKeyPair);

            const prologue = Buffer.alloc(0);
            const remoteStaticKey = Buffer.from(credential.remotePublicKey);
            this.noise.initialise(prologue, remoteStaticKey);

            const handshakeMessage = this.noise.send();
            await this.signalAdapter.send(new Uint8Array(handshakeMessage));

            const response = await this.waitForHandshakeResponse();
            this.noise.recv(Buffer.from(response));

            if (this.noise.complete) {
                if (!this.signalAdapter.supportNativeEncryption) {
                    this.sendCipher = new Cipher(this.noise.tx);
                    this.receiveCipher = new Cipher(this.noise.rx);
                }
                this.isReady = true;

                const updatedCredential: Credential = {
                    ...credential,
                    lastConnected: Date.now(),
                };

                this.emit("ready");
                return { success: true, credential: updatedCredential };
            }

            return { success: false };
        } catch (error) {
            console.error("IK initiator handshake failed:", error);
            return { success: false };
        }
    }

    private waitForHandshakeResponse(): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Handshake timeout"));
            }, this.options.handshakeTimeout);

            const handler = (data: Uint8Array) => {
                clearTimeout(timeout);
                this.signalAdapter.onMessage(this.rawMessageHandler);
                resolve(data);
            };

            this.signalAdapter.onMessage(handler);
        });
    }

    /**
     * 作为响应方进行 Noise IK 握手
     */
    private async performIKResponder(credential: Credential): Promise<ConnectResult> {
        try {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error("Handshake timeout"));
                }, this.options.handshakeTimeout);

                const messageHandler = (data: Uint8Array) => {
                    try {
                        // IK 模式需要：自己的静态密钥对
                        const keyPair = this.myKeyPair;
                        if (!keyPair) throw new Error("No key pair");
                        const myKeyPair = {
                            publicKey: Buffer.from(keyPair.publicKey),
                            secretKey: Buffer.from(keyPair.privateKey),
                        };
                        this.noise = new Noise("IK", false, myKeyPair);

                        const prologue = Buffer.alloc(0);
                        this.noise.initialise(prologue);

                        // 接收发起方的消息
                        this.noise.recv(Buffer.from(data));

                        // 发送响应
                        const responseMsg = this.noise.send();
                        this.signalAdapter.send(new Uint8Array(responseMsg));

                        if (this.noise.complete) {
                            if (!this.signalAdapter.supportNativeEncryption) {
                                this.sendCipher = new Cipher(this.noise.tx);
                                this.receiveCipher = new Cipher(this.noise.rx);
                            }
                            this.isReady = true;

                            clearTimeout(timeout);
                            this.signalAdapter.onMessage(this.rawMessageHandler);

                            const updatedCredential: Credential = {
                                ...credential,
                                lastConnected: Date.now(),
                            };

                            this.emit("ready");
                            resolve({ success: true, credential: updatedCredential });
                        } else {
                            clearTimeout(timeout);
                            resolve({ success: false });
                        }
                    } catch (err) {
                        clearTimeout(timeout);
                        reject(err);
                    }
                };

                this.signalAdapter.onMessage(messageHandler);
            });
        } catch (error) {
            console.error("IK responder handshake failed:", error);
            return { success: false };
        }
    }

    // ================= 加密初始化 =================

    private initializeEncryption(sharedSecret: Buffer): void {
        const key = Buffer.alloc(32);
        sharedSecret.copy(key, 0, 0, Math.min(16, sharedSecret.length));
        sharedSecret.copy(key, 16, 0, Math.min(16, sharedSecret.length));

        if (!this.signalAdapter.supportNativeEncryption) {
            this.sendCipher = new Cipher(key);
            this.receiveCipher = new Cipher(key);
        }
    }

    // ================= 消息处理 =================

    private handleRawMessage(data: Uint8Array): void {
        if (!this.isReady) {
            return;
        }

        if (!this.receiveCipher) {
            this.dispatchMessage(data);
        } else {
            try {
                const decrypted = this.receiveCipher.decrypt(Buffer.from(data));
                this.dispatchMessage(new Uint8Array(decrypted));
            } catch {
                this.emit("binary", data.buffer);
            }
        }
    }

    private dispatchMessage(data: Uint8Array): void {
        const text = new TextDecoder().decode(data);
        try {
            const parsed = JSON.parse(text);
            if (parsed.type === "credential_rotation") {
                this.emit("credentialRotated", {
                    remotePublicKey: new Uint8Array(parsed.publicKey),
                });
                return;
            }
        } catch {
            // Not JSON
        }

        const reencoded = new TextEncoder().encode(text);
        const isText = reencoded.length === data.length && !data.some((b) => b < 32 && b !== 10 && b !== 13 && b !== 9);
        if (isText) {
            this.emit("message", text);
        } else {
            this.emit("binary", data.buffer);
        }
    }

    private handleDisconnect(): void {
        this.isReady = false;
        this.sendCipher = null;
        this.receiveCipher = null;
        this.emit("disconnect");
    }

    private emit<K extends keyof SecureChannelEvents>(event: K, ...args: Parameters<SecureChannelEvents[K]>): void {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            for (const handler of handlers) {
                try {
                    handler(...args);
                } catch (err) {
                    console.error(`Error in event handler for ${event}:`, err);
                }
            }
        }
    }

    private generatePin(): string {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    private validatePin(pin: string): boolean {
        return /^\d{6}$/.test(pin);
    }

    private async generateKeyPair(): Promise<KeyPair> {
        // Noise IK 使用 X25519 密钥交换
        const keyPair = await crypto.subtle.generateKey({ name: "X25519" } as AlgorithmIdentifier, true, [
            "deriveBits",
        ]);

        const publicKeyBuffer = await crypto.subtle.exportKey("raw", (keyPair as CryptoKeyPair).publicKey);
        const privateKeyBuffer = await crypto.subtle.exportKey("pkcs8", (keyPair as CryptoKeyPair).privateKey);

        // X25519 私钥在 PKCS8 中是 48 字节，需要提取后 32 字节
        const privateKeyRaw = new Uint8Array(privateKeyBuffer).subarray(16);

        return {
            publicKey: new Uint8Array(publicKeyBuffer),
            privateKey: privateKeyRaw,
        };
    }
}
