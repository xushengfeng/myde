import type { PortalBackendResult, WireDict } from "./wire";

export interface PortalRequestInit {
    id: string;
    appId: string;
    parentWindow: string;
    modal: boolean;
}

/**
 * portal 请求的公共部分：等待结束、取消、失败和 Request.Close。
 * 所有结束路径都幂等；子类用 `finish()` 提交 response + results。
 */
export class PortalRequestBase {
    readonly id: string;
    readonly appId: string;
    readonly parentWindow: string;
    readonly modal: boolean;

    private readonly resultPromise: Promise<PortalBackendResult>;
    private resolveResult!: (result: PortalBackendResult) => void;
    private closed = false;
    private cancelHandlers = new Set<() => void>();

    constructor(op: PortalRequestInit) {
        this.id = op.id;
        this.appId = op.appId;
        this.parentWindow = op.parentWindow;
        this.modal = op.modal;
        this.resultPromise = new Promise((resolve) => {
            this.resolveResult = resolve;
        });
    }

    protected get isClosed(): boolean {
        return this.closed;
    }

    wait(): Promise<PortalBackendResult> {
        return this.resultPromise;
    }

    /** 用户取消：response=1 */
    async cancel(): Promise<void> {
        this.finish(1, []);
    }

    /** 内部失败：response=2 */
    async fail(message?: string): Promise<void> {
        if (message) console.warn(`[portal] request ${this.id} failed: ${message}`);
        this.finish(2, []);
    }

    /** 应用调用 org.freedesktop.impl.portal.Request.Close 时触发 */
    onCancel(handler: () => void): () => void {
        if (this.closed) {
            handler();
            return () => {};
        }
        this.cancelHandlers.add(handler);
        return () => {
            this.cancelHandlers.delete(handler);
        };
    }

    /** 前端调用 org.freedesktop.impl.portal.Request.Close */
    closeFromFrontend(): void {
        if (this.closed) return;
        const handlers = [...this.cancelHandlers];
        this.cancelHandlers.clear();
        this.finish(1, []);
        for (const handler of handlers) {
            try {
                handler();
            } catch (e) {
                console.warn("[portal] onCancel handler error:", e);
            }
        }
    }

    protected finish(response: number, results: WireDict): void {
        if (this.closed) return;
        this.closed = true;
        this.resolveResult({ response, results });
    }
}
