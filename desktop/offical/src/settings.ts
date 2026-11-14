import { button, type ElType, input, spacer, txt, view } from "dkh-ui";
import type { ConnectConnection, PairingSession } from "../../../src/desktop-api";
import { aLineText, gGlassStyle, px, sSize2 } from "./ui";

export type ImePanelPreeditMode = "auto" | "always" | "never";

/** 设置窗口的内容只通过这组读写函数接触设置，窗口外壳由桌面负责 */
export type SettingsContentOptions = {
    getIconTheme(): string;
    setIconTheme(theme: string): void;
    getImePanelPreedit(): ImePanelPreeditMode;
    setImePanelPreedit(mode: ImePanelPreeditMode): void;
    getCenterWindows(): boolean;
    setCenterWindows(enabled: boolean): void;
    /** Wayland 客户端/窗口缩放（1 = 100%） */
    getScale(): number;
    setScale(scale: number): void;
    /** winit / 普通窗口模式跟随宿主缩放，不提供额外缩放 */
    scaleFollowsHost(): boolean;
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
            txt(title).style({ fontSize: "20px", fontWeight: "600", lineHeight: "1.3" }),
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
        txt("添加互联设备").style({ fontSize: "17px", fontWeight: "600" }),
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
                return view("y")
                    .style({ gap: px(sSize2.padding + 8) })
                    .add([
                        sectionTitle("外观", "调整桌面的显示方式。"),
                        settingRow("图标主题", "应用图标的主题名称，修改后重新打开应用列表或桌面后生效。", themeInput),
                        settingRow("壁纸", "当前使用默认桌面自带壁纸。", txt("默认").style({ opacity: "0.6" })),
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
                return view("y")
                    .style({ gap: px(sSize2.padding + 8) })
                    .add([
                        sectionTitle("显示", "Wayland 客户端与窗口的缩放。"),
                        settingRow(
                            "客户端缩放",
                            op.scaleFollowsHost()
                                ? "winit / 窗口模式由宿主桌面负责缩放，myde 内部固定 1x。"
                                : "按比例渲染 Wayland 应用窗口；桌面面板暂不缩放。",
                            control,
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
                            .add([txt("设备").style({ fontSize: "13px", fontWeight: "600" }), list]),
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
                fontWeight: sid === id ? "600" : "400",
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
