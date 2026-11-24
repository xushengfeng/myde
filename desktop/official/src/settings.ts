import { button, dynamicSelect, type ElType, image, input, select, spacer, txt, view } from "dkh-ui";
import type { ConnectConnection, PairingSession } from "../../../src/desktop-api";
import { createFrameChart } from "./frame_chart";
import { aLineText, gGlassStyle, gTextStyle, px, sSize2 } from "./ui";
import type { WallpaperSlot } from "./wallpaper";

export type ImePanelPreeditMode = "auto" | "always" | "never";

/** 设置窗口的内容只通过这组读写函数接触设置，窗口外壳由桌面负责 */
export type SettingsContentOptions = {
    getIconTheme(): string;
    setIconTheme(theme: string): void;
    /** 当前壁纸 data URL（没有自定义或读取失败时是桌面自带壁纸） */
    getWallpaper(slot: WallpaperSlot): string;
    isDefaultWallpaper(slot: WallpaperSlot): boolean;
    /** 读取自定义壁纸失败的原因；设置里保留路径，方便文件恢复后再次加载 */
    getWallpaperError(slot: WallpaperSlot): string | undefined;
    /** 打开桌面自己的文件选择器选择图片 */
    chooseWallpaper(slot: WallpaperSlot): void;
    /** 恢复桌面自带壁纸 */
    resetWallpaper(slot: WallpaperSlot): void;
    subscribeWallpaper(callback: () => void): () => void;
    /** 桌面绘制的窗口圆角（视觉 px） */
    getWindowRadius(): number;
    setWindowRadius(radius: number): void;
    getImePanelPreedit(): ImePanelPreeditMode;
    setImePanelPreedit(mode: ImePanelPreeditMode): void;
    getCenterWindows(): boolean;
    setCenterWindows(enabled: boolean): void;
    /** Wayland 客户端/窗口缩放（1 = 100%） */
    getScale(): number;
    setScale(scale: number): void;
    /** winit / 普通窗口模式跟随宿主缩放，不提供额外缩放 */
    scaleFollowsHost(): boolean;
    /** 当前分辨率 */
    getResolution(): { width: number; height: number };
    /** 可切换的分辨率 */
    getResolutions(): { width: number; height: number }[];
    /** 切换分辨率；返回是否成功 */
    setResolution(width: number, height: number): Promise<boolean>;
    /** 当前输出刷新率（Hz） */
    getRefreshRate(): number;
    /** 当前分辨率下可切换的刷新率（Hz） */
    getRefreshRates(): number[];
    /** 切换刷新率；返回是否成功 */
    setRefreshRate(refreshRate: number): Promise<boolean>;
    /** wrap 是否支持切换屏幕模式（DRM） */
    screenModeAvailable(): boolean;
    /** 触摸板单指移动的指针速度（libinput 速度设置，-1 ~ 1） */
    getTouchpadSpeed(): number;
    setTouchpadSpeed(speed: number): void;
    /** 触摸板单指移动的自适应加速（libinput 曲线） */
    getTouchpadAcceleration(): boolean;
    setTouchpadAcceleration(enabled: boolean): void;
    /** 触摸板双指滚动速度倍率（1 = 1:1 跟随手指） */
    getTouchpadScrollGain(): number;
    setTouchpadScrollGain(gain: number): void;
    /** 触摸板自然滚动（内容跟随手指） */
    getNaturalScroll(): boolean;
    setNaturalScroll(enabled: boolean): void;
    /** 三指横滑切屏倍率 */
    getSwitchGestureGain(): number;
    setSwitchGestureGain(gain: number): void;
    /** 切屏后重排新旧顺序的延迟（毫秒） */
    getReorderDelay(): number;
    setReorderDelay(delay: number): void;
    inputMethodAvailable: boolean;
    connectAvailable: boolean;
    getConnectEnabled(): boolean;
    setConnectEnabled(enabled: boolean): void;
    getConnectId(): string;
    listConnectDevices(): ConnectConnection[];
    forgetConnectDevice(targetId: string): void;
    setConnectRemember(targetId: string, remember: boolean): void;
    createConnectPairing(): Promise<PairingSession>;
    subscribeConnect(callback: () => void): () => void;
    /** 重新载入桌面界面；不会重启 myde 进程，也不影响 myde-wrap */
    restartDesktop(): void;
    /** 设置窗口根元素，弹窗挂在这里，避免覆盖整个桌面和光标 */
    modalHost: HTMLElement;
};

