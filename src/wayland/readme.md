## 支持的协议

以下协议的错误处理均未实现

- wayland
    - wl_display
    - wl_registry
    - wl_callback
    - wl_compositor
    - wl_shm_pool 部分
    - wl_shm 部分
    - wl_buffer
    - wl_surface 部分
    - wl_seat 还没有 touch
    - wl_pointer 部分
    - wl_keyboard 还没有 repeat
    - wl_output 只是硬编码，还没有添加硬件处理
    - wl_region
    - wl_data_device 部分
    - wl_data_device_manager 部分
    - wl_data_offer 部分
    - wl_data_source 部分
    - wl_subcompositor
    - wl_subsurface 部分

- xdg-shell
    - xdg_wm_base
    - xdg_surface
    - xdg_toplevel 部分
    - xdg_popup 部分
    - xdg_positioner 部分

- text-input-unstable-v1
    - zwp_text_input_v1 部分
    - zwp_text_input_manager_v1
