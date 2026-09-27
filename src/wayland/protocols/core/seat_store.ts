import type { SeatRecord, WaylandObjectId2 } from "../../module";

export type { SeatRecord };

/**
 * 输入设备侧状态（原散在 host 的 `ClientState`（`obj2`）里：seats/serial/focusSurface/focusSurfaceType/modifiers）。
 *
 * **per-seat**：焦点与修饰键都是「一把 seat 一份」——`pointerFocus`/`keyboardFocus`/`mods`
 * 是 `SeatRecord` 上的数据字段（读写像 `win.actived` 一样直接），因为多光标 = 多 seat，
 * 各人的焦点互不相干（Firefox 启动时会把所有 seat 都绑上）。
 *
 * 只放数据与原子操作；**协议动作（发 wl_pointer.enter/leave、wl_keyboard.*）在协议文件里**
 * ——`protocols/core/wayland.ts` 的 `actions` / `core` initializer 经 `ctx.domain.seat`
 * 取这里的数据，组包与下发用 `ctx.sendNow`，store 不必注入一整套上下文。
 * 键盘焦点的单写入点是 `ctx.core.focusKeyboard`（同值去重后才发包）。
 *
 * 配套的 text-input v1/v3 仲裁状态在 core 的域槽里（`ctx.domain.textInput.owner`，
 * 见 `protocols/core/wayland.ts`）：v1/v3 各自私有状态走自己的 `ctx.domain.textInputV1/V3`。
 */
export class SeatStore {
    #seats = new Map<WaylandObjectId2<"wl_seat">, SeatRecord>();
    #byName = new Map<string, SeatRecord>();
    /** 键盘事件 serial：首值 1、步长 2（客户端级单调，两把键盘共用一个序列） */
    #serial = 1;

    addSeat(id: WaylandObjectId2<"wl_seat">, name: string): void {
        const record: SeatRecord = { name, pointerFocus: null, keyboardFocus: null, mods: new Set() };
        this.#seats.set(id, record);
        this.#byName.set(name, record);
    }

    get(id: WaylandObjectId2<"wl_seat">): SeatRecord | undefined {
        return this.#seats.get(id);
    }

    /** `input.*` 的 `seat` 参数解析用；缺省 `"seat0"`（本机光标） */
    byName(name: string): SeatRecord | undefined {
        return this.#byName.get(name);
    }

    /** 全 seat 遍历（焦点清理、offer 目标计算）用 */
    all(): IterableIterator<SeatRecord> {
        return this.#seats.values();
    }

    /** 分配一个键盘事件 serial */
    nextSerial(): number {
        const s = this.#serial;
        this.#serial = s + 2;
        return s;
    }

    /** 修饰键位按 seat 记（两把键盘的 Ctrl 状态互不相干） */
    addModifier(seat: SeatRecord, bit: number): void {
        seat.mods.add(bit);
    }

    removeModifier(seat: SeatRecord, bit: number): void {
        seat.mods.delete(bit);
    }

    /** `wl_keyboard.modifiers.mods_depressed` 的位掩码 */
    modifierMask(seat: SeatRecord): number {
        let mask = 0;
        for (const bit of seat.mods) mask |= 1 << bit;
        return mask;
    }
}