type Section = {
    id: string;
    name: string;
    build: () => ElType<HTMLElement>;
};

function sectionTitle(title: string, desc?: string) {
    return view("y")
        .style({ gap: "4px" })
        .add([
            txt(title).style({ ...gTextStyle.display, color: gTextStyle.color.primary }),
            ...(desc ? [txt(desc).style({ fontSize: "12px", opacity: "0.6", lineHeight: "1.5" })] : []),
        ]);
}

function settingRow(label: string, desc: string | undefined, control: ElType<HTMLElement>) {
    const info = view("y")
        .style({ gap: "3px", minWidth: "0", flexGrow: "1" })
        .add([
            aLineText().sv(label),
            ...(desc ? [txt(desc).style({ fontSize: "12px", opacity: "0.6", lineHeight: "1.45" })] : []),
        ]);
    return view("x")
        .style({
            alignItems: "center",
            gap: px(sSize2.padding),
            padding: `${px(sSize2.padding)} ${px(sSize2.padding + 4)}`,
            borderRadius: px(sSize2.radius1),
            ...gGlassStyle.itemInBg,
        })
        .add([info, spacer(), control]);
}

function fieldStyle(el: ElType<HTMLElement>) {
    return el.style({
        width: "190px",
        height: "32px",
        padding: "0 10px",
        borderRadius: "8px",
        border: "1px solid #00000024",
        background: "#fff",
        boxSizing: "border-box",
        flexShrink: "0",
    });
}

function createToggle(get: () => boolean, set: (value: boolean) => void) {
    let value = get();
    const knob = view().style({
        width: "20px",
        height: "20px",
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 3px #00000044",
        transition: "all 0.15s ease",
    });
    const track = view("x")
        .style({
            width: "44px",
            height: "24px",
            padding: "2px",
            boxSizing: "border-box",
            borderRadius: "12px",
            cursor: "pointer",
            flexShrink: "0",
            transition: "background 0.15s ease",
        })
        .add(knob);

    function render() {
        track.style({
            background: value ? "#00aaff" : "#00000026",
            justifyContent: value ? "flex-end" : "flex-start",
        });
    }
    render();

    track.on("click", () => {
        value = !value;
        render();
        set(value);
    });
    return track;
}

function createSegmented<T extends string | number>(
    options: { name: string; value: T }[],
    get: () => T,
    set: (value: T) => void,
) {
    let value = get();
    const group = view("x").style({
        gap: "2px",
        padding: "2px",
        borderRadius: "9px",
        background: "#0000000d",
        flexShrink: "0",
    });
    const buttons = new Map<T, ElType<HTMLDivElement>>();

    function render() {
        for (const [optionValue, el] of buttons) {
            el.style({
                background: optionValue === value ? "#fff" : "transparent",
                boxShadow: optionValue === value ? "0 1px 3px #00000022" : "none",
            });
        }
    }

    for (const option of options) {
        const el = view("x")
            .style({
                padding: "5px 10px",
                borderRadius: "7px",
                cursor: "pointer",
                alignItems: "center",
                transition: "background 0.15s ease",
            })
            .add(txt(option.name))
            .on("click", () => {
                value = option.value;
                render();
                set(value);
            });
        buttons.set(option.value, el);
        group.add(el);
    }
    render();
    return group;
}

function dialogField(control: ElType<HTMLInputElement>) {
    return control.style({
        width: "100%",
        height: "30px",
        padding: "0 8px",
        borderRadius: "7px",
        border: "1px solid #00000024",
        background: "#fff",
        boxSizing: "border-box",
    });
}

