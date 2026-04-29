/**
 * ESM 版本的 SPAKE2 实现
 * 基于原始 spake2 模块重写，使用 Web Crypto API 和 Uint8Array
 */
import BN from "bn.js";
declare const curveEd25519: {
    name: string;
    M: string;
    N: string;
    p: any;
    h: any;
};
declare class EllipticCurve {
    private ec;
    private name;
    M: any;
    N: any;
    P: any;
    p: BN;
    h: BN;
    constructor(curve: typeof curveEd25519);
    decodePoint(buf: string | Uint8Array): any;
    encodePoint(p: any): Uint8Array;
}
interface CipherSuite {
    curve: EllipticCurve;
    hash: (content: Uint8Array) => Promise<Uint8Array>;
    kdf: (salt: Uint8Array, ikm: Uint8Array, info: string) => Promise<Uint8Array>;
    mac: (content: Uint8Array, secret: Uint8Array) => Promise<Uint8Array>;
    mhf: (passphrase: Uint8Array, salt: Uint8Array, options: {
        n: number;
        r: number;
        p: number;
    }) => Promise<Uint8Array>;
}
interface SPAKE2Options {
    suite?: string;
    plus?: boolean;
    mhf?: {
        n: number;
        r: number;
        p: number;
    };
    kdf?: {
        AAD: string;
    };
}
declare class SharedSecret {
    protected Ke: Uint8Array;
    protected Ka: Uint8Array;
    protected KcA: Uint8Array;
    protected KcB: Uint8Array;
    protected options: SPAKE2Options;
    protected cipherSuite: CipherSuite;
    protected transcript: Uint8Array;
    constructor({ options, transcript, cipherSuite, }: {
        options: SPAKE2Options;
        transcript: Uint8Array;
        cipherSuite: CipherSuite;
    });
    init(): Promise<void>;
    getConfirmation(): Promise<Uint8Array>;
    verify(incomingConfirmation: Uint8Array): Promise<void>;
    toBuffer(): Uint8Array;
}
declare class ClientState {
    private options;
    private cipherSuite;
    private clientIdentity;
    private serverIdentity;
    private x;
    private w;
    private T;
    constructor({ clientIdentity, serverIdentity, w, x, options, cipherSuite, }: {
        clientIdentity: string;
        serverIdentity: string;
        w: BN;
        x: BN;
        options: SPAKE2Options;
        cipherSuite: CipherSuite;
    });
    getMessage(): Uint8Array;
    finish(incomingMessage: Uint8Array): Promise<SharedSecret>;
}
declare class ServerState {
    private options;
    private cipherSuite;
    private clientIdentity;
    private serverIdentity;
    private y;
    private w;
    private S;
    constructor({ clientIdentity, serverIdentity, w, y, options, cipherSuite, }: {
        clientIdentity: string;
        serverIdentity: string;
        w: BN;
        y: BN;
        options: SPAKE2Options;
        cipherSuite: CipherSuite;
    });
    getMessage(): Uint8Array;
    finish(incomingMessage: Uint8Array): Promise<SharedSecret>;
}
export declare class SPAKE2 {
    private options;
    private cipherSuite;
    constructor(options?: SPAKE2Options);
    startClient(clientIdentity: string, serverIdentity: string, password: string, salt: string): Promise<ClientState>;
    startServer(clientIdentity: string, serverIdentity: string, verifier: Uint8Array): Promise<ServerState>;
    computeVerifier(password: string, salt: string, clientIdentity: string, serverIdentity: string): Promise<Uint8Array>;
    private _computeW;
}
export declare function spake2(options?: SPAKE2Options): SPAKE2;
export {};
