import type { DBusType } from "myde-dbus";

/** D-Bus variant：signature + 已经铺平的值数组 */
export type WireVar = { signature: string; value: unknown[] };
export type WireDict = [string, WireVar][];

export interface PortalBackendResult {
    response: number;
    results: WireDict;
}

export function variant(signature: string, value: unknown[]): WireVar {
    return { signature, value };
}

export function optionValue<T extends string>(options: WireDict, key: string, signature: T): DBusType<T> | undefined {
    const entry = options.find(([k]) => k === key);
    if (!entry || entry[1].signature !== signature) return undefined;
    return entry[1].value[0] as DBusType<T>;
}
