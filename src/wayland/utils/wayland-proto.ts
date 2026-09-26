/** 协议元数据表：接口名 → 协议（含 enum 定义）；协议模块与 host 共用 */

import type { WaylandObjectId2 } from "../module";
import WaylandProtocolsJSON from "../protocols/protocols.json?raw";
import type { WaylandEnumObj, WaylandInterfaces } from "../protocols/wayland-types";
import type { WaylandName, WaylandProtocol } from "./wayland-binary";

const WaylandProtocolsx = JSON.parse(WaylandProtocolsJSON) as Record<string, WaylandProtocol[]>;
const WaylandProtocols = Object.fromEntries(Object.values(WaylandProtocolsx).flatMap((v) => v.map((p) => [p.name, p])));

export { WaylandProtocols };
/** 全局 name（数字）→ 协议；由 WaylandServer 启动时经 initWaylandProtocols 填充 */
export const waylandProtocolsNameMap = new Map<WaylandName, WaylandProtocol>();

export function getEnumValue<T extends keyof WaylandEnumObj>(
    enumName: T,
    value: WaylandEnumObj[T] | WaylandEnumObj[T][],
) {
    const [pName, enumN] = enumName.split(".");
    const proto = WaylandProtocols[pName];
    if (!proto) throw new Error(`Protocol ${pName} cannot find`);
    if (!proto.enum) throw new Error(`Protocol ${proto.name} has no enums`);
    const e = proto.enum.find((e) => e.name === enumN);
    if (!e) throw new Error(`Enum ${enumN} not found in protocol ${proto.name}`);
    if (Array.isArray(value)) {
        if (e.bitfield) {
            const b = value.map((i) => e.enum[i]).reduce((acc, curr) => acc | curr, 0);
            return b;
        } else {
            throw new Error(`Enum ${enumName} is not a bitfield`);
        }
    } else {
        const entry = e.enum[value];
        if (entry === undefined) throw new Error(`Value ${value} not found in enum ${enumName}`);
        return entry;
    }
}

export function getEnumName<T extends keyof WaylandEnumObj>(enumName: T, value: number): WaylandEnumObj[T] | undefined {
    const [pName, enumN] = enumName.split(".");
    const proto = WaylandProtocols[pName];
    if (!proto) throw new Error(`Protocol ${pName} cannot find`);
    if (!proto.enum) throw new Error(`Protocol ${proto.name} has no enums`);
    const e = proto.enum.find((e) => e.name === enumN);
    if (!e) throw new Error(`Enum ${enumN} not found in protocol ${proto.name}`);
    return Object.entries(e.enum).find(([, v]) => v === value)?.[0] as WaylandEnumObj[T] | undefined;
}

export function waylandObjectId<T extends number | undefined, i extends WaylandInterfaces>(
    id: T,
    _interface: i,
): T extends number ? WaylandObjectId2<i> : undefined {
    if (id === undefined) {
        return undefined as any;
    }
    return id as any;
}

export function tryX<t>(f: () => t): [Error, null] | [null, t] {
    try {
        const r = f();
        return [null, r];
    } catch (e) {
        return [e as Error, null];
    }
}
