export type Listener<T extends unknown[]> = (...args: T) => void;

export class EventEmitter<T extends { [K in keyof T]: unknown[] }> {
    private listeners = new Map<keyof T, Set<Listener<unknown[]>>>();

    on<K extends keyof T>(event: K, listener: Listener<T[K]>): void {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(listener as Listener<unknown[]>);
    }

    off<K extends keyof T>(event: K, listener: Listener<T[K]>): void {
        this.listeners.get(event)?.delete(listener as Listener<unknown[]>);
    }

    emit<K extends keyof T>(event: K, ...args: T[K]): void {
        const set = this.listeners.get(event);
        if (set) {
            for (const listener of set) {
                (listener as Listener<T[K]>)(...args);
            }
        }
    }

    once<K extends keyof T>(event: K, listener: Listener<T[K]>): void {
        const wrapper = ((...args: T[K]) => {
            this.off(event, wrapper);
            listener(...args);
        }) as Listener<T[K]>;
        this.on(event, wrapper);
    }

    removeAllListeners<K extends keyof T>(event?: K): void {
        if (event) {
            this.listeners.delete(event);
        } else {
            this.listeners.clear();
        }
    }
}
