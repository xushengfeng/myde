/**
 * 端到端加密通信通道
 *
 * 设计原则：
 * - 通道本身无状态，不持有任何长期凭证。
 * - 所有凭证的存储、加载、更新均由外部通过返回值/回调管理。
 * - 支持“临时会话”模式（应用层不保存返回的 Credential 即可）。
 *
 * 概念：
 * - UUID：每个设备一个，作为长期身份标识。
 * - Credential：配对后生成的凭证，包含我方私钥和对方公钥，用于免密重连。
 * - PIN 码：6位数字，用户手动传递，用于初次配对时的 PAKE 握手验证。
 */
export declare class SecureChannel {
    /**
     * 构造一个新的安全通道实例。
     * @param signalAdapter 信令适配器（由上层注入，如 PeerJS DataConnection）
     * @param options 可选配置
     */
    constructor(signalAdapter: SignalingAdapter, options?: ChannelOptions);

    /**
     * 主动断开连接并清理会话密钥。
     * 通道实例随后可丢弃，不会影响已保存的凭证。
     */
    disconnect(): void;

    // ================= 重连（免密） =================

    /**
     * 尝试使用已保存的凭证建立安全连接。
     *
     * 应用层应从本地安全存储中读取此前保存的 `Credential`，调用此方法。
     * 内部将使用该凭证与对方执行基于长期密钥的握手（如 Noise IK）。
     *
     * @param credential 我方为此设备保存的完整凭证（包含私钥）
     * @returns 若成功，返回 `{ success: true, credential }`，其中 credential 可能更新了 lastConnected；
     *          若失败（凭证失效、对方无记录等），返回 `{ success: false }`，需重新走配对流程。
     */
    tryConnect(credential: Credential): Promise<ConnectResult>;

    // ================= 初次配对（需用户传递 PIN） =================

    /**
     * 【发起方】开始配对：生成随机 PIN 并立即返回，同时内部开始等待对方连接。
     *
     * 调用此方法后，应立即将返回的 `pin` 展示给用户，并随后调用 `waitForPairing()` 等待配对完成。
     *
     * @returns 包含展示给用户的 PIN 和等待配对完成的 Promise 函数。
     */
    pairAsInitiator(): { pin: string; waitForPairing: () => Promise<Credential> };

    /**
     * 【接收方】使用对方提供的 PIN 完成配对。
     *
     * @param pin 用户从发起方获取并输入的 6 位数字 PIN
     * @returns 完成配对后的凭证，应用层应安全保存以备后续 `tryConnect` 使用。
     * @throws {InvalidPINFormatError} PIN 格式不正确
     * @throws {PairingFailedError} PIN 错误或遭受中间人攻击
     */
    pairAsReceiver(pin: string): Promise<Credential>;

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

    /**
     * 获取当前连接的远程设备信息（来自握手阶段交换的元数据）。
     * 若通道未建立，返回 `null`。
     */
    getRemoteDeviceInfo(): RemoteDeviceInfo | null;
}

// ================= 相关类型定义 =================

/**
 * 信令适配器接口：由上层实现，用于在双方之间传递握手消息。
 * 例如：基于 PeerJS DataConnection、WebSocket 等。
 */
interface SignalingAdapter {
    /** 发送原始二进制数据到对方 */
    send(data: Uint8Array): Promise<void>;
    /** 注册消息接收回调 */
    onMessage: (handler: (data: Uint8Array) => void) => void;
    /** 注册连接关闭回调 */
    onClose: (handler: () => void) => void;
    /** 注册错误回调 */
    onError: (handler: (err: Error) => void) => void;
}

/** 通道配置选项 */
interface ChannelOptions {
    /** 握手超时时间（毫秒），默认 30000 */
    handshakeTimeout?: number;
    /** 允许的最大 PIN 错误尝试次数，默认 5，超出后自动断开并触发 error 事件 */
    maxPinAttempts?: number;
}

/**
 * 配对后生成的完整凭证。
 * 应用层负责安全存储（例如存入系统 Keychain 或 Web Crypto 不可提取密钥）。
 * 私钥部分（myPrivateKey）绝不应离开本地设备。
 */
interface Credential {
    /** 我方设备 UUID */
    myDeviceId: string;
    /** 我方长期私钥（格式取决于底层实现，可能为 CryptoKey 或 Uint8Array） */
    myPrivateKey: CryptoKey | Uint8Array;
    /** 对方设备 UUID */
    remoteDeviceId: string;
    /** 对方长期公钥 */
    remotePublicKey: Uint8Array;
    /** 对方可读名称（可选） */
    remoteDisplayName?: string;
    /** 凭证创建时间戳（毫秒） */
    createdAt: number;
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

type ConnectResult = ConnectSuccess | ConnectFailed;

/** 当前连接的远程设备实时信息 */
interface RemoteDeviceInfo {
    deviceId: string;
    displayName?: string;
    /** 本次连接是否为重连（而非初次 PIN 配对） */
    isReconnect: boolean;
}

// ================= 错误类型 =================

/** 安全通道相关错误的基类 */
declare class SecureChannelError extends Error {
    code:
        | "PIN_INVALID"
        | "HANDSHAKE_FAILED"
        | "CHANNEL_NOT_READY"
        | "RECONNECT_FAILED"
        | "CREDENTIAL_ROTATION_FAILED"
        | "PAIRING_FAILED";
}

declare class InvalidPINFormatError extends SecureChannelError {}
declare class HandshakeFailedError extends SecureChannelError {}
declare class ChannelNotReadyError extends SecureChannelError {}
declare class ReconnectFailedError extends SecureChannelError {}
declare class PairingFailedError extends SecureChannelError {}
