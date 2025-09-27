export enum WaylandArgType {
    INT = "int",
    UINT = "uint",
    FIXED = "fixed",
    STRING = "string",
    OBJECT = "object",
    NEW_ID = "new_id",
    ARRAY = "array",
    FD = "fd",
}

export interface WaylandMessageDescription {
    name: string;
    type: "request" | "event";
    args: Array<{
        name: string;
        type: WaylandArgType;
        interface?: string; // 对于object/new_id类型
    }>;
}

export interface WaylandInterfaceDescription {
    name: string;
    version: number;
    requests: WaylandMessageDescription[];
    events: WaylandMessageDescription[];
}
