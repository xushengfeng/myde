// 自动生成，勿手动编辑
import type { WaylandObjectId } from "./wayland-binary";

export enum WaylandEventOpcode {
    wl_display__error = 0,
    wl_display__delete_id = 1,
    wl_registry__global = 0,
    wl_registry__global_remove = 1,
    wl_callback__done = 0,
    wl_shm__format = 0,
    wl_buffer__release = 0,
    wl_surface__enter = 0,
    wl_surface__leave = 1,
    wl_surface__preferred_buffer_scale = 2,
    wl_surface__preferred_buffer_transform = 3,
    wl_seat__capabilities = 0,
    wl_seat__name = 1,
    wl_pointer__enter = 0,
    wl_pointer__leave = 1,
    wl_pointer__motion = 2,
    wl_pointer__button = 3,
    wl_pointer__axis = 4,
    wl_pointer__frame = 5,
    wl_pointer__axis_source = 6,
    wl_pointer__axis_stop = 7,
    wl_pointer__axis_discrete = 8,
    wl_pointer__axis_value120 = 9,
    wl_pointer__axis_relative_direction = 10,
    wl_keyboard__keymap = 0,
    wl_keyboard__enter = 1,
    wl_keyboard__leave = 2,
    wl_keyboard__key = 3,
    wl_keyboard__modifiers = 4,
    wl_keyboard__repeat_info = 5,
    wl_output__geometry = 0,
    wl_output__mode = 1,
    wl_output__done = 2,
    wl_output__scale = 3,
    wl_output__name = 4,
    wl_output__description = 5,
    xdg_wm_base__ping = 0,
    xdg_surface__configure = 0,
    xdg_toplevel__configure = 0,
    xdg_toplevel__close = 1,
    xdg_toplevel__configure_bounds = 2,
    xdg_toplevel__wm_capabilities = 3,
    xdg_popup__configure = 0,
    xdg_popup__popup_done = 1,
    xdg_popup__repositioned = 2,
}

