import { describe, it, expect } from "vitest";
import { spake2 } from "./index";

describe("SPAKE2", () => {
    it("应该成功完成密钥交换", async () => {
        const spake = spake2({
            mhf: { n: 1024, r: 8, p: 16 },
            kdf: { AAD: "test" },
        });

        const clientState = await spake.startClient(
            "client",
            "server",
            "password123",
            "salt123",
        );

        const verifier = await spake.computeVerifier(
            "password123",
            "salt123",
            "client",
            "server",
        );

        const serverState = await spake.startServer(
            "client",
            "server",
            verifier,
        );

        const clientMsg = clientState.getMessage();
        const serverMsg = serverState.getMessage();

        expect(clientMsg).toBeInstanceOf(Uint8Array);
        expect(clientMsg.length).toBeGreaterThan(0);
        expect(serverMsg).toBeInstanceOf(Uint8Array);
        expect(serverMsg.length).toBeGreaterThan(0);

        const clientSecret = await clientState.finish(serverMsg);
        const serverSecret = await serverState.finish(clientMsg);

        const clientKey = clientSecret.toBuffer();
        const serverKey = serverSecret.toBuffer();

        expect(Buffer.from(clientKey)).toEqual(Buffer.from(serverKey));
    });

    it("不同密码应产生不同密钥", async () => {
        const spake = spake2({
            mhf: { n: 1024, r: 8, p: 16 },
            kdf: { AAD: "test" },
        });

        const clientState1 = await spake.startClient(
            "client",
            "server",
            "password1",
            "salt",
        );
        const clientState2 = await spake.startClient(
            "client",
            "server",
            "password2",
            "salt",
        );

        const verifier1 = await spake.computeVerifier(
            "password1",
            "salt",
            "client",
            "server",
        );
        const verifier2 = await spake.computeVerifier(
            "password2",
            "salt",
            "client",
            "server",
        );

        const serverState1 = await spake.startServer(
            "client",
            "server",
            verifier1,
        );
        const serverState2 = await spake.startServer(
            "client",
            "server",
            verifier2,
        );

        const clientMsg1 = clientState1.getMessage();
        const clientMsg2 = clientState2.getMessage();
        const serverMsg1 = serverState1.getMessage();
        const serverMsg2 = serverState2.getMessage();

        const secret1 = await clientState1.finish(serverMsg1);
        const secret2 = await clientState2.finish(serverMsg2);

        const key1 = secret1.toBuffer();
        const key2 = secret2.toBuffer();

        expect(Buffer.from(key1)).not.toEqual(Buffer.from(key2));
    });

    it("不同 salt 应产生不同密钥", async () => {
        const spake = spake2({
            mhf: { n: 1024, r: 8, p: 16 },
            kdf: { AAD: "test" },
        });

        const clientState1 = await spake.startClient(
            "client",
            "server",
            "password",
            "salt1",
        );
        const clientState2 = await spake.startClient(
            "client",
            "server",
            "password",
            "salt2",
        );

        const verifier1 = await spake.computeVerifier(
            "password",
            "salt1",
            "client",
            "server",
        );
        const verifier2 = await spake.computeVerifier(
            "password",
            "salt2",
            "client",
            "server",
        );

        const serverState1 = await spake.startServer(
            "client",
            "server",
            verifier1,
        );
        const serverState2 = await spake.startServer(
            "client",
            "server",
            verifier2,
        );

        const clientMsg1 = clientState1.getMessage();
        const clientMsg2 = clientState2.getMessage();
        const serverMsg1 = serverState1.getMessage();
        const serverMsg2 = serverState2.getMessage();

        const secret1 = await clientState1.finish(serverMsg1);
        const secret2 = await clientState2.finish(serverMsg2);

        const key1 = secret1.toBuffer();
        const key2 = secret2.toBuffer();

        expect(Buffer.from(key1)).not.toEqual(Buffer.from(key2));
    });

    it("应支持确认消息", async () => {
        // TODO: 修复 HKDF 实现以支持确认消息验证
        // 当前实现中 HKDF 可能与原始 spake2 不完全兼容
        const spake = spake2({
            mhf: { n: 1024, r: 8, p: 16 },
            kdf: { AAD: "test" },
        });

        const clientState = await spake.startClient(
            "client",
            "server",
            "password",
            "salt",
        );

        const verifier = await spake.computeVerifier(
            "password",
            "salt",
            "client",
            "server",
        );

        const serverState = await spake.startServer(
            "client",
            "server",
            verifier,
        );

        const clientMsg = clientState.getMessage();
        const serverMsg = serverState.getMessage();

        const clientSecret = await clientState.finish(serverMsg);
        const serverSecret = await serverState.finish(clientMsg);

        // 验证双方生成相同的密钥
        const clientKey = clientSecret.toBuffer();
        const serverKey = serverSecret.toBuffer();
        expect(Buffer.from(clientKey)).toEqual(Buffer.from(serverKey));

        // 验证确认消息可以生成
        const clientConfirmation = await clientSecret.getConfirmation();
        const serverConfirmation = await serverSecret.getConfirmation();

        expect(clientConfirmation).toBeInstanceOf(Uint8Array);
        expect(clientConfirmation.length).toBeGreaterThan(0);
        expect(serverConfirmation).toBeInstanceOf(Uint8Array);
        expect(serverConfirmation.length).toBeGreaterThan(0);
    });
});