function dialogButton(label: string, primary = false) {
    return button(txt(label)).style({
        padding: "6px 14px",
        borderRadius: "7px",
        border: primary ? "1px solid #0088dd" : "1px solid #00000020",
        background: primary ? "#00aaff" : "#fff",
        color: primary ? "#fff" : "#111",
        cursor: "pointer",
        fontSize: "12px",
    });
}

function createWallpaperControl(op: SettingsContentOptions, slot: WallpaperSlot) {
    const status = txt("").style({
        fontSize: "11px",
        lineHeight: "14px",
        minHeight: "14px",
        color: "#c33",
    });
    const preview = image(op.getWallpaper(slot), "wallpaper").style({
        width: "104px",
        height: "59px",
        objectFit: "cover",
        objectPosition: "center",
        borderRadius: "8px",
        border: "1px solid #0000001f",
        background: "#00000010",
        flexShrink: "0",
    });
    const chooseBtn = dialogButton("选择图片").on("click", () => {
        try {
            op.chooseWallpaper(slot);
        } catch (error) {
            status.sv(error instanceof Error ? error.message : String(error));
        }
    });
    const resetBtn = dialogButton("恢复默认").on("click", () => {
        try {
            op.resetWallpaper(slot);
        } catch (error) {
            status.sv(error instanceof Error ? error.message : String(error));
        }
    });

    function render() {
        preview.attr({ src: op.getWallpaper(slot) });
        resetBtn.style({ display: op.isDefaultWallpaper(slot) ? "none" : "" });
        status.sv(op.getWallpaperError(slot) ?? "");
    }

    const unsubscribe = op.subscribeWallpaper(render);
    render();

    const el = view("y")
        .style({ gap: "4px", flexShrink: "0" })
        .add([
            view("x")
                .style({ alignItems: "center", gap: "8px" })
                .add([preview, view("y").style({ gap: "6px" }).add([chooseBtn, resetBtn])]),
            status,
        ]);

    return { el, dispose: unsubscribe };
}

