import { EventEmitter } from "../event-emitter/event-emitter";
import type { PolkitWireRequest, SessionAppEvent, SessionHelperEvent, SpawnAppRequest } from "../main/session_ipc";
import { AppProcess } from "./app_process";
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
 * 桌面侧对 session helper 的代理。
 *
 * helper 在 Chromium 把主进程搬进 `app-*.scope` 之前启动，留在登录会话里，因此
 * 可以注册会话级 polkit agent，并且用它启动的应用（以及应用派生的子进程）都在
 * 同一个会话里。这里把认证事件转给桌面、回传用户输入，并把应用启动请求转给
 * helper。
 */
export class sessionRemote extends EventEmitter<PolkitEvents> {
    /** helper 可用时，应用从这里启动；不可用时 runApp 回退到本地 spawn */
    available: boolean;

    private current?: RemotePolkitRequest;
    private readonly apps = new Map<number, AppProcess>();
    private nextAppId = 1;

    private readonly handleEvent = (_event: Electron.IpcRendererEvent, event: SessionHelperEvent) => {
        this.handleMessage(event);
    };

    private readonly handleHelperExit = () => {
        this.available = false;
        for (const [id, app] of this.apps) {
            this.apps.delete(id);
            app.emit("error", new Error("session helper 已退出"));
        }
    };

    private readonly handleAppEvent = (_event: Electron.IpcRendererEvent, event: SessionAppEvent) => {
        const app = this.apps.get(event.id);
        if (!app) return;
        switch (event.type) {
            case "started":
                app.pid = event.pid;
                return;
            case "error":
                app.emit("error", new Error(event.message));
                return;
            case "exit":
                this.apps.delete(event.id);
                app.exitCode = event.code;
                app.emit("exit", event.code, event.signal);
                return;
        }
    };

    constructor() {
        super();
        this.available = ipcRenderer.sendSync("app:spawn-available") === true;
        ipcRenderer.on("polkit:event", this.handleEvent);
        ipcRenderer.on("app:event", this.handleAppEvent);
        ipcRenderer.on("app:helper-exit", this.handleHelperExit);
        // helper 如果没法注册会话级 agent，会退化成按进程注册；把桌面进程
        // 自己补上，至少桌面发起的认证能弹出来
        ipcRenderer.send("polkit:action", { type: "watch", pid: process.pid });
    }

    /** 请求 helper 启动应用；进程在 helper 所在的 cgroup（登录会话）里 */
    spawnApp(req: SpawnAppRequest): AppProcess {
        if (!this.available) {
            const failed = new AppProcess();
            queueMicrotask(() => failed.emit("error", new Error("session helper 不可用")));
            return failed;
        }
        const id = this.nextAppId++;
        const app = new AppProcess(undefined, (signal) => {
            ipcRenderer.send("app:kill", { id, signal });
            return true;
        });
        this.apps.set(id, app);
        ipcRenderer.send("app:spawn", { type: "spawn", id, ...req });
        return app;
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
        ipcRenderer.off("app:event", this.handleAppEvent);
        ipcRenderer.off("app:helper-exit", this.handleHelperExit);
        this.current = undefined;
        this.apps.clear();
    }

    private match(id: number): RemotePolkitRequest | undefined {
        return this.current?.id === id ? this.current : undefined;
    }

    private handleMessage(event: SessionHelperEvent): void {
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

/** 桌面实现用到的部分：应用是否经 session helper 启动 */
export type SessionApi = Pick<sessionRemote, "available" | "spawnApp">;
