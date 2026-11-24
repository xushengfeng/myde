const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");
const { dbusIO } = require("myde-dbus") as typeof import("myde-dbus");

import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

import type { PolkitAuthRequest } from "../sys_api/polkit";
import { polkit } from "../sys_api/polkit";
import { spawnSessionApp } from "./session_apps";
import type { PolkitWireRequest, SessionHelperCommand, SessionHelperEvent } from "./session_ipc";

function send(event: SessionHelperEvent) {
    process.send?.(event);
}

function serialize(request: PolkitAuthRequest): PolkitWireRequest {
    return {
        id: request.id,
        actionId: request.actionId,
        message: request.message,
        iconName: request.iconName,
        details: { ...request.details },
        identities: [...request.identities],
        command: request.command,
        vendor: request.vendor,
        vendorUrl: request.vendorUrl,
        selectedIdentity: { ...request.selectedIdentity },
        prompt: request.prompt,
        echo: request.echo,
        info: request.info,
        error: request.error,
    };
}

/** 本进程是否在某个登录会话的 cgroup 里（helper 需要在 Chromium 搬 cgroup 之前启动） */
function inLoginSession(): boolean {
    try {
        return /session-[^/]+\.scope/.test(readFileSync("/proc/self/cgroup", "utf8"));
    } catch {
        return false;
    }
}

async function main() {
    if (!inLoginSession()) {
        console.warn(
            "[session-helper] 不在登录会话的 cgroup 里：helper 代启动的应用不会被算进会话，polkit 认证可能仍由宿主桌面的 agent 处理",
        );
    }

    const socket = new mus.USocket();
    socket.connect("/var/run/dbus/system_bus_socket");
    const io = new dbusIO({ socket });
    const agent = new polkit(io);

    /** helper 代启动的应用，按请求 id 索引 */
    const apps = new Map<number, ChildProcess>();

    /**
     * 桌面装好认证 UI 之前不注册 agent：否则会话里的认证会被抢过来，
     * 桌面却没有对话框可以应答，pkexec/systemctl 会直接失败。
     */
    let armed = false;
    /** 就绪前收到的 watch 请求，arm 后补注册 */
    const pendingWatches = new Set<number>();
    const watchProcess = (pid: number | undefined) => {
        if (pid === undefined || pid <= 0) return;
        if (!armed) {
            pendingWatches.add(pid);
            return;
        }
        void agent.watchProcess(pid);
    };

    const arm = async () => {
        if (armed) return;
        armed = true;
        try {
            await agent.start();
        } catch (error) {
            console.error("[session-helper] 注册认证 agent 失败:", error);
        }
        const pids = new Set(pendingWatches);
        pendingWatches.clear();
        // 主进程被 Chromium 搬进了 app-*.scope，会话级 agent 覆盖不到它的认证
        if (process.ppid > 1) pids.add(process.ppid);
        for (const child of apps.values()) {
            if (child.pid !== undefined) pids.add(child.pid);
        }
        for (const pid of pids) void agent.watchProcess(pid);
    };

    const current = (id: number): PolkitAuthRequest | undefined => {
        const request = agent.getRequest();
        return request && request.id === id ? request : undefined;
    };

    agent.on("auth-request", (request) => send({ type: "request", request: serialize(request) }));
    agent.on("auth-prompt", (request, prompt, echo) => send({ type: "prompt", id: request.id, prompt, echo }));
    agent.on("auth-info", (request, message) => send({ type: "info", id: request.id, message }));
    agent.on("auth-error", (request, message) => send({ type: "error", id: request.id, message }));
    agent.on("auth-identity-changed", (request, identity) => send({ type: "identity", id: request.id, identity }));
    agent.on("auth-end", (request, result) => send({ type: "end", id: request.id, result }));

    let ready = false;
    const pending: SessionHelperCommand[] = [];
    const handleCommand = (message: SessionHelperCommand) => {
        switch (message.type) {
            case "arm":
                void arm();
                break;
            case "submit":
                current(message.id)?.submitPassword(message.value);
                break;
            case "cancel":
                current(message.id)?.cancel();
                break;
            case "select":
                current(message.id)?.selectIdentity(message.identityId);
                break;
            case "watch":
                watchProcess(message.pid);
                break;
            case "unwatch":
                pendingWatches.delete(message.pid);
                void agent.unwatchProcess(message.pid);
                break;
            case "spawn": {
                const child = spawnSessionApp(
                    {
                        exec: message.exec,
                        args: message.args,
                        env: message.env,
                        cwd: message.cwd,
                        uid: message.uid,
                        gid: message.gid,
                    },
                    {
                        started: (pid) => {
                            if (pid === undefined) return;
                            // 会话级 agent 不可用时，至少这个应用的认证能转到桌面
                            watchProcess(pid);
                            send({ type: "app-started", id: message.id, pid });
                        },
                        error: (text) => send({ type: "app-error", id: message.id, message: text }),
                        exit: (code, signal) => {
                            apps.delete(message.id);
                            send({ type: "app-exit", id: message.id, code, signal });
                        },
                    },
                );
                apps.set(message.id, child);
                break;
            }
            case "kill":
                apps.get(message.id)?.kill(message.signal);
                break;
        }
    };

    process.on("message", (message: SessionHelperCommand) => {
        if (!message || typeof message !== "object") return;
        // init 完成前收到的指令（通常只有 watch 桌面进程）先排队
        if (!ready) pending.push(message);
        else handleCommand(message);
    });

    // polkit 起不来不影响代启动应用：spawning 和 agent 是两件事，应用照常要能启动。
    // 这里只连接总线，注册等桌面发来 arm（UI 已就绪）。
    try {
        await agent.init({ register: false });
    } catch (error) {
        console.error("[session-helper] polkit 初始化失败:", error);
    }
    ready = true;
    for (const message of pending.splice(0)) handleCommand(message);
}

process.on("disconnect", () => process.exit(0));

void main().catch((error) => {
    console.error("[session-helper]", error);
    process.exit(1);
});
