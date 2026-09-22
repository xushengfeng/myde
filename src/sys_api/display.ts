import type { USocket } from "myde-unix-socket";
import { EventEmitter } from "../event-emitter/event-emitter";

const { ipcRenderer } = require("electron") as typeof import("electron");

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

export class display extends EventEmitter<Record<string, [DisplayMessage]>> {
    private socket: USocket | null = null;
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
            // data is a Node Buffer: its underlying ArrayBuffer may be pooled,
            // so only pass the actual [byteOffset, byteOffset + byteLength) range.
            this.handleData(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        });

        this.socket.on("error", (error) => {
            console.error("Display socket error:", error);
        });

        this.socket.on("close", () => {
            console.log("Display socket closed");
            this.socket = null;
        });
    }

    private handleData(data: Uint8Array): void {
        // Append new data to buffer
        const newBuffer = new ArrayBuffer(this.buffer.byteLength + data.byteLength);
        const newView = new Uint8Array(newBuffer);
        newView.set(new Uint8Array(this.buffer));
        newView.set(data, this.buffer.byteLength);
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

        if (type === "Error") {
            // Reject all pending requests on error
            for (const [id, pending] of this.pendingRequests) {
                this.pendingRequests.delete(id);
                pending.reject(new Error(data.message as string));
            }
        } else {
            // Resolve the pending request registered under this response type
            // (see sendWithResponse: pendingRequests is keyed by responseType).
            const pending = this.pendingRequests.get(type);
            if (pending) {
                this.pendingRequests.delete(type);
                if (type === "Screens") {
                    pending.resolve(data.screens as Screen[]);
                } else if (type === "InputState") {
                    pending.resolve(data.enabled as boolean);
                } else {
                    pending.resolve(undefined);
                }
            }
        }

        // Notify message handlers
        this.emit(type, message);
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
            const pending = {
                resolve: (value: unknown) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (reason: Error) => {
                    clearTimeout(timer);
                    reject(reason);
                },
            };
            this.pendingRequests.set(responseType, pending);

            // Timeout after 5 seconds
            const timer = setTimeout(() => {
                // Only reject if this request is still the pending one
                if (this.pendingRequests.get(responseType) === pending) {
                    this.pendingRequests.delete(responseType);
                    pending.reject(new Error(`Request timeout: ${type}`));
                }
            }, 5000);

            try {
                this.send({ type, ...data });
            } catch (error) {
                this.pendingRequests.delete(responseType);
                pending.reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    async setWindowSize(width: number, height: number): Promise<void> {
        if (this.type !== "desktop") {
            return;
        }
        // await this.sendWithResponse("SetWindowSize", { width, height }, "WindowSizeSet");
        ipcRenderer.send("SetWindowSize", { width, height });
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
