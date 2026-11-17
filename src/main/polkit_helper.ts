const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");
const { dbusIO } = require("myde-dbus") as typeof import("myde-dbus");

import type { PolkitAuthRequest } from "../sys_api/polkit";
import { polkit } from "../sys_api/polkit";
import type { PolkitHelperCommand, PolkitHelperEvent, PolkitWireRequest } from "./polkit_ipc";

function send(event: PolkitHelperEvent) {
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

async function main() {
    const socket = new mus.USocket();
    socket.connect("/run/dbus/system_bus_socket");
    const io = new dbusIO({ socket });
    const agent = new polkit(io);

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
    const pending: PolkitHelperCommand[] = [];
    const handleCommand = (message: PolkitHelperCommand) => {
        switch (message.type) {
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
                void agent.watchProcess(message.pid);
                break;
            case "unwatch":
                void agent.unwatchProcess(message.pid);
                break;
        }
    };

    process.on("message", (message: PolkitHelperCommand) => {
        if (!message || typeof message !== "object") return;
        // init 完成前收到的指令（通常只有 watch 桌面进程）先排队
        if (!ready) pending.push(message);
        else handleCommand(message);
    });

    await agent.init();
    ready = true;
    for (const message of pending.splice(0)) handleCommand(message);
}

process.on("disconnect", () => process.exit(0));

void main().catch((error) => {
    console.error("[polkit-helper]", error);
    process.exit(1);
});
