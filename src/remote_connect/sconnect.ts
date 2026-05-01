import type {
    ChannelOptions,
    ChannelState,
    ConnectRequest,
    ConnectResult,
    Credential,
    CredentialPublicInfo,
    HandshakeType,
    PairRequest,
    SecureChannel,
    SignalingAdapter,
} from "./sconnect_type";
import { spake2 } from "./spake/index";
import {
    createNoise,
    initialiseNoise,
    sendNoise,
    recvNoise,
    destroyNoise,
    createCipher,
    type NoiseState,
} from "./noise_utils";

interface KeyPair {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
}

// 协议消息类型
const MSG_PAIR_REQUEST = 0x01;
const MSG_USE_YOUR_PIN = 0x02; // 通知对方使用自己的 PIN
const MSG_PAIR_REJECT = 0x07; // 拒绝配对请求
const MSG_CONNECT_REQUEST = 0x03;
const MSG_CONNECT_ACCEPT = 0x04;
const MSG_CONNECT_REJECT = 0x05;
const MSG_ERROR = 0x06;
const MSG_NOISE_DATA = 0x10;
const MSG_APP_DATA = 0x20;

type SecureChannelEvents = {
    ready: () => void;
    message: (payload: string) => void;
    binary: (data: ArrayBuffer) => void;
    disconnect: () => void;
    error: (err: SConnectError) => void;
    pairRequest: (request: PairRequest) => void;
    connectRequest: (request: ConnectRequest) => void;
    credentialRotated: (updatedCredential: Credential) => void;
    credentialInvalidated: (remoteDeviceId: string) => void;
};

// 错误类
class SConnectError extends Error {
    code: string;
    recoverable: boolean;

    constructor(code: string, message: string, recoverable = true) {
        super(message);
        this.name = "SConnectError";
        this.code = code;
        this.recoverable = recoverable;
    }
}

export class SConnect implements SecureChannel {
    private signalAdapter: SignalingAdapter;
    private options: Required<ChannelOptions>;
    private noise: NoiseState | null = null;
    private sendCipher: ReturnType<typeof createCipher> | null = null;
    private receiveCipher: ReturnType<typeof createCipher> | null = null;
    private PIN = "";
    private eventHandlers: Map<string, Set<(...args: unknown[]) => void>> = new Map();

    // 状态机
    private state: ChannelState = "Idle";
    private handshakeType: HandshakeType = null;

    // 设备身份
    private myDeviceId = "";
    private myKeyPair: KeyPair | null = null;

    // 计时器管理
    private activeTimers: Set<ReturnType<typeof setTimeout>> = new Set();

    constructor(signalAdapter: SignalingAdapter, options?: ChannelOptions) {
        this.signalAdapter = signalAdapter;
        this.options = {
            connectTimeout: options?.connectTimeout ?? 30000,
            pairingTimeout: options?.pairingTimeout ?? 60000,
            handshakeTimeout: options?.handshakeTimeout ?? 30000,
            maxPinAttempts: options?.maxPinAttempts ?? 5,
        };

        this.signalAdapter.onMessage((data) => this.handleRawMessage(data));
        this.signalAdapter.onClose(() => this.handleDisconnect());
        this.signalAdapter.onError((err) => this.emit("error", this.wrapError(err)));
    }

    // ================= 初始化 =================

    async init(myDeviceId: string, keyPair?: KeyPair): Promise<Uint8Array> {
        if (this.state !== "Idle") {
            throw new SConnectError("NOT_INITIALIZED", "Already initialized");
        }

        this.myDeviceId = myDeviceId;
        await this.signalAdapter.init(myDeviceId);

        if (keyPair) {
            this.myKeyPair = keyPair;
        } else {
            this.myKeyPair = await this.generateKeyPair();
        }

        this.setState("Ready");
        return this.myKeyPair.publicKey;
    }

    // ================= 连接 =================

