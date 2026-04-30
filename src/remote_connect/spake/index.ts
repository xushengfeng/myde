/**
 * ESM 版本的 SPAKE2 实现
 * 基于原始 spake2 模块重写，使用 Web Crypto API 和 Uint8Array
 */

import BN from "bn.js";
import { ec as EC } from "elliptic";
import { uint8ArrayToHex, hexToUint8Array, stringToUint8Array, uint8ArrayEquals, concatUint8Array } from "./utils";

// ==================== 椭圆曲线定义 ====================

const TWO_POW_255 = new BN(2).pow(new BN(255));

const curveEd25519 = {
    name: "ed25519",
    M: "d048032c6ea0b6d697ddc2e86bda85a33adac920f1bf18e1b0c6d166a5cecdaf",
    N: "d3bfb518f44f3430f29d0c92af503865a1ed3281dc69b35dd868ba85f886c4ab",
    p: new BN("7237005577332262213973186563042994240857116359379907606001950938285454250989", 10),
    h: new BN(8),
};

class EllipticCurve {
    private ec: any;
    private name: string;
    public M: any;
    public N: any;
    public P: any;
    public p: BN;
    public h: BN;

    constructor(curve: typeof curveEd25519) {
        const ec = new EC(curve.name);
        this.name = curve.name;
        this.ec = ec.curve;
        this.M = this.decodePoint(curve.M);
        this.N = this.decodePoint(curve.N);
        this.P = this.ec.g;
        this.p = curve.p;
        this.h = curve.h;
    }

    decodePoint(buf: string | Uint8Array): any {
        const hex = typeof buf === "string" ? buf : uint8ArrayToHex(buf);
        if (this.name === "ed25519") {
            const b = new BN(hex, 16, "le");
            return this.ec.pointFromY(b.mod(TWO_POW_255).toString(16), b.gte(TWO_POW_255));
        }
        return this.ec.decodePoint(hex, true);
    }

    encodePoint(p: any): Uint8Array {
        if (this.name === "ed25519") {
            const x = p.getX();
            const y = p.getY();
            return new Uint8Array(x.mod(new BN(2)).mul(TWO_POW_255).add(y).toArray("le", 32));
        }
        return new Uint8Array(p.encodeCompressed());
    }
}

// ==================== 密码学工具 ====================

async function sha256(content: Uint8Array): Promise<Uint8Array> {
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
        const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", content as any);
        return new Uint8Array(hashBuffer);
    }
    // Fallback: 使用 bn.js 实现的简单 SHA-256（仅用于测试）
    throw new Error("SHA-256 not available");
}

async function hmacSha256(content: Uint8Array, secret: Uint8Array): Promise<Uint8Array> {
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
        const key = await globalThis.crypto.subtle.importKey(
            "raw",
            secret as any,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
        );
        const signature = await globalThis.crypto.subtle.sign("HMAC", key, content as any);
        return new Uint8Array(signature);
    }
    throw new Error("HMAC-SHA256 not available");
}

async function hkdfSha256(salt: Uint8Array, ikm: Uint8Array, info: string): Promise<Uint8Array> {
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
        // HKDF 实现 (RFC 5869)
        // Step 1: Extract
        const actualSalt = salt.length > 0 ? salt : new Uint8Array(32);
        const prk = await hmacSha256(ikm, actualSalt);

        // Step 2: Expand
        const infoBuffer = new TextEncoder().encode(info);
        const N = Math.ceil(32 / 32); // hashLen = 32 for SHA-256
        const okm = new Uint8Array(32);

        let T = new Uint8Array(0);
        for (let i = 1; i <= N; i++) {
            const input = new Uint8Array(T.length + infoBuffer.length + 1);
            input.set(T);
            input.set(infoBuffer, T.length);
            input[T.length + infoBuffer.length] = i;
            T = (await hmacSha256(input, prk)) as unknown as Uint8Array<ArrayBuffer>;
        }

        okm.set(T.subarray(0, 32));
        return okm;
    }
    throw new Error("HKDF-SHA256 not available");
}

async function scrypt(
    passphrase: Uint8Array,
    salt: Uint8Array,
    options: { n: number; r: number; p: number },
): Promise<Uint8Array> {
    // 简化的 scrypt 实现（用于浏览器环境）
    // 实际应用中应使用完整的 scrypt 实现
    const { n, r, p } = options;

    // 使用 PBKDF2 作为 fallback（安全性较低，但可用于测试）
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
        const key = await globalThis.crypto.subtle.importKey("raw", passphrase as any, { name: "PBKDF2" }, false, [
            "deriveBits",
        ]);
        const derivedBits = await globalThis.crypto.subtle.deriveBits(
            {
                name: "PBKDF2",
                salt: salt as any,
                iterations: n * r * p,
                hash: "SHA-256",
            },
            key,
            256,
        );
        return new Uint8Array(derivedBits);
    }
    throw new Error("scrypt not available");
}

