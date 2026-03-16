// 自动生成，勿手动编辑
import type { WaylandObjectId } from "./wayland-binary";
type WaylandObjectId2<T extends string> = WaylandObjectId & { __interface: T };

export enum WaylandEventOpcode {
    wl_display__error = 0,
    wl_display__delete_id = 1,
    wl_registry__global = 0,
    wl_registry__global_remove = 1,
    wl_callback__done = 0,
    wl_shm__format = 0,
    wl_buffer__release = 0,
    wl_data_offer__offer = 0,
    wl_data_offer__source_actions = 1,
    wl_data_offer__action = 2,
    wl_data_source__target = 0,
    wl_data_source__send = 1,
    wl_data_source__cancelled = 2,
    wl_data_source__dnd_drop_performed = 3,
    wl_data_source__dnd_finished = 4,
    wl_data_source__action = 5,
    wl_data_device__data_offer = 0,
    wl_data_device__enter = 1,
    wl_data_device__leave = 2,
    wl_data_device__motion = 3,
    wl_data_device__drop = 4,
    wl_data_device__selection = 5,
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
    zwp_linux_dmabuf_v1__format = 0,
    zwp_linux_dmabuf_v1__modifier = 1,
    zwp_linux_buffer_params_v1__created = 0,
    zwp_linux_buffer_params_v1__failed = 1,
    zwp_linux_dmabuf_feedback_v1__done = 0,
    zwp_linux_dmabuf_feedback_v1__format_table = 1,
    zwp_linux_dmabuf_feedback_v1__main_device = 2,
    zwp_linux_dmabuf_feedback_v1__tranche_done = 3,
    zwp_linux_dmabuf_feedback_v1__tranche_target_device = 4,
    zwp_linux_dmabuf_feedback_v1__tranche_formats = 5,
    zwp_linux_dmabuf_feedback_v1__tranche_flags = 6,
    zwp_text_input_v1__enter = 0,
    zwp_text_input_v1__leave = 1,
    zwp_text_input_v1__modifiers_map = 2,
    zwp_text_input_v1__input_panel_state = 3,
    zwp_text_input_v1__preedit_string = 4,
    zwp_text_input_v1__preedit_styling = 5,
    zwp_text_input_v1__preedit_cursor = 6,
    zwp_text_input_v1__commit_string = 7,
    zwp_text_input_v1__cursor_position = 8,
    zwp_text_input_v1__delete_surrounding_text = 9,
    zwp_text_input_v1__keysym = 10,
    zwp_text_input_v1__language = 11,
    zwp_text_input_v1__text_direction = 12,
}

