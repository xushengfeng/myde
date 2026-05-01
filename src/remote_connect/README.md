# @myde/remote-connect

安全远程连接模块，支持 PAKE 配对和 Noise IK 握手。

## 功能特性

- **端到端加密**: 使用 Noise IK 协议建立安全通道
- **PAKE 配对**: 基于 SPAKE2 协议的 PIN 码配对
- **凭证管理**: 支持凭证保存和重连
- **多种适配器**: 支持 PeerJS (WebRTC)、本地回环等
- **浏览器兼容**: 纯 ESM 模块，无 Node.js 依赖

## 快速开始

### 1. 受信任信道（如本地 IPC）

```typescript
import { SConnect } from "@myde/remote-connect/sconnect";
import { LoopbackAdapter } from "@myde/remote_connect/loopback_adapter";

// 创建适配器对
const [adapterA, adapterB] = LoopbackAdapter.createPair();

// 创建通道实例
const channelA = new SConnect(adapterA);
const channelB = new SConnect(adapterB);

// 初始化设备身份
await channelA.init("device-a");
await channelB.init("device-b");

// 建立连接
const result = await channelA.tryConnect({
    myDeviceId: "device-a",
    remoteDeviceId: "device-b",
});

if (result.success) {
    // 发送消息
    await channelA.send("Hello, Device B!");

    // 接收消息
    channelB.on("message", (payload) => {
        console.log("Received:", payload);
    });
}
```

### 2. 不受信任信道（如网络）- PAKE 配对

```typescript
import { SConnect } from "@myde/remote-connect/sconnect";
import { UntrustedLoopbackAdapter } from "@myde/remote_connect/loopback_adapter";

// 创建适配器对
const [adapterA, adapterB] = UntrustedLoopbackAdapter.createPair();

// 创建通道实例
const channelA = new SConnect(adapterA, { handshakeTimeout: 10000 });
const channelB = new SConnect(adapterB, { handshakeTimeout: 10000 });

// 初始化，id需要手动创建，建议使用crypto.randomUUID()
await channelA.init("device-a");
await channelB.init("device-b");

// ===== 接收方 B：监听配对请求 =====
channelB.on("pairRequest", async (request) => {
    console.log(`${request.remoteDeviceId} 请求配对`);

    // 用户输入对方显示的 PIN
    const pin = await getUserInput("请输入对方显示的 PIN:");

    // 接受配对
    request.inputOtherPin(pin);
    const credential = await request.waitForPairing();
    console.log("B 配对成功", credential);

    // 或者拒绝配对
    // request.reject();
});

// ===== 发起方 A：发起配对 =====
const pairing = await channelA.pairInit({
    myDeviceId: "device-a",
    remoteDeviceId: "device-b",
});

// 显示 PIN 给用户
console.log("请将此 PIN 告诉对方:", pairing.pin);

// 等待对方输入 PIN 完成配对
const credentialA = await pairing.waitForPairing();
console.log("A 配对成功", credentialA);

// 任何一方都可以输入pin

// 现在可以安全通信
await channelA.send("Secure message");
```

### 3. 使用凭证重连

```typescript
// ===== 发起方 A =====
// A 有 B 的 Credential（之前配对获得的）
const credentialOfB = loadCredential("device-b");
const result = await channelA.tryConnect(credentialOfB);
if (result.success) {
    console.log("连接成功");
}

// ===== 接收方 B =====
channelB.on("connectRequest", async (request) => {
    console.log(`${request.remoteDeviceId} 请求连接`);

    // 从本地存储加载 B 保存的关于 A 的 Credential
    const credentialOfA = loadCredential(request.remoteDeviceId);

    if (credentialOfA) {
        // 使用保存的 Credential 接受连接
        const result = await request.accept(credentialOfA);
        console.log("连接成功", result);
    } else {
        // 没有保存的凭证，拒绝
        request.reject();
    }
});
```

## API 参考

### SConnect

