import type { ElType } from "dkh-ui";
import type { Registry } from "./registry";
import type { BooleanRegistryKeys, RegistrySchema } from "./registry_schema";
import { dynamicScrollList } from "./scroll-list";
import { px, sSize, uBatteryInfo, uBatteryRow, uChoiceRow, uSegmented, uSwitch } from "./ui";

/** registry 驱动的一个工具控件；toggle 供整行点击等场景切换 */
export interface ControlNode {
    id: string;
    type: string;
    el: ElType<HTMLElement>;
    toggle?(): void;
    unmount?(): void;
}

export function createToggle(registry: Registry<RegistrySchema>, id: BooleanRegistryKeys): ControlNode {
    const source = registry.get(id);
    const sw = uSwitch(false, (value) => source.set?.(value));
    const unsub = source.getAndSubscribe((v) => sw.setValue(v));
    return { id, type: "toggle", el: sw.el, toggle: sw.toggle, unmount: unsub };
}

export interface ToolPoolOptions {
    /** 点击互联设备行的动作；main.ts 接真实 connect，预览里改成修改 mock 数据 */
    toggleConnectDevice?: (device: RegistrySchema["connect.devices[]"]) => Promise<void>;
    /** 点击 Wi-Fi 接入点行的动作：已连接时断开，否则连接该 SSID */
    toggleWifiAccessPoint?: (ap: RegistrySchema["wifi.accessPoints[]"]) => Promise<void>;
    /** 点击蓝牙设备行的动作：已连接时断开，否则连接 */
    toggleBlueDevice?: (device: RegistrySchema["blue.devices[]"]) => Promise<void>;
}

/**
 * 网络 / 蓝牙 / 互联 / 电源弹窗里由 registry 驱动的控件。
 * `main.ts` 传真实 registry，`test/ui_example/ui_demo.ts` 传假数据，两边跑同一套订阅。
 */