    async tryConnect(credential: CredentialPublicInfo | Credential): Promise<ConnectResult> {
        if (this.state !== "Ready") {
            throw new SConnectError("CHANNEL_NOT_READY", `Cannot connect in ${this.state} state`);
        }

        try {
            await this.signalAdapter.connect(credential.remoteDeviceId);

            if (this.signalAdapter.trustIdentity) {
                this.setState("Connected");
                this.emit("ready");
                return { success: true, credential: this.buildCredential(credential) };
            }

            if ("myPrivateKey" in credential && credential.myPrivateKey) {
                this.setState("Handshaking", "connect-request");
                return await this.sendConnectRequest(credential as Credential);
            }

            return { success: false, reason: "NEEDS_PAIRING" };
        } catch (error) {
            this.setState("Ready");
            this.emit("error", this.wrapError(error));
            return { success: false };
        }
    }

    // ================= 配对 =================

    updatePIN(): string {
        this.PIN = this.generatePin();
        return this.PIN;
    }

    pairInit(credential: CredentialPublicInfo): {
        pin: string;
        inputOtherPin: (pin: string) => void;
        waitForPairing: () => Promise<Credential>;
    } {
        if (this.state !== "Ready") {
            throw new SConnectError("CHANNEL_NOT_READY", `Cannot pair in ${this.state} state`);
        }

        const pin = this.PIN || this.updatePIN();
        let resolvePairing: (credential: Credential) => void;
        let rejectPairing: (error: Error) => void;
        let pinAttempts = 0;
        let pairingStarted = false;
        let waitingForPairing = false;
        let savedPin: string | null = null;

        const pairingPromise = new Promise<Credential>((resolve, reject) => {
            resolvePairing = resolve;
            rejectPairing = reject;
        });
        pairingPromise.catch(() => {}); // 防止 unhandled rejection

        this.setState("Handshaking", "pake");

        // 设置回调：当收到 MSG_PAIR_REJECT 消息时，立即 reject
        this.onPairReject = () => {
            this.setState("Ready");
            rejectPairing(new SConnectError("PAIRING_FAILED", "Pairing rejected by peer"));
            pairingStarted = true; // 确保其他地方不再启动
        };

        // startResponder 始终作为 Server，使用指定的 PIN 计算 verifier
        const startResponder = (usePin: string) => {
            if (pairingStarted) return;
            pairingStarted = true;
            this.setupPAKEResponder(credential, usePin).then(resolvePairing).catch(rejectPairing);
        };

        const inputOtherPin = (remotePin: string) => {
            if (pairingStarted) return;

            pinAttempts++;
            if (pinAttempts > this.options.maxPinAttempts) {
                this.setState("Ready");
                rejectPairing(new SConnectError("PIN_MISMATCH", "Maximum PIN attempts exceeded"));
                return;
            }

            if (!this.validatePin(remotePin)) {
                this.emit("error", new SConnectError("PIN_INVALID", "PIN must be 6 digits"));
                rejectPairing(new SConnectError("PIN_INVALID", "PIN must be 6 digits"));
                return;
            }

            // 通知对方使用自己的 PIN
            this.signalAdapter.send(new Uint8Array([MSG_USE_YOUR_PIN])).catch(() => {});

            if (waitingForPairing) {
                // waitForPairing 已调用，用远程 PIN 启动 Server
                startResponder(remotePin);
            } else {
                // 保存 PIN，等 waitForPairing 调用
                savedPin = remotePin;
            }
        };

        const waitForPairing = (): Promise<Credential> => {
            if (pairingStarted) {
                return pairingPromise;
            }

            if (savedPin) {
                // inputOtherPin 已调用，用远程 PIN 启动 Server
                startResponder(savedPin);
            } else {
                // 未调用 inputOtherPin，用自己的 PIN 启动 Server
                waitingForPairing = true;
                startResponder(pin);
            }
            return pairingPromise;
        };

        // 发送配对请求
        this.sendPairRequest(credential).catch(rejectPairing);

        return { pin, inputOtherPin, waitForPairing };
    }

    // ================= 断开 =================

