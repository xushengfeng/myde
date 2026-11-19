import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ModuleCtx, ProtocolModule } from "../module";
import { waylandCoreModule } from "../protocols/core/wayland";
import { dmabufModule } from "../protocols/ext/dmabuf";
import { FdRegistry, isFdOpen, newFd } from "../utils/fd";

/**
 * 客户端 fd 的生命周期：dma-buf plane 与 wl_shm pool 都必须等到最后一个使用者
 * 销毁（或连接断开）才 close。不关就会一直钉住显存，关早了会把还在读的 fd 关掉。
 */

type Request = { id: number; args: Record<string, unknown> };

function handler(module: ProtocolModule, key: string) {
    const h = module.requests.get(key as never);
    if (!h) throw new Error(`未声明 ${key}`);
    return h as unknown as (x: Request, ctx: ModuleCtx) => void;
}

function makeCtx() {
    const objects = new Map<number, { protocol: unknown; data: unknown }>();
    const fds = new FdRegistry();
    const sent: { id: number; event: string; args: Record<string, unknown> }[] = [];
    let nextId = 100;

    const objectsApi = {
        get: (id: number) => {
            const obj = objects.get(id);
            if (!obj) throw new Error(`object ${id} not found`);
            return obj;
        },
        getOption: (id: number | undefined) => (id === undefined ? undefined : objects.get(id)),
        getData: (id: number) => objects.get(id)?.data,
        setData: (id: number, data: unknown) => {
            const obj = objects.get(id);
            if (obj) obj.data = data;
        },
        create: () => {
            const id = nextId++;
            objects.set(id, { protocol: {}, data: undefined });
            return id;
        },
        delete: (id: number) => objects.delete(id),
        has: (id: number) => objects.has(id),
        entries: () => objects.entries(),
        bind: () => {},
    };

    const ctx = {
        objects: objectsApi,
        fds: {
            retain: (fd: number) => fds.retain(fd),
            release: (fd: number) => fds.release(fd),
        },
        send: (id: number, event: string, args: Record<string, unknown>) => sent.push({ id, event, args }),
        sendNow: (id: number, event: string, args: Record<string, unknown>) => sent.push({ id, event, args }),
        postError: () => {},
    } as unknown as ModuleCtx;

    const addObject = (id: number, data?: unknown) => objects.set(id, { protocol: {}, data });
    return { ctx, objects, addObject, sent };
}

const createPool = handler(waylandCoreModule, "wl_shm.create_pool");
const createBuffer = handler(waylandCoreModule, "wl_shm_pool.create_buffer");
const destroyPool = handler(waylandCoreModule, "wl_shm_pool.destroy");
const destroyBuffer = handler(waylandCoreModule, "wl_buffer.destroy");

const paramsAdd = handler(dmabufModule, "zwp_linux_buffer_params_v1.add");
const paramsCreateImmed = handler(dmabufModule, "zwp_linux_buffer_params_v1.create_immed");
const paramsDestroy = handler(dmabufModule, "zwp_linux_buffer_params_v1.destroy");

describe("fd 生命周期", () => {
    it("wl_shm pool 与 buffer 共用 fd，各自销毁后只剩最后一个引用才 close", () => {
        const { ctx, addObject } = makeCtx();
        const { fd } = newFd(new Uint8Array(16));
        addObject(2);
        addObject(3);

        createPool({ id: 2, args: { id: 2, fd } }, ctx);
        createBuffer({ id: 2, args: { id: 3, offset: 0, stride: 8, width: 2, height: 1, format: 0 } }, ctx);
        expect(isFdOpen(fd)).toBe(true);

        // buffer 先走：pool 还持有一份
        destroyBuffer({ id: 3, args: {} }, ctx);
        expect(isFdOpen(fd)).toBe(true);

        destroyPool({ id: 2, args: {} }, ctx);
        expect(isFdOpen(fd)).toBe(false);
    });

    it("pool 先销毁（buffer 仍在用）也不能关掉 fd", () => {
        const { ctx, addObject } = makeCtx();
        const { fd } = newFd(new Uint8Array(16));
        addObject(2);
        addObject(3);

        createPool({ id: 2, args: { id: 2, fd } }, ctx);
        createBuffer({ id: 2, args: { id: 3, offset: 0, stride: 8, width: 2, height: 1, format: 0 } }, ctx);

        destroyPool({ id: 2, args: {} }, ctx);
        expect(isFdOpen(fd)).toBe(true);

        destroyBuffer({ id: 3, args: {} }, ctx);
        expect(isFdOpen(fd)).toBe(false);
    });

    it("dma-buf plane fd 移交给 wl_buffer，params 销毁不算归还", () => {
        const { ctx, addObject } = makeCtx();
        const { fd } = newFd(new Uint8Array(16));
        // params 对象在 create_params 时建立，这里直接给出 planes 容器
        addObject(4, { planes: [] });
        addObject(5);

        paramsAdd({ id: 4, args: { plane_idx: 0, fd, offset: 0, stride: 16, modifier_hi: 0, modifier_lo: 0 } }, ctx);
        paramsCreateImmed({ id: 4, args: { buffer_id: 5, width: 2, height: 2, format: 1 } }, ctx);

        // create_immed 之后 params 只是空壳，销毁它不能还 buffer 的 fd
        paramsDestroy({ id: 4, args: {} }, ctx);
        expect(isFdOpen(fd)).toBe(true);

        destroyBuffer({ id: 5, args: {} }, ctx);
        expect(isFdOpen(fd)).toBe(false);
    });

    it("没 create 就销毁 params 时归还 add 进来的 fd", () => {
        const { ctx, addObject } = makeCtx();
        const { fd } = newFd(new Uint8Array(16));
        addObject(6, { planes: [] });

        paramsAdd({ id: 6, args: { plane_idx: 0, fd, offset: 0, stride: 16, modifier_hi: 0, modifier_lo: 0 } }, ctx);
        expect(isFdOpen(fd)).toBe(true);

        paramsDestroy({ id: 6, args: {} }, ctx);
        expect(isFdOpen(fd)).toBe(false);
    });

    it("FdRegistry 按引用计数关，closeAll 兜底断连", () => {
        const registry = new FdRegistry();
        const { fd } = newFd(new Uint8Array(16));

        registry.retain(fd);
        registry.retain(fd);
        registry.release(fd);
        expect(isFdOpen(fd)).toBe(true);

        registry.closeAll();
        expect(isFdOpen(fd)).toBe(false);

        // 未登记或已释放的 fd 不应抛
        expect(() => registry.release(fd)).not.toThrow();
        expect(() => registry.release(999_999)).not.toThrow();
    });

    it.runIf(existsSync("/dev/dri/renderD128"))("发给客户端的 format_table fd 发送后自己关掉", () => {
        const { ctx, sent } = makeCtx();
        const getFeedback = handler(dmabufModule, "zwp_linux_dmabuf_v1.get_default_feedback");

        getFeedback({ id: 7, args: { id: 8 } }, ctx);

        const formatTable = sent.find((m) => m.event === "zwp_linux_dmabuf_feedback_v1.format_table");
        expect(formatTable).toBeDefined();
        const fd = formatTable?.args.fd as number;
        expect(typeof fd).toBe("number");
        expect(isFdOpen(fd)).toBe(false);
    });
});
