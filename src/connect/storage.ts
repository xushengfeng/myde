/**
 * Connect 的持久化接口。
 *
 * 和 localStorage 同形，桌面加载器可以直接注入 localStorage；
 * node 测试可注入 FileConnectStorage（明文文件）。
 */
export interface ConnectStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/** 仅当前进程有效的内存实现，主要用于临时连接和单元测试。 */
export class MemoryConnectStorage implements ConnectStorage {
    private data = new Map<string, string>();

    getItem(key: string): string | null {
        return this.data.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.data.set(key, value);
    }

    removeItem(key: string): void {
        this.data.delete(key);
    }
}
