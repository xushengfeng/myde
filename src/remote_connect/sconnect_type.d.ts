/**
 * 端到端加密通信通道
 *
 * 设计原则：
 * - 通道本身无状态，不持有任何长期凭证。
 * - 双方id由上层注入，通道仅负责使用这些id进行握手和加密通信。如果某个设备有多个连接，实际上就有多个id
 * - 所有凭证的存储、加载、更新均由外部通过返回值/回调管理。
 * - 支持"临时会话"模式（应用层不保存返回的 Credential 即可）。
 *
 * 使用流程：
 * init -> 拥有对方id
 * 身份信任通道：tryConnect
 * 不信任通道：tryConnect -> 失败 -> pairInit获取Credential -> tryConnect
 * 不信任通道临时与持久：只要有一方没有保存Credential，连接即为临时会话，断开即失效。
 *
 * 概念：
 * - UUID：每个设备一个，作为长期身份标识。
 * - Credential：配对后生成的凭证，包含我方私钥和对方公钥，用于免密重连。
 * - PIN 码：6位数字，用户手动传递，用于初次配对时的 PAKE 握手验证。
 */
export declare class SecureChannel {
    constructor(signalAdapter: SignalingAdapter, options?: ChannelOptions);

    /**
     * 初始化通道，设置本设备身份。
     * 必须在 tryConnect 或 pairInit 之前调用。
     *
     * @param myDeviceId 本设备 UUID
     * @param remoteId 可选的远程设备 UUID
     */
    init(myDeviceId: string, remoteId?: string): Promise<void>;

    /**
     * 主动断开连接并清理会话密钥。
     * 通道实例随后可丢弃，不会影响已保存的凭证。
     */
    disconnect(): void;

    // ================= 连接 =================

    /**
     * 尝试使用已保存的凭证建立安全连接。
     *
     * 应用层应从本地安全存储中读取此前保存的 `Credential`，调用此方法。
     * 内部将使用该凭证与对方执行基于长期密钥的握手（如 Noise IK）。
     *
     * @returns 若成功，返回 `{ success: true, credential }`，其中 credential 可能更新了 lastConnected；
     *          若失败（凭证失效、对方无记录等），返回 `{ success: false }`，需重新走配对流程。
     */
    tryConnect(credential?: CredentialPrivateInfo): Promise<ConnectResult>;

    // ================= 初次配对（需用户传递 PIN） =================

    /**
     * 预生成 PIN，可在 pairInit 之前调用以提前展示给用户。
     * 重复调用会重新生成 PIN。
     * @returns 6 位数字 PIN
     */
    updatePIN(): string;

    /**
     * 在需要身份验证的信道中进行配对，通过 PIN，完成基于 PAKE 的握手，只需要一方输入 PIN。
     */
    pairInit(credential: CredentialPublicInfo): Promise<{
        /** 展示给用户的 6 位数字 PIN，需要用户输入到另一端 */
        pin: string;
        /** 用户输入对方的 PIN */
        inputOtherPin: (pin: string) => void;
        /** 等待配对完成 */
        waitForPairing: () => Promise<Credential>;
    }>;

    // ================= 数据收发（安全通道建立后） =================

    /**
     * 发送加密数据（任意可序列化对象）。
     * @throws {ChannelNotReadyError} 若安全通道尚未就绪（未调用成功配对/重连）
     */
    send(payload: string): Promise<void>;

    /**
     * 发送二进制数据（高效）。
     * @throws {ChannelNotReadyError}
     */
    sendBinary(data: ArrayBuffer | Uint8Array): Promise<void>;

    // ================= 事件订阅 =================

