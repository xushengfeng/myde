import { renderToolsHtmlEl } from "./view/render_tools_el";
import { mapKeyCode } from "./input_map/web2x";
import { getDesktopEntries, getDesktopEntry, getDesktopIcon, refreshDesktopEntries } from "./sys_api/application";
import { getEnv } from "./sys_api/env";
import { vfs } from "./sys_api/fs";
import { server } from "./sys_api/run";
import type { setting } from "./setting/setting";
import type { nowConfig } from "./setting/config";

export const _myde = {
    MSysApi: {
        getDesktopEntry,
        getDesktopEntries,
        getDesktopIcon,
        refreshDesktopEntries,
        getEnv,
        server,
        fs: new vfs("/"),
    },
    MInputMap: {
        mapKeyCode,
    },
    MUtils: {
        renderToolsHtmlEl,
    },
    MSetting: undefined as unknown as setting<nowConfig>,
};
export type DesktopApi = typeof _myde;
export type { DesktopIconConfig } from "./sys_api/application";

declare global {
    var myde: DesktopApi;
}

export type { renderTools } from "./view/render_tools";
export type { WaylandClient, WaylandWinId } from "./view/view";
