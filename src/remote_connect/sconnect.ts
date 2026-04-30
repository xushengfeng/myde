import type {
    ChannelOptions,
    ConnectRequest,
    ConnectResult,
    Credential,
    CredentialPublicInfo,
    PairRequest,
    SecureChannel,
    SignalingAdapter,
} from "./sconnect_type";
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher";
import { spake2 } from "./spake/index";

interface KeyPair {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
}

// 协议消息类型常量
const MSG_PAIR_REQUEST = 0x01;
const MSG_CONNECT_REQUEST = 0x03;
const MSG_CONNECT_ACCEPT = 0x04;
const MSG_CONNECT_REJECT = 0x05;

type SecureChannelEvents = {
    ready: () => void;
    message: (payload: string) => void;
    binary: (data: ArrayBuffer) => void;
    disconnect: () => void;
    error: (err: Error) => void;
    pairRequest: (request: PairRequest) => void;
    connectRequest: (request: ConnectRequest) => void;
    credentialRotated: (updatedCredential: Credential) => void;
    credentialInvalidated: (remoteDeviceId: string) => void;
};

export class SConnect implements SecureChannel {
    private signalAdapter: SignalingAdapter;
    private options: Required<ChannelOptions>;
    private noise: Noise | null = null;
    private sendCipher: Cipher | null = null;
    private receiveCipher: Cipher | null = null;
    private PIN = "";
    private isReady = false;
    private eventHandlers: Map<string, Set<(...args: unknown[]) => void>> = new Map();

    // 设备身份
    private myDeviceId = "";
    private myKeyPair: KeyPair | null = null;

