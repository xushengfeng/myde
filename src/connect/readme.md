# 远程连接协议

利用`myde-remote-connect`库实现配对和端到端加密通信。这个文件夹旨在创建定义相关通信协议和方便使用的api

下面文本都是utf-8

头包为`[32包长][文本协议]`

文本协议首行规定后续协议使用的相关解析方式，默认为`myde-protocol-0.0.1`

## myde-protocol-0.0.1 定义如下：

下面表示长度的都是32位，内容都是小段序

`[总包长][json长][json文本][二进制长][二进制][第二个二进制长][二进制]`

二进制是为了补充json不足而有的，个数可选，看各个方法约定

不区分主从

现在在代码中添加从a节点到b节点的发送，在json中`_`记录相关数据。后面还有用一对多、多对一等方法，应用层添加回调等

其他详细协议开发中

## 持久化

`Connect` 通过 `ConnectStorage` 保存本机 id、连接配置和配对凭据：

```ts
interface ConnectStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
```

- 桌面环境直接把 `localStorage` 作为 `storage` 传入。
- node 测试可使用 `FileConnectStorage(path)`，内容为明文 JSON key-value，仅用于测试或受信任环境。
- 不传 `storage` 时使用进程内实现，重启后不保留。

本机 id 由 `Connect` 内部管理：存储中没有时自动生成并保存，可通过 `getId()` 读取，`refreshId()` 重新生成。刷新 id 要求当前没有活动连接。

## 临时连接与记忆

`startPairing({ remember })`、`startPairing().connect(remoteId, { remember })` 和 `connect2({ targetId, remember })` 都可以选择是否持久化：

- `remember: true`（默认）：连接配置和配对凭据写入存储，重启后可免 PIN 重连。
- `remember: false`：只在当前进程内有效，重启后消失。

已有连接可通过 `setRemember(targetId, remember)` 调整。

## 桌面侧接口

`Connect` 提供类似 NetworkManager 的查询和操作：

```ts
const connect = myde.MConnect();
await connect.init();

const id = connect.getId();
const saved = connect.getSavedConnections();
const active = connect.getActiveConnections();
const all = connect.getConnections();
const map = connect.getGlobalMap();

await connect.connect("peer-device-id");
await connect.disconnect("peer-device-id");
connect.removeConnection("peer-device-id");

const pairing = await connect.startPairing();
// pairing.pin 展示给对端；这里输入对端展示的 PIN
const result = await pairing.connect("peer-device-id", { remember: true });
result.inputOtherPin(remotePin);
await result.waitForPair();
```

事件通过 `EventEmitter` 提供：`connection-added`、`connection-removed`、`connection-changed`、`connected`、`disconnected`、`id-changed`、`error`。
