import type { Connect } from "./connect/connect";
import { mapKeyCode } from "./input_map/web2x";
import type { nowConfig } from "./setting/config";
import type { setting } from "./setting/setting";
import type { tray } from "./sys_api/appIndicator";
import { getDesktopEntries, getDesktopEntry, getDesktopIcon, refreshDesktopEntries } from "./sys_api/application";
import type { blue } from "./sys_api/blue";
import type { display } from "./sys_api/display";
import { getEnv } from "./sys_api/env";
import { vfs } from "./sys_api/fs";
import type { InputManager } from "./sys_api/input";
import { setPowerState } from "./sys_api/login";
import type { mpris } from "./sys_api/mpris";
import type { network } from "./sys_api/network";
import type { notification } from "./sys_api/notification";
import type { power } from "./sys_api/power";
import { server } from "./sys_api/run";
import { renderToolsHtmlEl } from "./wayland/render_tools_el";

export const _myde = {
    MSysApi: {
        getDesktopEntry,
        getDesktopEntries,
        getDesktopIcon,
        refreshDesktopEntries,
        getEnv,
        server,
        fs: new vfs("/"),
        login: setPowerState,
        media: undefined as unknown as mpris,
        notification: undefined as unknown as notification,
        verifyUserPassword: async (_password: string) => {
            return false;
        },
        tray: undefined as unknown as tray,
        power: undefined as unknown as power,
        blue: undefined as unknown as blue,
        network: undefined as unknown as network,
        display: undefined as unknown as display,
        input: undefined as unknown as InputManager,
    },
    MInputMap: {
        mapKeyCode,
    },
    MUtils: {
        renderToolsHtmlEl,
    },
    MSetting: undefined as unknown as setting<nowConfig>,
    MConnect: undefined as unknown as (id: string) => Connect,
};
export type DesktopApi = typeof _myde;
export type { DesktopIconConfig } from "./sys_api/application";

declare global {
    var myde: DesktopApi;
}

export type { renderTools } from "./wayland/render_tools";
export type { WaylandClient, WaylandWinId } from "./wayland/server";
