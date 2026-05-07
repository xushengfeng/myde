import { renderToolsHtmlEl } from "./view/render_tools_el";
import { mapKeyCode } from "./input_map/web2x";
import { getDesktopEntries, getDesktopEntry, getDesktopIcon, refreshDesktopEntries } from "./sys_api/application";
import { getEnv } from "./sys_api/env";
import { vfs } from "./sys_api/fs";
import { server } from "./sys_api/run";
import type { setting } from "./setting/setting";
import type { nowConfig } from "./setting/config";
import { setPowerState } from "./sys_api/login";
import type { SConnect } from "./remote_connect/sconnect";
import type { mpris } from "./sys_api/mpris";
import type { notification } from "./sys_api/notification";
import type { tray } from "./sys_api/appIndicator";
import { power } from "./sys_api/power";

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
    },
    MInputMap: {
        mapKeyCode,
    },
    MUtils: {
        renderToolsHtmlEl,
    },
    MSetting: undefined as unknown as setting<nowConfig>,
    MConnect: undefined as unknown as SConnect,
};
export type DesktopApi = typeof _myde;
export type { DesktopIconConfig } from "./sys_api/application";

declare global {
    var myde: DesktopApi;
}

export type { renderTools } from "./view/render_tools";
export type { WaylandClient, WaylandWinId } from "./view/view";
