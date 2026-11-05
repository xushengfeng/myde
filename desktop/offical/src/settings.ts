import { type ElType, input, spacer, txt, view } from "dkh-ui";
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
    inputMethodAvailable: boolean;
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

function createSegmented<T extends string>(
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

export function createSettingsContent(op: SettingsContentOptions) {
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

    return view("x")
        .style({
            flexGrow: "1",
            minHeight: "0",
            minWidth: "0",
        })
        .add([nav, content]);
}
