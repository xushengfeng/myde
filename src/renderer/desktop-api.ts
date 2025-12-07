import { mapKeyCode } from "./input_map/web2x";
import { getDesktopEntries, getDesktopIcon, type DesktopIconConfig as dskIcon } from "./sys_api/application";
import { getEnv } from "./sys_api/env";
import { server } from "./sys_api/run";

export const myde = {
    MSysApi: {
        getDesktopEntries,
        getDesktopIcon,
        getEnv,
        server,
    },
    MInputMap: {
        mapKeyCode,
    },
    MRootDir: "./",
};
export type DesktopApi = typeof myde;
export type DesktopIconConfig = dskIcon;
declare global {
    interface Window {
        myde: DesktopApi;
    }
}

export type { WaylandClient } from "../renderer/view/view";
