# @myde/spake

ESM 版本的 SPAKE2 协议实现，可在浏览器和 Node.js 环境中运行。

## 参考来源

本模块基于以下项目重写：

- **原始项目**: [spake2-js](https://gitlab.com/blocksq/spake2-js) by [Samuel Tang](https://gitlab.com/samueltangz)
- **协议规范**: [draft-irtf-cfrg-spake2-08](https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-spake2-08)
- **密码学基础**: 
  - 椭圆曲线: Ed25519 (Curve25519)
  - 哈希函数: SHA-256
  - 密钥派生: HKDF-SHA256
  - 内存硬哈希: PBKDF2 (替代 scrypt，用于浏览器兼容)

## 主要改动

与原始 `spake2` 模块相比，本模块做了以下改动：

1. **ESM 模块化**: 使用 ES Module 语法，支持 tree-shaking
2. **浏览器兼容**: 使用 Web Crypto API 替代 Node.js `crypto` 模块
3. **Uint8Array**: 使用 `Uint8Array` 替代 `Buffer`，提高跨平台兼容性
4. **异步 API**: 所有密码学操作都是异步的，支持非阻塞执行

## 安装

本模块已包含在 `@myde/remote-connect` 中，无需单独安装。

如需单独使用，可将 `spake` 文件夹复制到项目中，并安装依赖：

```bash
npm install bn.js elliptic
```

## 使用方法

```typescript
import { spake2 } from "./spake/index";

// 创建 SPAKE2 实例
const spake = spake2({
    mhf: { n: 1024, r: 8, p: 16 },  // scrypt 参数
    kdf: { AAD: "my-app" },           // KDF 附加数据
});

// 客户端
const clientState = await spake.startClient(
    "client-id",      // 客户端身份
    "server-id",      // 服务器身份
    "password123",    // 密码（PIN）
    "salt-value"      // 盐值
);

// 服务器端
const verifier = await spake.computeVerifier(
    "password123",    // 密码（与客户端相同）
    "salt-value",     // 盐值（与客户端相同）
    "client-id",      // 客户端身份
    "server-id"       // 服务器身份
);

const serverState = await spake.startServer(
    "client-id",      // 客户端身份
    "server-id",      // 服务器身份
    verifier          // 验证器
);

// 交换消息
const clientMsg = clientState.getMessage();
const serverMsg = serverState.getMessage();

// 完成密钥交换
const clientSecret = await clientState.finish(serverMsg);
const serverSecret = await serverState.finish(clientMsg);

// 获取共享密钥
const clientKey = clientSecret.toBuffer();  // Uint8Array
const serverKey = serverSecret.toBuffer();  // Uint8Array
// clientKey === serverKey
```

## API

### `spake2(options?)`

创建 SPAKE2 实例。

**参数:**
- `options.mhf`: 内存硬哈希参数 `{ n: number, r: number, p: number }`
- `options.kdf`: KDF 参数 `{ AAD: string }`

**返回:** `SPAKE2` 实例

### `SPAKE2.startClient(clientIdentity, serverIdentity, password, salt)`

创建客户端状态。

**参数:**
- `clientIdentity`: 客户端身份标识
- `serverIdentity`: 服务器身份标识
- `password`: 密码（PIN）
- `salt`: 盐值

**返回:** `Promise<ClientState>`

### `SPAKE2.startServer(clientIdentity, serverIdentity, verifier)`

创建服务器状态。

**参数:**
- `clientIdentity`: 客户端身份标识
- `serverIdentity`: 服务器身份标识
- `verifier`: 验证器（由 `computeVerifier` 生成）

**返回:** `Promise<ServerState>`

### `SPAKE2.computeVerifier(password, salt, clientIdentity, serverIdentity)`

计算验证器。

**参数:**
- `password`: 密码
- `salt`: 盐值
- `clientIdentity`: 客户端身份标识
- `serverIdentity`: 服务器身份标识

**返回:** `Promise<Uint8Array>`

### `ClientState` / `ServerState`

#### `getMessage()`

生成握手消息。

**返回:** `Uint8Array`

#### `finish(incomingMessage)`

完成密钥交换。

**参数:**
- `incomingMessage`: 对方的握手消息

**返回:** `Promise<SharedSecret>`

### `SharedSecret`

#### `toBuffer()`

获取共享密钥。

**返回:** `Uint8Array`

#### `getConfirmation()`

获取确认消息。

**返回:** `Promise<Uint8Array>`

#### `verify(incomingConfirmation)`

验证对方的确认消息。

**参数:**
- `incomingConfirmation`: 对方的确认消息

**返回:** `Promise<void>`

## 安全注意事项

- 本实现未经正式密码学审计，请谨慎使用
- PBKDF2 替代 scrypt 会降低暴力破解的难度，建议在生产环境中使用完整的 scrypt 实现
- 密码（PIN）不应直接传输，应通过安全信道交换

## 许可证

AGPL-3.0-only
