import { describe, expect, it } from "vitest";
import { InputEventCodes } from "../../../input_codes/types";
import type { ModuleCtx } from "../../module";
import { newFd } from "../../utils/fd";
import { waylandCoreModule } from "./wayland";

/** core 数据设备请求/动作的单测：不启动 Wayland 连接，只检查协议事件顺序和 fd 路由 */

type Sent = { id: number; event: string; args: Record<string, unknown> };

function makeCtx() {
    const sent: Sent[] = [];
    const selections: { seat: string; sourceId: number; mimes: string[] }[] = [];
    const forwards: { token: string; mime: string; fd: number }[] = [];
    const drags: {
        kind: "start" | "finish";
        sourceId: number;
        mimes?: string[];
        actions?: string[];
        reason?: string;
    }[] = [];
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
        // start_drag 要求有仍按住按钮的隐式 grab；测试直接以 serial 1 发起
        pointerGrab: { serial: 1, surface: 10, winId: 20, buttons: new Set([InputEventCodes.BTN_LEFT]) } as {
            serial: number;
            surface: number;
            winId: number;
            buttons: Set<number>;
        },
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
        dataDevice: { devices: new Map<string, Set<number>>([["seat0", new Set([11])]]) },
        serial: {
            next: () => {
                const s = serial;
                serial += 2;
                return s;
            },
        },
        seat: {
            byName: (name?: string) => ((name ?? "seat0") === "seat0" ? seat : undefined),
            get: (id: number) => (id === 1 ? seat : undefined),
            all: () => [seat][Symbol.iterator](),
            isUserActionSerial: () => true,
            isActivePointerGrab: () => true,
            activeTouchSerial: () => undefined,
            beginPointerGrab: (_seat: unknown, _winId: number, _surface: number, button: number, serial: number) => {
                seat.pointerGrab = { serial, surface: 10, winId: 20, buttons: new Set([button]) };
            },
            endPointerButton: (_seat: unknown, button: number) => {
                seat.pointerGrab.buttons.delete(button);
                return seat.pointerGrab.buttons.size === 0;
            },
            noteKeyboardPress: () => {},
            noteTouchPress: () => {},
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
        client: { id: "test", displayId: 1, emit: () => {} },
        transfer: {
            selectionChanged: (seat: string, sourceId: number, mimes: string[]) =>
                selections.push({ seat, sourceId, mimes }),
            clearSelection: () => {},
            sourceDestroyed: () => {},
            forward: (token: string, mime: string, fd: number) => forwards.push({ token, mime, fd }),
            dragStarted: (_seat: string, sourceId: number, mimes: string[], actions: ("copy" | "move")[]) =>
                drags.push({ kind: "start", sourceId, mimes, actions }),
            dragFinished: (sourceId: number, reason: string) => drags.push({ kind: "finish", sourceId, reason }),
        },
        dnd: {
            targetAccept: () => {},
            targetActions: () => {},
            targetReceive: () => {},
            targetFinish: () => {},
            targetGone: () => {},
            sourceActions: () => {},
        },
        core: {},
        cursor: {},
        notify: {},
        scene: {},
    } as unknown as ModuleCtx;

    // 一个 wl_surface、一个 wl_data_device、一个 wl_data_source
    objectData.set(10, {});
    objectData.set(11, { seatName: "seat0" });
    objectData.set(12, { offers: ["text/plain;charset=utf-8"] });

    return { ctx, sent, selections, forwards, drags, objectData, seat };
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
        const { ctx, sent, drags } = makeCtx();

        request(ctx, "wl_data_device.start_drag", 11, { source: 12, origin: 10, icon: 0, serial: 1 });

        expect(drags[0]).toEqual({
            kind: "start",
            sourceId: 12,
            mimes: ["text/plain;charset=utf-8"],
            actions: ["copy"],
        });
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
        expect(drags[1]).toEqual({ kind: "finish", sourceId: 12, reason: "finished" });

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

describe("wl_data_device clipboard", () => {
    it("set_selection 只把 mime 交给 transfer，不读字节", () => {
        const { ctx, selections } = makeCtx();

        request(ctx, "wl_data_device.set_selection", 11, { source: 12, serial: 1 });

        expect(selections).toEqual([{ seat: "seat0", sourceId: 12, mimes: ["text/plain;charset=utf-8"] }]);
    });

    it("clipboard.offer 按 selection 的 mime 组包，receive 交给 transfer.forward", () => {
        const { ctx, sent, forwards } = makeCtx();

        action(ctx, "clipboard.offer", 20, [{ token: "t1", mimes: ["text/plain;charset=utf-8"] }]);

        const selection = events(sent, "wl_data_device.selection")[0];
        expect(selection.args.id).toBeDefined();
        const offerId = selection.args.id as number;
        expect(events(sent, "wl_data_offer.offer").map((e) => e.args.mime_type)).toEqual(["text/plain;charset=utf-8"]);

        const { fd } = newFd("");
        request(ctx, "wl_data_offer.receive", offerId, { mime_type: "text/plain;charset=utf-8", fd });
        expect(forwards).toEqual([{ token: "t1", mime: "text/plain;charset=utf-8", fd }]);
    });

    it("offer(null) 发 selection(nil)", () => {
        const { ctx, sent } = makeCtx();

        action(ctx, "clipboard.offer", 20, [undefined]);

        const selection = events(sent, "wl_data_device.selection")[0];
        expect(selection.args.id).toBe(0);
    });
});

describe("drag action negotiation", () => {
    it("重复 set_actions 不再反复回 action", () => {
        const { ctx, sent } = makeCtx();
        request(ctx, "wl_data_device.start_drag", 11, { source: 12, origin: 10, icon: 0, serial: 1 });
        const offerId = events(sent, "wl_data_device.enter")[0].args.id as number;

        for (let i = 0; i < 5; i++) {
            request(ctx, "wl_data_offer.set_actions", offerId, {
                dnd_actions: 7,
                preferred_action: 2,
            });
        }

        expect(events(sent, "wl_data_offer.action")).toHaveLength(1);
        expect(events(sent, "wl_data_source.action")).toHaveLength(1);
    });
});
