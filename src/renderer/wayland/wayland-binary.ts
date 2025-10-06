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

export type WaylandName = number & { __brand: "WaylandName" };
export type WaylandObjectId = number & { __brand: "WaylandObjectId" };

export type WaylandOp = {
    name: string;
    since?: number;
    args: Array<{
        name: string;
        type: WaylandArgType;
        interface?: string;
        allowNull?: boolean;
    }>;
};
export type WaylandProtocol = {
    name: string;
    version: number;
    request?: Array<WaylandOp>;
    event?: Array<WaylandOp>;
    enum?: Array<{ name: string; enum: Record<string, number>; bitfield?: boolean }>;
};