export type WaylandEventObj = {
    "wl_display.error": {
        /** object where the error occurred*/
        object_id: number;
        /** error code*/
        code: number;
        /** error description*/
        message: string;
    };
    "wl_display.delete_id": {
        /** deleted object ID*/
        id: number;
    };
    "wl_registry.global": {
        /** numeric name of the global object*/
        name: number;
        /** interface implemented by the object*/
        interface: string;
        /** interface version*/
        version: number;
    };
    "wl_registry.global_remove": {
        /** numeric name of the global object*/
        name: number;
    };
    "wl_callback.done": {
        /** request-specific data for the callback*/
        callback_data: number;
    };
    "wl_shm.format": {
        /** buffer pixel format*/
        format: number;
    };
    "wl_buffer.release": {};
    "wl_data_offer.offer": {
        /** offered mime type*/
        mime_type: string;
    };
    "wl_data_offer.source_actions": {
        /** actions offered by the data source*/
        source_actions: number;
    };
    "wl_data_offer.action": {
        /** action selected by the compositor*/
        dnd_action: number;
    };
    "wl_data_source.target": {
        /** mime type accepted by the target*/
        mime_type?: string;
    };
    "wl_data_source.send": {
        /** mime type for the data*/
        mime_type: string;
        /** file descriptor for the data*/
        fd: number;
    };
    "wl_data_source.cancelled": {};
    "wl_data_source.dnd_drop_performed": {};
    "wl_data_source.dnd_finished": {};
    "wl_data_source.action": {
        /** action selected by the compositor*/
        dnd_action: number;
    };
    "wl_data_device.data_offer": {
        /** the new data_offer object*/
        id: WaylandObjectId2<"wl_data_offer">;
    };
    "wl_data_device.enter": {
        /** serial number of the enter event*/
        serial: number;
        /** client surface entered*/
        surface: number;
        /** surface-local x coordinate*/
        x: number;
        /** surface-local y coordinate*/
        y: number;
        /** source data_offer object*/
        id?: number;
    };
    "wl_data_device.leave": {};
    "wl_data_device.motion": {
        /** timestamp with millisecond granularity*/
        time: number;
        /** surface-local x coordinate*/
        x: number;
        /** surface-local y coordinate*/
        y: number;
    };
    "wl_data_device.drop": {};
    "wl_data_device.selection": {
        /** selection data_offer object*/
        id?: number;
    };
    "wl_surface.enter": {
        /** output entered by the surface*/
        output: number;
    };
    "wl_surface.leave": {
        /** output left by the surface*/
        output: number;
    };
    "wl_surface.preferred_buffer_scale": {
        /** preferred scaling factor*/
        factor: number;
    };
    "wl_surface.preferred_buffer_transform": {
        /** preferred transform*/
        transform: number;
    };
    "wl_seat.capabilities": {
        /** capabilities of the seat*/
        capabilities: number;
    };
    "wl_seat.name": {
        /** seat identifier*/
        name: string;
    };
    "wl_pointer.enter": {
        /** serial number of the enter event*/
        serial: number;
        /** surface entered by the pointer*/
        surface: number;
        /** surface-local x coordinate*/
        surface_x: number;
        /** surface-local y coordinate*/
        surface_y: number;
    };
    "wl_pointer.leave": {
        /** serial number of the leave event*/
        serial: number;
        /** surface left by the pointer*/
        surface: number;
    };
    "wl_pointer.motion": {
        /** timestamp with millisecond granularity*/
        time: number;
        /** surface-local x coordinate*/
        surface_x: number;
        /** surface-local y coordinate*/
        surface_y: number;
    };
    "wl_pointer.button": {
        /** serial number of the button event*/
        serial: number;
        /** timestamp with millisecond granularity*/
        time: number;
        /** button that produced the event*/
        button: number;
        /** physical state of the button*/
        state: number;
    };
    "wl_pointer.axis": {
        /** timestamp with millisecond granularity*/
        time: number;
        /** axis type*/
        axis: number;
        /** length of vector in surface-local coordinate space*/
        value: number;
    };
    "wl_pointer.frame": {};
    "wl_pointer.axis_source": {
        /** source of the axis event*/
        axis_source: number;
    };
    "wl_pointer.axis_stop": {
        /** timestamp with millisecond granularity*/
        time: number;
        /** the axis stopped with this event*/
        axis: number;
    };
    "wl_pointer.axis_discrete": {
        /** axis type*/
        axis: number;
        /** number of steps*/
        discrete: number;
    };
    "wl_pointer.axis_value120": {
        /** axis type*/
        axis: number;
        /** scroll distance as fraction of 120*/
        value120: number;
    };
    "wl_pointer.axis_relative_direction": {
        /** axis type*/
        axis: number;
        /** physical direction relative to axis motion*/
        direction: number;
    };
    "wl_keyboard.keymap": {
        /** keymap format*/
        format: number;
        /** keymap file descriptor*/
        fd: number;
        /** keymap size, in bytes*/
        size: number;
    };
    "wl_keyboard.enter": {
        /** serial number of the enter event*/
        serial: number;
        /** surface gaining keyboard focus*/
        surface: number;
        /** the keys currently logically down*/
        keys: number[];
    };
    "wl_keyboard.leave": {
        /** serial number of the leave event*/
        serial: number;
        /** surface that lost keyboard focus*/
        surface: number;
    };
    "wl_keyboard.key": {
        /** serial number of the key event*/
        serial: number;
        /** timestamp with millisecond granularity*/
        time: number;
        /** key that produced the event*/
        key: number;
        /** physical state of the key*/
        state: number;
    };
    "wl_keyboard.modifiers": {
        /** serial number of the modifiers event*/
        serial: number;
        /** depressed modifiers*/
        mods_depressed: number;
        /** latched modifiers*/
        mods_latched: number;
        /** locked modifiers*/
        mods_locked: number;
        /** keyboard layout*/
        group: number;
    };
    "wl_keyboard.repeat_info": {
        /** the rate of repeating keys in characters per second*/
        rate: number;
        /** delay in milliseconds since key down until repeating starts*/
        delay: number;
    };
    "wl_output.geometry": {
        /** x position within the global compositor space*/
        x: number;
        /** y position within the global compositor space*/
        y: number;
        /** width in millimeters of the output*/
        physical_width: number;
        /** height in millimeters of the output*/
        physical_height: number;
        /** subpixel orientation of the output*/
        subpixel: number;
        /** textual description of the manufacturer*/
        make: string;
        /** textual description of the model*/
        model: string;
        /** additional transformation applied to buffer contents during presentation*/
        transform: number;
    };
    "wl_output.mode": {
        /** bitfield of mode flags*/
        flags: number;
        /** width of the mode in hardware units*/
        width: number;
        /** height of the mode in hardware units*/
        height: number;
        /** vertical refresh rate in mHz*/
        refresh: number;
    };
    "wl_output.done": {};
    "wl_output.scale": {
        /** scaling factor of output*/
        factor: number;
    };
    "wl_output.name": {
        /** output name*/
        name: string;
    };
    "wl_output.description": {
        /** output description*/
        description: string;
    };
    "xdg_wm_base.ping": {
        /** pass this to the pong request*/
        serial: number;
    };
    "xdg_surface.configure": {
        /** serial of the configure event*/
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
        /** array of 32-bit capabilities*/
        capabilities: number[];
    };
    "xdg_popup.configure": {
        /** x position relative to parent surface window geometry*/
        x: number;
        /** y position relative to parent surface window geometry*/
        y: number;
        /** window geometry width*/
        width: number;
        /** window geometry height*/
        height: number;
    };
    "xdg_popup.popup_done": {};
    "xdg_popup.repositioned": {
        /** reposition request token*/
        token: number;
    };
    "zwp_linux_dmabuf_v1.format": {
        /** DRM_FORMAT code*/
        format: number;
    };
    "zwp_linux_dmabuf_v1.modifier": {
        /** DRM_FORMAT code*/
        format: number;
        /** high 32 bits of layout modifier*/
        modifier_hi: number;
        /** low 32 bits of layout modifier*/
        modifier_lo: number;
    };
    "zwp_linux_buffer_params_v1.created": {
        /** the newly created wl_buffer*/
        buffer: WaylandObjectId2<"wl_buffer">;
    };
    "zwp_linux_buffer_params_v1.failed": {};
    "zwp_linux_dmabuf_feedback_v1.done": {};
    "zwp_linux_dmabuf_feedback_v1.format_table": {
        /** table file descriptor*/
        fd: number;
        /** table size, in bytes*/
        size: number;
    };
    "zwp_linux_dmabuf_feedback_v1.main_device": {
        /** device dev_t value*/
        device: number[];
    };
    "zwp_linux_dmabuf_feedback_v1.tranche_done": {};
    "zwp_linux_dmabuf_feedback_v1.tranche_target_device": {
        /** device dev_t value*/
        device: number[];
    };
    "zwp_linux_dmabuf_feedback_v1.tranche_formats": {
        /** array of 16-bit indexes*/
        indices: number[];
    };
    "zwp_linux_dmabuf_feedback_v1.tranche_flags": {
        /** tranche flags*/
        flags: number;
    };
    "zwp_text_input_v1.enter": {
        surface: number;
    };
    "zwp_text_input_v1.leave": {};
    "zwp_text_input_v1.modifiers_map": {
        map: number[];
    };
    "zwp_text_input_v1.input_panel_state": {
        state: number;
    };
    "zwp_text_input_v1.preedit_string": {
        /** serial of the latest known text input state*/
        serial: number;
        text: string;
        commit: string;
    };
    "zwp_text_input_v1.preedit_styling": {
        index: number;
        length: number;
        style: number;
    };
    "zwp_text_input_v1.preedit_cursor": {
        index: number;
    };
    "zwp_text_input_v1.commit_string": {
        /** serial of the latest known text input state*/
        serial: number;
        text: string;
    };
    "zwp_text_input_v1.cursor_position": {
        index: number;
        anchor: number;
    };
    "zwp_text_input_v1.delete_surrounding_text": {
        index: number;
        length: number;
    };
    "zwp_text_input_v1.keysym": {
        /** serial of the latest known text input state*/
        serial: number;
        time: number;
        sym: number;
        state: number;
        modifiers: number;
    };
    "zwp_text_input_v1.language": {
        /** serial of the latest known text input state*/
        serial: number;
        language: string;
    };
    "zwp_text_input_v1.text_direction": {
        /** serial of the latest known text input state*/
        serial: number;
        direction: number;
    };
};

