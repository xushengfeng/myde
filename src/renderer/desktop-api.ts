import { mapKeyCode } from "./input_map/web2x";
import { getDesktopEntries, getDesktopEntry, getDesktopIcon } from "./sys_api/application";
import { getEnv } from "./sys_api/env";
import { server } from "./sys_api/run";
import { renderToolsHtmlEl } from "../renderer/view/render_tools_el";

export const myde = {
    MSysApi: {
        getDesktopEntry,
        getDesktopEntries,
        getDesktopIcon,
        getEnv,
        server,
    },
    MInputMap: {
        mapKeyCode,
    },
    MRootDir: "./",
    MUtils: {
        renderToolsHtmlEl,
    },
};
export type DesktopApi = typeof myde;
export type { DesktopIconConfig } from "./sys_api/application";
declare global {
    interface Window {
        myde: DesktopApi;
    }
}

export type { WaylandClient, WaylandWinId } from "../renderer/view/view";

export type { renderTools } from "../renderer/view/render_tools";
