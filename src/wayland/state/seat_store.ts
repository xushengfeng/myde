import type { SurfaceId, WaylandObjectId2 } from "../module";

export interface SeatRecord {
    pointer?: WaylandObjectId2<"wl_pointer">;
    keyboard?: WaylandObjectId2<"wl_keyboard">;
}

/** 焦点来源：主 surface 还是 popup —— 决定键盘焦点要不要跟着切 */
export type FocusType = "main" | "popup" | null;

/**
 * 输入设备侧状态（原散在 `obj2.seats/serial/focusSurface/focusSurfaceType/modifiers`）。
 *
 * 只放数据与原子操作；发 wl_pointer.enter/leave、wl_keyboard.* 这些**协议动作仍留在调用方**——
 * 它们依赖 objects/多路 send，搬进来反而要注入一整套上下文。
 *
 * 配套的 text-input v1/v3 仲裁状态暂留 `obj2`：它牵扯两个未来模块的边界划分
 * （各协议私有状态 vs 共享仲裁点），到 Phase 3-5 拆 text_input_*.ts 时再定归属。
 */
export class SeatStore {
    #seats = new Map<WaylandObjectId2<"wl_seat">, SeatRecord>();
    /** 键盘事件 serial：首值 1、步长 2（与原 obj2.serial 一致） */
    #serial = 1;
    #modifiers = new Set<number>();
    #focus: SurfaceId | null = null;
    #focusType: FocusType = null;

    addSeat(id: WaylandObjectId2<"wl_seat">): void {
        this.#seats.set(id, {});
    }

    get(id: WaylandObjectId2<"wl_seat">): SeatRecord | undefined {
        return this.#seats.get(id);
    }

    /** getPointers / getKeyboards 遍历用 */
    all(): IterableIterator<SeatRecord> {
        return this.#seats.values();
    }

    /** 分配一个键盘事件 serial */
    nextSerial(): number {
        const s = this.#serial;
        this.#serial = s + 2;
        return s;
    }

    addModifier(bit: number): void {
        this.#modifiers.add(bit);
    }

    removeModifier(bit: number): void {
        this.#modifiers.delete(bit);
    }

    /** wl_keyboard.modifiers 的 mods_depressed 掩码 */
    modifierMask(): number {
        let mask = 0;
        for (const b of this.#modifiers) mask |= 1 << b;
        return mask;
    }

    focus(): SurfaceId | null {
        return this.#focus;
    }

    focusType(): FocusType {
        return this.#focusType;
    }

    setFocus(surface: SurfaceId | null, type: FocusType): void {
        this.#focus = surface;
        this.#focusType = type;
    }
}