export type WaylandEventObj = {
    "wl_display.error": {
        object_id: number;
        code: number;
        message: string;
    };
    "wl_display.delete_id": {
        id: number;
    };
    "wl_registry.global": {
        name: number;
        interface: string;
        version: number;
    };
    "wl_registry.global_remove": {
        name: number;
    };
    "wl_callback.done": {
        callback_data: number;
    };
    "wl_shm.format": {
        format: number;
    };
    "wl_buffer.release": {};
    "wl_surface.enter": {
        output: number;
    };
    "wl_surface.leave": {
        output: number;
    };
    "wl_surface.preferred_buffer_scale": {
        factor: number;
    };
    "wl_surface.preferred_buffer_transform": {
        transform: number;
    };
    "wl_seat.capabilities": {
        capabilities: number;
    };
    "wl_seat.name": {
        name: string;
    };
    "wl_pointer.enter": {
        serial: number;
        surface: number;
        surface_x: number;
        surface_y: number;
    };
    "wl_pointer.leave": {
        serial: number;
        surface: number;
    };
    "wl_pointer.motion": {
        time: number;
        surface_x: number;
        surface_y: number;
    };
    "wl_pointer.button": {
        serial: number;
        time: number;
        button: number;
        state: number;
    };
    "wl_pointer.axis": {
        time: number;
        axis: number;
        value: number;
    };
    "wl_pointer.frame": {};
    "wl_pointer.axis_source": {
        axis_source: number;
    };
    "wl_pointer.axis_stop": {
        time: number;
        axis: number;
    };
    "wl_pointer.axis_discrete": {
        axis: number;
        discrete: number;
    };
    "wl_pointer.axis_value120": {
        axis: number;
        value120: number;
    };
    "wl_pointer.axis_relative_direction": {
        axis: number;
        direction: number;
    };
    "wl_keyboard.keymap": {
        format: number;
        fd: number;
        size: number;
    };
    "wl_keyboard.enter": {
        serial: number;
        surface: number;
        keys: number[];
    };
    "wl_keyboard.leave": {
        serial: number;
        surface: number;
    };
    "wl_keyboard.key": {
        serial: number;
        time: number;
        key: number;
        state: number;
    };
    "wl_keyboard.modifiers": {
        serial: number;
        mods_depressed: number;
        mods_latched: number;
        mods_locked: number;
        group: number;
    };
    "wl_keyboard.repeat_info": {
        rate: number;
        delay: number;
    };
    "wl_output.geometry": {
        x: number;
        y: number;
        physical_width: number;
        physical_height: number;
        subpixel: number;
        make: string;
        model: string;
        transform: number;
    };
    "wl_output.mode": {
        flags: number;
        width: number;
        height: number;
        refresh: number;
    };
    "wl_output.done": {};
    "wl_output.scale": {
        factor: number;
    };
    "wl_output.name": {
        name: string;
    };
    "wl_output.description": {
        description: string;
    };
    "xdg_wm_base.ping": {
        serial: number;
    };
    "xdg_surface.configure": {
        serial: number;
    };
    "xdg_toplevel.configure": {
        width: number;
        height: number;
        states: number[];
    };
    "xdg_toplevel.close": {};
    "xdg_toplevel.configure_bounds": {
        width: number;
        height: number;
    };
    "xdg_toplevel.wm_capabilities": {
        capabilities: number[];
    };
    "xdg_popup.configure": {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    "xdg_popup.popup_done": {};
    "xdg_popup.repositioned": {
        token: number;
    };
};

export type WaylandRequestObj = {
    "wl_display.sync": {
        callback: WaylandObjectId;
    };
    "wl_display.get_registry": {
        registry: WaylandObjectId;
    };
    "wl_registry.bind": {
        name: number;
        id: WaylandObjectId;
    };
    "wl_compositor.create_surface": {
        id: WaylandObjectId;
    };
    "wl_compositor.create_region": {
        id: WaylandObjectId;
    };
    "wl_shm_pool.create_buffer": {
        id: WaylandObjectId;
        offset: number;
        width: number;
        height: number;
        stride: number;
        format: number;
    };
    "wl_shm_pool.destroy": {};
    "wl_shm_pool.resize": {
        size: number;
    };
    "wl_shm.create_pool": {
        id: WaylandObjectId;
        fd: number;
        size: number;
    };
    "wl_shm.release": {};
    "wl_buffer.destroy": {};
    "wl_surface.destroy": {};
    "wl_surface.attach": {
        buffer: number;
        x: number;
        y: number;
    };
    "wl_surface.damage": {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    "wl_surface.frame": {
        callback: WaylandObjectId;
    };
    "wl_surface.set_opaque_region": {
        region: number;
    };
    "wl_surface.set_input_region": {
        region: number;
    };
    "wl_surface.commit": {};
    "wl_surface.set_buffer_transform": {
        transform: number;
    };
    "wl_surface.set_buffer_scale": {
        scale: number;
    };
    "wl_surface.damage_buffer": {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    "wl_surface.offset": {
        x: number;
        y: number;
    };
    "wl_seat.get_pointer": {
        id: WaylandObjectId;
    };
    "wl_seat.get_keyboard": {
        id: WaylandObjectId;
    };
    "wl_seat.get_touch": {
        id: WaylandObjectId;
    };
    "wl_seat.release": {};
    "wl_pointer.set_cursor": {
        serial: number;
        surface: number;
        hotspot_x: number;
        hotspot_y: number;
    };
    "wl_pointer.release": {};
    "wl_keyboard.release": {};
    "wl_output.release": {};
    "wl_region.destroy": {};
    "wl_region.add": {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    "wl_region.subtract": {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    "xdg_wm_base.destroy": {};
    "xdg_wm_base.create_positioner": {
        id: WaylandObjectId;
    };
    "xdg_wm_base.get_xdg_surface": {
        id: WaylandObjectId;
        surface: number;
    };
    "xdg_wm_base.pong": {
        serial: number;
    };
    "xdg_positioner.destroy": {};
    "xdg_positioner.set_size": {
        width: number;
        height: number;
    };
    "xdg_positioner.set_anchor_rect": {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    "xdg_positioner.set_anchor": {
        anchor: number;
    };
    "xdg_positioner.set_gravity": {
        gravity: number;
    };
    "xdg_positioner.set_constraint_adjustment": {
        constraint_adjustment: number;
    };
    "xdg_positioner.set_offset": {
        x: number;
        y: number;
    };
    "xdg_positioner.set_reactive": {};
    "xdg_positioner.set_parent_size": {
        parent_width: number;
        parent_height: number;
    };
    "xdg_positioner.set_parent_configure": {
        serial: number;
    };
    "xdg_surface.destroy": {};
    "xdg_surface.get_toplevel": {
        id: WaylandObjectId;
    };
    "xdg_surface.get_popup": {
        id: WaylandObjectId;
        parent: number;
        positioner: number;
    };
    "xdg_surface.set_window_geometry": {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    "xdg_surface.ack_configure": {
        serial: number;
    };
    "xdg_toplevel.destroy": {};
    "xdg_toplevel.set_parent": {
        parent: number;
    };
    "xdg_toplevel.set_title": {
        title: string;
    };
    "xdg_toplevel.set_app_id": {
        app_id: string;
    };
    "xdg_toplevel.show_window_menu": {
        seat: number;
        serial: number;
        x: number;
        y: number;
    };
    "xdg_toplevel.move": {
        seat: number;
        serial: number;
    };
    "xdg_toplevel.resize": {
        seat: number;
        serial: number;
        edges: number;
    };
    "xdg_toplevel.set_max_size": {
        width: number;
        height: number;
    };
    "xdg_toplevel.set_min_size": {
        width: number;
        height: number;
    };
    "xdg_toplevel.set_maximized": {};
    "xdg_toplevel.unset_maximized": {};
    "xdg_toplevel.set_fullscreen": {
        output: number;
    };
    "xdg_toplevel.unset_fullscreen": {};
    "xdg_toplevel.set_minimized": {};
    "xdg_popup.destroy": {};
    "xdg_popup.grab": {
        seat: number;
        serial: number;
    };
    "xdg_popup.reposition": {
        positioner: number;
        token: number;
    };
    "wp_viewporter.destroy": {};
    "wp_viewporter.get_viewport": {
        id: WaylandObjectId;
        surface: number;
    };
    "wp_viewport.destroy": {};
    "wp_viewport.set_source": {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    "wp_viewport.set_destination": {
        width: number;
        height: number;
    };
};

export type WaylandEnumObj = {
    "wl_display.error": "invalid_object" | "invalid_method" | "no_memory" | "implementation";
    "wl_shm.error": "invalid_format" | "invalid_stride" | "invalid_fd";
    "wl_shm.format": "argb8888" | "xrgb8888" | "c8" | "rgb332" | "bgr233" | "xrgb4444" | "xbgr4444" | "rgbx4444" | "bgrx4444" | "argb4444" | "abgr4444" | "rgba4444" | "bgra4444" | "xrgb1555" | "xbgr1555" | "rgbx5551" | "bgrx5551" | "argb1555" | "abgr1555" | "rgba5551" | "bgra5551" | "rgb565" | "bgr565" | "rgb888" | "bgr888" | "xbgr8888" | "rgbx8888" | "bgrx8888" | "abgr8888" | "rgba8888" | "bgra8888" | "xrgb2101010" | "xbgr2101010" | "rgbx1010102" | "bgrx1010102" | "argb2101010" | "abgr2101010" | "rgba1010102" | "bgra1010102" | "yuyv" | "yvyu" | "uyvy" | "vyuy" | "ayuv" | "nv12" | "nv21" | "nv16" | "nv61" | "yuv410" | "yvu410" | "yuv411" | "yvu411" | "yuv420" | "yvu420" | "yuv422" | "yvu422" | "yuv444" | "yvu444" | "r8" | "r16" | "rg88" | "gr88" | "rg1616" | "gr1616" | "xrgb16161616f" | "xbgr16161616f" | "argb16161616f" | "abgr16161616f" | "xyuv8888" | "vuy888" | "vuy101010" | "y210" | "y212" | "y216" | "y410" | "y412" | "y416" | "xvyu2101010" | "xvyu12_16161616" | "xvyu16161616" | "y0l0" | "x0l0" | "y0l2" | "x0l2" | "yuv420_8bit" | "yuv420_10bit" | "xrgb8888_a8" | "xbgr8888_a8" | "rgbx8888_a8" | "bgrx8888_a8" | "rgb888_a8" | "bgr888_a8" | "rgb565_a8" | "bgr565_a8" | "nv24" | "nv42" | "p210" | "p010" | "p012" | "p016" | "axbxgxrx106106106106" | "nv15" | "q410" | "q401" | "xrgb16161616" | "xbgr16161616" | "argb16161616" | "abgr16161616" | "c1" | "c2" | "c4" | "d1" | "d2" | "d4" | "d8" | "r1" | "r2" | "r4" | "r10" | "r12" | "avuy8888" | "xvuy8888" | "p030";
    "wl_surface.error": "invalid_scale" | "invalid_transform" | "invalid_size" | "invalid_offset" | "defunct_role_object";
    "wl_seat.capability": "pointer" | "keyboard" | "touch";
    "wl_seat.error": "missing_capability";
    "wl_pointer.error": "role";
    "wl_pointer.button_state": "released" | "pressed";
    "wl_pointer.axis": "vertical_scroll" | "horizontal_scroll";
    "wl_pointer.axis_source": "wheel" | "finger" | "continuous" | "wheel_tilt";
    "wl_pointer.axis_relative_direction": "identical" | "inverted";
    "wl_keyboard.keymap_format": "no_keymap" | "xkb_v1";
    "wl_keyboard.key_state": "released" | "pressed" | "repeated";
    "wl_output.subpixel": "unknown" | "none" | "horizontal_rgb" | "horizontal_bgr" | "vertical_rgb" | "vertical_bgr";
    "wl_output.transform": "90" | "180" | "270" | "normal" | "flipped" | "flipped_90" | "flipped_180" | "flipped_270";
    "wl_output.mode": "current" | "preferred";
    "xdg_wm_base.error": "role" | "defunct_surfaces" | "not_the_topmost_popup" | "invalid_popup_parent" | "invalid_surface_state" | "invalid_positioner" | "unresponsive";
    "xdg_positioner.error": "invalid_input";
    "xdg_positioner.anchor": "none" | "top" | "bottom" | "left" | "right" | "top_left" | "bottom_left" | "top_right" | "bottom_right";
    "xdg_positioner.gravity": "none" | "top" | "bottom" | "left" | "right" | "top_left" | "bottom_left" | "top_right" | "bottom_right";
    "xdg_positioner.constraint_adjustment": "none" | "slide_x" | "slide_y" | "flip_x" | "flip_y" | "resize_x" | "resize_y";
    "xdg_surface.error": "not_constructed" | "already_constructed" | "unconfigured_buffer" | "invalid_serial" | "invalid_size" | "defunct_role_object";
    "xdg_toplevel.error": "invalid_resize_edge" | "invalid_parent" | "invalid_size";
    "xdg_toplevel.resize_edge": "none" | "top" | "bottom" | "left" | "top_left" | "bottom_left" | "right" | "top_right" | "bottom_right";
    "xdg_toplevel.state": "maximized" | "fullscreen" | "resizing" | "activated" | "tiled_left" | "tiled_right" | "tiled_top" | "tiled_bottom" | "suspended" | "constrained_left" | "constrained_right" | "constrained_top" | "constrained_bottom";
    "xdg_toplevel.wm_capabilities": "window_menu" | "maximize" | "fullscreen" | "minimize";
    "xdg_popup.error": "invalid_grab";
    "wp_viewporter.error": "viewport_exists";
    "wp_viewport.error": "bad_value" | "bad_size" | "out_of_buffer" | "no_surface";
};
