import { describe, it, expect } from "vitest";
import { SConnect } from "./sconnect";
import { LoopbackAdapter, UntrustedLoopbackAdapter } from "./loopback_adapter";
import type { ConnectRequest, PairRequest } from "./sconnect_type";

function waitForEvent<T extends any[], E extends string>(
    emitter: { on: (event: E, cb: (...args: T) => void) => void },
    event: E,
    timeout = 5000,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeout);
        emitter.on(event, (...args: T) => {
            clearTimeout(timer);
            resolve(args);
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
            expect(new TextDecoder().decode(rawSentData!)).toBe(testMessage);
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
                // @ts-ignore
                expect(result.reason).toBe("NEEDS_PAIRING");
            }

            channelA.disconnect();
            adapterB.close();
        });

        it("发起方 pairInit 应触发接收方 pairRequest 事件", async () => {
            const [adapterA, adapterB] = UntrustedLoopbackAdapter.createPair();
            const channelA = new SConnect(adapterA, { handshakeTimeout: 10000 });
            const channelB = new SConnect(adapterB, { handshakeTimeout: 10000 });

            await channelA.init("device-a");
            await channelB.init("device-b");

            // B 监听配对请求
            const pairRequestPromise = new Promise<PairRequest>((resolve) => {
                channelB.on("pairRequest", (request) => {
                    resolve(request);
                });
            });

            // A 发起配对
            const pairingA = channelA.pairInit({
                myDeviceId: "device-a",
                remoteDeviceId: "device-b",
            });

            // 等待 B 收到配对请求
            const pairRequest = await pairRequestPromise;

            expect(pairRequest.remoteDeviceId).toBe("device-a");
            expect(typeof pairRequest.inputPin).toBe("function");
            expect(typeof pairRequest.reject).toBe("function");

            channelA.disconnect();
            channelB.disconnect();
        });

        it("完整配对流程：A 发起，B 输入 PIN", async () => {
            const [adapterA, adapterB] = UntrustedLoopbackAdapter.createPair();
            const channelA = new SConnect(adapterA, { handshakeTimeout: 10000 });
            const channelB = new SConnect(adapterB, { handshakeTimeout: 10000 });

            await channelA.init("device-a");
            await channelB.init("device-b");

            const receivedMessages: string[] = [];
            channelB.on("message", (msg) => receivedMessages.push(msg));

            // B 监听配对请求
            const pairRequestPromise = new Promise<PairRequest>((resolve) => {
                channelB.on("pairRequest", (request) => {
                    resolve(request);
                });
            });

            // A 发起配对
            const pairingA = channelA.pairInit({
                myDeviceId: "device-a",
                remoteDeviceId: "device-b",
            });

            // 等待 B 收到配对请求
            const pairRequest = await pairRequestPromise;

            // B 输入 A 的 PIN
            pairRequest.inputPin(pairingA.pin);
            const credentialBPromise = pairRequest.waitForPairing();

            // A 等待配对完成
            const credentialAPromise = pairingA.waitForPairing();

            const [credentialA, credentialB] = await Promise.all([credentialAPromise, credentialBPromise]);

            expect(credentialA).toBeDefined();
            expect(credentialB).toBeDefined();

            // 配对后应该能收发消息
            await channelA.send("hello after pairing");
            await new Promise((r) => setTimeout(r, 100));

            expect(receivedMessages).toContain("hello after pairing");

            channelA.disconnect();
            channelB.disconnect();
        });

        it("B 可以拒绝配对请求", async () => {
            const [adapterA, adapterB] = UntrustedLoopbackAdapter.createPair();
            const channelA = new SConnect(adapterA, { handshakeTimeout: 2000 });
            const channelB = new SConnect(adapterB, { handshakeTimeout: 2000 });

            await channelA.init("device-a");
            await channelB.init("device-b");

            // B 监听配对请求并拒绝
            const pairRequestPromise = new Promise<PairRequest>((resolve) => {
                channelB.on("pairRequest", (request) => {
                    resolve(request);
                });
            });

            // A 发起配对
            const pairingA = channelA.pairInit({
                myDeviceId: "device-a",
                remoteDeviceId: "device-b",
            });

            // 等待 B 收到配对请求
            const pairRequest = await pairRequestPromise;

            // B 拒绝配对 - 需要捕获 rejection
            const rejectPromise = pairRequest.waitForPairing().catch(() => {});
            pairRequest.reject();
            await rejectPromise;

            // A 的配对应该超时失败（因为 B 拒绝了，不会完成 PAKE）
            await expect(pairingA.waitForPairing()).rejects.toThrow();

            channelA.disconnect();
            channelB.disconnect();
        });

        it("PAKE 配对后消息应被加密 (supportNativeEncryption=false)", async () => {
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

            // B 监听配对请求
            const pairRequestPromise = new Promise<PairRequest>((resolve) => {
                channelB.on("pairRequest", (request) => {
                    resolve(request);
                });
            });

            // A 发起配对
            const pairingA = channelA.pairInit({
                myDeviceId: "device-a",
                remoteDeviceId: "device-b",
            });

            const pairRequest = await pairRequestPromise;
            pairRequest.inputPin(pairingA.pin);
            const credentialBPromise = pairRequest.waitForPairing();
            const credentialAPromise = pairingA.waitForPairing();

            await Promise.all([credentialAPromise, credentialBPromise]);

            const testMessage = "should be encrypted";
            await channelA.send(testMessage);
            await new Promise((r) => setTimeout(r, 100));

            expect(rawSentData).not.toBeNull();
            expect(new TextDecoder().decode(rawSentData!)).not.toBe(testMessage);

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

            // B 监听配对请求
            const pairRequestPromise = new Promise<PairRequest>((resolve) => {
                channelB.on("pairRequest", (request) => {
                    resolve(request);
                });
            });

            // A 发起配对
            const pairingA = channelA.pairInit({
                myDeviceId: "device-a",
                remoteDeviceId: "device-b",
            });

            const pairRequest = await pairRequestPromise;
            pairRequest.inputPin(pairingA.pin);
            const credentialBPromise = pairRequest.waitForPairing();
            const credentialAPromise = pairingA.waitForPairing();

            await Promise.all([credentialAPromise, credentialBPromise]);

            const testMessage = "native encrypted";
            await channelA.send(testMessage);
            await new Promise((r) => setTimeout(r, 100));

            expect(rawSentData).not.toBeNull();
            expect(new TextDecoder().decode(rawSentData!)).toBe(testMessage);
            expect(receivedMessages).toContain(testMessage);

            channelA.disconnect();
            channelB.disconnect();
        });

        it("旧模式：双方都调用 pairInit，一方输入 PIN", async () => {
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

            // B 先开始等待（设置为响应方）
            const promiseB = pairingB.waitForPairing();
            await new Promise((r) => setTimeout(r, 50));

            // A 输入 B 的 PIN
            pairingA.inputOtherPin(pairingB.pin);

            const [credentialA, credentialB] = await Promise.all([pairingA.waitForPairing(), promiseB]);

            expect(credentialA).toBeDefined();
            expect(credentialB).toBeDefined();

            await channelA.send("hello from old mode");
            await new Promise((r) => setTimeout(r, 100));

            expect(receivedMessages).toContain("hello from old mode");

            channelA.disconnect();
            channelB.disconnect();
        });
    });

    describe("不受信任信道 - Credential 重连", () => {
        it("有 Credential 时 tryConnect 应触发 connectRequest 事件", async () => {
            // 第一次配对
            const [adapterA1, adapterB1] = UntrustedLoopbackAdapter.createPair();
            const channelA1 = new SConnect(adapterA1, { handshakeTimeout: 10000 });
            const channelB1 = new SConnect(adapterB1, { handshakeTimeout: 10000 });

            await channelA1.init("device-a");
            await channelB1.init("device-b");

            // B 监听配对请求
            const pairRequestPromise = new Promise<PairRequest>((resolve) => {
                channelB1.on("pairRequest", (request) => {
                    resolve(request);
                });
            });

            // A 发起配对
            const pairingA = channelA1.pairInit({
                myDeviceId: "device-a",
                remoteDeviceId: "device-b",
            });

            const pairRequest = await pairRequestPromise;
            pairRequest.inputPin(pairingA.pin);
            const credentialBPromise = pairRequest.waitForPairing();
            const credentialAPromise = pairingA.waitForPairing();

            const [credentialA, credentialB] = await Promise.all([credentialAPromise, credentialBPromise]);

            expect(credentialA.myPublicKey).toBeInstanceOf(Uint8Array);
            expect(credentialA.myPublicKey.length).toBeGreaterThan(0);

            channelA1.disconnect();
            channelB1.disconnect();

            // 第二次重连
            const [adapterA2, adapterB2] = UntrustedLoopbackAdapter.createPair();
            const channelA2 = new SConnect(adapterA2, { handshakeTimeout: 10000 });
            const channelB2 = new SConnect(adapterB2, { handshakeTimeout: 10000 });

            await channelA2.init("device-a", {
                privateKey: credentialA.myPrivateKey as Uint8Array,
                publicKey: credentialA.myPublicKey,
            });
            await channelB2.init("device-b", {
                privateKey: credentialB.myPrivateKey as Uint8Array,
                publicKey: credentialB.myPublicKey,
            });

            // B 监听连接请求
            const connectRequestPromise = new Promise<ConnectRequest>((resolve) => {
                channelB2.on("connectRequest", (request) => {
                    resolve(request);
                });
            });

            // A 发起连接
            const resultAPromise = channelA2.tryConnect(credentialA);

            // 等待 B 收到连接请求
            const connectRequest = await connectRequestPromise;
            expect(connectRequest.remoteDeviceId).toBe("device-a");

            // B 接受连接
            const resultBPromise = connectRequest.accept(credentialB);

            const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise]);

            expect(resultA.success).toBe(true);
            expect(resultB.success).toBe(true);

            channelA2.disconnect();
            channelB2.disconnect();
        });

        it("B 可以拒绝连接请求", async () => {
            // 第一次配对
            const [adapterA1, adapterB1] = UntrustedLoopbackAdapter.createPair();
            const channelA1 = new SConnect(adapterA1, { handshakeTimeout: 10000 });
            const channelB1 = new SConnect(adapterB1, { handshakeTimeout: 10000 });

            await channelA1.init("device-a");
            await channelB1.init("device-b");

            // B 监听配对请求
            const pairRequestPromise = new Promise<PairRequest>((resolve) => {
                channelB1.on("pairRequest", (request) => {
                    resolve(request);
                });
            });

            // A 发起配对
            const pairingA = channelA1.pairInit({
                myDeviceId: "device-a",
                remoteDeviceId: "device-b",
            });

            const pairRequest = await pairRequestPromise;
            pairRequest.inputPin(pairingA.pin);
            const credentialBPromise = pairRequest.waitForPairing();
            const credentialAPromise = pairingA.waitForPairing();

            const [credentialA, credentialB] = await Promise.all([credentialAPromise, credentialBPromise]);

            channelA1.disconnect();
            channelB1.disconnect();

            // 第二次重连 - B 拒绝
            const [adapterA2, adapterB2] = UntrustedLoopbackAdapter.createPair();
            const channelA2 = new SConnect(adapterA2, { handshakeTimeout: 2000 });
            const channelB2 = new SConnect(adapterB2, { handshakeTimeout: 2000 });

            await channelA2.init("device-a", {
                privateKey: credentialA.myPrivateKey as Uint8Array,
                publicKey: credentialA.myPublicKey,
            });
            await channelB2.init("device-b", {
                privateKey: credentialB.myPrivateKey as Uint8Array,
                publicKey: credentialB.myPublicKey,
            });

            // B 监听连接请求并拒绝
            const connectRequestPromise = new Promise<ConnectRequest>((resolve) => {
                channelB2.on("connectRequest", (request) => {
                    resolve(request);
                });
            });

            // A 发起连接
            const resultAPromise = channelA2.tryConnect(credentialA);

            // 等待 B 收到连接请求
            const connectRequest = await connectRequestPromise;

            // B 拒绝连接
            connectRequest.reject();

            // A 应该收到失败结果
            const resultA = await resultAPromise;
            expect(resultA.success).toBe(false);

            channelA2.disconnect();
            channelB2.disconnect();
        });

        it("重连后应能收发消息", async () => {
            // 第一次配对
            const [adapterA1, adapterB1] = UntrustedLoopbackAdapter.createPair();
            const channelA1 = new SConnect(adapterA1, { handshakeTimeout: 10000 });
            const channelB1 = new SConnect(adapterB1, { handshakeTimeout: 10000 });

            await channelA1.init("device-a");
            await channelB1.init("device-b");

            // B 监听配对请求
            const pairRequestPromise = new Promise<PairRequest>((resolve) => {
                channelB1.on("pairRequest", (request) => {
                    resolve(request);
                });
            });

            // A 发起配对
            const pairingA = channelA1.pairInit({
                myDeviceId: "device-a",
                remoteDeviceId: "device-b",
            });

            const pairRequest = await pairRequestPromise;
            pairRequest.inputPin(pairingA.pin);
            const credentialBPromise = pairRequest.waitForPairing();
            const credentialAPromise = pairingA.waitForPairing();

            const [credentialA, credentialB] = await Promise.all([credentialAPromise, credentialBPromise]);

            channelA1.disconnect();
            channelB1.disconnect();

            // 第二次重连
            const [adapterA2, adapterB2] = UntrustedLoopbackAdapter.createPair();
            const channelA2 = new SConnect(adapterA2, { handshakeTimeout: 10000 });
            const channelB2 = new SConnect(adapterB2, { handshakeTimeout: 10000 });

            await channelA2.init("device-a", {
                privateKey: credentialA.myPrivateKey as Uint8Array,
                publicKey: credentialA.myPublicKey,
            });
            await channelB2.init("device-b", {
                privateKey: credentialB.myPrivateKey as Uint8Array,
                publicKey: credentialB.myPublicKey,
            });

            const receivedMessages: string[] = [];
            channelB2.on("message", (msg) => receivedMessages.push(msg));

            // B 监听连接请求
            const connectRequestPromise = new Promise<ConnectRequest>((resolve) => {
                channelB2.on("connectRequest", (request) => {
                    resolve(request);
                });
            });

            // A 发起连接
            const resultAPromise = channelA2.tryConnect(credentialA);

            // B 接受连接
            const connectRequest = await connectRequestPromise;
            const resultBPromise = connectRequest.accept(credentialB);

            await Promise.all([resultAPromise, resultBPromise]);

            // 重连后应该能收发消息
            await channelA2.send("hello after reconnect");
            await new Promise((r) => setTimeout(r, 100));

            expect(receivedMessages).toContain("hello after reconnect");

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

            // @ts-ignore
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

            // @ts-ignore
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
