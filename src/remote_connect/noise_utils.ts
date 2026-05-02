/**
 * Noise 握手库封装
 * 提供 Uint8Array 接口，内部使用 b4a 进行 Buffer 转换
 */

import b4a from "b4a";
import Noise from "noise-handshake";
import Cipher from "noise-handshake/cipher";

interface KeyPair {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
}

export interface NoiseState {
    complete: boolean;
    tx: Uint8Array;
    rx: Uint8Array;
}

/**
 * 创建 Noise 握手状态
 */
export function createNoise(pattern: string, initiator: boolean, staticKeypair?: KeyPair): NoiseState {
    if (!staticKeypair || staticKeypair.publicKey.length === 0) {
        throw new Error("Static keypair with valid keys is required");
    }
    const b4aKeypair = {
        publicKey: b4a.from(staticKeypair.publicKey) as Buffer,
        secretKey: b4a.from(staticKeypair.privateKey) as Buffer,
    };
    const noise = new Noise(pattern, initiator, b4aKeypair);
    return noise as any;
}

/**
 * 初始化握手状态
 */
export function initialiseNoise(state: NoiseState, prologue: Uint8Array, remoteStatic?: Uint8Array): void {
    const noise = state as any;
    noise.initialise(b4a.from(prologue), remoteStatic ? b4a.from(remoteStatic) : undefined);
}

/**
 * 发送握手消息
 */
export function sendNoise(state: NoiseState): Uint8Array {
    const noise = state as any;
    return noise.send();
}

/**
 * 接收握手消息
 */
export function recvNoise(state: NoiseState, message: Uint8Array): void {
    const noise = state as any;
    noise.recv(b4a.from(message));
}

/**
 * 销毁握手状态
 */
export function destroyNoise(state: NoiseState): void {
    // noise-handshake 不需要手动销毁，让 GC 处理
    const _state = state as any;
    if (_state._clear) {
        try {
            _state._clear();
        } catch {
            // 忽略清理错误
        }
    }
}

/**
 * 创建加密器
 */
export function createCipher(key: Uint8Array): {
    encrypt: (data: Uint8Array) => Uint8Array;
    decrypt: (data: Uint8Array) => Uint8Array;
} {
    const cipher = new Cipher(b4a.from(key) as Buffer);
    return {
        encrypt: (data: Uint8Array) => {
            return cipher.encrypt(b4a.from(data) as Buffer);
        },
        decrypt: (data: Uint8Array) => {
            return cipher.decrypt(b4a.from(data) as Buffer);
        },
    };
}
