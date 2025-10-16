import { getDesktopEntries, getDesktopIcon } from "./sys_api/application";

export const myde = {
    sysApi: {
        getDesktopEntries,
        getDesktopIcon,
    },
    rootDir: "./",
};
export type DesktopApi = typeof myde;

export default myde;
