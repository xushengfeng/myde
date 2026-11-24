import type { MenuItem } from "../../../src/sys_api/menu";

/** 特殊 id 类型，表示可以用 registry.get 获取 */
export type id<T extends string = string> = string & { __brand: T };

/** RegistrySchema 定义所有键值对类型 */
export interface RegistrySchema {
    "power.battery": number;
    "power.battery.charging": boolean;
    "power.lidClosed": boolean;
    "power.devices": id<"power.devices[]">[];
    "power.devices[]": {
        name: string;
        percentage: number;
        status:
            | "Charging"
            | "Discharging"
            | "Empty"
            | "Fully charged"
            | "Pending charge"
            | "Pending discharge"
            | "Unknown";
    };
    "power.profiles": id<"power.profiles[]">[];
    "power.profiles[]": {
        name: string;
        label: string;
    };
    "power.profile": string;
    "wifi.enabled": boolean;
    "wifi.accessPoints": id<"wifi.accessPoints[]">[];
    "wifi.accessPoints[]": {
        ssid: string;
        connected: boolean;
    };
    "connect.enabled": boolean;
    "connect.id": string;
    "connect.devices": id<"connect.devices[]">[];
    "connect.devices[]": {
        id: string;
        name: string;
        connected: boolean;
        remembered: boolean;
    };
    "blue.power": boolean;
    "blue.devices": id<"blue.devices[]">[];
    "blue.devices[]": {
        address: string;
        name: string;
        connected: boolean;
    };
    "notification.list": id<"notification.list[]">[];
    "notification.list[]": {
        /** summary */
        title: string;
        /** body */
        content: string;
        id: number;
        appName: string;
        appIcon: string;
        actions: string[];
        hints: Record<string, unknown>;
        expireTimeout: number;
        replacesId: number;
        closed: boolean;
        /** 1 超时 / 2 用户关闭 / 3 CloseNotification；活动通知为 0 */
        reason: number;
    };
    "notification.list[].delete": boolean;
    "media.list": id<"media.list[]">[];
    "media.list[]": {
        title: string;
        cover: string;
        artist: string[];
        duration: number;
    };
    "media.list[].play": boolean;
    "media.list[].next": boolean;
    "media.list[].previous": boolean;
    "media.list[].currentTime": number;
    "tray.list": id<"tray.list[]">[];
    "tray.list[]": {
        icon: string;
        title: string;
        itemIsMenu: boolean;
    };
    "tray.list[].active": boolean;
    "tray.list[].menu": MenuItem[];
    "volume.output.default.muted": boolean;
    "volume.input.default.muted": boolean;
    "volume.output.default.volume": number;
    "volume.input.default.volume": number;
    "brightness.displays": id<"brightness.displays[]">[];
    "brightness.displays[]": {
        name: string;
        kind: "backlight" | "ddc";
        writable: boolean;
    };
    "brightness.displays[].brightness": number;
    "time.hour": number;
    "time.minute": number;
    "time.second": number;
    "time.year": number;
    "time.month": number;
    "time.day": number;
    "time.weekday": number;
}

/** 可以整行点击切换的布尔键 */
export type BooleanRegistryKeys = "wifi.enabled" | "blue.power" | "connect.enabled";
