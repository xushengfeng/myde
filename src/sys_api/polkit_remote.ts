import { EventEmitter } from "../event-emitter/event-emitter";
import type { PolkitHelperEvent, PolkitWireRequest } from "../main/polkit_ipc";
import type { PolkitAuthRequest, PolkitAuthResult, PolkitEvents, PolkitIdentity } from "./polkit";

const { ipcRenderer } = require("electron") as typeof import("electron");

class RemotePolkitRequest implements PolkitAuthRequest {
    readonly id: number;
    readonly actionId: string;
    readonly message: string;
    readonly iconName: string;
    readonly details: Readonly<Record<string, string>>;
    readonly identities: readonly PolkitIdentity[];
    readonly command: string;
    readonly vendor: string;
    readonly vendorUrl: string;

    private selected: PolkitIdentity;
    private promptText: string;
    private echoPrompt: boolean;
    private infoText: string;
    private errorText: string;

    constructor(wire: PolkitWireRequest) {
        this.id = wire.id;
        this.actionId = wire.actionId;
        this.message = wire.message;
        this.iconName = wire.iconName;
        this.details = wire.details;
        this.identities = wire.identities;
        this.command = wire.command;
        this.vendor = wire.vendor;
        this.vendorUrl = wire.vendorUrl;
        this.selected = wire.selectedIdentity;
        this.promptText = wire.prompt;
        this.echoPrompt = wire.echo;
        this.infoText = wire.info;
        this.errorText = wire.error;
    }

    get selectedIdentity(): PolkitIdentity {
        return this.selected;
    }

    get prompt(): string {
        return this.promptText;
    }

    get echo(): boolean {
        return this.echoPrompt;
    }

    get info(): string {
        return this.infoText;
    }

    get error(): string {
        return this.errorText;
    }

    submitPassword(value: string): void {
        ipcRenderer.send("polkit:action", { type: "submit", id: this.id, value });
    }

    cancel(): void {
        ipcRenderer.send("polkit:action", { type: "cancel", id: this.id });
    }

    selectIdentity(identityId: string): boolean {
        if (!this.identities.some((identity) => identity.id === identityId)) return false;
        ipcRenderer.send("polkit:action", { type: "select", id: this.id, identityId });
        return true;
    }

    updateSelected(identity: PolkitIdentity): void {
        this.selected = identity;
    }

    updatePrompt(prompt: string, echo: boolean): void {
        this.promptText = prompt;
        this.echoPrompt = echo;
    }

    updateInfo(info: string): void {
        this.infoText = info;
    }

    updateError(error: string): void {
        this.errorText = error;
    }
}

/**
 * 桌面侧的 polkit agent 代理。
 *
 * 真正的 agent 在主进程启动的 helper 里：helper 在 Chromium 把主进程搬进
 * `app-*.scope` 之前启动，留在登录会话里，因此可以注册会话级 agent，覆盖
 * 会话内所有进程（包括应用派生的子进程）。这里只把认证事件转给桌面并回传
 * 用户输入。
 */
export class polkitRemote extends EventEmitter<PolkitEvents> {
    private current?: RemotePolkitRequest;

    private readonly handleEvent = (_event: Electron.IpcRendererEvent, event: PolkitHelperEvent) => {
        this.handleMessage(event);
    };

    constructor() {
        super();
        ipcRenderer.on("polkit:event", this.handleEvent);
        // helper 如果没法注册会话级 agent，会退化成按进程注册；把桌面进程
        // 自己补上，至少桌面发起的认证能弹出来
        ipcRenderer.send("polkit:action", { type: "watch", pid: process.pid });
    }

    getRequest(): PolkitAuthRequest | undefined {
        return this.current;
    }

    async watchProcess(pid: number): Promise<boolean> {
        ipcRenderer.send("polkit:action", { type: "watch", pid });
        return true;
    }

    async unwatchProcess(pid: number): Promise<void> {
        ipcRenderer.send("polkit:action", { type: "unwatch", pid });
    }

    destroy(): void {
        ipcRenderer.off("polkit:event", this.handleEvent);
        this.current = undefined;
    }

    private match(id: number): RemotePolkitRequest | undefined {
        return this.current?.id === id ? this.current : undefined;
    }

    private handleMessage(event: PolkitHelperEvent): void {
        switch (event.type) {
            case "request": {
                const request = new RemotePolkitRequest(event.request);
                this.current = request;
                this.emit("auth-request", request);
                return;
            }
            case "prompt": {
                const request = this.match(event.id);
                if (!request) return;
                request.updatePrompt(event.prompt, event.echo);
                this.emit("auth-prompt", request, event.prompt, event.echo);
                return;
            }
            case "info": {
                const request = this.match(event.id);
                if (!request) return;
                request.updateInfo(event.message);
                this.emit("auth-info", request, event.message);
                return;
            }
            case "error": {
                const request = this.match(event.id);
                if (!request) return;
                request.updateError(event.message);
                this.emit("auth-error", request, event.message);
                return;
            }
            case "identity": {
                const request = this.match(event.id);
                if (!request) return;
                request.updateSelected(event.identity);
                this.emit("auth-identity-changed", request, event.identity);
                return;
            }
            case "end": {
                const request = this.match(event.id);
                if (!request) return;
                this.emit("auth-end", request, event.result satisfies PolkitAuthResult);
                if (this.current === request) this.current = undefined;
                return;
            }
        }
    }
}
