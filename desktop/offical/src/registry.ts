export interface BindingSource<T> {
    get: () => Promise<T>;
    subscribe: (cb: (value: T) => void) => () => void;
    getAndSubscribe: (cb: (value: T, isFirst: boolean) => void) => () => void;
    set?: (value: T) => Promise<void>;
}

/**
 * 响应式数据编程
 * 使用 setData 直接设置数据，支持订阅和双向绑定
 */
export class Registry<T = object> {
    private data = new Map<string, unknown>();
    private subscribers = new Map<string, Set<(value: unknown) => void>>();
    private setCallbacks = new Map<string, (value: unknown) => Promise<void>>();
    private pendingBinds = new Map<string, Set<(value: unknown) => void>>();

    setData<K extends keyof T & string>(id: K, data: T[K]) {
        this.data.set(id, data);

        // 通知所有订阅者
        const subs = this.subscribers.get(id);
        if (subs) {
            for (const cb of subs) {
                cb(data);
            }
        }

        // 解决 pending 的 get 请求
        const pending = this.pendingBinds.get(id);
        if (pending) {
            for (const cb of pending) {
                cb(data);
            }
            this.pendingBinds.delete(id);
        }
    }

    setSetCallback<K extends keyof T & string>(id: K, callback: (value: T[K]) => Promise<void>) {
        this.setCallbacks.set(id, callback as (value: unknown) => Promise<void>);
    }

    get<K extends keyof T & string>(id: K): BindingSource<T[K]> {
        const currentValue = this.data.get(id) as T[K] | undefined;

        // 如果数据已经存在，直接返回
        if (currentValue !== undefined) {
            const setcallback = this.setCallbacks.get(id);
            return {
                get: () => Promise.resolve(this.data.get(id) as T[K]),
                subscribe: (cb) => {
                    const subs = this.subscribers.get(id) ?? new Set();
                    const wrappedCb = (v: unknown) => cb(v as T[K]);
                    subs.add(wrappedCb);
                    this.subscribers.set(id, subs);
                    return () => subs.delete(wrappedCb);
                },
                getAndSubscribe: (cb) => {
                    cb(this.data.get(id) as T[K], true);
                    const subs = this.subscribers.get(id) ?? new Set();
                    const wrappedCb = (v: unknown) => cb(v as T[K], false);
                    subs.add(wrappedCb);
                    this.subscribers.set(id, subs);
                    return () => subs.delete(wrappedCb);
                },
                set: setcallback ? (v) => setcallback(v) : undefined,
            };
        }

        // 数据尚未存在，创建 pending 绑定
        const promiseWithResolvers = Promise.withResolvers<T[K]>();
        let resolved = false;

        const pending = this.pendingBinds.get(id) ?? new Set();
        pending.add((v: unknown) => {
            if (!resolved) {
                resolved = true;
                promiseWithResolvers.resolve(v as T[K]);
            }
            const subs = this.subscribers.get(id);
            if (subs) {
                for (const cb of subs) cb(v);
            }
        });
        this.pendingBinds.set(id, pending);

        return {
            get: () => promiseWithResolvers.promise,
            subscribe: (cb) => {
                const subs = this.subscribers.get(id) ?? new Set();
                const wrappedCb = (v: unknown) => cb(v as T[K]);
                subs.add(wrappedCb);
                this.subscribers.set(id, subs);
                return () => subs.delete(wrappedCb);
            },
            getAndSubscribe: (cb) => {
                promiseWithResolvers.promise.then((v) => {
                    if (!resolved) {
                        cb(v, true);
                    }
                });
                const subs = this.subscribers.get(id) ?? new Set();
                const wrappedCb = (v: unknown) => cb(v as T[K], false);
                subs.add(wrappedCb);
                this.subscribers.set(id, subs);
                return () => subs.delete(wrappedCb);
            },
            set: (v) => {
                return Promise.resolve(this.setCallbacks.get(id)?.(v));
            },
        };
    }
    buildVarId<K extends keyof T & string>(idTemp: K, ids: string[]) {
        let r = idTemp as string;
        let offset = 0;
        let iids = ids;
        for (let i = 0; i < idTemp.length; i++) {
            const index = r.indexOf("[]", offset);
            if (index === -1) {
                return r as K;
            }
            offset = index + 2;
            const id = iids.at(0);
            if (id === undefined) {
                return idTemp;
            }
            iids = iids.slice(1);
            r = `${r.slice(0, index)}.${id}${r.slice(index + 2)}`;
        }
        return r as K;
    }
}