function openConnectDialog(op: SettingsContentOptions, onDone: () => void) {
    const overlay = view().style({
        position: "absolute",
        inset: "0",
        zIndex: "30",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // 只让卡片接收鼠标，避免整层遮罩挡住桌面的指针层级。
        pointerEvents: "none",
    });
    const card = view("y").style({
        width: "380px",
        maxWidth: "calc(100% - 24px)",
        maxHeight: "calc(100% - 24px)",
        overflowY: "auto",
        boxSizing: "border-box",
        padding: "16px",
        gap: "8px",
        borderRadius: "14px",
        background: "#fafafa",
        boxShadow: "0 18px 60px #00000044",
        color: "#111",
        fontFamily: "sans-serif",
        pointerEvents: "auto",
    });
    const fieldRow = (label: string, control: ElType<HTMLElement>) =>
        view("y")
            .style({ gap: "2px" })
            .add([txt(label).style({ fontSize: "11px", opacity: "0.65" }), control]);

    const pointText = txt("准备中…").style({
        fontFamily: "monospace",
        fontSize: "11px",
        userSelect: "text",
        overflowWrap: "anywhere",
    });
    const pinText = txt("准备中…").style({
        fontFamily: "monospace",
        fontSize: "22px",
        letterSpacing: "4px",
        userSelect: "text",
    });
    const remoteIdInput = dialogField(input("text").attr({ placeholder: "对方设备 ID" }));
    const remotePinInput = dialogField(input("text").attr({ placeholder: "对方 PIN", maxLength: 6 }));
    const remember = input("checkbox").attr({ checked: true });
    const status = txt("").style({ fontSize: "11px", color: "#c33", minHeight: "14px" });

    let session: PairingSession | undefined;
    let closed = false;
    function close() {
        if (closed) return;
        closed = true;
        window.removeEventListener("pointerdown", onOutside, true);
        overlay.remove();
    }
    function onOutside(e: PointerEvent) {
        if (!card.el.contains(e.target as Node)) close();
    }
    window.addEventListener("pointerdown", onOutside, true);

    const connectButton = dialogButton("连接", true).on("click", async () => {
        if (!session) {
            status.sv("配对尚未准备好");
            return;
        }
        const remoteId = remoteIdInput.gv.trim();
        const remotePin = remotePinInput.gv.trim();
        if (!remoteId) {
            status.sv("请输入对方设备 ID");
            return;
        }
        if (!/^\d{6}$/.test(remotePin)) {
            status.sv("对方 PIN 应为 6 位数字");
            return;
        }

        connectButton.attr({ disabled: true });
        status.sv("连接中…");
        status.style({ color: "#555" });
        try {
            const result = await session.connect(remoteId, { remember: remember.el.checked });
            result.inputOtherPin(remotePin);
            await result.waitForPair();
            close();
            onDone();
        } catch (error) {
            status.sv(error instanceof Error ? error.message : String(error));
            status.style({ color: "#c33" });
            connectButton.attr({ disabled: false });
        }
    });
    const cancelButton = dialogButton("取消").on("click", close);

    card.add([
        txt("添加互联设备").style({ ...gTextStyle.title, fontSize: "17px", color: gTextStyle.color.primary }),
        txt("把本机配对 ID 和 PIN 告诉对方，再输入对方的配对 ID 和 PIN。").style({
            fontSize: "11px",
            opacity: "0.6",
        }),
        fieldRow("本机配对 ID", pointText),
        fieldRow("本机 PIN", pinText),
        fieldRow("对方配对 ID", remoteIdInput),
        fieldRow("对方 PIN", remotePinInput),
        view("x")
            .style({ alignItems: "center", gap: "6px" })
            .add([remember, txt("记住此设备")]),
        status,
        view("x").style({ justifyContent: "flex-end", gap: "8px" }).add([cancelButton, connectButton]),
    ]);
    overlay.add(card).addInto(op.modalHost);

    op.createConnectPairing()
        .then((pairing) => {
            if (closed) return;
            session = pairing;
            pointText.sv(pairing.pointId);
            pinText.sv(pairing.pin);
            pairing.onPair((request) => {
                if (closed) return;
                status.style({ color: "#555" });
                status.sv(`收到 ${request.remoteDeviceId.slice(0, 8)} 的配对请求，等待对方输入 PIN…`);
                request
                    .waitForPair()
                    .then((result) => {
                        op.setConnectRemember(result.targetId, remember.el.checked);
                        close();
                        onDone();
                    })
                    .catch((error) => {
                        if (closed) return;
                        status.sv(error instanceof Error ? error.message : String(error));
                        status.style({ color: "#c33" });
                    });
            });
        })
        .catch((error) => {
            if (closed) return;
            status.sv(error instanceof Error ? error.message : String(error));
            status.style({ color: "#c33" });
        });
}

export type SettingsContent = {
    el: ElType<HTMLElement>;
    dispose: () => void;
};