    constructor(signalAdapter: SignalingAdapter, options?: ChannelOptions) {
        this.signalAdapter = signalAdapter;
        this.options = {
            handshakeTimeout: options?.handshakeTimeout ?? 30000,
            maxPinAttempts: options?.maxPinAttempts ?? 5,
        };

        this.signalAdapter.onMessage((data) => this.handleRawMessage(data));
        this.signalAdapter.onClose(() => this.handleDisconnect());
        this.signalAdapter.onError((err) => this.emit("error", err));
    }

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
                this.isReady = true;
                this.emit("ready");
                return { success: true, credential: this.buildCredential(credential) };
            }

            if ("myPrivateKey" in credential && credential.myPrivateKey) {
                return await this.sendConnectRequest(credential as Credential);
            }

            return { success: false, reason: "NEEDS_PAIRING" };
        } catch (error) {
            console.error("tryConnect failed:", error);
            return { success: false };
        }
    }

    updatePIN(): string {
        this.PIN = this.generatePin();
        return this.PIN;
    }

    pairInit(credential: CredentialPublicInfo): {
        pin: string;
        inputOtherPin: (pin: string) => void;
        waitForPairing: () => Promise<Credential>;
    } {
        if (!this.myDeviceId) {
            throw new Error("Call init() first");
        }

        const pin = this.PIN || this.updatePIN();
        let resolvePairing: (credential: Credential) => void;
        let rejectPairing: (error: Error) => void;
        let pinAttempts = 0;
        let pairingStarted = false;

        const pairingPromise = new Promise<Credential>((resolve, reject) => {
            resolvePairing = resolve;
            rejectPairing = reject;
        });

        // 立即设置为响应方
        this.setupPAKEResponder(credential, pin).then(resolvePairing).catch(rejectPairing);

        const inputOtherPin = (remotePin: string) => {
            if (pairingStarted) return;
            pairingStarted = true;

            pinAttempts++;
            if (pinAttempts > this.options.maxPinAttempts) {
                rejectPairing(new Error("Maximum PIN attempts exceeded"));
                return;
            }

            if (!this.validatePin(remotePin)) {
                this.emit("error", new Error("Invalid PIN format"));
                rejectPairing(new Error("Invalid PIN format"));
                return;
            }

            this.performPAKEClient(credential, remotePin).then(resolvePairing).catch(rejectPairing);
        };

        // 发送配对请求
        this.sendPairRequest(credential).catch(rejectPairing);

        return { pin, inputOtherPin, waitForPairing: () => pairingPromise };
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

        if (this.sendCipher) {
            const encrypted = this.sendCipher.encrypt(data as any);
            await this.signalAdapter.send(new Uint8Array(encrypted));
        } else {
            await this.signalAdapter.send(data);
        }
    }

    async sendBinary(data: ArrayBuffer | Uint8Array): Promise<void> {
        if (!this.isReady) {
            throw new Error("Channel not ready");
        }

        const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

        if (this.sendCipher) {
            const encrypted = this.sendCipher.encrypt(buffer as any);
            await this.signalAdapter.send(new Uint8Array(encrypted));
        } else {
            await this.signalAdapter.send(buffer);
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

    // ================= 消息处理 =================

    private handleRawMessage(data: Uint8Array): void {
        // 只有在未就绪时才检查协议消息
        if (!this.isReady && data[0] < 0x20) {
            this.handleProtocolMessage(data);
            return;
        }

        // 应用数据
        if (!this.isReady) {
            return;
        }

        this.handleAppData(data);
    }

    private handleProtocolMessage(data: Uint8Array): void {
        const type = data[0];
        const payload = data.subarray(1);

        switch (type) {
            case MSG_PAIR_REQUEST:
                this.handlePairRequest(payload);
                break;
            case MSG_CONNECT_REQUEST:
                this.handleConnectRequest(payload);
                break;
            case MSG_CONNECT_ACCEPT:
                // 连接接受由 tryConnect 的回调处理
                break;
            case MSG_CONNECT_REJECT:
                // 连接拒绝由 tryConnect 的回调处理
                break;
            default:
                // 可能是 PAKE 或 Noise 数据，由专门的处理器处理
                break;
        }
    }

    private handleAppData(data: Uint8Array): void {
        let decryptedData = data;

        if (this.receiveCipher) {
            try {
                decryptedData = new Uint8Array(this.receiveCipher.decrypt(data as any));
            } catch {
                this.emit("binary", data.buffer as ArrayBuffer);
                return;
            }
        }

        const text = new TextDecoder().decode(decryptedData);
        try {
            const parsed = JSON.parse(text);
            if (parsed.type === "credential_rotation") {
                this.emit("credentialRotated", {
                    remotePublicKey: new Uint8Array(parsed.publicKey),
                } as Credential);
                return;
            }
        } catch {
            // Not JSON
        }

        // 检查是否为文本
        const reencoded = new TextEncoder().encode(text);
        const isText =
            reencoded.length === decryptedData.length &&
            !decryptedData.some((b) => b < 32 && b !== 10 && b !== 13 && b !== 9);
        if (isText) {
            this.emit("message", text);
        } else {
            this.emit("binary", decryptedData.buffer as ArrayBuffer);
        }
    }

    // ================= 配对请求处理 =================

    private handlePairRequest(payload: Uint8Array): void {
        const senderIdLength = new DataView(payload.buffer, payload.byteOffset).getUint16(0);
        const senderId = new TextDecoder().decode(payload.subarray(2, 2 + senderIdLength));

        const request: PairRequest = {
            remoteDeviceId: senderId,
            inputPin: (pin: string): Promise<Credential> => {
                return new Promise((resolve, reject) => {
                    if (!this.validatePin(pin)) {
                        reject(new Error("Invalid PIN format"));
                        return;
                    }

                    const credential: CredentialPublicInfo = {
                        myDeviceId: this.myDeviceId,
                        remoteDeviceId: senderId,
                    };

                    this.performPAKEClient(credential, pin).then(resolve).catch(reject);
                });
            },
            reject: () => {
                // 拒绝配对
            },
        };

        this.emit("pairRequest", request);
    }

    private async sendPairRequest(credential: CredentialPublicInfo): Promise<void> {
        await this.signalAdapter.connect(credential.remoteDeviceId);

        const myIdBytes = new TextEncoder().encode(this.myDeviceId);
        const message = new Uint8Array(1 + 2 + myIdBytes.length);
        message[0] = MSG_PAIR_REQUEST;
        new DataView(message.buffer).setUint16(1, myIdBytes.length);
        message.set(myIdBytes, 3);

        await this.signalAdapter.send(message);
    }

    // ================= 连接请求处理 =================

    private handleConnectRequest(payload: Uint8Array): void {
        const senderIdLength = new DataView(payload.buffer, payload.byteOffset).getUint16(0);
        const senderId = new TextDecoder().decode(payload.subarray(2, 2 + senderIdLength));

        const request: ConnectRequest = {
            remoteDeviceId: senderId,
            accept: (credential: Credential): Promise<ConnectResult> => {
                return new Promise((resolve, reject) => {
                    // 发送接受响应
                    const acceptMsg = new Uint8Array([MSG_CONNECT_ACCEPT]);
                    this.signalAdapter.send(acceptMsg);

                    // 作为响应方进行 Noise IK 握手
                    this.performIKResponder(credential).then(resolve).catch(reject);
                });
            },
            reject: () => {
                const rejectMsg = new Uint8Array([MSG_CONNECT_REJECT]);
                this.signalAdapter.send(rejectMsg);
            },
        };

        this.emit("connectRequest", request);
    }

    private async sendConnectRequest(credential: Credential): Promise<ConnectResult> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.restoreMessageHandler();
                reject(new Error("Connect request timeout"));
            }, this.options.handshakeTimeout);

            // 设置消息处理器等待响应
            const messageHandler = (data: Uint8Array) => {
                if (data[0] === MSG_CONNECT_ACCEPT) {
                    clearTimeout(timeout);
                    this.restoreMessageHandler();

                    // 开始 Noise IK 握手
                    this.performIKInitiator(credential).then(resolve).catch(reject);
                } else if (data[0] === MSG_CONNECT_REJECT) {
                    clearTimeout(timeout);
                    this.restoreMessageHandler();
                    resolve({ success: false });
                }
            };

            this.signalAdapter.onMessage(messageHandler);

            // 发送连接请求
            const myIdBytes = new TextEncoder().encode(this.myDeviceId);
            const message = new Uint8Array(1 + 2 + myIdBytes.length);
            message[0] = MSG_CONNECT_REQUEST;
            new DataView(message.buffer).setUint16(1, myIdBytes.length);
            message.set(myIdBytes, 3);

            this.signalAdapter.send(message).catch((err) => {
                clearTimeout(timeout);
                this.restoreMessageHandler();
                reject(err);
            });
        });
    }

    // ================= PAKE 配对 =================

    private async setupPAKEResponder(credential: CredentialPublicInfo, myPin: string): Promise<Credential> {
        await this.signalAdapter.connect(credential.remoteDeviceId);

        const spake = spake2({
            mhf: { n: 1024, r: 8, p: 16 },
            kdf: { AAD: "sconnect-pairing" },
        });

        const verifier = await spake.computeVerifier(
            myPin,
            credential.myDeviceId + credential.remoteDeviceId,
            credential.myDeviceId,
            credential.remoteDeviceId,
        );

        const serverState = await spake.startServer(credential.myDeviceId, credential.remoteDeviceId, verifier);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Pairing timeout"));
            }, this.options.handshakeTimeout);

            const messageHandler = async (data: Uint8Array) => {
                try {
                    // 解析: 2字节SPAKE2长度 + SPAKE2消息 + 对方公钥
                    const spakeLen = new DataView(data.buffer, data.byteOffset).getUint16(0);
                    const spakeMsg = data.subarray(2, 2 + spakeLen);
                    const remotePublicKey = data.subarray(2 + spakeLen);

                    // 发送响应
                    const serverMsg = serverState.getMessage();
                    const myPublicKey = this.myKeyPair?.publicKey ?? new Uint8Array();
                    const response = new Uint8Array(2 + serverMsg.length + myPublicKey.length);
                    new DataView(response.buffer).setUint16(0, serverMsg.length);
                    response.set(serverMsg, 2);
                    response.set(myPublicKey, 2 + serverMsg.length);
                    this.signalAdapter.send(response);

                    const sharedSecret = await serverState.finish(spakeMsg);

                    clearTimeout(timeout);
                    this.restoreMessageHandler();

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

    private async performPAKEClient(credential: CredentialPublicInfo, remotePin: string): Promise<Credential> {
        await this.signalAdapter.connect(credential.remoteDeviceId);

        const spake = spake2({
            mhf: { n: 1024, r: 8, p: 16 },
            kdf: { AAD: "sconnect-pairing" },
        });

        const clientState = await spake.startClient(
            credential.remoteDeviceId,
            credential.myDeviceId,
            remotePin,
            credential.remoteDeviceId + credential.myDeviceId,
        );

        // 发送: 2字节SPAKE2长度 + SPAKE2消息 + 我方公钥
        const clientMsg = clientState.getMessage();
        const myPublicKey = this.myKeyPair?.publicKey ?? new Uint8Array();
        const message = new Uint8Array(2 + clientMsg.length + myPublicKey.length);
        new DataView(message.buffer).setUint16(0, clientMsg.length);
        message.set(clientMsg, 2);
        message.set(myPublicKey, 2 + clientMsg.length);
        await this.signalAdapter.send(message);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Pairing timeout"));
            }, this.options.handshakeTimeout);

            const messageHandler = async (data: Uint8Array) => {
                try {
                    // 解析: 2字节SPAKE2长度 + SPAKE2消息 + 对方公钥
                    const spakeLen = new DataView(data.buffer, data.byteOffset).getUint16(0);
                    const spakeMsg = data.subarray(2, 2 + spakeLen);
                    const remotePublicKey = data.subarray(2 + spakeLen);

                    const sharedSecret = await clientState.finish(spakeMsg);

                    clearTimeout(timeout);
                    this.restoreMessageHandler();

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

    private async performIKInitiator(credential: Credential): Promise<ConnectResult> {
        try {
            const keyPair = this.myKeyPair;
            if (!keyPair) throw new Error("No key pair");
            const myKeyPair = {
                publicKey: keyPair.publicKey as any,
                secretKey: keyPair.privateKey as any,
            };
            this.noise = new Noise("IK", true, myKeyPair);

            const prologue = new Uint8Array(0) as any;
            const remoteStaticKey = credential.remotePublicKey as any;
            this.noise.initialise(prologue, remoteStaticKey);

            const handshakeMessage = this.noise.send();
            await this.signalAdapter.send(new Uint8Array(handshakeMessage));

            const response = await this.waitForNoiseResponse();
            this.noise.recv(response as any);

            if (this.noise.complete) {
                if (!this.signalAdapter.supportNativeEncryption) {
                    this.sendCipher = new Cipher(this.noise.tx as any);
                    this.receiveCipher = new Cipher(this.noise.rx as any);
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

    private async performIKResponder(credential: Credential): Promise<ConnectResult> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Handshake timeout"));
            }, this.options.handshakeTimeout);

            const messageHandler = (data: Uint8Array) => {
                try {
                    const keyPair = this.myKeyPair;
                    if (!keyPair) throw new Error("No key pair");
                    const myKeyPair = {
                        publicKey: keyPair.publicKey as any,
                        secretKey: keyPair.privateKey as any,
                    };
                    this.noise = new Noise("IK", false, myKeyPair);

                    const prologue = new Uint8Array(0) as any;
                    this.noise.initialise(prologue);

                    this.noise.recv(data as any);

                    const responseMsg = this.noise.send();
                    this.signalAdapter.send(new Uint8Array(responseMsg));

                    if (this.noise.complete) {
                        if (!this.signalAdapter.supportNativeEncryption) {
                            this.sendCipher = new Cipher(this.noise.tx as any);
                            this.receiveCipher = new Cipher(this.noise.rx as any);
                        }
                        this.isReady = true;

                        clearTimeout(timeout);
                        this.restoreMessageHandler();

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
    }

    private waitForNoiseResponse(): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Handshake timeout"));
            }, this.options.handshakeTimeout);

            const handler = (data: Uint8Array) => {
                clearTimeout(timeout);
                this.restoreMessageHandler();
                resolve(data);
            };

            this.signalAdapter.onMessage(handler);
        });
    }

    // ================= 工具方法 =================

    private restoreMessageHandler(): void {
        this.signalAdapter.onMessage((data) => this.handleRawMessage(data));
    }

    private initializeEncryption(sharedSecret: Uint8Array): void {
        const secretArray = new Uint8Array(sharedSecret);
        const key = new Uint8Array(32);
        key.set(secretArray.subarray(0, Math.min(16, secretArray.length)), 0);
        key.set(secretArray.subarray(0, Math.min(16, secretArray.length)), 16);

        if (!this.signalAdapter.supportNativeEncryption) {
            this.sendCipher = new Cipher(key as any);
            this.receiveCipher = new Cipher(key as any);
        }
    }

    private buildCredential(credential: CredentialPublicInfo | Credential): Credential {
        return {
            ...credential,
            myPrivateKey: "myPrivateKey" in credential ? credential.myPrivateKey : new Uint8Array(),
            myPublicKey: this.myKeyPair?.publicKey ?? new Uint8Array(),
            remotePublicKey: "remotePublicKey" in credential ? credential.remotePublicKey : new Uint8Array(),
            createdAt: "createdAt" in credential ? credential.createdAt : Date.now(),
            lastConnected: Date.now(),
        };
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
        const keyPair = await crypto.subtle.generateKey({ name: "X25519" } as AlgorithmIdentifier, true, [
            "deriveBits",
        ]);

        const publicKeyBuffer = await crypto.subtle.exportKey("raw", (keyPair as CryptoKeyPair).publicKey);
        const privateKeyBuffer = await crypto.subtle.exportKey("pkcs8", (keyPair as CryptoKeyPair).privateKey);

        const privateKeyRaw = new Uint8Array(privateKeyBuffer).subarray(16);

        return {
            publicKey: new Uint8Array(publicKeyBuffer),
            privateKey: privateKeyRaw,
        };
    }
}
