import { describe, expect, it } from "vitest";
import type { ModuleCtx } from "../../module";
import { newFd } from "../../utils/fd";
import { waylandCoreModule } from "./wayland";

/** core 数据设备请求/动作的单测：不启动 Wayland 连接，只检查协议事件顺序和 fd 路由 */

type Sent = { id: number; event: string; args: Record<string, unknown> };

function makeCtx() {
    const sent: Sent[] = [];
    const objectData = new Map<number, unknown>();
    let nextId = 100;
    let serial = 1;

    const seat = {
        name: "seat0",
        pointers: new Set<number>(),
        keyboards: new Set<number>(),
        pointerFocus: 10,
        pointerPos: { x: 5, y: 5 },
        keyboardFocus: null,
        mods: new Set<number>(),
    };

    const objects = {
        create: () => {
            const id = nextId++;
            objectData.set(id, undefined);
            return id;
        },
        get: (id: number) => {
            if (!objectData.has(id)) throw new Error(`object ${id} not found`);
            return { protocol: {}, data: objectData.get(id) };
        },
        getOption: (id: number | undefined) => {
            if (id === undefined || !objectData.has(id)) return undefined;
            return { protocol: {}, data: objectData.get(id) };
        },
        getData: (id: number) => objectData.get(id),
        setData: (id: number, data: unknown) => objectData.set(id, data),
        has: (id: number) => objectData.has(id),
        delete: (id: number) => objectData.delete(id),
        entries: () => objectData.entries(),
        bind: () => {},
    };

    const domain = {
        dataDevice: { devices: new Map(), pendingPaste: undefined },
        seat: {
            byName: (name?: string) => ((name ?? "seat0") === "seat0" ? seat : undefined),
            get: (id: number) => (id === 1 ? seat : undefined),
            all: () => [seat][Symbol.iterator](),
            nextSerial: () => {
                const s = serial;
                serial += 2;
                return s;
            },
            addModifier: () => {},
            removeModifier: () => {},
            modifierMask: () => 0,
        },
        xdgSurface: {
            // 指针移动始终落在 surface 10 上
            hitTest: (_winId: number, p: { x: number; y: number }) => ({ surface: 10, x: p.x, y: p.y }),
            dismissGrabsForPointer: () => {},
        },
        output: { outputs: new Set(), surfaces: new Set() },
        commitPacing: { pending: new Map(), raf: false },
        textInput: { owner: null },
    };

    const ctx = {
        objects,
        sendNow: (id: number, event: string, args: Record<string, unknown>) => sent.push({ id, event, args }),
        send: (id: number, event: string, args: Record<string, unknown>) => sent.push({ id, event, args }),
        postError: () => {
            throw new Error("protocol error");
        },
        domain,
        client: { id: "test", displayId: 1, protoVersions: new Map(), emit: () => {} },
        core: {},
        cursor: {},
        notify: {},
        scene: {},
    } as unknown as ModuleCtx;

    // 一个 wl_surface、一个 wl_data_device、一个 wl_data_source
    objectData.set(10, {});
    objectData.set(11, { seatName: "seat0" });
    objectData.set(12, { offers: ["text/plain;charset=utf-8"] });

    return { ctx, sent, objectData, seat };
}

function request(ctx: ModuleCtx, key: string, id: number, args: Record<string, unknown>) {
    const handler = waylandCoreModule.requests.get(key as never);
    if (!handler) throw new Error(`未声明请求 ${key}`);
    handler({ id, proto: {}, op: {}, args } as never, ctx);
}

function action(ctx: ModuleCtx, key: string, winId: number, args: unknown[]) {
    const handler = waylandCoreModule.actions.get(key as never);
    if (!handler) throw new Error(`未声明动作 ${key}`);
    handler({ winId, args } as never, ctx);
}

function events(sent: Sent[], event: string) {
    return sent.filter((e) => e.event === event);
}

describe("wl_data_device drag-and-drop", () => {
    it("start_drag → motion → drop → receive 路由回 source", () => {
        const { ctx, sent } = makeCtx();

        request(ctx, "wl_data_device.start_drag", 11, { source: 12, origin: 10, icon: 0, serial: 1 });

        const enter = events(sent, "wl_data_device.enter")[0];
        expect(enter).toBeDefined();
        expect(enter.args).toMatchObject({ surface: 10, x: 5, y: 5 });
        expect(events(sent, "wl_data_device.data_offer")).toHaveLength(1);
        expect(events(sent, "wl_data_offer.offer")[0].args.mime_type).toBe("text/plain;charset=utf-8");
        expect(events(sent, "wl_data_offer.source_actions")[0].args.source_actions).toBe(1);

        action(ctx, "input.pointer", 20, [{ type: "move", x: 7, y: 8, button: 0 }]);
        expect(events(sent, "wl_data_device.motion")[0].args).toMatchObject({ x: 7, y: 8 });

        action(ctx, "input.pointer", 20, [{ type: "up", x: 7, y: 8, button: 0 }]);
        expect(events(sent, "wl_data_device.drop")).toHaveLength(1);
        expect(events(sent, "wl_data_offer.action")[0].args.dnd_action).toBe(1);
        expect(events(sent, "wl_data_source.dnd_drop_performed")).toHaveLength(1);

        const offerId = enter.args.id as number;
        const { fd } = newFd("");
        request(ctx, "wl_data_offer.receive", offerId, { mime_type: "text/plain;charset=utf-8", fd });
        expect(events(sent, "wl_data_source.send")[0].args.mime_type).toBe("text/plain;charset=utf-8");
        request(ctx, "wl_data_offer.finish", offerId, {});
        expect(events(sent, "wl_data_source.dnd_finished")).toHaveLength(1);
    });

    it("目标不在本 client（跨 client）时取消拖拽", () => {
        const { ctx, sent, seat } = makeCtx();
        seat.pointerFocus = 999;

        request(ctx, "wl_data_device.start_drag", 11, { source: 12, origin: 999, icon: 0, serial: 1 });

        expect(events(sent, "wl_data_source.cancelled")).toHaveLength(1);
        expect(events(sent, "wl_data_device.enter")).toHaveLength(0);
        expect(ctx.domain.dataDevice.drag).toBeUndefined();
    });
});