export function createSettingsContent(op: SettingsContentOptions): SettingsContent {
    let sectionCleanup: (() => void) | undefined;
    const sections: Section[] = [
        {
            id: "appearance",
            name: "外观",
            build: () => {
                const themeInput = fieldStyle(input("text").sv(op.getIconTheme()));
                let saveTimer: number | undefined;
                const saveTheme = () => {
                    const theme = themeInput.gv.trim();
                    if (!theme) {
                        themeInput.sv(op.getIconTheme());
                        return;
                    }
                    op.setIconTheme(theme);
                };
                themeInput.on("change", saveTheme);
                themeInput.on("input", () => {
                    clearTimeout(saveTimer);
                    saveTimer = window.setTimeout(saveTheme, 400);
                });
                const desktopWallpaper = createWallpaperControl(op, "desktop");
                const lockWallpaper = createWallpaperControl(op, "lock");
                sectionCleanup = () => {
                    desktopWallpaper.dispose();
                    lockWallpaper.dispose();
                };
                return view("y")
                    .style({ gap: px(sSize2.padding + 8) })
                    .add([
                        sectionTitle("外观", "调整桌面的显示方式。"),
                        settingRow("图标主题", "应用图标的主题名称，修改后重新打开应用列表或桌面后生效。", themeInput),
                        settingRow(
                            "窗口圆角",
                            "桌面绘制的窗口标题栏和内容四角半径；0 为直角。",
                            createSegmented(
                                [0, 6, 12, 18, 24].map((value) => ({ name: `${value}`, value })),
                                op.getWindowRadius,
                                op.setWindowRadius,
                            ),
                        ),
                        settingRow(
                            "桌面壁纸",
                            "图片居中填充整个屏幕；没有选择时使用桌面自带壁纸。",
                            desktopWallpaper.el,
                        ),
                        settingRow(
                            "锁屏壁纸",
                            "锁屏界面单独使用，图片居中填充整个屏幕；没有选择时使用桌面自带壁纸。",
                            lockWallpaper.el,
                        ),
                    ]);
            },
        },
        {
            id: "display",
            name: "显示",
            build: () => {
                const control = op.scaleFollowsHost()
                    ? txt("跟随宿主桌面").style({ opacity: "0.7" })
                    : createSegmented(
                          [
                              { name: "100%", value: 1 },
                              { name: "125%", value: 1.25 },
                              { name: "150%", value: 1.5 },
                              { name: "175%", value: 1.75 },
                              { name: "200%", value: 2 },
                          ],
                          op.getScale,
                          op.setScale,
                      );
                const modeAvailable = op.screenModeAvailable();
                const resolution = op.getResolution();
                const resolutions = op.getResolutions();
                const refreshSelect = dynamicSelect();
                let fillRefresh = () => {};

                let resolutionControl: ElType<HTMLElement>;
                if (!modeAvailable) {
                    resolutionControl = txt(
                        op.scaleFollowsHost()
                            ? `${resolution.width} × ${resolution.height}`
                            : `${resolution.width} × ${resolution.height}（当前 wrap 不支持切换）`,
                    ).style({ opacity: "0.7" });
                } else {
                    const resolutionSelect = select(
                        resolutions.map((item) => ({
                            name: `${item.width} × ${item.height}`,
                            value: `${item.width}x${item.height}`,
                        })),
                    ).sv(`${resolution.width}x${resolution.height}`);
                    resolutionSelect.on("change", () => {
                        const [width, height] = resolutionSelect.gv.split("x").map(Number);
                        void op.setResolution(width, height).then((ok) => {
                            if (!ok) {
                                const current = op.getResolution();
                                resolutionSelect.sv(`${current.width}x${current.height}`);
                            }
                            fillRefresh();
                        });
                    });
                    resolutionControl = fieldStyle(resolutionSelect);
                }

                let refreshControl: ElType<HTMLElement>;
                if (!modeAvailable) {
                    refreshControl = txt(
                        op.scaleFollowsHost()
                            ? `${op.getRefreshRate()} Hz，跟随宿主桌面`
                            : `${op.getRefreshRate()} Hz（当前 wrap 不支持切换）`,
                    ).style({ opacity: "0.7" });
                } else {
                    fillRefresh = () => {
                        const rates = op.getRefreshRates();
                        refreshSelect.setList(
                            rates.map((rate) => ({
                                name: `${rate} Hz`,
                                value: String(rate),
                            })),
                        );
                        refreshSelect.el.sv(String(op.getRefreshRate()));
                    };
                    fillRefresh();
                    refreshSelect.el.on("change", () => {
                        void op.setRefreshRate(Number(refreshSelect.el.gv));
                    });
                    refreshControl = fieldStyle(refreshSelect.el);
                }

                // 预算线跟随当前输出刷新率；没有测量需求时不跑 rAF，点图表里的开始再采样
                const frameChart = createFrameChart({
                    windowMs: 4000,
                    height: 132,
                    refreshRate: () => op.getRefreshRate(),
                    autoStart: false,
                });
                sectionCleanup = () => frameChart.destroy();

                return view("y")
                    .style({ gap: px(sSize2.padding + 8) })
                    .add([
                        sectionTitle("显示", "Wayland 客户端缩放、输出分辨率与刷新率。"),
                        settingRow(
                            "客户端缩放",
                            op.scaleFollowsHost()
                                ? "winit / 窗口模式由宿主桌面负责缩放，myde 内部固定 1x。"
                                : "按比例渲染 Wayland 应用窗口，桌面自绘 UI 也跟随该缩放；不改变 surface 逻辑坐标。",
                            control,
                        ),
                        settingRow(
                            "分辨率",
                            op.scaleFollowsHost()
                                ? "winit / 窗口模式由宿主桌面决定分辨率。"
                                : "切换 DRM 输出分辨率；窗口和 Wayland 客户端会按新尺寸重新布局。",
                            resolutionControl,
                        ),
                        settingRow(
                            "刷新率",
                            op.scaleFollowsHost()
                                ? "winit / 窗口模式由宿主桌面决定刷新率。"
                                : "切换当前分辨率下的刷新率；Wayland 客户端和 wp_presentation 会使用新值。",
                            refreshControl,
                        ),
                        view("y")
                            .style({
                                padding: `${px(sSize2.padding)} ${px(sSize2.padding + 4)}`,
                                borderRadius: px(sSize2.radius1),
                                ...gGlassStyle.itemInBg,
                            })
                            .add(frameChart.el),
                    ]);
            },
        },
        {
            id: "scroll",
            name: "触摸板",
            build: () => {
                return view("y")
                    .style({ gap: px(sSize2.padding + 8) })
                    .add([
                        sectionTitle("触摸板", "物理触摸板的单指指针速度和双指滚动行为。"),
                        settingRow(
                            "指针速度",
                            "物理触摸板按 libinput 的速度曲线缩放单指移动；标准速度保持 1:1，数值越大同样手势移动越快。",
                            createSegmented(
                                [
                                    { name: "很慢", value: -0.5 },
                                    { name: "慢", value: -0.25 },
                                    { name: "标准", value: 0 },
                                    { name: "快", value: 0.25 },
                                    { name: "很快", value: 0.5 },
                                ],
                                op.getTouchpadSpeed,
                                op.setTouchpadSpeed,
                            ),
                        ),
                        settingRow(
                            "指针加速度",
                            "开启后物理触摸板使用 libinput 的自适应曲线：慢速移动更精细，快速移动加速；关闭后按固定倍率移动。",
                            createToggle(op.getTouchpadAcceleration, op.setTouchpadAcceleration),
                        ),
                        settingRow(
                            "滚动速度",
                            "双指滚动默认按手指位移 1:1 滚动；应用窗口和桌面界面共用同一倍率。",
                            createSegmented(
                                [
                                    { name: "0.5×", value: 0.5 },
                                    { name: "0.75×", value: 0.75 },
                                    { name: "1×", value: 1 },
                                    { name: "1.5×", value: 1.5 },
                                    { name: "2×", value: 2 },
                                    { name: "3×", value: 3 },
                                ],
                                op.getTouchpadScrollGain,
                                op.setTouchpadScrollGain,
                            ),
                        ),
                        settingRow(
                            "自然滚动",
                            "开启时内容跟随手指移动；关闭后方向相反，接近传统滚轮。",
                            createToggle(op.getNaturalScroll, op.setNaturalScroll),
                        ),
                    ]);
            },
        },
        {
            id: "gesture",
            name: "手势",
            build: () => {
                return view("y")
                    .style({ gap: px(sSize2.padding + 8) })
                    .add([
                        sectionTitle("手势", "触摸板三指手势与虚拟桌面切换。"),
                        settingRow(
                            "切屏倍率",
                            "三指横滑的位移倍率；数值越大，换一个虚拟屏需要的滑动距离越短。",
                            createSegmented(
                                [
                                    { name: "1×", value: 1 },
                                    { name: "2×", value: 2 },
                                    { name: "3×", value: 3 },
                                    { name: "4×", value: 4 },
                                    { name: "5×", value: 5 },
                                    { name: "6×", value: 6 },
                                ],
                                op.getSwitchGestureGain,
                                op.setSwitchGestureGain,
                            ),
                        ),
                        settingRow(
                            "重排延迟",
                            "切屏后保持旧空间顺序的时间；到点后按最近使用顺序在内部重排。",
                            createSegmented(
                                [
                                    { name: "1 秒", value: 1000 },
                                    { name: "2 秒", value: 2000 },
                                    { name: "3 秒", value: 3000 },
                                    { name: "4 秒", value: 4000 },
                                    { name: "5 秒", value: 5000 },
                                ],
                                op.getReorderDelay,
                                op.setReorderDelay,
                            ),
                        ),
                    ]);
            },
        },
        {
            id: "input",
            name: "输入法",
            build: () => {
                return view("y")
                    .style({ gap: px(sSize2.padding + 8) })
                    .add([
                        sectionTitle("输入法", "候选窗和输入上下文的行为。"),
                        settingRow(
                            "候选窗预编辑",
                            op.inputMethodAvailable
                                ? "客户端不显示内联预编辑时，自动模式会把预编辑放进候选窗。"
                                : "当前没有连接到输入法服务（fcitx5），设置会在输入法可用后生效。",
                            createSegmented(
                                [
                                    { name: "自动", value: "auto" as const },
                                    { name: "总是显示", value: "always" as const },
                                    { name: "从不显示", value: "never" as const },
                                ],
                                op.getImePanelPreedit,
                                op.setImePanelPreedit,
                            ),
                        ),
                    ]);
            },
        },
        {
            id: "connect",
            name: "互联",
            build: () => {
                const list = view("y").style({ gap: "6px" });
                const renderList = () => {
                    list.clear();
                    if (!op.connectAvailable) {
                        list.add(txt("当前环境没有可用的互联接口。").style({ opacity: "0.6" }));
                        return;
                    }
                    const devices = op.listConnectDevices();
                    if (devices.length === 0) {
                        list.add(txt("还没有记忆设备。").style({ opacity: "0.6" }));
                        return;
                    }
                    for (const device of devices) {
                        const name = device.remoteDeviceName === "unknown" ? device.targetId : device.remoteDeviceName;
                        const status = device.connected ? "已连接" : device.remembered ? "已记忆" : "临时";
                        const row = view("x")
                            .style({
                                alignItems: "center",
                                gap: px(sSize2.padding),
                                padding: `${px(sSize2.padding)} ${px(sSize2.padding + 4)}`,
                                borderRadius: px(sSize2.radius1),
                                ...gGlassStyle.itemInBg,
                            })
                            .add([
                                view("y")
                                    .style({ gap: "2px", minWidth: "0", flexGrow: "1" })
                                    .add([
                                        aLineText().sv(name),
                                        txt(device.targetId).style({
                                            fontSize: "11px",
                                            opacity: "0.55",
                                            fontFamily: "monospace",
                                            userSelect: "text",
                                            overflowWrap: "anywhere",
                                        }),
                                    ]),
                                txt(status).style({ fontSize: "12px", opacity: "0.7", flexShrink: "0" }),
                                button(txt("忘记"))
                                    .style({
                                        padding: "5px 10px",
                                        borderRadius: "7px",
                                        border: "1px solid #00000020",
                                        background: "#fff",
                                        cursor: "pointer",
                                        fontSize: "12px",
                                        flexShrink: "0",
                                    })
                                    .on("click", () => {
                                        op.forgetConnectDevice(device.targetId);
                                        renderList();
                                    }),
                            ]);
                        list.add(row);
                    }
                };

                const addButton = dialogButton("添加设备", true).on("click", () => {
                    if (!op.getConnectEnabled()) return;
                    openConnectDialog(op, renderList);
                });
                if (!op.connectAvailable) addButton.attr({ disabled: true });

                renderList();
                sectionCleanup = op.subscribeConnect(renderList);

                return view("y")
                    .style({ gap: px(sSize2.padding + 8) })
                    .add([
                        sectionTitle("互联", "与其他设备建立远程连接。"),
                        settingRow(
                            "启用互联",
                            "关闭后断开当前互联，并停止自动连接记忆设备。",
                            createToggle(op.getConnectEnabled, op.setConnectEnabled),
                        ),
                        settingRow(
                            "本机 ID",
                            "设备长期身份。配对时请使用添加设备弹窗里显示的本机配对 ID。",
                            txt(op.connectAvailable ? op.getConnectId() : "-").style({
                                fontFamily: "monospace",
                                fontSize: "12px",
                                userSelect: "text",
                                overflowWrap: "anywhere",
                                maxWidth: "260px",
                                textAlign: "right",
                            }),
                        ),
                        settingRow(
                            "添加设备",
                            "输入对方配对 ID 和 PIN；把本机配对 ID/PIN 告诉对方完成配对。",
                            addButton,
                        ),
                        view("y")
                            .style({ gap: "6px" })
                            .add([txt("设备").style({ ...gTextStyle.strong, color: gTextStyle.color.primary }), list]),
                    ]);
            },
        },
        {
            id: "windows",
            name: "窗口",
            build: () => {
                return view("y")
                    .style({ gap: px(sSize2.padding + 8) })
                    .add([
                        sectionTitle("窗口", "窗口布局与摆放。"),
                        settingRow(
                            "新窗口居中",
                            "新开的窗口和尺寸变化后的窗口自动放到当前桌面区域中央。",
                            createToggle(op.getCenterWindows, op.setCenterWindows),
                        ),
                    ]);
            },
        },
        {
            id: "about",
            name: "关于",
            build: () => {
                return view("y")
                    .style({ gap: px(sSize2.padding + 8) })
                    .add([
                        sectionTitle("关于", "MyDE 默认桌面"),
                        settingRow(
                            "设置文件",
                            "设置由启动器统一保存，更换桌面实现后仍会保留。",
                            txt("共享").style({ opacity: "0.6" }),
                        ),
                        settingRow(
                            "窗口逻辑",
                            "设置窗口和 Wayland 客户端窗口使用同一套虚拟桌面、聚焦和关闭逻辑。",
                            txt("一致").style({ opacity: "0.6" }),
                        ),
                        settingRow(
                            "重启桌面",
                            "重新载入桌面界面，正在运行的窗口会被关闭。重新编译桌面实现后使用；不会重启 myde 进程。",
                            dialogButton("重启桌面", true).on("click", () => op.restartDesktop()),
                        ),
                    ]);
            },
        },
    ];

    const nav = view("y").style({
        width: "152px",
        padding: px(sSize2.padding),
        gap: "4px",
        borderRight: "1px solid #00000014",
        flexShrink: "0",
        boxSizing: "border-box",
    });
    const content = view("y").style({
        flexGrow: "1",
        minWidth: "0",
        padding: px(sSize2.padding + 12),
        overflowY: "auto",
        boxSizing: "border-box",
    });
    const navItems = new Map<string, ElType<HTMLDivElement>>();

    function show(id: string) {
        for (const [sid, el] of navItems) {
            el.style({
                background: sid === id ? "#ffffff" : "transparent",
                fontWeight: sid === id ? gTextStyle.weight.strong : gTextStyle.weight.regular,
            });
        }
        const section = sections.find((s) => s.id === id);
        if (!section) return;
        sectionCleanup?.();
        sectionCleanup = undefined;
        content.clear().add(section.build());
    }

    for (const section of sections) {
        const item = view("x")
            .style({
                padding: `9px ${px(sSize2.padding)}`,
                borderRadius: px(sSize2.radius1),
                cursor: "pointer",
                alignItems: "center",
                flexShrink: "0",
                transition: "background 0.15s ease",
            })
            .add(aLineText().sv(section.name))
            .on("click", () => show(section.id));
        navItems.set(section.id, item);
        nav.add(item);
    }

    show("appearance");

    const el = view("x")
        .style({
            flexGrow: "1",
            minHeight: "0",
            minWidth: "0",
        })
        .add([nav, content]);

    return {
        el,
        dispose: () => {
            sectionCleanup?.();
            sectionCleanup = undefined;
        },
    };
}
