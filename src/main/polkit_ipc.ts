import type { PolkitAuthResult, PolkitIdentity } from "../sys_api/polkit";

/** 主进程 ↔ polkit helper 的消息；也是 helper → renderer 的转发内容 */
export interface PolkitWireRequest {
    id: number;
    actionId: string;
    message: string;
    iconName: string;
    details: Record<string, string>;
    identities: PolkitIdentity[];
    command: string;
    vendor: string;
    vendorUrl: string;
    selectedIdentity: PolkitIdentity;
    prompt: string;
    echo: boolean;
    info: string;
    error: string;
}

export type PolkitHelperEvent =
    | { type: "request"; request: PolkitWireRequest }
    | { type: "prompt"; id: number; prompt: string; echo: boolean }
    | { type: "info"; id: number; message: string }
    | { type: "error"; id: number; message: string }
    | { type: "identity"; id: number; identity: PolkitIdentity }
    | { type: "end"; id: number; result: PolkitAuthResult };

export type PolkitHelperCommand =
    | { type: "submit"; id: number; value: string }
    | { type: "cancel"; id: number }
    | { type: "select"; id: number; identityId: string }
    | { type: "watch"; pid: number }
    | { type: "unwatch"; pid: number };
