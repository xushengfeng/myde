/**
 * Uint8Array 工具函数
 * 替代 Node.js Buffer 的常用功能
 */

/**
 * 将 Uint8Array 转换为十六进制字符串
 */
export function uint8ArrayToHex(arr: Uint8Array): string {
    return Array.from(arr)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * 将十六进制字符串转换为 Uint8Array
 */
export function hexToUint8Array(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

/**
 * 将字符串转换为 Uint8Array
 */
export function stringToUint8Array(str: string): Uint8Array {
    return new TextEncoder().encode(str);
}

/**
 * 将 Uint8Array 转换为字符串
 */
export function uint8ArrayToString(arr: Uint8Array): string {
    return new TextDecoder().decode(arr);
}

/**
 * 比较两个 Uint8Array 是否相等
 */
export function uint8ArrayEquals(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * 连接多个 Uint8Array
 */
export function concatUint8Array(...arrays: Uint8Array[]): Uint8Array {
    let totalLength = 0;
    for (const arr of arrays) {
        totalLength += arr.length;
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }

    return result;
}

/**
 * 创建空的 Uint8Array
 */
export function emptyUint8Array(): Uint8Array {
    return new Uint8Array(0);
}

/**
 * 复制 Uint8Array
 */
export function copyUint8Array(arr: Uint8Array): Uint8Array {
    return new Uint8Array(arr);
}