export function createToolPool(registry: Registry<RegistrySchema>, op?: ToolPoolOptions) {
    return {
        powerBattery: () => {
            const percentage = registry.get("power.battery");
            const charging = registry.get("power.battery.charging");
            const info = uBatteryInfo({ percentage: 0, charging: false });
            let percentageValue = 0;
            let chargingValue = false;
            const unsubPercentage = percentage.getAndSubscribe((v) => {
                percentageValue = v;
                info.setValue(percentageValue, chargingValue);
            });
            const unsubCharging = charging.getAndSubscribe((v) => {
                chargingValue = v;
                info.setValue(percentageValue, chargingValue);
            });
            return {
                id: "power.battery",
                type: "indicator",
                el: info.el,
                unmount: () => {
                    unsubPercentage();
                    unsubCharging();
                },
            };
        },
        powerDevices: () => {
            const source = registry.get("power.devices");
            const us: (() => void)[] = [];
            const container = dynamicScrollList<string>({
                itemSize: sSize(1.5),
                containerSize: sSize(1.5) * 4,
                direction: "down",
                keyExtractor: (x) => x,
                renderItem: (k) => {
                    const row = uBatteryRow("", 0);
                    const s = registry.get(k as "power.devices[]").getAndSubscribe((v) => {
                        row.setValue(v.name, v.percentage);
                    });
                    us.push(s);
                    return row.el;
                },
            });

            const unsub = source.getAndSubscribe(async (ids) => {
                container.setList(ids);
            });
            return {
                id: "power.devices",
                type: "dynamic-list",
                el: container.el.style({ width: px(sSize(6)) }),
                unmount: () => {
                    unsub();
                    for (const s of us) s();
                },
            };
        },
        powerProfiles: () => {
            const source = registry.get("power.profiles");
            const activeSource = registry.get("power.profile");
            const segments = uSegmented<string>({
                items: [],
                onChange: (name) => registry.get("power.profile").set?.(name),
            });
            const unsubActive = activeSource.getAndSubscribe((v) => segments.setValue(v));
            const unsubs: (() => void)[] = [];
            const unsub = source.getAndSubscribe((ids) => {
                for (const u of unsubs) u();
                unsubs.length = 0;
                const data = new Map<string, { name: string; label: string }>();
                const refresh = () => {
                    const items = ids
                        .map((id) => data.get(id))
                        .filter((v): v is { name: string; label: string } => !!v)
                        .map((v) => ({ label: v.label, value: v.name }));
                    segments.setItems(items);
                };
                for (const id of ids) {
                    const us = registry.get(id as "power.profiles[]").getAndSubscribe((v) => {
                        data.set(id, { name: v.name, label: v.label });
                        refresh();
                    });
                    unsubs.push(us);
                }
            });
            return {
                id: "power.profiles",
                type: "dynamic-list",
                el: segments.el,
                unmount: () => {
                    unsub();
                    unsubActive();
                    for (const u of unsubs) u();
                },
            };
        },
        wifiToggle: () => createToggle(registry, "wifi.enabled"),
        wifiAccessPoints: () => {
            const source = registry.get("wifi.accessPoints");
            const us: (() => void)[] = [];
            let wifiEnabled = false;
            const unsubEnabled = registry.get("wifi.enabled").getAndSubscribe((v) => {
                wifiEnabled = v;
            });
            const container = dynamicScrollList<string>({
                itemSize: sSize(1.5),
                containerSize: sSize(1.5) * 4,
                direction: "down",
                keyExtractor: (x) => x,
                renderItem: (k) => {
                    let canClick = false;
                    const row = uChoiceRow({
                        label: "",
                        detail: "",
                        onClick: async () => {
                            if (!canClick) return;
                            const ap = await registry.get(k as "wifi.accessPoints[]").get();
                            if (!ap || !(await registry.get("wifi.enabled").get())) return;
                            try {
                                await op?.toggleWifiAccessPoint?.(ap);
                            } catch (error) {
                                console.warn("wifi: toggle access point failed", ap.ssid, error);
                            }
                        },
                    });
                    const s = registry.get(k as "wifi.accessPoints[]").getAndSubscribe((v) => {
                        canClick = v.connected || wifiEnabled;
                        row.setLabel(v.ssid);
                        row.setDetail(v.connected ? "已连接" : "");
                        row.setSelected(v.connected);
                        row.el.style({ cursor: canClick ? "pointer" : "default" });
                    });
                    us.push(s);
                    return row.el;
                },
            });

            const unsub = source.getAndSubscribe(async (ids) => {
                container.setList(ids);
            });
            return {
                id: "wifi.devices",
                type: "dynamic-list",
                el: container.el.style({ width: px(sSize(6)) }),
                unmount: () => {
                    unsub();
                    unsubEnabled();
                    for (const s of us) s();
                },
            };
        },
        connectToggle: () => createToggle(registry, "connect.enabled"),
        connectDevices: () => {
            const source = registry.get("connect.devices");
            const us: (() => void)[] = [];
            let connectEnabled = false;
            const unsubEnabled = registry.get("connect.enabled").getAndSubscribe((v) => {
                connectEnabled = v;
            });
            const container = dynamicScrollList<string>({
                itemSize: sSize(1.5),
                containerSize: sSize(1.5) * 4,
                direction: "down",
                keyExtractor: (x) => x,
                renderItem: (k) => {
                    let canClick = false;
                    const row = uChoiceRow({
                        label: "",
                        detail: "",
                        onClick: async () => {
                            if (!canClick) return;
                            const device = await registry.get(k as "connect.devices[]").get();
                            if (!device || !(await registry.get("connect.enabled").get())) return;
                            try {
                                await op?.toggleConnectDevice?.(device);
                            } catch (error) {
                                console.warn("connect: toggle device failed", device.id, error);
                            }
                        },
                    });
                    const s = registry.get(k as "connect.devices[]").getAndSubscribe((v) => {
                        canClick = v.connected || connectEnabled;
                        row.setLabel(v.name);
                        row.setDetail(v.connected ? "已连接" : v.remembered ? "已记忆" : "临时");
                        row.setSelected(v.connected);
                        row.el.style({ cursor: canClick ? "pointer" : "default" });
                    });
                    us.push(s);
                    return row.el;
                },
            });

            const unsub = source.getAndSubscribe(async (ids) => {
                container.setList(ids);
            });
            return {
                id: "connect.devices",
                type: "dynamic-list",
                el: container.el.style({ width: px(sSize(6)) }),
                unmount: () => {
                    unsub();
                    unsubEnabled();
                    for (const s of us) s();
                },
            };
        },
        blueToggle: () => createToggle(registry, "blue.power"),
        blueDevices: () => {
            const source = registry.get("blue.devices");
            const us: (() => void)[] = [];
            let powered = false;
            const unsubPowered = registry.get("blue.power").getAndSubscribe((v) => {
                powered = v;
            });
            const container = dynamicScrollList<string>({
                itemSize: sSize(1.5),
                containerSize: sSize(1.5) * 4,
                direction: "down",
                keyExtractor: (x) => x,
                renderItem: (k) => {
                    let canClick = false;
                    const row = uChoiceRow({
                        label: "",
                        detail: "",
                        onClick: async () => {
                            if (!canClick) return;
                            const device = await registry.get(k as "blue.devices[]").get();
                            if (!device || !(await registry.get("blue.power").get())) return;
                            try {
                                await op?.toggleBlueDevice?.(device);
                            } catch (error) {
                                console.warn("blue: toggle device failed", device.address, error);
                            }
                        },
                    });
                    const s = registry.get(k as "blue.devices[]").getAndSubscribe((v) => {
                        canClick = v.connected || powered;
                        row.setLabel(v.name);
                        row.setDetail(v.connected ? "已连接" : "");
                        row.setSelected(v.connected);
                        row.el.style({ cursor: canClick ? "pointer" : "default" });
                    });
                    us.push(s);
                    return row.el;
                },
            });

            const unsub = source.getAndSubscribe(async (ids) => {
                container.setList(ids);
            });
            return {
                id: "blue.devices",
                type: "dynamic-list",
                el: container.el.style({ width: px(sSize(6)) }),
                unmount: () => {
                    unsub();
                    unsubPowered();
                    for (const s of us) s();
                },
            };
        },
    };
}
