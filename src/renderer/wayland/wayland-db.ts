import { type WaylandProtocol, WaylandArgType } from "./wayland-binary";

export const WaylandProtocols: Record<string, WaylandProtocol> = {
    wl_display: {
        objectId: 1,
        name: "wl_display",
        version: 1,
        ops: [
            {
                name: "sync",
                type: "request",
                args: [{ name: "callback", type: WaylandArgType.NEW_ID, interface: "wl_callback" }],
            },
            {
                name: "get_registry",
                type: "request",
                args: [{ name: "registry", type: WaylandArgType.NEW_ID, interface: "wl_registry" }],
            },
            { name: "delete_id", type: "request", args: [{ name: "id", type: WaylandArgType.UINT }] },
            {
                name: "error",
                type: "error",
                args: [
                    { name: "code", type: WaylandArgType.UINT },
                    { name: "message", type: WaylandArgType.STRING },
                ],
            },
        ],
    },
};
