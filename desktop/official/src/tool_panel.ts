import type { ElType } from "dkh-ui";
import { txt } from "dkh-ui";
import type { Registry } from "./registry";
import type { RegistrySchema } from "./registry_schema";
import { attachBatteryFx, attachOrbitFx, attachRippleFx } from "./tool_fx";
import { createToolPool, type ToolPoolOptions } from "./tool_pool";
import { aLineText, gTextStyle, px, sSize, sSize2, ui, uToggleRow } from "./ui";

/**
 * 工具栏弹窗的装配：外层 L1 宽度、固定高度列表、L2 信息行，以及网络 / 蓝牙 / 互联 / 电源的弹窗结构。
 * 真实弹窗的数据来自 registry（见 main.ts），`test/ui_example/ui_demo.ts` 用同一套函数装静态样例，
 * 改弹窗结构只改这里。
 */

/** 开关行接受的控件；uSwitch 与 uipool 的 toggle 都满足 */
export type ToggleControl = { el: ElType<HTMLElement>; toggle?: () => void };

/** 弹窗的 L1 容器：固定宽度，列表隐藏时也不改变弹窗宽度 */
export function tPanel(els: ElType<HTMLElement>[]) {
    const panel = ui.bar(els);
    panel.el.style({ width: px(sSize(6)) });
    return panel.el;
}

/** 弹窗里的固定高度 L2 列表容器 */
export function tListPanel(rows: ElType<HTMLElement> | ElType<HTMLElement>[], height = sSize(1.5) * 4) {
    return ui
        .barItem()
        .style({ height: px(height) })
        .add(rows);
}

/** 单行 L2 信息条：垂直居中，左右留 paddingx */
export function tInfoRow(content: ElType<HTMLElement> | ElType<HTMLElement>[], op?: { gap?: number }) {
    const row = ui.barItem().style({
        height: px(sSize(1.5)),
        display: "flex",
        alignItems: "center",
        padding: `0 ${px(sSize2.paddingx)}`,
        boxSizing: "border-box",
    });
    if (op?.gap !== undefined) row.style({ gap: px(op.gap) });
    row.add(content);
    return row;
}

/** 互联弹窗的本机 ID 行：标签 + 可选中、右对齐、单行省略的 ID */
export function tConnectIdRow(idValue: ElType<HTMLElement>) {
    idValue.style({
        ...gTextStyle.caption,
        color: gTextStyle.color.secondary,
        fontFamily: gTextStyle.monoFamily,
        flexGrow: "1",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        textAlign: "right",
        userSelect: "text",
    });
    return tInfoRow(
        [
            aLineText()
                .sv("本机 ID")
                .style({
                    ...gTextStyle.caption,
                    color: gTextStyle.color.secondary,
                    flexShrink: "0",
                }),
            idValue,
        ],
        { gap: sSize2.paddingx },
    );
}

/** 电池信息行 + 电量动效；registry 订阅和静态预览共用 */
export function tBatteryBar(info: ElType<HTMLElement>) {
    const el = tInfoRow(info);
    return { el, fx: attachBatteryFx(el) };
}

function createTogglePanel(op: {
    label: string;
    icon: string;
    control: ToggleControl;
    list: ElType<HTMLElement> | ElType<HTMLElement>[];
    extra?: ElType<HTMLElement>[];
    fx: { kind: "ripple"; color: string; from: "bottom" | "left" } | { kind: "orbit"; color: string };
}) {
    const row = uToggleRow(op.label, op.control, { icon: op.icon });
    const fx =
        op.fx.kind === "orbit"
            ? attachOrbitFx(row, { color: op.fx.color })
            : attachRippleFx(row, { color: op.fx.color, from: op.fx.from });
    const listBar = tListPanel(op.list);
    return {
        el: tPanel([row, ...(op.extra ?? []), listBar]),
        setActive: (active: boolean) => fx.setActive(active),
        setVisible: (visible: boolean) => fx.setVisible(visible),
        setListVisible: (visible: boolean) => listBar.style({ display: visible ? "" : "none" }),
    };
}

/** Wi-Fi 弹窗：开关行 + 接入点列表 */
export function tWifiPanel(op: { control: ToggleControl; list: ElType<HTMLElement> | ElType<HTMLElement>[] }) {
    return createTogglePanel({
        label: "Wi-Fi",
        icon: "wifi",
        control: op.control,
        list: op.list,
        fx: { kind: "ripple", color: "rgba(34, 197, 94, 0.65)", from: "bottom" },
    });
}