export type WaylandRequestObj = {
    "wl_display.sync": {
        /** callback object for the sync request*/
        callback: WaylandObjectId2<"wl_callback">;
    };
    "wl_display.get_registry": {
        /** global registry object*/
        registry: WaylandObjectId2<"wl_registry">;
    };
    "wl_registry.bind": {
        /** unique numeric name of the object*/
        name: number;
        /** bounded object*/
        id: WaylandObjectId2<"undefined">;
    };
    "wl_compositor.create_surface": {
        /** the new surface*/
        id: WaylandObjectId2<"wl_surface">;
    };
    "wl_compositor.create_region": {
        /** the new region*/
        id: WaylandObjectId2<"wl_region">;
    };
    "wl_shm_pool.create_buffer": {
        /** buffer to create*/
        id: WaylandObjectId2<"wl_buffer">;
        /** buffer byte offset within the pool*/
        offset: number;
        /** buffer width, in pixels*/
        width: number;
        /** buffer height, in pixels*/
        height: number;
        /** number of bytes from the beginning of one row to the beginning of the next row*/
        stride: number;
        /** buffer pixel format*/
        format: number;
    };
    "wl_shm_pool.destroy": {};
    "wl_shm_pool.resize": {
        /** new size of the pool, in bytes*/
        size: number;
    };
    "wl_shm.create_pool": {
        /** pool to create*/
        id: WaylandObjectId2<"wl_shm_pool">;
        /** file descriptor for the pool*/
        fd: number;
        /** pool size, in bytes*/
        size: number;
    };
    "wl_shm.release": {};
    "wl_buffer.destroy": {};
    "wl_data_offer.accept": {
        /** serial number of the accept request*/
        serial: number;
        /** mime type accepted by the client*/
        mime_type?: string;
    };
    "wl_data_offer.receive": {
        /** mime type desired by receiver*/
        mime_type: string;
        /** file descriptor for data transfer*/
        fd: number;
    };
    "wl_data_offer.destroy": {};
    "wl_data_offer.finish": {};
    "wl_data_offer.set_actions": {
        /** actions supported by the destination client*/
        dnd_actions: number;
        /** action preferred by the destination client*/
        preferred_action: number;
    };
    "wl_data_source.offer": {
        /** mime type offered by the data source*/
        mime_type: string;
    };
    "wl_data_source.destroy": {};
    "wl_data_source.set_actions": {
        /** actions supported by the data source*/
        dnd_actions: number;
    };
    "wl_data_device.start_drag": {
        /** data source for the eventual transfer*/
        source?: number;
        /** surface where the drag originates*/
        origin: number;
        /** drag-and-drop icon surface*/
        icon?: number;
        /** serial number of the implicit grab on the origin*/
        serial: number;
    };
    "wl_data_device.set_selection": {
        /** data source for the selection*/
        source?: number;
        /** serial number of the event that triggered this request*/
        serial: number;
    };
    "wl_data_device.release": {};
    "wl_data_device_manager.create_data_source": {
        /** data source to create*/
        id: WaylandObjectId2<"wl_data_source">;
    };
    "wl_data_device_manager.get_data_device": {
        /** data device to create*/
        id: WaylandObjectId2<"wl_data_device">;
        /** seat associated with the data device*/
        seat: number;
    };
    "wl_surface.destroy": {};
    "wl_surface.attach": {
        /** buffer of surface contents*/
        buffer?: number;
        /** surface-local x coordinate*/
        x: number;
        /** surface-local y coordinate*/
        y: number;
    };
    "wl_surface.damage": {
        /** surface-local x coordinate*/
        x: number;
        /** surface-local y coordinate*/
        y: number;
        /** width of damage rectangle*/
        width: number;
        /** height of damage rectangle*/
        height: number;
    };
    "wl_surface.frame": {
        /** callback object for the frame request*/
        callback: WaylandObjectId2<"wl_callback">;
    };
    "wl_surface.set_opaque_region": {
        /** opaque region of the surface*/
        region?: number;
    };
    "wl_surface.set_input_region": {
        /** input region of the surface*/
        region?: number;
    };
    "wl_surface.commit": {};
    "wl_surface.set_buffer_transform": {
        /** transform for interpreting buffer contents*/
        transform: number;
    };
    "wl_surface.set_buffer_scale": {
        /** scale for interpreting buffer contents*/
        scale: number;
    };
    "wl_surface.damage_buffer": {
        /** buffer-local x coordinate*/
        x: number;
        /** buffer-local y coordinate*/
        y: number;
        /** width of damage rectangle*/
        width: number;
        /** height of damage rectangle*/
        height: number;
    };
    "wl_surface.offset": {
        /** surface-local x coordinate*/
        x: number;
        /** surface-local y coordinate*/
        y: number;
    };
    "wl_seat.get_pointer": {
        /** seat pointer*/
        id: WaylandObjectId2<"wl_pointer">;
    };
    "wl_seat.get_keyboard": {
        /** seat keyboard*/
        id: WaylandObjectId2<"wl_keyboard">;
    };
    "wl_seat.get_touch": {
        /** seat touch interface*/
        id: WaylandObjectId2<"wl_touch">;
    };
    "wl_seat.release": {};
    "wl_pointer.set_cursor": {
        /** serial number of the enter event*/
        serial: number;
        /** pointer surface*/
        surface?: number;
        /** surface-local x coordinate*/
        hotspot_x: number;
        /** surface-local y coordinate*/
        hotspot_y: number;
    };
    "wl_pointer.release": {};
    "wl_keyboard.release": {};
    "wl_output.release": {};
    "wl_region.destroy": {};
    "wl_region.add": {
        /** region-local x coordinate*/
        x: number;
        /** region-local y coordinate*/
        y: number;
        /** rectangle width*/
        width: number;
        /** rectangle height*/
        height: number;
    };
    "wl_region.subtract": {
        /** region-local x coordinate*/
        x: number;
        /** region-local y coordinate*/
        y: number;
        /** rectangle width*/
        width: number;
        /** rectangle height*/
        height: number;
    };
    "wl_subcompositor.destroy": {};
    "wl_subcompositor.get_subsurface": {
        /** the new sub-surface object ID*/
        id: WaylandObjectId2<"wl_subsurface">;
        /** the surface to be turned into a sub-surface*/
        surface: number;
        /** the parent surface*/
        parent: number;
    };
    "wl_subsurface.destroy": {};
    "wl_subsurface.set_position": {
        /** x coordinate in the parent surface*/
        x: number;
        /** y coordinate in the parent surface*/
        y: number;
    };
    "wl_subsurface.place_above": {
        /** the reference surface*/
        sibling: number;
    };
    "wl_subsurface.place_below": {
        /** the reference surface*/
        sibling: number;
    };
    "wl_subsurface.set_sync": {};
    "wl_subsurface.set_desync": {};
    "xdg_wm_base.destroy": {};
    "xdg_wm_base.create_positioner": {
        id: WaylandObjectId2<"xdg_positioner">;
    };
    "xdg_wm_base.get_xdg_surface": {
        id: WaylandObjectId2<"xdg_surface">;
        surface: number;
    };
    "xdg_wm_base.pong": {
        /** serial of the ping event*/
        serial: number;
    };
    "xdg_positioner.destroy": {};
    "xdg_positioner.set_size": {
        /** width of positioned rectangle*/
        width: number;
        /** height of positioned rectangle*/
        height: number;
    };
    "xdg_positioner.set_anchor_rect": {
        /** x position of anchor rectangle*/
        x: number;
        /** y position of anchor rectangle*/
        y: number;
        /** width of anchor rectangle*/
        width: number;
        /** height of anchor rectangle*/
        height: number;
    };
    "xdg_positioner.set_anchor": {
        /** anchor*/
        anchor: number;
    };
    "xdg_positioner.set_gravity": {
        /** gravity direction*/
        gravity: number;
    };
    "xdg_positioner.set_constraint_adjustment": {
        /** bit mask of constraint adjustments*/
        constraint_adjustment: number;
    };
    "xdg_positioner.set_offset": {
        /** surface position x offset*/
        x: number;
        /** surface position y offset*/
        y: number;
    };
    "xdg_positioner.set_reactive": {};
    "xdg_positioner.set_parent_size": {
        /** future window geometry width of parent*/
        parent_width: number;
        /** future window geometry height of parent*/
        parent_height: number;
    };
    "xdg_positioner.set_parent_configure": {
        /** serial of parent configure event*/
        serial: number;
    };
    "xdg_surface.destroy": {};
    "xdg_surface.get_toplevel": {
        id: WaylandObjectId2<"xdg_toplevel">;
    };
    "xdg_surface.get_popup": {
        id: WaylandObjectId2<"xdg_popup">;
        parent?: number;
        positioner: number;
    };
    "xdg_surface.set_window_geometry": {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    "xdg_surface.ack_configure": {
        /** the serial from the configure event*/
        serial: number;
    };
    "xdg_toplevel.destroy": {};
    "xdg_toplevel.set_parent": {
        parent?: number;
    };
    "xdg_toplevel.set_title": {
        title: string;
    };
    "xdg_toplevel.set_app_id": {
        app_id: string;
    };
    "xdg_toplevel.show_window_menu": {
        /** the wl_seat of the user event*/
        seat: number;
        /** the serial of the user event*/
        serial: number;
        /** the x position to pop up the window menu at*/
        x: number;
        /** the y position to pop up the window menu at*/
        y: number;
    };
    "xdg_toplevel.move": {
        /** the wl_seat of the user event*/
        seat: number;
        /** the serial of the user event*/
        serial: number;
    };
    "xdg_toplevel.resize": {
        /** the wl_seat of the user event*/
        seat: number;
        /** the serial of the user event*/
        serial: number;
        /** which edge or corner is being dragged*/
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
        output?: number;
    };
    "xdg_toplevel.unset_fullscreen": {};
    "xdg_toplevel.set_minimized": {};
    "xdg_popup.destroy": {};
    "xdg_popup.grab": {
        /** the wl_seat of the user event*/
        seat: number;
        /** the serial of the user event*/
        serial: number;
    };
    "xdg_popup.reposition": {
        positioner: number;
        /** reposition request token*/
        token: number;
    };
    "wp_viewporter.destroy": {};
    "wp_viewporter.get_viewport": {
        /** the new viewport interface id*/
        id: WaylandObjectId2<"wp_viewport">;
        /** the surface*/
        surface: number;
    };
    "wp_viewport.destroy": {};
    "wp_viewport.set_source": {
        /** source rectangle x*/
        x: number;
        /** source rectangle y*/
        y: number;
        /** source rectangle width*/
        width: number;
        /** source rectangle height*/
        height: number;
    };
    "wp_viewport.set_destination": {
        /** surface width*/
        width: number;
        /** surface height*/
        height: number;
    };
    "zwp_linux_dmabuf_v1.destroy": {};
    "zwp_linux_dmabuf_v1.create_params": {
        /** the new temporary*/
        params_id: WaylandObjectId2<"zwp_linux_buffer_params_v1">;
    };
    "zwp_linux_dmabuf_v1.get_default_feedback": {
        id: WaylandObjectId2<"zwp_linux_dmabuf_feedback_v1">;
    };
    "zwp_linux_dmabuf_v1.get_surface_feedback": {
        id: WaylandObjectId2<"zwp_linux_dmabuf_feedback_v1">;
        surface: number;
    };
    "zwp_linux_buffer_params_v1.destroy": {};
    "zwp_linux_buffer_params_v1.add": {
        /** dmabuf fd*/
        fd: number;
        /** plane index*/
        plane_idx: number;
        /** offset in bytes*/
        offset: number;
        /** stride in bytes*/
        stride: number;
        /** high 32 bits of layout modifier*/
        modifier_hi: number;
        /** low 32 bits of layout modifier*/
        modifier_lo: number;
    };
    "zwp_linux_buffer_params_v1.create": {
        /** base plane width in pixels*/
        width: number;
        /** base plane height in pixels*/
        height: number;
        /** DRM_FORMAT code*/
        format: number;
        /** see enum flags*/
        flags: number;
    };
    "zwp_linux_buffer_params_v1.create_immed": {
        /** id for the newly created wl_buffer*/
        buffer_id: WaylandObjectId2<"wl_buffer">;
        /** base plane width in pixels*/
        width: number;
        /** base plane height in pixels*/
        height: number;
        /** DRM_FORMAT code*/
        format: number;
        /** see enum flags*/
        flags: number;
    };
    "zwp_linux_dmabuf_feedback_v1.destroy": {};
    "zwp_text_input_v1.activate": {
        seat: number;
        surface: number;
    };
    "zwp_text_input_v1.deactivate": {
        seat: number;
    };
    "zwp_text_input_v1.show_input_panel": {};
    "zwp_text_input_v1.hide_input_panel": {};
    "zwp_text_input_v1.reset": {};
    "zwp_text_input_v1.set_surrounding_text": {
        text: string;
        cursor: number;
        anchor: number;
    };
    "zwp_text_input_v1.set_content_type": {
        hint: number;
        purpose: number;
    };
    "zwp_text_input_v1.set_cursor_rectangle": {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    "zwp_text_input_v1.set_preferred_language": {
        language: string;
    };
    "zwp_text_input_v1.commit_state": {
        /** used to identify the known state*/
        serial: number;
    };
    "zwp_text_input_v1.invoke_action": {
        button: number;
        index: number;
    };
    "zwp_text_input_manager_v1.create_text_input": {
        id: WaylandObjectId2<"zwp_text_input_v1">;
    };
};

export type WaylandEnumObj = {
    "wl_display.error": "invalid_object" | "invalid_method" | "no_memory" | "implementation";
    "wl_shm.error": "invalid_format" | "invalid_stride" | "invalid_fd";
    "wl_shm.format": "argb8888" | "xrgb8888" | "c8" | "rgb332" | "bgr233" | "xrgb4444" | "xbgr4444" | "rgbx4444" | "bgrx4444" | "argb4444" | "abgr4444" | "rgba4444" | "bgra4444" | "xrgb1555" | "xbgr1555" | "rgbx5551" | "bgrx5551" | "argb1555" | "abgr1555" | "rgba5551" | "bgra5551" | "rgb565" | "bgr565" | "rgb888" | "bgr888" | "xbgr8888" | "rgbx8888" | "bgrx8888" | "abgr8888" | "rgba8888" | "bgra8888" | "xrgb2101010" | "xbgr2101010" | "rgbx1010102" | "bgrx1010102" | "argb2101010" | "abgr2101010" | "rgba1010102" | "bgra1010102" | "yuyv" | "yvyu" | "uyvy" | "vyuy" | "ayuv" | "nv12" | "nv21" | "nv16" | "nv61" | "yuv410" | "yvu410" | "yuv411" | "yvu411" | "yuv420" | "yvu420" | "yuv422" | "yvu422" | "yuv444" | "yvu444" | "r8" | "r16" | "rg88" | "gr88" | "rg1616" | "gr1616" | "xrgb16161616f" | "xbgr16161616f" | "argb16161616f" | "abgr16161616f" | "xyuv8888" | "vuy888" | "vuy101010" | "y210" | "y212" | "y216" | "y410" | "y412" | "y416" | "xvyu2101010" | "xvyu12_16161616" | "xvyu16161616" | "y0l0" | "x0l0" | "y0l2" | "x0l2" | "yuv420_8bit" | "yuv420_10bit" | "xrgb8888_a8" | "xbgr8888_a8" | "rgbx8888_a8" | "bgrx8888_a8" | "rgb888_a8" | "bgr888_a8" | "rgb565_a8" | "bgr565_a8" | "nv24" | "nv42" | "p210" | "p010" | "p012" | "p016" | "axbxgxrx106106106106" | "nv15" | "q410" | "q401" | "xrgb16161616" | "xbgr16161616" | "argb16161616" | "abgr16161616" | "c1" | "c2" | "c4" | "d1" | "d2" | "d4" | "d8" | "r1" | "r2" | "r4" | "r10" | "r12" | "avuy8888" | "xvuy8888" | "p030";
    "wl_data_offer.error": "invalid_finish" | "invalid_action_mask" | "invalid_action" | "invalid_offer";
    "wl_data_source.error": "invalid_action_mask" | "invalid_source";
    "wl_data_device.error": "role" | "used_source";
    "wl_data_device_manager.dnd_action": "none" | "copy" | "move" | "ask";
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
    "wl_subcompositor.error": "bad_surface" | "bad_parent";
    "wl_subsurface.error": "bad_surface";
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
    "zwp_linux_buffer_params_v1.error": "already_used" | "plane_idx" | "plane_set" | "incomplete" | "invalid_format" | "invalid_dimensions" | "out_of_bounds" | "invalid_wl_buffer";
    "zwp_linux_buffer_params_v1.flags": "y_invert" | "interlaced" | "bottom_first";
    "zwp_linux_dmabuf_feedback_v1.tranche_flags": "scanout";
    "zwp_text_input_v1.content_hint": "none" | "default" | "password" | "auto_completion" | "auto_correction" | "auto_capitalization" | "lowercase" | "uppercase" | "titlecase" | "hidden_text" | "sensitive_data" | "latin" | "multiline";
    "zwp_text_input_v1.content_purpose": "normal" | "alpha" | "digits" | "number" | "phone" | "url" | "email" | "name" | "password" | "date" | "time" | "datetime" | "terminal";
    "zwp_text_input_v1.preedit_style": "default" | "none" | "active" | "inactive" | "highlight" | "underline" | "selection" | "incorrect";
    "zwp_text_input_v1.text_direction": "auto" | "ltr" | "rtl";
};