    disconnect(): void {
        if (this.state === "Idle") return;

        this.sendCipher = null;
        this.receiveCipher = null;

        // 清理回调
        this.onUseYourPin = null;
        this.onPairReject = null;

        if (this.noise) {
            destroyNoise(this.noise);
            this.noise = null;
        }

        this.signalAdapter.close();
        this.setState("Ready");
        this.emit("disconnect");
    }

    destroy(): void {
        this.sendCipher = null;
        this.receiveCipher = null;

        if (this.noise) {
            destroyNoise(this.noise);
            this.noise = null;
        }

        this.signalAdapter.close();
        this.myDeviceId = "";
        this.myKeyPair = null;
        this.setState("Idle");
    }

    // ================= 数据发送 =================

    async send(payload: string): Promise<void> {
        if (this.state !== "Connected") {
            throw new SConnectError("CHANNEL_NOT_READY", `Cannot send in ${this.state} state`);
        }

        const data = new TextEncoder().encode(payload);
        await this.sendData(data);
    }

    async sendBinary(data: ArrayBuffer | Uint8Array): Promise<void> {
        if (this.state !== "Connected") {
            throw new SConnectError("CHANNEL_NOT_READY", `Cannot send in ${this.state} state`);
        }

        const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        await this.sendData(buffer);
    }

    private async sendData(data: Uint8Array): Promise<void> {
        // 添加应用数据类型字节
        const message = new Uint8Array(1 + data.length);
        message[0] = MSG_APP_DATA;
        message.set(data, 1);

        if (this.sendCipher) {
            const encrypted = this.sendCipher.encrypt(message);
            await this.signalAdapter.send(encrypted);
        } else {
            await this.signalAdapter.send(message);
        }
    }

