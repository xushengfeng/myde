import type { PolkitAuthResult, PolkitIdentity } from "../sys_api/polkit";

/** 主进程 ↔ session helper 的 polkit 认证请求内容；也是 helper → renderer 的转发内容 */
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

/** 经 session helper 启动应用：进程在 helper 所在的 cgroup（登录会话）里 */
export interface SpawnAppRequest {
    exec: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string;
    uid?: number;
    gid?: number;
}

/** helper → 主进程 */
export type SessionHelperEvent =
    | { type: "request"; request: PolkitWireRequest }
    | { type: "prompt"; id: number; prompt: string; echo: boolean }
    | { type: "info"; id: number; message: string }
    | { type: "error"; id: number; message: string }
    | { type: "identity"; id: number; identity: PolkitIdentity }
    | { type: "end"; id: number; result: PolkitAuthResult }
    | { type: "app-started"; id: number; pid?: number }
    | { type: "app-error"; id: number; message: string }
    | { type: "app-exit"; id: number; code: number | null; signal: string | null };

/** 主进程 → helper */
export type SessionHelperCommand =
    /** 桌面已经装好认证 UI，可以注册 agent 接收认证了 */
    | { type: "arm" }
    | { type: "submit"; id: number; value: string }
    | { type: "cancel"; id: number }
    | { type: "select"; id: number; identityId: string }
    | { type: "watch"; pid: number }
    | { type: "unwatch"; pid: number }
    | ({ type: "spawn"; id: number } & SpawnAppRequest)
    | { type: "kill"; id: number; signal?: NodeJS.Signals };

/** 主进程 → renderer：helper 里的应用进程事件 */
export type SessionAppEvent =
    | { type: "started"; id: number; pid?: number }
    | { type: "error"; id: number; message: string }
    | { type: "exit"; id: number; code: number | null; signal: string | null };
