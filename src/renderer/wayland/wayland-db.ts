import { type WaylandProtocol, WaylandArgType } from "./wayland-binary";

export const WaylandProtocols: Record<string, WaylandProtocol> = {
    wl_display: {
        name: "wl_display",
        version: 1,
        request: [
            {
                name: "sync",
                args: [{ name: "callback", type: WaylandArgType.NEW_ID, interface: "wl_callback" }],
            },
            {
                name: "get_registry",
                args: [{ name: "registry", type: WaylandArgType.NEW_ID, interface: "wl_registry" }],
            },
        ],
        event: [
            {
                name: "error",
                args: [
                    { name: "object_id", type: WaylandArgType.OBJECT },
                    { name: "code", type: WaylandArgType.UINT },
                    { name: "message", type: WaylandArgType.STRING },
                ],
            },
            { name: "delete_id", args: [{ name: "id", type: WaylandArgType.UINT }] },
        ],
        enum: [
            {
                name: "error",
                enum: {
                    invalid_object: 0,
                    invalid_method: 1,
                    no_memory: 2,
                    implementation: 3,
                },
            },
        ],
    },
    wl_registry: {
        name: "wl_registry",
        version: 1,
        request: [
            {
                name: "bind",
                args: [
                    { name: "name", type: WaylandArgType.UINT },
                    { name: "id", type: WaylandArgType.NEW_ID, interface: "*" },
                ],
            },
        ],
        event: [
            {
                name: "global",
                args: [
                    { name: "name", type: WaylandArgType.UINT },
                    { name: "interface", type: WaylandArgType.STRING },
                    { name: "version", type: WaylandArgType.UINT },
                ],
            },
            { name: "global_remove", args: [{ name: "name", type: WaylandArgType.UINT }] },
        ],
    },
    wl_callback: {
        name: "wl_callback",
        version: 1,
        event: [
            {
                name: "done",
                args: [{ name: "time", type: WaylandArgType.UINT }],
            },
        ],
    },
    wl_compositor: {
        name: "wl_compositor",
        version: 6,
        request: [
            {
                name: "create_surface",
                args: [{ name: "id", type: WaylandArgType.NEW_ID, interface: "wl_surface" }],
            },
            {
                name: "create_region",
                args: [{ name: "id", type: WaylandArgType.NEW_ID, interface: "wl_region" }],
            },
        ],
    },
};
