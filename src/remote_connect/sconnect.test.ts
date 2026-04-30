import { describe, it, expect } from "vitest";
import { SConnect } from "./sconnect";
import { LoopbackAdapter, UntrustedLoopbackAdapter } from "./loopback_adapter";

function waitForEvent<T>(
    emitter: { on: (event: string, cb: (arg: T) => void) => void },
    event: string,
    timeout = 5000,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeout);
        emitter.on(event, (arg: T) => {
            clearTimeout(timer);
            resolve(arg);
        });
    });
}

describe("SConnect", () => {
    describe("init", () => {
        it("应返回本设备公钥", async () => {
            const [adapterA] = LoopbackAdapter.createPair();
            const channelA = new SConnect(adapterA);

            const publicKey = await channelA.init("device-a");

            expect(publicKey).toBeInstanceOf(Uint8Array);
            expect(publicKey.length).toBeGreaterThan(0);

            channelA.disconnect();
        });

        it("应支持传入自定义密钥对", async () => {
            const [adapterA] = LoopbackAdapter.createPair();
            const channelA = new SConnect(adapterA);

            // 生成一个密钥对
            const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" } as AlgorithmIdentifier, true, [
                "sign",
                "verify",
            ]);
            const publicKey = new Uint8Array(
                await crypto.subtle.exportKey("raw", (keyPair as CryptoKeyPair).publicKey),
            );
            const privateKey = new Uint8Array(
                await crypto.subtle.exportKey("pkcs8", (keyPair as CryptoKeyPair).privateKey),
            );

            const returnedPublicKey = await channelA.init("device-a", {
                publicKey,
                privateKey,
            });

            expect(returnedPublicKey).toEqual(publicKey);

            channelA.disconnect();
        });
    });

    describe("受信任信道 (trustIdentity=true)", () => {
        it("应直接建立明文连接", async () => {
            const [adapterA, adapterB] = LoopbackAdapter.createPair();
            const channelA = new SConnect(adapterA);
            const channelB = new SConnect(adapterB);

            await channelA.init("device-a");
            await channelB.init("device-b");

            const [resultA, resultB] = await Promise.all([
                channelA.tryConnect({
                    myDeviceId: "device-a",
                    remoteDeviceId: "device-b",
                }),
                channelB.tryConnect({
                    myDeviceId: "device-b",
                    remoteDeviceId: "device-a",
                }),
            ]);

            expect(resultA.success).toBe(true);
            expect(resultB.success).toBe(true);

            channelA.disconnect();
            channelB.disconnect();
        });

        it("消息应为明文（不加密）", async () => {
            const [adapterA, adapterB] = LoopbackAdapter.createPair();
            const channelA = new SConnect(adapterA);
            const channelB = new SConnect(adapterB);

            await channelA.init("device-a");
            await channelB.init("device-b");

            let rawSentData: Uint8Array | null = null;
            const originalSend = adapterA.send.bind(adapterA);
            adapterA.send = async (data: Uint8Array) => {
                rawSentData = new Uint8Array(data);
                return originalSend(data);
            };

            const receivedMessages: string[] = [];
            channelB.on("message", (msg) => receivedMessages.push(msg));

            await Promise.all([
                channelA.tryConnect({
                    myDeviceId: "device-a",
                    remoteDeviceId: "device-b",
                }),
                channelB.tryConnect({
                    myDeviceId: "device-b",
                    remoteDeviceId: "device-a",
                }),
            ]);

            const testMessage = "plaintext hello";
            await channelA.send(testMessage);
            await new Promise((r) => setTimeout(r, 50));

            expect(rawSentData).not.toBeNull();
            expect(new TextDecoder().decode(rawSentData)).toBe(testMessage);
            expect(receivedMessages).toContain(testMessage);

            channelA.disconnect();
            channelB.disconnect();
        });
    });

    describe("不受信任信道 - PAKE 配对 (trustIdentity=false)", () => {
        it("无凭证时应返回 NEEDS_PAIRING", async () => {
            const [adapterA, adapterB] = UntrustedLoopbackAdapter.createPair();
            const channelA = new SConnect(adapterA);

            await channelA.init("device-a");

            const result = await channelA.tryConnect({
                myDeviceId: "device-a",
                remoteDeviceId: "device-b",
            });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.reason).toBe("NEEDS_PAIRING");
            }

            channelA.disconnect();
            adapterB.close();
        });

        it("PAKE 配对后应能收发消息（单边输入 PIN）", async () => {
            const [adapterA, adapterB] = UntrustedLoopbackAdapter.createPair();
            const channelA = new SConnect(adapterA, { handshakeTimeout: 10000 });
            const channelB = new SConnect(adapterB, { handshakeTimeout: 10000 });

            await channelA.init("device-a");
            await channelB.init("device-b");

            const receivedMessages: string[] = [];
            channelB.on("message", (msg) => receivedMessages.push(msg));

            // 双方都调用 pairInit
            const pairingA = channelA.pairInit({
                myDeviceId: "device-a",
                remoteDeviceId: "device-b",
            });
            const pairingB = channelB.pairInit({
                myDeviceId: "device-b",
                remoteDeviceId: "device-a",
            });

            // 只有 device-a 输入 device-b 的 PIN（单边输入）
            pairingA.inputOtherPin(pairingB.pin);

            // 双方都等待配对完成
            await Promise.all([pairingA.waitForPairing(), pairingB.waitForPairing()]);

            await channelA.send("encrypted hello");
            await new Promise((r) => setTimeout(r, 100));

            expect(receivedMessages).toContain("encrypted hello");

            channelA.disconnect();
            channelB.disconnect();
        });

        it("supportNativeEncryption=false 时消息应被加密", async () => {
            const [adapterA, adapterB] = UntrustedLoopbackAdapter.createPair(false);
            const channelA = new SConnect(adapterA, { handshakeTimeout: 10000 });
            const channelB = new SConnect(adapterB, { handshakeTimeout: 10000 });

            await channelA.init("device-a");
            await channelB.init("device-b");

            let rawSentData: Uint8Array | null = null;
            const originalSend = adapterA.send.bind(adapterA);
            adapterA.send = async (data: Uint8Array) => {
                rawSentData = new Uint8Array(data);
                return originalSend(data);
            };

            const pairingA = channelA.pairInit({
                myDeviceId: "device-a",
                remoteDeviceId: "device-b",
            });
            const pairingB = channelB.pairInit({
                myDeviceId: "device-b",
                remoteDeviceId: "device-a",
            });

            // 只有 device-a 输入 PIN
            pairingA.inputOtherPin(pairingB.pin);

            await Promise.all([pairingA.waitForPairing(), pairingB.waitForPairing()]);

            const testMessage = "should be encrypted";
            await channelA.send(testMessage);
            await new Promise((r) => setTimeout(r, 100));

            expect(rawSentData).not.toBeNull();
            expect(new TextDecoder().decode(rawSentData)).not.toBe(testMessage);

            channelA.disconnect();
            channelB.disconnect();
        });

        it("supportNativeEncryption=true 时不加密", async () => {
            const [adapterA, adapterB] = UntrustedLoopbackAdapter.createPair(true);
            const channelA = new SConnect(adapterA, { handshakeTimeout: 10000 });
            const channelB = new SConnect(adapterB, { handshakeTimeout: 10000 });

            await channelA.init("device-a");
            await channelB.init("device-b");

            let rawSentData: Uint8Array | null = null;
            const originalSend = adapterA.send.bind(adapterA);
            adapterA.send = async (data: Uint8Array) => {
                rawSentData = new Uint8Array(data);
                return originalSend(data);
            };

            const receivedMessages: string[] = [];
            channelB.on("message", (msg) => receivedMessages.push(msg));

            const pairingA = channelA.pairInit({
                myDeviceId: "device-a",
                remoteDeviceId: "device-b",
            });
            const pairingB = channelB.pairInit({
                myDeviceId: "device-b",
                remoteDeviceId: "device-a",
            });

            // 只有 device-a 输入 PIN
            pairingA.inputOtherPin(pairingB.pin);

            await Promise.all([pairingA.waitForPairing(), pairingB.waitForPairing()]);

            const testMessage = "native encrypted";
            await channelA.send(testMessage);
            await new Promise((r) => setTimeout(r, 100));

            expect(rawSentData).not.toBeNull();
            expect(new TextDecoder().decode(rawSentData)).toBe(testMessage);
            expect(receivedMessages).toContain(testMessage);

            channelA.disconnect();
            channelB.disconnect();
        });
    });

    describe("不受信任信道 - Credential 重连", () => {
        it("有 Credential 时 IK 握手成功应返回 success=true", async () => {
            // 第一次配对
            const [adapterA1, adapterB1] = UntrustedLoopbackAdapter.createPair();
            const channelA1 = new SConnect(adapterA1, { handshakeTimeout: 10000 });
            const channelB1 = new SConnect(adapterB1, { handshakeTimeout: 10000 });

            await channelA1.init("device-a");
            await channelB1.init("device-b");

            const pairingA = channelA1.pairInit({
                myDeviceId: "device-a",
                remoteDeviceId: "device-b",
            });
            const pairingB = channelB1.pairInit({
                myDeviceId: "device-b",
                remoteDeviceId: "device-a",
            });

            // 只有 device-a 输入 PIN
            pairingA.inputOtherPin(pairingB.pin);

            const credentialA = await pairingA.waitForPairing();
            const credentialB = await pairingB.waitForPairing();

            // 验证 Credential 包含公钥
            expect(credentialA.myPublicKey).toBeInstanceOf(Uint8Array);
            expect(credentialA.myPublicKey.length).toBeGreaterThan(0);
            expect(credentialA.remotePublicKey).toBeInstanceOf(Uint8Array);
            expect(credentialA.remotePublicKey.length).toBeGreaterThan(0);

            channelA1.disconnect();
            channelB1.disconnect();

            // 第二次重连
            const [adapterA2, adapterB2] = UntrustedLoopbackAdapter.createPair();
            const channelA2 = new SConnect(adapterA2, { handshakeTimeout: 10000 });
            const channelB2 = new SConnect(adapterB2, { handshakeTimeout: 10000 });

            // 用配对时的密钥初始化
            await channelA2.init("device-a", {
                privateKey: credentialA.myPrivateKey as Uint8Array,
                publicKey: credentialA.myPublicKey,
            });
            await channelB2.init("device-b", {
                privateKey: credentialB.myPrivateKey as Uint8Array,
                publicKey: credentialB.myPublicKey,
            });

            // device-a < device-b，所以 device-a 是发起方，device-b 是响应方
            // 响应方先开始等待
            const resultBPromise = channelB2.tryConnect(credentialB);
            // 等一下让响应方先设置好消息处理器
            await new Promise((r) => setTimeout(r, 10));
            // 发起方发起握手
            const resultA = await channelA2.tryConnect(credentialA);
            const resultB = await resultBPromise;

            expect(resultA.success).toBe(true);
            expect(resultB.success).toBe(true);

            channelA2.disconnect();
            channelB2.disconnect();
        });
    });

    describe("事件系统", () => {
        it("应触发 ready 和 disconnect 事件", async () => {
            const [adapterA, adapterB] = LoopbackAdapter.createPair();
            const channelA = new SConnect(adapterA);
            const channelB = new SConnect(adapterB);

            await channelA.init("device-a");
            await channelB.init("device-b");

            const readyPromise = waitForEvent(channelA, "ready");

            await Promise.all([
                channelA.tryConnect({
                    myDeviceId: "device-a",
                    remoteDeviceId: "device-b",
                }),
                channelB.tryConnect({
                    myDeviceId: "device-b",
                    remoteDeviceId: "device-a",
                }),
            ]);

            await readyPromise;

            const disconnectPromise = waitForEvent(channelB, "disconnect");
            channelA.disconnect();
            await disconnectPromise;

            channelB.disconnect();
        });
    });

    describe("二进制数据传输", () => {
        it("应支持发送和接收二进制数据", async () => {
            const [adapterA, adapterB] = LoopbackAdapter.createPair();
            const channelA = new SConnect(adapterA);
            const channelB = new SConnect(adapterB);

            await channelA.init("device-a");
            await channelB.init("device-b");

            const receivedData: ArrayBuffer[] = [];
            channelB.on("binary", (data) => receivedData.push(data));

            await Promise.all([
                channelA.tryConnect({
                    myDeviceId: "device-a",
                    remoteDeviceId: "device-b",
                }),
                channelB.tryConnect({
                    myDeviceId: "device-b",
                    remoteDeviceId: "device-a",
                }),
            ]);

            const testData = new Uint8Array([1, 2, 3, 4, 5]);
            await channelA.sendBinary(testData);
            await new Promise((r) => setTimeout(r, 100));

            expect(receivedData.length).toBe(1);
            expect(new Uint8Array(receivedData[0])).toEqual(testData);

            channelA.disconnect();
            channelB.disconnect();
        });
    });
});

// TODO: 安全性验证
// - 验证 Noise IK 握手的前向安全性
// - 验证 SPAKE2 协议的正确性（PIN 错误时应拒绝连接）
// - 验证会话密钥的隔离性（不同会话使用不同密钥）
// - 验证重放攻击防护
// - 验证中间人攻击防护
// - 验证凭证轮换的正确性