    /**
     * 监听通道事件。
     * @param event 事件名
     * @param callback 回调函数
     */
    on(event: "ready", callback: () => void): void;
    on(event: "message", callback: (payload: string) => void): void;
    on(event: "binary", callback: (data: ArrayBuffer) => void): void;
    on(event: "disconnect", callback: () => void): void;
    on(event: "error", callback: (err: SecureChannelError) => void): void;
    /**
     * 收到配对请求事件（接收方监听）。
     * 回调参数包含发起方信息，以及 inputPin/reject 函数。
     */
    on(event: "pairRequest", callback: (request: PairRequest) => void): void;
    /**
     * 收到连接请求事件（接收方监听，用于 Credential 重连）。
     * 回调参数包含发起方信息，以及 accept/reject 函数。
     */
    on(event: "connectRequest", callback: (request: ConnectRequest) => void): void;
    /**
     * 凭证轮换事件（己方或对方主动发起）。
     * 应用层应使用 `updatedCredential` 覆盖本地存储的旧凭证。
     */
    on(event: "credentialRotated", callback: (updatedCredential: Credential) => void): void;
    /**
     * 凭证失效事件（如对方撤销信任，导致我方凭证不再被接受）。
     * 应用层应删除本地对应的凭证，并提示用户重新配对。
     */
    on(event: "credentialInvalidated", callback: (remoteDeviceId: string) => void): void;

    /** 移除事件监听 */
    off(event: string, callback: Function): void;

    // ================= 主动凭证管理 =================

    /**
     * 主动轮换我方长期凭证（生成新密钥对并与对方交换）。
     * 完成后会触发 `credentialRotated` 事件，应用层应保存新凭证。
     *
     * 仅在通道处于 `ready` 状态时可调用。
     */
    rotateCredential(): Promise<void>;
}

// ================= 相关类型定义 =================

/**
 * 信令适配器接口：由上层实现，用于在双方之间传递握手消息。
 * 例如：基于 PeerJS DataConnection、WebSocket 等。
 *
 * 类型逻辑：
 * - trustIdentity=true：外部已验证身份（如物理信道），算法上不验证，不加密，supportNativeEncryption 固定为 false
 * - trustIdentity=false：需要内部 PAKE 验证，验证后可选加密
 */
type SignalingAdapter = TrustedSignalingAdapter | UntrustedSignalingAdapter;

/** 受信任的信令适配器（物理信道等），外部已验证身份，不加密 */
interface TrustedSignalingAdapter {
    trustIdentity: true;
    /** 受信任信道不使用加密，固定为 false */
    supportNativeEncryption: false;
    init(myId: string): Promise<void>;
    connect(id: string): Promise<void>;
    send(data: Uint8Array): Promise<void>;
    close(): void;
    onMessage: (handler: (data: Uint8Array) => void) => void;
    onClose: (handler: () => void) => void;
    onError: (handler: (err: Error) => void) => void;
}

/** 不受信任的信令适配器（网络信道等），需要内部 PAKE 验证，可选加密 */
interface UntrustedSignalingAdapter {
    trustIdentity: false;
    /** PAKE 验证后是否启用应用层加密（如 Noise） */
    supportNativeEncryption: boolean;
    init(myId: string): Promise<void>;
    connect(id: string): Promise<void>;
    send(data: Uint8Array): Promise<void>;
    close(): void;
    onMessage: (handler: (data: Uint8Array) => void) => void;
    onClose: (handler: () => void) => void;
    onError: (handler: (err: Error) => void) => void;
}

/** 配对请求信息（接收方通过 pairRequest 事件获取） */
interface PairRequest {
    /** 发起方的设备 ID */
    remoteDeviceId: string;
    /** 发起方的显示名称（可选） */
    remoteDisplayName?: string;
    /** 输入对方的 PIN（触发 PAKE 交换） */
    inputOtherPin: (pin: string) => void;
    /** 等待配对完成 */
    waitForPairing: () => Promise<Credential>;
    /** 拒绝配对请求 */
    reject: () => void;
}

/** 连接请求信息（接收方通过 connectRequest 事件获取，用于 Credential 重连） */
interface ConnectRequest {
    /** 发起方的设备 ID */
    remoteDeviceId: string;
    /** 发起方的显示名称（可选） */
    remoteDisplayName?: string;
    /** 接受连接请求，传入本地保存的关于对方的 Credential */
    accept: (credential: Credential) => Promise<ConnectResult>;
    /** 拒绝连接请求 */
    reject: () => void;
}