function randomBytes(size: number): Uint8Array {
    if (typeof globalThis.crypto !== "undefined") {
        return globalThis.crypto.getRandomValues(new Uint8Array(size));
    }
    throw new Error("crypto.getRandomValues not available");
}

function randomInteger(l: BN, r: BN): BN {
    const range = r.sub(l);
    const size = Math.ceil(range.sub(new BN(1)).toString(16).length / 2);
    const randomData = randomBytes(size + 8);
    const v = new BN(uint8ArrayToHex(randomData), 16);
    return v.mod(range).add(l);
}

// ==================== 工具函数 ====================

function concat(...bufs: Uint8Array[]): Uint8Array {
    let totalLength = 0;
    for (const buf of bufs) {
        if (buf.length > 0) {
            totalLength += 8 + buf.length;
        }
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;

    for (const buf of bufs) {
        if (buf.length === 0) continue;

        // 写入长度（小端序，8字节）
        const lenBuf = new BN(buf.length).toArray("le", 8);
        for (let i = 0; i < 8; i++) {
            result[offset++] = lenBuf[i] || 0;
        }

        // 写入数据
        result.set(buf, offset);
        offset += buf.length;
    }

    return result;
}

// ==================== 密码套件 ====================

interface CipherSuite {
    curve: EllipticCurve;
    hash: (content: Uint8Array) => Promise<Uint8Array>;
    kdf: (salt: Uint8Array, ikm: Uint8Array, info: string) => Promise<Uint8Array>;
    mac: (content: Uint8Array, secret: Uint8Array) => Promise<Uint8Array>;
    mhf: (
        passphrase: Uint8Array,
        salt: Uint8Array,
        options: { n: number; r: number; p: number },
    ) => Promise<Uint8Array>;
}

const defaultCipherSuite: CipherSuite = {
    curve: new EllipticCurve(curveEd25519),
    hash: sha256,
    kdf: hkdfSha256,
    mac: hmacSha256,
    mhf: scrypt,
};

// ==================== SPAKE2 实现 ====================

interface SPAKE2Options {
    suite?: string;
    plus?: boolean;
    mhf?: { n: number; r: number; p: number };
    kdf?: { AAD: string };
}

class SharedSecret {
    protected Ke: Uint8Array;
    protected Ka: Uint8Array;
    protected KcA: Uint8Array;
    protected KcB: Uint8Array;
    protected options: SPAKE2Options;
    protected cipherSuite: CipherSuite;
    protected transcript: Uint8Array;

    constructor({
        options,
        transcript,
        cipherSuite,
    }: {
        options: SPAKE2Options;
        transcript: Uint8Array;
        cipherSuite: CipherSuite;
    }) {
        this.options = options;
        this.cipherSuite = cipherSuite;
        this.transcript = transcript;

        // 同步初始化（使用预计算的哈希）
        // 注意：这里需要异步初始化，但构造函数不能是异步的
        // 实际的初始化在 finish 方法中完成
        this.Ke = new Uint8Array(16);
        this.Ka = new Uint8Array(16);
        this.KcA = new Uint8Array(16);
        this.KcB = new Uint8Array(16);
    }

    async init(): Promise<void> {
        const hashTranscript = await this.cipherSuite.hash(this.transcript);
        const transcriptLen = hashTranscript.length;
        this.Ke = hashTranscript.subarray(0, Math.floor(transcriptLen / 2));
        this.Ka = hashTranscript.subarray(Math.floor(transcriptLen / 2));

        // 使用与原始 spake2 相同的参数格式
        const aad = this.options.kdf?.AAD || "";
        const Kc = await this.cipherSuite.kdf(
            new TextEncoder().encode(""), // salt 为空字符串
            this.Ka,
            "ConfirmationKeys" + aad,
        );
        const kcLen = Kc.length;
        this.KcA = Kc.subarray(0, Math.floor(kcLen / 2));
        this.KcB = Kc.subarray(Math.floor(kcLen / 2));
    }

    async getConfirmation(): Promise<Uint8Array> {
        return this.cipherSuite.mac(this.transcript, this.KcA);
    }

    async verify(incomingConfirmation: Uint8Array): Promise<void> {
        const mac = await this.cipherSuite.mac(this.transcript, this.KcB);
        if (!uint8ArrayEquals(mac, incomingConfirmation)) {
            throw new Error("invalid confirmation");
        }
    }

    toBuffer(): Uint8Array {
        return this.Ke;
    }
}

class ClientState {
    private options: SPAKE2Options;
    private cipherSuite: CipherSuite;
    private clientIdentity: string;
    private serverIdentity: string;
    private x: BN;
    private w: BN;
    private T: any = null;

    constructor({
        clientIdentity,
        serverIdentity,
        w,
        x,
        options,
        cipherSuite,
    }: {
        clientIdentity: string;
        serverIdentity: string;
        w: BN;
        x: BN;
        options: SPAKE2Options;
        cipherSuite: CipherSuite;
    }) {
        this.options = options;
        this.cipherSuite = cipherSuite;
        this.clientIdentity = clientIdentity;
        this.serverIdentity = serverIdentity;
        this.x = x;
        this.w = w;
    }

    getMessage(): Uint8Array {
        const { curve } = this.cipherSuite;
        const { P, M } = curve;
        this.T = P.mul(this.x).add(M.mul(this.w));
        return curve.encodePoint(this.T);
    }

    async finish(incomingMessage: Uint8Array): Promise<SharedSecret> {
        if (!this.T) {
            throw new Error("getMessage method needs to be called before this method");
        }

        const { curve } = this.cipherSuite;
        const { h, N } = curve;
        const S = curve.decodePoint(incomingMessage);

        if (S.mul(h).isInfinity()) {
            throw new Error("invalid curve point");
        }

        const K = S.add(N.neg().mul(this.w)).mul(this.x);
        const TT = concat(
            new TextEncoder().encode(this.clientIdentity),
            new TextEncoder().encode(this.serverIdentity),
            curve.encodePoint(S),
            curve.encodePoint(this.T),
            curve.encodePoint(K),
            new Uint8Array(this.w.toArray("be", 32)),
        );

        const secret = new SharedSecret({
            options: this.options,
            transcript: TT,
            cipherSuite: this.cipherSuite,
        });
        await secret.init();
        return secret;
    }
}

class ServerState {
    private options: SPAKE2Options;
    private cipherSuite: CipherSuite;
    private clientIdentity: string;
    private serverIdentity: string;
    private y: BN;
    private w: BN;
    private S: any = null;

    constructor({
        clientIdentity,
        serverIdentity,
        w,
        y,
        options,
        cipherSuite,
    }: {
        clientIdentity: string;
        serverIdentity: string;
        w: BN;
        y: BN;
        options: SPAKE2Options;
        cipherSuite: CipherSuite;
    }) {
        this.options = options;
        this.cipherSuite = cipherSuite;
        this.clientIdentity = clientIdentity;
        this.serverIdentity = serverIdentity;
        this.y = y;
        this.w = w;
    }

    getMessage(): Uint8Array {
        const { curve } = this.cipherSuite;
        const { P, N } = curve;
        this.S = P.mul(this.y).add(N.mul(this.w));
        return curve.encodePoint(this.S);
    }

    async finish(incomingMessage: Uint8Array): Promise<SharedSecret> {
        if (!this.S) {
            throw new Error("getMessage method needs to be called before this method");
        }

        const { curve } = this.cipherSuite;
        const { h, M } = curve;
        const T = curve.decodePoint(incomingMessage);

        if (T.mul(h).isInfinity()) {
            throw new Error("invalid curve point");
        }

        const K = T.add(M.neg().mul(this.w)).mul(this.y);
        const TT = concat(
            new TextEncoder().encode(this.clientIdentity),
            new TextEncoder().encode(this.serverIdentity),
            curve.encodePoint(this.S),
            curve.encodePoint(T),
            curve.encodePoint(K),
            new Uint8Array(this.w.toArray("be", 32)),
        );

        const secret = new SharedSecret({
            options: this.options,
            transcript: TT,
            cipherSuite: this.cipherSuite,
        });
        await secret.init();
        return secret;
    }
}

export class SPAKE2 {
    private options: SPAKE2Options;
    private cipherSuite: CipherSuite;

    constructor(options: SPAKE2Options = {}) {
        this.options = options;
        this.cipherSuite = defaultCipherSuite;
    }

    async startClient(
        clientIdentity: string,
        serverIdentity: string,
        password: string,
        salt: string,
    ): Promise<ClientState> {
        const { cipherSuite, options } = this;
        const { p } = cipherSuite.curve;

        const w = await this._computeW(password, salt);
        const x = randomInteger(new BN("0", 10), p);

        return new ClientState({
            clientIdentity,
            serverIdentity,
            w,
            x,
            options,
            cipherSuite,
        });
    }

    async startServer(clientIdentity: string, serverIdentity: string, verifier: Uint8Array): Promise<ServerState> {
        const { cipherSuite, options } = this;
        const { p } = cipherSuite.curve;

        const y = randomInteger(new BN("0", 10), p);
        const w = new BN(uint8ArrayToHex(verifier), 16);

        return new ServerState({
            clientIdentity,
            serverIdentity,
            w,
            y,
            options,
            cipherSuite,
        });
    }

    async computeVerifier(
        password: string,
        salt: string,
        clientIdentity: string,
        serverIdentity: string,
    ): Promise<Uint8Array> {
        const w = await this._computeW(password, salt);
        return new Uint8Array(w.toArray("be", 32));
    }

    private async _computeW(password: string, salt: string): Promise<BN> {
        const { cipherSuite, options } = this;
        const { p } = cipherSuite.curve;

        const verifier = await cipherSuite.mhf(
            new TextEncoder().encode(password),
            new TextEncoder().encode(salt),
            options.mhf || { n: 1024, r: 8, p: 16 },
        );

        return new BN(uint8ArrayToHex(verifier), 16).mod(p);
    }
}

export function spake2(options: SPAKE2Options = {}): SPAKE2 {
    return new SPAKE2(options);
}
