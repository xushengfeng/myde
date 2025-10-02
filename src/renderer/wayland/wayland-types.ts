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
