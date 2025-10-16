import { getDesktopEntries, getDesktopIcon } from "./sys_api/application";

export const myde = {
    sysApi: {
        getDesktopEntries,
        getDesktopIcon,
    },
};
export type DesktopApi = typeof myde;

export const sysApi = myde.sysApi;
