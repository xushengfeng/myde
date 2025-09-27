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

export type WaylandProtocol = {
    objectId: number;
    name: string;
    version: number;
    ops: Array<{
        name: string;
        type: "event" | "request" | "error";
        args: Array<{
            name: string;
            type: WaylandArgType;
            interface?: string; // 对于object/new_id类型
        }>;
    }>;
};