```typescript
class SConnect implements SecureChannel {
    constructor(signalAdapter: SignalingAdapter, options?: ChannelOptions);

    // 初始化设备身份
    init(myDeviceId: string, keyPair?: KeyPair): Promise<Uint8Array>;

    // 尝试连接
    tryConnect(credential: CredentialPublicInfo | Credential): Promise<ConnectResult>;

    // 发起方调用：发起配对请求
    pairInit(credential: CredentialPublicInfo): Promise<{
        pin: string; // 显示给用户的 PIN
        inputOtherPin: (pin: string) => void; // 可选：也可输入对方的 PIN
        waitForPairing: () => Promise<Credential>;
    }>;

    // 断开连接
    disconnect(): void;

    // 发送消息
    send(payload: string): Promise<void>;
    sendBinary(data: ArrayBuffer | Uint8Array): Promise<void>;

    // 事件监听
    on(event: "ready", callback: () => void): void;
    on(event: "message", callback: (payload: string) => void): void;
    on(event: "binary", callback: (data: ArrayBuffer) => void): void;
    on(event: "disconnect", callback: () => void): void;
    on(event: "error", callback: (err: Error) => void): void;
    on(event: "pairRequest", callback: (request: PairRequest) => void): void;
    on(event: "connectRequest", callback: (request: ConnectRequest) => void): void;
    on(event: "credentialRotated", callback: (credential: Credential) => void): void;
    on(event: "credentialInvalidated", callback: (remoteDeviceId: string) => void): void;

    off(event: string, callback: Function): void;

    // 凭证轮换
    rotateCredential(): Promise<void>;
}
```

### PairRequest

```typescript
interface PairRequest {
    /** 发起方的设备 ID */
    remoteDeviceId: string;
    /** 发起方的显示名称（可选） */
    remoteDisplayName?: string;

    /** 输入对方的 PIN 完成配对 */
    inputOtherPin: (pin: string) => Promise<Credential>;
    waitForPairing: () => Promise<Credential>;
    /** 拒绝配对请求 */
    reject: () => void;
}
```

### ConnectRequest

```typescript
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
```

### Credential

```typescript
interface Credential extends CredentialPublicInfo {
    myPrivateKey: CryptoKey | Uint8Array;
    myPublicKey: Uint8Array;
    remotePublicKey: Uint8Array;
    createdAt: number;
    lastConnected?: number;
}
```

## 内置适配器

### PeerjsAdapter

基于 PeerJS (WebRTC) 的适配器。

```typescript
import { PeerjsAdapter } from "@myde/remote-connect/peerjs_adapter";

const adapter = new PeerjsAdapter(
    { debug: 0 }, // PeerJS 选项
    true, // 是否支持原生加密（WebRTC DTLS）
);

const channel = new SConnect(adapter);
```

### LoopbackAdapter

本地回环适配器，用于测试和本地 IPC。

```typescript
const [adapterA, adapterB] = LoopbackAdapter.createPair();
```

### UntrustedLoopbackAdapter

不受信任的本地回环适配器，用于测试。

```typescript
const [adapterA, adapterB] = UntrustedLoopbackAdapter.createPair(
    supportNativeEncryption, // 是否支持原生加密，默认 true
);
```

## 安全模型

### 信道类型

| 类型     | trustIdentity | 行为                     |
| -------- | ------------- | ------------------------ |
| 受信任   | true          | 直接明文通信，不加密     |
| 不受信任 | false         | 需要 PAKE 配对，可选加密 |

### 配对流程

```
发起方 A                                    接收方 B
    │                                          │
    │  1. A 知道 B 的 ID                        │
    │                                          │
    ├─ 2. channelA.pairInit(B_ID) ────────────►│
    │     - 生成 PIN 显示给用户                  │
    │     - 发送配对请求到 B                     │
    │                                          │
    │◄────── Adapter 通知 B ──────────────────┤
    │         "A 请求配对"                       │
    │         回调提供 inputPin / reject         │
    │                                          │
    │                              3. 用户输入 PIN │
    │                                 调用 inputPin │
    │                                          │
    │  4. PAKE 握手完成                          │
    │     双方获得 Credential                    │
    │                                          │
```

### 连接流程

```
受信任信道:
  tryConnect -> 直接连接

不受信任信道（首次配对）:
  发起方: pairInit -> 生成 PIN -> 等待
  接收方: pairRequest 事件 -> inputPin -> PAKE 握手 -> Credential

不受信任信道（凭证重连）:
  发起方: tryConnect(credential) -> 发送连接请求 -> 等待
  接收方: connectRequest 事件 -> accept(credential) -> Noise IK 握手
```

### 加密策略

- `supportNativeEncryption = true`: 使用底层信道加密（如 WebRTC DTLS）
- `supportNativeEncryption = false`: 使用应用层加密（Noise/SPAKE2）

## 依赖

- `noise-handshake`: Noise IK 协议实现（嵌入）
- `bn.js`, `elliptic`: 椭圆曲线运算（嵌入）
- `peerjs`: WebRTC 信令（可选外部依赖）

## 许可证

AGPL-3.0-only
