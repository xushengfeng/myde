# myde

[中文](./README.md)

A Linux Wayland desktop environment (compositor) built on Electron. It parses Wayland protocols via JavaScript and renders native applications (e.g. Firefox) onto a Canvas, rather than relying on custom Web software.

> **Current Status**: In development, only a subset of applications are supported.

## Vision

myde demonstrates the potential of web technology stacks for desktop environments (previously explored by [term.everything](https://github.com/mmulet/term.everything/tree/typescript) and [greenfield](https://github.com/udevbe/greenfield)).

Frontend developers' enthusiasm for art design, UX interaction, and "building wheels" naturally suits desktop window manager development. In fact, KWin and GNOME already offer more or less programmable interfaces for frontend developers.

myde goes further: it handles application rendering to Canvas and some input events, while composition and drawing are handled by Chrome. Everything else — window management, decorations, desktop components, taskbar, etc. — is fully customizable by developers. This means you can design cutting-edge interfaces, replicate Windows/macOS styles, or even adapt to phone or tablet layouts. Developers don't need to deal with low-level display protocols or manually manage memory, working in a more convenient environment than C/Rust, with the hope of fostering a more usable and feature-rich Linux desktop.

The project uses a modular plugin architecture, allowing users to switch between downloaded desktop implementations.

## Current Progress

Only a small number of example applications can display correctly. Custom desktop APIs are unstable — treat this as a **tech demo**. The project is in **Alpha** stage and will move to Beta when it becomes my daily desktop environment. For more limitations, see [Limitations](#limitations).

![Screenshot](https://s1.img-e.com/20260630/6a43d2956b2a3.png)

> Background is KDE, light blue area is myde, running on a KDE host desktop.

## Running

### Requirements

- Linux system with X11 or Wayland session running
- `xwayland-satellite` installed

### Install Dependencies

(`pnpm` can be replaced with `npm` if preferred)

```shell
pnpm i
```

### Start Desktop

- Start default desktop:
    ```shell
    pnpm run desktop:offical
    ```
- Start simple Windows-style demo desktop:
    ```shell
    pnpm run desktop:example
    ```

A window will pop up where you can launch system-installed applications.

## Development

For development details, see [AGENTS.md](./AGENTS.md), which is oriented towards developers and LLM tools.

### Custom Desktop Development

- Default desktop implementation is in `desktop/` for reference.
- Provides window management API, unified settings/interconnect API, and numerous system APIs (e.g. MPRIS media control, notifications, battery, Bluetooth, Wi-Fi, etc.). For progress and supported protocol list, see [Wayland Protocol Support](./src/wayland/readme.md) and [Desktop API Documentation](./desktop/readme.md).

> **License Note**: Although this project uses AGPL-3, custom desktop plugins are theoretically not infected. For user safety and community prosperity, it is recommended to open source for community review; while keeping personal copyright, you may use a stricter license.

## Limitations

### Current Known Limitations

- Due to Electron's inability to output directly to native displays, the desktop can only be shown as a window (similar to launching Weston via a window). To serve as a real desktop, a host desktop is needed, then launch myde in fullscreen mode.
- Applications that display correctly: `weston-*` related example apps, `gtk4-demos`, `google-chrome`, `firefox`, etc. Applications relying on GPU rendering (e.g. Blender) cannot display correctly.
- Many protocols are supported but implementations have deviations; details need refinement.

### Long-term Performance Concerns

- JavaScript may consume more resources than necessary.

## Architecture

myde is built on Node.js and the Electron framework, using Node.js native modules and system-level components (e.g. Wayland client, dbus) for inter-process communication via Unix sockets. All Wayland protocol messages are parsed and processed by JavaScript, reading or mapping graphics resources, and finally rendering via Canvas in Electron's renderer process (i.e. the web page).

### Native Programming Used

- Node.js core libraries such as `fs`
- Electron APIs like `sharedTexture`
- Unix socket library (Node.js built-in socket library doesn't support fd transfer)
- PAM module
