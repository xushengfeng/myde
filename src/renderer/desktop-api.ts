import { getDesktopEntries, getDesktopIcon } from "./sys_api/application";
import { getEnv } from "./sys_api/env";
import { server } from "./sys_api/run";

export const myde = {
    sysApi: {
        getDesktopEntries,
        getDesktopIcon,
        getEnv,
        server,
    },
    rootDir: "./",
};
export type DesktopApi = typeof myde;

export default myde;

export type { WaylandClient } from "../renderer/view/view";
