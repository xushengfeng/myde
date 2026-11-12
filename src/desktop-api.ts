import type { InputManager } from "myde-input";
import type { Connect } from "./connect/connect";
import { absPosMapping, absRange, absRatio } from "./input_map/abs";
import { mapKeyCode } from "./input_map/web2x";
import type { nowConfig } from "./setting/config";
import type { setting } from "./setting/setting";
import { getPid, getPidTree } from "./sys_api/app_control";
import type { tray } from "./sys_api/appIndicator";
import { getDesktopEntries, getDesktopEntry, getDesktopIcon, refreshDesktopEntries } from "./sys_api/application";
import type { blue } from "./sys_api/blue";
import type { display } from "./sys_api/display";
import { getEnv } from "./sys_api/env";
import { vfs } from "./sys_api/fs";
import type { inputMethod } from "./sys_api/input_method";
import type { inputSim } from "./sys_api/input_sim";
import { setPowerState } from "./sys_api/login";
import type { mpris } from "./sys_api/mpris";
import type { network } from "./sys_api/network";
import type { notification } from "./sys_api/notification";
import type { polkit } from "./sys_api/polkit";
import type { power } from "./sys_api/power";
import { server } from "./sys_api/run";
import type { volumeControl } from "./sys_api/volume";
import type { xdgDesktopPortal } from "./sys_api/xdg_desktop_portal/xdg_desktop_portal";
import { throttle } from "./utils/throttle";
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
        polkit: undefined as unknown as polkit,
        display: undefined as unknown as display,
        input: undefined as unknown as InputManager,
        inputSim: undefined as unknown as inputSim,
        inputMethod: undefined as unknown as inputMethod,
        volume: undefined as unknown as volumeControl,
        portal: undefined as unknown as xdgDesktopPortal,
        appControl: {
            getPidTree,
            getPid,
        },
    },
    MInputMap: {
        mapKeyCode,
        absRange,
        absRatio,
        absPosMapping,
    },
    MUtils: {
        renderToolsHtmlEl,
        throttle,
    },
    MSetting: undefined as unknown as setting<nowConfig>,
    MConnect: undefined as unknown as () => Connect,
};
export type DesktopApi = typeof _myde;
export type { ConnectConnection, ConnectEvents, PairingSession } from "./connect/connect";
export type { DesktopIconConfig } from "./sys_api/application";

declare global {
    var myde: DesktopApi;
}

export type {
    AppError,
    AxisInfo,
    DeviceCapabilities,
    DeviceError,
    DeviceInfo,
    DeviceType,
    InputDevice,
    InputDeviceEvents,
    InputEvent,
    InputManager,
    InputManagerEvents,
    Result,
    TouchInfo,
} from "myde-input";
export type { AbsRatioMapping } from "./input_map/abs";
export type {
    InputSimHost,
    InputSource,
    SimEventInit,
    UniInputEvent,
    UniKeyEvent,
    UniPointerEvent,
} from "./sys_api/input_sim";
export type { PolkitAuthRequest, PolkitAuthResult, PolkitEvents, PolkitIdentity } from "./sys_api/polkit";
export type {
    FileChooserMode,
    FileChooserRequest,
    FileChooserSelection,
    PortalAcceptResult,
    PortalChoice,
    PortalChoiceOption,
    PortalDirEntry,
    PortalFileKind,
    PortalFilter,
    PortalFilterRule,
    PortalPlace,
    PortalStat,
} from "./sys_api/xdg_desktop_portal/xdg_desktop_portal";
export type {
    Client,
    CursorState,
    PointerCommand,
    Rect,
    renderTools,
    ScrollCommand,
    ServerEvents,
    ServerNotifyMap,
    ServerRequests,
    Size,
    TextInputState,
    WaylandWinId,
    WindowInfo,
    WindowStates,
    WinHandle,
} from "./wayland";