/** 通道配置选项 */
interface ChannelOptions {
    /** 连接请求超时时间（毫秒），默认 30000 */
    connectTimeout?: number;
    /** 配对超时时间（毫秒），默认 60000（PIN 输入需要更多时间） */
    pairingTimeout?: number;
    /** 握手超时时间（毫秒），默认 30000 */
    handshakeTimeout?: number;
    /** 允许的最大 PIN 错误尝试次数，默认 5，超出后自动断开并触发 error 事件 */
    maxPinAttempts?: number;
    /** 配对请求间隔限制（毫秒），默认 1000 */
    pairInterval?: number;
    /** 连接请求间隔限制（毫秒），默认 20 */
    connectInterval?: number;
}

interface CredentialPublicInfo {
    /** 我方设备 UUID */
    myDeviceId: string;
    /** 我方可读名称（可选） */
    myDisplayName?: string;
    /** 对方设备 UUID */
    remoteDeviceId: string;
    /** 对方可读名称（可选） */
    remoteDisplayName?: string;
}

interface CredentialPrivateInfo {
    /** 我方长期私钥（格式取决于底层实现，可能为 CryptoKey 或 Uint8Array） */
    myPrivateKey: Uint8Array; // todo 使用 Web Crypto API
    /** 我方长期公钥（用于对方验证我方身份） */
    myPublicKey: Uint8Array;
    /** 对方长期公钥（用于验证对方身份） */
    remotePublicKey: Uint8Array;
    /** 凭证创建时间戳（毫秒） */
    createdAt: number;
}

/**
 * 配对后生成的完整凭证。
 * 应用层负责安全存储（例如存入系统 Keychain 或 Web Crypto 不可提取密钥）。
 * 私钥部分（myPrivateKey）绝不应离开本地设备。
 */
interface Credential extends CredentialPublicInfo, CredentialPrivateInfo {
    /** 上次成功连接时间戳（毫秒），用于 UI 排序 */
    lastConnected?: number;
}

/** `tryConnect` 返回的结果类型 */
interface ConnectSuccess {
    success: true;
    /** 重连成功，可能更新了 lastConnected 等字段的凭证 */
    credential: Credential;
}

interface ConnectFailed {
    success: false;
}

interface ConnectNeedsPairing {
    success: false;
    reason: "NEEDS_PAIRING";
}

type ConnectResult = ConnectSuccess | ConnectFailed | ConnectNeedsPairing;

// ================= 状态类型 =================

/** 通道状态 */
type ChannelState = "Idle" | "Ready" | "Handshaking" | "Connected";

/** 握手类型 */
type HandshakeType = "pake" | "ik" | "connect-request" | "connect-response" | null;

// ================= 错误类型 =================

/** 安全通道相关错误的基类 */
declare class SConnectError extends Error {
    code: ErrorCode;
    recoverable: boolean;
}

type ErrorCode =
    // 配对错误
    | "PIN_INVALID"
    | "PIN_MISMATCH"
    | "PAKE_FAILED"
    // 连接错误
    | "TIMEOUT"
    | "ADAPTER_ERROR"
    | "PEER_DISCONNECTED"
    // 验证错误
    | "CREDENTIAL_INVALID"
    | "CREDENTIAL_EXPIRED"
    | "IK_HANDSHAKE_FAILED"
    // 状态错误
    | "NOT_INITIALIZED"
    | "ALREADY_CONNECTING"
    | "CHANNEL_NOT_READY"
    // 对端错误
    | "UNEXPECTED_MESSAGE"
    | "NOT_CONNECTED"
    | "ALREADY_CONNECTED"
    // 致命错误
    | "ADAPTER_INIT_FAILED"
    | "CRYPTO_UNAVAILABLE";
