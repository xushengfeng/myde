export type EventMap = Record<string, any[]>;

export type RequestEventMap = Record<string, { args: any[]; result: any }>;

export type EventHandler<T extends any[]> = (...args: T) => void;

export type RequestHandler<TArgs extends any[], TResult> = (...args: TArgs) => TResult;

export interface EventEmitterOptions {
    signal?: AbortSignal;
}

interface ListenerEntry<T extends any[]> {
    handler: EventHandler<T>;
    once: boolean;
}

export class EventEmitter<T extends EventMap = EventMap, R extends RequestEventMap = RequestEventMap> {
    private listeners = new Map<keyof T, ListenerEntry<any[]>[]>();
    private responders = new Map<keyof R, Set<RequestHandler<any[], any>>>();

    on<K extends keyof T>(event: K, handler: EventHandler<T[K]>, options?: EventEmitterOptions): () => void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        // biome-ignore lint/style/noNonNullAssertion: check and keep
        this.listeners.get(event)!.push({ handler, once: false });

        const cleanup = () => {
            this.off(event, handler);
        };

        if (options?.signal) {
            if (options.signal.aborted) {
                cleanup();
                return cleanup;
            }
            options.signal.addEventListener("abort", cleanup, { once: true });
        }

        return cleanup;
    }

    off<K extends keyof T>(event: K, handler: EventHandler<T[K]>): void {
        const entries = this.listeners.get(event);
        if (entries) {
            const index = entries.findIndex((entry) => entry.handler === handler);
            if (index !== -1) {
                entries.splice(index, 1);
            }
        }
    }

    once<K extends keyof T>(event: K, handler: EventHandler<T[K]>, options?: EventEmitterOptions): () => void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        // biome-ignore lint/style/noNonNullAssertion: check and keep
        this.listeners.get(event)!.push({ handler, once: true });

        const cleanup = () => {
            this.off(event, handler);
        };

        if (options?.signal) {
            if (options.signal.aborted) {
                cleanup();
                return cleanup;
            }
            options.signal.addEventListener("abort", cleanup, { once: true });
        }

        return cleanup;
    }

    emit<K extends keyof T>(event: K, ...args: T[K]): void {
        const entries = this.listeners.get(event);
        if (!entries) return;

        const onceIndices: number[] = [];

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            try {
                entry.handler(...args);
            } catch (error) {
                console.error(`Error in event handler for ${String(event)}:`, error);
            }
            if (entry.once) {
                onceIndices.push(i);
            }
        }

        for (let i = onceIndices.length - 1; i >= 0; i--) {
            entries.splice(onceIndices[i], 1);
        }
    }

    removeAllListeners<K extends keyof T>(event: K): void {
        this.listeners.delete(event);
    }

    waitFor<K extends keyof T>(event: K, options?: EventEmitterOptions): Promise<T[K]> {
        return new Promise((resolve, reject) => {
            const cleanup = this.once(event, (...args: T[K]) => {
                cleanup();
                resolve(args);
            });

            if (options?.signal) {
                if (options.signal.aborted) {
                    cleanup();
                    reject(new Error("Aborted"));
                    return;
                }
                options.signal.addEventListener(
                    "abort",
                    () => {
                        cleanup();
                        reject(new Error("Aborted"));
                    },
                    { once: true },
                );
            }
        });
    }

    listenerCount<K extends keyof T>(event: K): number {
        return this.listeners.get(event)?.length ?? 0;
    }

    hasListeners<K extends keyof T>(event: K): boolean {
        return this.listenerCount(event) > 0;
    }

    respond<K extends keyof R>(event: K, handler: RequestHandler<R[K]["args"], R[K]["result"]>, options?: EventEmitterOptions): () => void {
        if (!this.responders.has(event)) {
            this.responders.set(event, new Set());
        }
        this.responders.get(event)!.add(handler);

        const cleanup = () => {
            this.responders.get(event)?.delete(handler);
        };

        if (options?.signal) {
            if (options.signal.aborted) {
                cleanup();
                return cleanup;
            }
            options.signal.addEventListener("abort", cleanup, { once: true });
        }

        return cleanup;
    }

    request<K extends keyof R>(event: K, ...args: R[K]["args"]): Promise<R[K]["result"][]> {
        return new Promise((resolve, reject) => {
            const responders = this.responders.get(event);
            if (!responders || responders.size === 0) {
                resolve([]);
                return;
            }

            const results: R[K]["result"][] = [];
            const errors: Error[] = [];

            for (const handler of responders) {
                try {
                    const result = handler(...args);
                    results.push(result);
                } catch (error) {
                    errors.push(error instanceof Error ? error : new Error(String(error)));
                }
            }

            if (errors.length > 0) {
                reject(errors[0]);
            } else {
                resolve(results);
            }
        });
    }
}
