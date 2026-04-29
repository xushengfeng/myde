declare module "noise-handshake" {
    interface KeyPair {
        publicKey: Buffer;
        secretKey: Buffer;
    }

    interface NoiseState {
        tx: Buffer;
        rx: Buffer;
        rs: Buffer;
        hash: Buffer;
        complete: boolean;
        initialise(prologue: Buffer, remoteStatic?: Buffer): void;
        send(payload?: Buffer): Buffer;
        recv(message: Buffer): Buffer;
        destroy?(): void;
    }

    export default class Noise {
        constructor(
            pattern: string,
            initiator: boolean,
            staticKeypair?: KeyPair,
            opts?: Record<string, unknown>,
        );
        tx: Buffer;
        rx: Buffer;
        rs: Buffer;
        hash: Buffer;
        complete: boolean;
        initialise(prologue: Buffer, remoteStatic?: Buffer): void;
        send(payload?: Buffer): Buffer;
        recv(message: Buffer): Buffer;
        destroy?(): void;
    }
}

declare module "noise-handshake/cipher" {
    export default class Cipher {
        constructor(key: Buffer);
        encrypt(plaintext: Buffer, ad?: Buffer): Buffer;
        decrypt(ciphertext: Buffer, ad?: Buffer): Buffer;
    }
}