    // ================= 事件 =================

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
        if (this.state !== "Connected") {
            throw new SConnectError("CHANNEL_NOT_READY", `Cannot rotate in ${this.state} state`);
        }
        // TODO: implement credential rotation
    }

    // ================= 状态机 =================

    private setState(newState: ChannelState, handshakeType?: HandshakeType): void {
        const oldState = this.state;
        this.state = newState;
        this.handshakeType = handshakeType ?? (newState === "Handshaking" ? this.handshakeType : null);

        // 状态改变时清理所有计时器
        if (oldState !== newState) {
            this.clearAllTimers();
        }
    }

    // ================= 计时器管理 =================

    private createTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
        const timer = setTimeout(() => {
            this.activeTimers.delete(timer);
            callback();
        }, ms);
        this.activeTimers.add(timer);
        return timer;
    }

    private clearAllTimers(): void {
        for (const timer of this.activeTimers) {
            clearTimeout(timer);
        }
        this.activeTimers.clear();
    }

    // ================= 消息处理 =================

    private handleRawMessage(data: Uint8Array): void {
        const type = data[0];

        // 错误消息任何状态都处理
        if (type === MSG_ERROR) {
            this.handleErrorFromPeer(data.subarray(1));
            return;
        }

        switch (this.state) {
            case "Idle":
                return;

            case "Ready":
                if (type < 0x20) {
                    this.handleProtocolMessage(data);
                } else {
                    this.sendErrorToPeer("NOT_CONNECTED", "Peer is not connected");
                }
                return;

            case "Handshaking":
                if (this.isHandshakeMessage(type)) {
                    this.handleHandshakeMessage(data);
                } else {
                    this.sendErrorToPeer("UNEXPECTED_MESSAGE", "Peer is in handshake state");
                }
                return;

            case "Connected":
                // 只拒绝新的配对/连接请求
                if (type === MSG_PAIR_REQUEST) {
                    this.sendErrorToPeer("ALREADY_CONNECTED", "Peer is already connected");
                } else if (type === MSG_CONNECT_REQUEST) {
                    this.sendErrorToPeer("ALREADY_CONNECTED", "Peer is already connected");
                } else {
                    // 其他都作为应用数据处理（包括协议消息）
                    this.handleAppData(data);
                }
                return;
        }
    }

    private isHandshakeMessage(type: number): boolean {
        switch (this.handshakeType) {
            case "pake":
                return type === MSG_APP_DATA || type === MSG_PAIR_REJECT;
            case "ik":
                return type === MSG_NOISE_DATA || type === MSG_APP_DATA;
            case "connect-request":
                return type === MSG_CONNECT_ACCEPT || type === MSG_CONNECT_REJECT;
            case "connect-response":
                return type === MSG_NOISE_DATA || type === MSG_APP_DATA;
            default:
                return false;
        }
    }

    private handleHandshakeMessage(data: Uint8Array): void {
        const type = data[0];

        // 处理配对拒绝消息
        if (type === MSG_PAIR_REJECT) {
            this.handlePairReject();
            return;
        }

        // 其他握手消息由各握手方法的消息处理器处理
        // 这里只是路由，实际处理在各方法的 messageHandler 中
    }

    private handleProtocolMessage(data: Uint8Array): void {
        const type = data[0];
        const payload = data.subarray(1);

        switch (type) {
            case MSG_PAIR_REQUEST:
                this.handlePairRequest(payload);
                break;
            case MSG_USE_YOUR_PIN:
                this.handleUseYourPin();
                break;
            case MSG_CONNECT_REQUEST:
                this.handleConnectRequest(payload);
                break;
        }
    }

    private handleUseYourPin(): void {
        if (this.onUseYourPin) {
            this.onUseYourPin();
            this.onUseYourPin = null;
        }
    }

    private handlePairReject(): void {
        if (this.onPairReject) {
            this.onPairReject();
            this.onPairReject = null;
        }
    }

    private handleAppData(data: Uint8Array): void {
        // 移除类型字节
        let payload = new Uint8Array(data.subarray(1));

        if (this.receiveCipher) {
            try {
                payload = new Uint8Array(this.receiveCipher.decrypt(payload));
            } catch {
                this.emit("binary", new Uint8Array(payload).buffer as ArrayBuffer);
                return;
            }
        }

        const text = new TextDecoder().decode(payload);
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

        const reencoded = new TextEncoder().encode(text);
        const isText =
            reencoded.length === payload.length && !payload.some((b) => b < 32 && b !== 10 && b !== 13 && b !== 9);
        if (isText) {
            this.emit("message", text);
        } else {
            this.emit("binary", payload.buffer as ArrayBuffer);
        }
    }

    // ================= 错误消息 =================

    private sendErrorToPeer(code: string, message: string): void {
        const errorMsg = JSON.stringify({ code, message });
        const payload = new TextEncoder().encode(errorMsg);
        const msg = new Uint8Array(1 + payload.length);
        msg[0] = MSG_ERROR;
        msg.set(payload, 1);
        this.signalAdapter.send(msg).catch(() => {});
    }

    private handleErrorFromPeer(payload: Uint8Array): void {
        const text = new TextDecoder().decode(payload);
        try {
            const error = JSON.parse(text);
            this.emit("error", new SConnectError(error.code, error.message));
        } catch {
            // ignore
        }
    }

    // ================= 配对请求 =================

    // 当前配对请求的回调函数，用于处理 MSG_USE_YOUR_PIN 消息
    private onUseYourPin: (() => void) | null = null;
    // 当前配对请求的回调函数，用于处理 MSG_PAIR_REJECT 消息
    private onPairReject: (() => void) | null = null;

    private handlePairRequest(payload: Uint8Array): void {
        const senderIdLength = new DataView(payload.buffer, payload.byteOffset).getUint16(0);
        const senderId = new TextDecoder().decode(payload.subarray(2, 2 + senderIdLength));

        let resolvePairing: (credential: Credential) => void;
        let rejectPairing: (error: Error) => void;
        let pinAttempts = 0;
        let savedPin: string | null = null;
        let pairingStarted = false;
        let waitingForPairing = false;

        const pairingPromise = new Promise<Credential>((resolve, reject) => {
            resolvePairing = resolve;
            rejectPairing = reject;
        });
        pairingPromise.catch(() => {}); // 防止 unhandled rejection

        const startPairing = (pin: string) => {
            if (pairingStarted) return;
            pairingStarted = true;

            this.setState("Handshaking", "pake");

            const credential: CredentialPublicInfo = {
                myDeviceId: this.myDeviceId,
                remoteDeviceId: senderId,
            };

            this.performPAKEClient(credential, pin).then(resolvePairing).catch(rejectPairing);
        };

        // 设置回调：当收到 MSG_USE_YOUR_PIN 消息时，用自己的 PIN 启动 Client
        this.onUseYourPin = () => {
            if (waitingForPairing && !pairingStarted) {
                startPairing(this.PIN);
            }
        };

        const request: PairRequest = {
            remoteDeviceId: senderId,
            inputOtherPin: (pin: string): void => {
                pinAttempts++;
                if (pinAttempts > this.options.maxPinAttempts) {
                    rejectPairing(new SConnectError("PIN_MISMATCH", "Maximum PIN attempts exceeded"));
                    return;
                }

                if (!this.validatePin(pin)) {
                    this.emit("error", new SConnectError("PIN_INVALID", "PIN must be 6 digits"));
                    rejectPairing(new SConnectError("PIN_INVALID", "PIN must be 6 digits"));
                    return;
                }

                if (waitingForPairing) {
                    // waitForPairing 已调用，直接开始配对
                    startPairing(pin);
                } else {
                    // 保存 PIN，等 waitForPairing 调用
                    savedPin = pin;
                }
            },
            waitForPairing: () => {
                if (pairingStarted) {
                    // 已经在配对中，直接返回 promise
                } else if (savedPin) {
                    // inputPin 已调用，开始配对
                    startPairing(savedPin);
                } else {
                    // 等待 inputPin 调用或 MSG_USE_YOUR_PIN 消息
                    waitingForPairing = true;
                }
                return pairingPromise;
            },
            reject: () => {
                // 通知对方配对被拒绝
                this.signalAdapter.send(new Uint8Array([MSG_PAIR_REJECT])).catch(() => {});
                rejectPairing(new SConnectError("PAIRING_FAILED", "Pairing rejected"));
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

    // ================= 连接请求 =================

    private handleConnectRequest(payload: Uint8Array): void {
        const senderIdLength = new DataView(payload.buffer, payload.byteOffset).getUint16(0);
        const senderId = new TextDecoder().decode(payload.subarray(2, 2 + senderIdLength));

        const request: ConnectRequest = {
            remoteDeviceId: senderId,
            accept: (credential: Credential): Promise<ConnectResult> => {
                this.setState("Handshaking", "connect-response");
                this.signalAdapter.send(new Uint8Array([MSG_CONNECT_ACCEPT]));
                return this.performIKResponder(credential);
            },
            reject: () => {
                this.signalAdapter.send(new Uint8Array([MSG_CONNECT_REJECT]));
            },
        };

        this.emit("connectRequest", request);
    }

    private async sendConnectRequest(credential: Credential): Promise<ConnectResult> {
        return new Promise((resolve, reject) => {
            const timeout = this.createTimer(() => {
                this.restoreMessageHandler();
                this.setState("Ready");
                this.sendErrorToPeer("TIMEOUT", "Connect request timeout");
                reject(new SConnectError("TIMEOUT", "Connect request timeout"));
            }, this.options.connectTimeout);

            const messageHandler = (data: Uint8Array) => {
                if (data[0] === MSG_CONNECT_ACCEPT) {
                    clearTimeout(timeout);
                    this.activeTimers.delete(timeout);
                    this.restoreMessageHandler();
                    this.setState("Handshaking", "ik");
                    this.performIKInitiator(credential).then(resolve).catch(reject);
                } else if (data[0] === MSG_CONNECT_REJECT) {
                    clearTimeout(timeout);
                    this.activeTimers.delete(timeout);
                    this.restoreMessageHandler();
                    this.setState("Ready");
                    resolve({ success: false });
                }
            };

            this.signalAdapter.onMessage(messageHandler);

            const myIdBytes = new TextEncoder().encode(this.myDeviceId);
            const message = new Uint8Array(1 + 2 + myIdBytes.length);
            message[0] = MSG_CONNECT_REQUEST;
            new DataView(message.buffer).setUint16(1, myIdBytes.length);
            message.set(myIdBytes, 3);

            this.signalAdapter.send(message).catch((err) => {
                clearTimeout(timeout);
                this.activeTimers.delete(timeout);
                this.restoreMessageHandler();
                this.setState("Ready");
                reject(err);
            });
        });
    }

    // ================= PAKE =================

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
            const timeout = this.createTimer(() => {
                this.restoreMessageHandler();
                this.setState("Ready");
                this.sendErrorToPeer("TIMEOUT", "PAKE pairing timeout");
                reject(new SConnectError("TIMEOUT", "PAKE pairing timeout"));
            }, this.options.pairingTimeout);

            const messageHandler = async (data: Uint8Array) => {
                try {
                    const spakeLen = new DataView(data.buffer, data.byteOffset).getUint16(0);
                    const spakeMsg = data.subarray(2, 2 + spakeLen);
                    const remotePublicKey = data.subarray(2 + spakeLen);

                    const serverMsg = serverState.getMessage();
                    const myPublicKey = this.myKeyPair?.publicKey ?? new Uint8Array();
                    const response = new Uint8Array(2 + serverMsg.length + myPublicKey.length);
                    new DataView(response.buffer).setUint16(0, serverMsg.length);
                    response.set(serverMsg, 2);
                    response.set(myPublicKey, 2 + serverMsg.length);
                    await this.signalAdapter.send(response);

                    const sharedSecret = await serverState.finish(spakeMsg);

                    this.activeTimers.delete(timeout);
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

                    this.setState("Connected");
                    this.emit("ready");
                    resolve(fullCredential);
                } catch (err) {
                    this.activeTimers.delete(timeout);
                    clearTimeout(timeout);
                    this.restoreMessageHandler();
                    this.setState("Ready");
                    reject(new SConnectError("PAKE_FAILED", "PAKE protocol failed"));
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

        const clientMsg = clientState.getMessage();
        const myPublicKey = this.myKeyPair?.publicKey ?? new Uint8Array();
        const message = new Uint8Array(2 + clientMsg.length + myPublicKey.length);
        new DataView(message.buffer).setUint16(0, clientMsg.length);
        message.set(clientMsg, 2);
        message.set(myPublicKey, 2 + clientMsg.length);
        await this.signalAdapter.send(message);

        return new Promise((resolve, reject) => {
            const timeout = this.createTimer(() => {
                this.restoreMessageHandler();
                this.setState("Ready");
                this.sendErrorToPeer("TIMEOUT", "PAKE pairing timeout");
                reject(new SConnectError("TIMEOUT", "PAKE pairing timeout"));
            }, this.options.pairingTimeout);

            const messageHandler = async (data: Uint8Array) => {
                try {
                    const spakeLen = new DataView(data.buffer, data.byteOffset).getUint16(0);
                    const spakeMsg = data.subarray(2, 2 + spakeLen);
                    const remotePublicKey = data.subarray(2 + spakeLen);

                    const sharedSecret = await clientState.finish(spakeMsg);

                    this.activeTimers.delete(timeout);
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

                    this.setState("Connected");
                    this.emit("ready");
                    resolve(fullCredential);
                } catch (err) {
                    this.activeTimers.delete(timeout);
                    clearTimeout(timeout);
                    this.restoreMessageHandler();
                    this.setState("Ready");
                    reject(new SConnectError("PAKE_FAILED", "PAKE protocol failed"));
                }
            };

            this.signalAdapter.onMessage(messageHandler);
        });
    }

    // ================= Noise IK =================

    private async performIKInitiator(credential: Credential): Promise<ConnectResult> {
        try {
            const keyPair = this.myKeyPair;
            if (!keyPair) throw new Error("No key pair");

            this.noise = createNoise("IK", true, keyPair);
            initialiseNoise(this.noise, new Uint8Array(0), credential.remotePublicKey);

            const handshakeMessage = sendNoise(this.noise);
            await this.signalAdapter.send(handshakeMessage);

            const response = await this.waitForNoiseResponse();
            recvNoise(this.noise, response);

            if (this.noise.complete) {
                if (!this.signalAdapter.supportNativeEncryption) {
                    this.sendCipher = createCipher(this.noise.tx);
                    this.receiveCipher = createCipher(this.noise.rx);
                }

                this.setState("Connected");
                this.emit("ready");
                return {
                    success: true,
                    credential: { ...credential, lastConnected: Date.now() },
                };
            }

            this.setState("Ready");
            return { success: false };
        } catch (error) {
            this.setState("Ready");
            this.emit("error", new SConnectError("IK_HANDSHAKE_FAILED", "Noise IK handshake failed"));
            return { success: false };
        }
    }

    private async performIKResponder(credential: Credential): Promise<ConnectResult> {
        return new Promise((resolve, reject) => {
            const timeout = this.createTimer(() => {
                this.restoreMessageHandler();
                this.setState("Ready");
                this.sendErrorToPeer("TIMEOUT", "IK handshake timeout");
                reject(new SConnectError("TIMEOUT", "IK handshake timeout"));
            }, this.options.handshakeTimeout);

            const messageHandler = (data: Uint8Array) => {
                try {
                    const keyPair = this.myKeyPair;
                    if (!keyPair) throw new Error("No key pair");

                    this.noise = createNoise("IK", false, keyPair);
                    initialiseNoise(this.noise, new Uint8Array(0));
                    recvNoise(this.noise, data);

                    const responseMsg = sendNoise(this.noise);
                    this.signalAdapter.send(responseMsg);

                    if (this.noise.complete) {
                        if (!this.signalAdapter.supportNativeEncryption) {
                            this.sendCipher = createCipher(this.noise.tx);
                            this.receiveCipher = createCipher(this.noise.rx);
                        }

                        this.setState("Connected");
                        this.activeTimers.delete(timeout);
                        clearTimeout(timeout);
                        this.restoreMessageHandler();
                        this.emit("ready");
                        resolve({
                            success: true,
                            credential: { ...credential, lastConnected: Date.now() },
                        });
                    } else {
                        this.activeTimers.delete(timeout);
                        clearTimeout(timeout);
                        this.setState("Ready");
                        resolve({ success: false });
                    }
                } catch (err) {
                    this.activeTimers.delete(timeout);
                    clearTimeout(timeout);
                    this.restoreMessageHandler();
                    this.setState("Ready");
                    reject(new SConnectError("IK_HANDSHAKE_FAILED", "Noise IK handshake failed"));
                }
            };

            this.signalAdapter.onMessage(messageHandler);
        });
    }

    private waitForNoiseResponse(): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            const timeout = this.createTimer(() => {
                this.restoreMessageHandler();
                this.setState("Ready");
                this.sendErrorToPeer("TIMEOUT", "Noise handshake timeout");
                reject(new SConnectError("TIMEOUT", "Noise handshake timeout"));
            }, this.options.handshakeTimeout);

            const handler = (data: Uint8Array) => {
                this.activeTimers.delete(timeout);
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
            this.sendCipher = createCipher(key);
            this.receiveCipher = createCipher(key);
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
        if (this.state === "Idle") return;
        this.sendCipher = null;
        this.receiveCipher = null;
        this.setState("Ready");
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

    private wrapError(error: unknown): SConnectError {
        if (error instanceof SConnectError) return error;
        return new SConnectError("ADAPTER_ERROR", error instanceof Error ? error.message : String(error));
    }

    private async generateKeyPair(): Promise<KeyPair> {
        const keyPair = await crypto.subtle.generateKey({ name: "X25519" } as AlgorithmIdentifier, true, [
            "deriveBits",
        ]);

        const publicKeyBuffer = await crypto.subtle.exportKey("raw", (keyPair as CryptoKeyPair).publicKey);
        const privateKeyBuffer = await crypto.subtle.exportKey("pkcs8", (keyPair as CryptoKeyPair).privateKey);

        return {
            publicKey: new Uint8Array(publicKeyBuffer),
            privateKey: new Uint8Array(privateKeyBuffer).subarray(16),
        };
    }
}