/** 蓝牙弹窗：开关行 + 设备列表 */
export function tBluePanel(op: { control: ToggleControl; list: ElType<HTMLElement> | ElType<HTMLElement>[] }) {
    return createTogglePanel({
        label: "蓝牙",
        icon: "blue",
        control: op.control,
        list: op.list,
        fx: { kind: "ripple", color: "rgba(0, 122, 255, 0.6)", from: "left" },
    });
}

/** 互联弹窗：开关行 + 本机 ID + 设备列表 */
export function tConnectPanel(op: {
    control: ToggleControl;
    idValue: ElType<HTMLElement>;
    list: ElType<HTMLElement> | ElType<HTMLElement>[];
}) {
    return createTogglePanel({
        label: "互联",
        icon: "connect",
        control: op.control,
        list: op.list,
        extra: [tConnectIdRow(op.idValue)],
        fx: { kind: "orbit", color: "rgba(139, 92, 246, 0.75)" },
    });
}

/** 电源弹窗：电池信息 + 性能模式 + 设备电池列表；后两段可单独隐藏 */
export function tPowerPanel(op: {
    info: ElType<HTMLElement>;
    profiles?: ElType<HTMLElement>;
    devices?: ElType<HTMLElement>;
}) {
    const battery = tBatteryBar(op.info);
    const profilesBar = op.profiles
        ? ui
              .barItem()
              .style({ height: px(sSize(1)) })
              .add(op.profiles)
        : undefined;
    const devicesBar = op.devices ? tListPanel(op.devices) : undefined;
    return {
        el: tPanel([battery.el, ...(profilesBar ? [profilesBar] : []), ...(devicesBar ? [devicesBar] : [])]),
        fx: battery.fx,
        setVisible: (visible: boolean) => battery.fx.setVisible(visible),
        setProfilesVisible: (visible: boolean) => profilesBar?.style({ display: visible ? "" : "none" }),
        setDevicesVisible: (visible: boolean) => devicesBar?.style({ display: visible ? "" : "none" }),
    };
}

/** Wi-Fi 弹窗 + registry 订阅：开关状态、接入点列表显隐 */
export function createWifiPanel(registry: Registry<RegistrySchema>) {
    const pool = createToolPool(registry);
    const panel = tWifiPanel({ control: pool.wifiToggle(), list: pool.wifiAccessPoints().el });
    registry.get("wifi.enabled").getAndSubscribe((v) => panel.setActive(v));
    registry.get("wifi.accessPoints").getAndSubscribe((ids) => panel.setListVisible(ids.length > 0));
    return panel;
}

/** 蓝牙弹窗 + registry 订阅：开关状态、设备列表显隐 */
export function createBluePanel(registry: Registry<RegistrySchema>) {
    const pool = createToolPool(registry);
    const panel = tBluePanel({ control: pool.blueToggle(), list: pool.blueDevices().el });
    registry.get("blue.power").getAndSubscribe((v) => panel.setActive(v));
    registry.get("blue.devices").getAndSubscribe((ids) => panel.setListVisible(ids.length > 0));
    return panel;
}

/** 互联弹窗 + registry 订阅：开关状态、本机 ID、设备列表显隐与点击连接 */
export function createConnectPanel(registry: Registry<RegistrySchema>, op?: ToolPoolOptions) {
    const pool = createToolPool(registry, op);
    const idValue = txt("");
    registry.get("connect.id").getAndSubscribe((id) => idValue.sv(id));
    const panel = tConnectPanel({ control: pool.connectToggle(), idValue, list: pool.connectDevices().el });
    registry.get("connect.enabled").getAndSubscribe((v) => panel.setActive(v));
    registry.get("connect.devices").getAndSubscribe((ids) => panel.setListVisible(ids.length > 0));
    return panel;
}

/** 电源弹窗 + registry 订阅：电量、充电、性能模式、设备列表 */
export function createPowerPanel(registry: Registry<RegistrySchema>) {
    const pool = createToolPool(registry);
    const panel = tPowerPanel({
        info: pool.powerBattery().el,
        profiles: pool.powerProfiles().el,
        devices: pool.powerDevices().el,
    });
    registry.get("power.battery").getAndSubscribe((v) => panel.fx.setPercentage(v));
    registry.get("power.battery.charging").getAndSubscribe((v) => panel.fx.setCharging(v));
    registry.get("power.profile").getAndSubscribe((v) => panel.fx.setProfile(v));
    registry.get("power.profiles").getAndSubscribe((ids) => panel.setProfilesVisible(ids.length > 0));
    registry.get("power.devices").getAndSubscribe((ids) => panel.setDevicesVisible(ids.length > 0));
    return panel;
}
