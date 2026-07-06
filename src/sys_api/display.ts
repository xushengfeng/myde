import type { USocket } from "myde-unix-socket";

interface Screen {
    name: string;
    width: number;
    height: number;
    refresh_rate: number;
}

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface Transform {
    rotation?: number;
    scale_x?: number;
    scale_y?: number;
    translate_x?: number;
    translate_y?: number;
}

interface DisplayMessage {
    type: string;
    [key: string]: unknown;
}

export class display {
    private socket: USocket | null = null;
    private messageHandlers: Map<string, (data: DisplayMessage) => void> = new Map();
    private pendingRequests: Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }> =
        new Map();
    private buffer: ArrayBuffer = new ArrayBuffer(0);
    private type: "desktop" | "window" = "window";

    setType(type: "desktop" | "window") {
        this.type = type;
    }

    getType(): "desktop" | "window" {
        return this.type;
    }

    async connect(op: { socketPath: string; mus: typeof import("myde-unix-socket") }): Promise<void> {
        if (this.type !== "desktop") {
            return;
        }

        const mus = op.mus;
        this.socket = new mus.USocket({ path: op.socketPath });

        this.socket.on("data", (data) => {
            this.handleData(data.buffer as ArrayBuffer);
        });

        this.socket.on("error", (error) => {
            console.error("Display socket error:", error);
        });

        this.socket.on("close", () => {
            console.log("Display socket closed");
            this.socket = null;
        });
    }

    private handleData(data: ArrayBuffer): void {
        // Append new data to buffer
        const newBuffer = new ArrayBuffer(this.buffer.byteLength + data.byteLength);
        const newView = new Uint8Array(newBuffer);
        newView.set(new Uint8Array(this.buffer));
        newView.set(new Uint8Array(data), this.buffer.byteLength);
        this.buffer = newBuffer;

        // Process complete messages
        while (this.buffer.byteLength >= 4) {
            const view = new DataView(this.buffer);
            const len = view.getUint32(0, false); // Big-endian length

            if (this.buffer.byteLength < 4 + len) {
                break; // Not enough data for complete message
            }

            const payload = new Uint8Array(this.buffer, 4, len);
            const json = new TextDecoder().decode(payload);
            const message = JSON.parse(json) as DisplayMessage;

            // Remove processed message from buffer
            this.buffer = this.buffer.slice(4 + len);

            // Handle message
            this.handleMessage(message);
        }
    }

    private handleMessage(message: DisplayMessage): void {
        const { type, ...data } = message;

        // Handle responses to pending requests
        if (type === "Screens" && this.pendingRequests.has("GetScreens")) {
            const pending = this.pendingRequests.get("GetScreens");
            pending?.resolve(data.screens as Screen[]);
            this.pendingRequests.delete("GetScreens");
        } else if (type === "WindowSizeSet" && this.pendingRequests.has("SetWindowSize")) {
            const pending = this.pendingRequests.get("SetWindowSize");
            pending?.resolve(undefined);
            this.pendingRequests.delete("SetWindowSize");
        } else if (type === "RenderedToScreen" && this.pendingRequests.has("RenderToScreen")) {
            const pending = this.pendingRequests.get("RenderToScreen");
            pending?.resolve(undefined);
            this.pendingRequests.delete("RenderToScreen");
        } else if (type === "InputState" && this.pendingRequests.has("SetInputEnabled")) {
            const pending = this.pendingRequests.get("SetInputEnabled");
            pending?.resolve(data.enabled as boolean);
            this.pendingRequests.delete("SetInputEnabled");
        } else if (type === "Pong" && this.pendingRequests.has("Ping")) {
            const pending = this.pendingRequests.get("Ping");
            pending?.resolve(undefined);
            this.pendingRequests.delete("Ping");
        } else if (type === "Error") {
            // Reject all pending requests on error
            for (const [id, pending] of this.pendingRequests) {
                pending.reject(new Error(data.message as string));
                this.pendingRequests.delete(id);
            }
        }

        // Notify message handlers
        const handler = this.messageHandlers.get(type);
        if (handler) {
            handler(message);
        }
    }

    private send(data: object): void {
        if (!this.socket) {
            throw new Error("Display socket not connected");
        }

        const json = JSON.stringify(data);
        const encoder = new TextEncoder();
        const jsonBytes = encoder.encode(json);
        const payloadLen = jsonBytes.length;

        const buffer = new ArrayBuffer(4 + payloadLen);
        const view = new DataView(buffer);
        view.setUint32(0, payloadLen, false); // Big-endian length
        new Uint8Array(buffer, 4).set(jsonBytes);

        this.socket.write(Buffer.from(buffer));
    }

    private sendWithResponse(type: string, data: object, responseType: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(responseType, { resolve, reject });

            this.send({ type, ...data });

            // Timeout after 5 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(responseType)) {
                    this.pendingRequests.get(responseType)?.reject(new Error(`Request timeout: ${type}`));
                    this.pendingRequests.delete(responseType);
                }
            }, 5000);
        });
    }

    onMessage(type: string, handler: (data: DisplayMessage) => void): void {
        this.messageHandlers.set(type, handler);
    }

    offMessage(type: string): void {
        this.messageHandlers.delete(type);
    }

    async setWindowSize(width: number, height: number): Promise<void> {
        if (this.type !== "desktop") {
            return;
        }
        await this.sendWithResponse("SetWindowSize", { width, height }, "WindowSizeSet");
    }

    async renderToScreen(screenIndex: number, rects: Rect[], transforms?: Transform[]): Promise<void> {
        if (this.type !== "desktop") {
            return;
        }
        await this.sendWithResponse(
            "RenderToScreen",
            {
                screen_index: screenIndex,
                rects,
                transforms: transforms || [],
            },
            "RenderedToScreen",
        );
    }

    async getScreens(): Promise<Screen[]> {
        if (this.type !== "desktop") {
            return [];
        }
        return (await this.sendWithResponse("GetScreens", {}, "Screens")) as Screen[];
    }

    async setInputEnabled(enabled: boolean): Promise<boolean> {
        if (this.type !== "desktop") {
            return false;
        }
        return (await this.sendWithResponse("SetInputEnabled", { enabled }, "InputState")) as boolean;
    }

    async ping(): Promise<void> {
        if (this.type !== "desktop") {
            return;
        }
        await this.sendWithResponse("Ping", {}, "Pong");
    }

    disconnect(): void {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }
}
