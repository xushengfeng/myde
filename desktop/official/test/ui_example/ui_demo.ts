import { addStyle, button, type ElType, initDKH, txt, view } from "dkh-ui";
import type { ClipboardItem, ClipboardStation } from "../../src/clipboard";
import { createClipboardStationTool } from "../../src/clipboard_tool";
import { getIconXEl } from "../../src/icon";
import { type PanelPreeditMode, resolveImePreedit } from "../../src/ime/ime";
import type { BindingSource } from "../../src/registry";
import { carousel, dynamicScrollList } from "../../src/scroll-list";
import {
    aLineText,
    gRadius,
    gShadowStyle,
    gSurfaceStyle,
    gTextStyle,
    type ImeTrayStatus,
    iItem,
    imeCandidatePopup,
    imeTrayPanel,
    mMedia,
    nNotiList,
    nNumber,
    rRange,
    sourceTag,
    sSize,
    sSize2,
    uBatteryInfo,
    uBatteryRow,
    uBrightnessList,
    uBrightnessSlider,
    uChoiceRow,
    ui,
    uScrollList,
    uSegmented,
    uSwitch,
    uSystemMenu,
    uToggleRow,
    vVolume,
} from "../../src/ui";

addStyle({ body: { userSelect: "none", padding: "8px", fontFamily: "sans-serif" } });
initDKH({ pureStyle: true });

function px(n: number) {
    return `${n}px`;
}

// 单行文本
aLineText()
    .sv("中文1iIlmg")
    .addInto(view().style({ border: "solid 1px", width: "100px" }).addInto());
aLineText()
    .sv("长长长长长长长长长长长长长长长长")
    .addInto(view().style({ border: "solid 1px", width: "100px" }).addInto());

// 数字
view("y")
    .style({ gap: "8px" })
    .add([
        nNumber("0123456789.:/\\,#%-+°_ "),
        nNumber("12:34.567"),
        nNumber("-200°0"),
        nNumber("#12345"),
        nNumber("1234,5678,9.0"),
        nNumber("1234.5678.90,0"),
        nNumber("1234_5678_90.0"),
        nNumber("123 4567 890.0"),
    ])
    .addInto();

// 布局
function whiteView() {
    return view().style({
        background: "white",
        borderRadius: px(sSize2.radius1),
    });
}
aLineText().sv("布局").addInto();
view("y")
    .style({ padding: px(8), background: "#2196F3", gap: px(8) })
    .addInto()
    .add([
        whiteView()
            .style({
                width: px(sSize(4)),
                height: px(sSize(1)),
                padding: px(sSize2.paddingx),
            })
            .add(aLineText().sv("回1mMg")),
        view("x")
            .style({
                gap: px(8),
            })
            .add([
                whiteView()
                    .style({
                        width: px(sSize(8)),
                        height: px(sSize(1.5)),
                        padding: px(sSize2.paddingx),
                    })
                    .add(aLineText().sv("回1mMg")),
            ]),
        view("x")
            .style({
                gap: px(8),
            })
            .add([
                whiteView()
                    .style({
                        width: px(sSize(8)),
                        height: px(sSize(2.5)),
                        padding: px(sSize2.paddingx),
                    })
                    .add(view("y").add([aLineText().sv("标题title标题")])),
            ]),
    ]);

// ── 设计 token ────────────────────────────────────────────────────────────────────────────────
// 静态尺寸、单行文本、三层材质：
// L1 内部只直接放 L2 面板；L2 只放 L3 item；L3 item 自带圆角。
const tokenSection = view("y").style({ marginTop: "30px", gap: "12px", fontFamily: gTextStyle.family }).addInto();
tokenSection.add(
    aLineText()
        .sv("设计 token")
        .style({ ...gTextStyle.display, color: gTextStyle.color.primary }),
);

// 文字
tokenSection.add(
    aLineText()
        .sv("文字")
        .style({ ...gTextStyle.title, color: gTextStyle.color.primary }),
);

function typeRow(role: string, sample: string, style: { fontSize: string; fontWeight: string; lineHeight: string }) {
    return view("x")
        .style({ alignItems: "baseline", gap: "12px", height: "24px" })
        .add([
            aLineText()
                .sv(role)
                .style({
                    ...gTextStyle.micro,
                    color: gTextStyle.color.muted,
                    width: "56px",
                    flexShrink: "0",
                }),
            aLineText()
                .sv(sample)
                .style({
                    ...style,
                    flexGrow: "1",
                    minWidth: "0",
                    color: gTextStyle.color.primary,
                }),
        ]);
}

const typeCard = view("y")
    .style({
        width: "440px",
        height: px(sSize(8)),
        padding: px(sSize2.padding + 4),
        boxSizing: "border-box",
        borderRadius: px(gRadius.container),
        background: "#fff",
        boxShadow: gShadowStyle.panel,
        gap: "4px",
    })
    .addInto(tokenSection);
typeCard.add([
    typeRow("display", "桌面与窗口", gTextStyle.display),
    typeRow("title", "面板标题", gTextStyle.title),
    typeRow("subtitle", "窗口标题", gTextStyle.subtitle),
    typeRow("body", "正文内容与列表项", gTextStyle.body),
    typeRow("strong", "正文强调", gTextStyle.strong),
    typeRow("caption", "次要说明与元数据", gTextStyle.caption),
    typeRow("captionStrong", "小字强调", gTextStyle.captionStrong),
    typeRow("micro", "标签与快捷键提示", gTextStyle.micro),
    typeRow("microStrong", "微小强调", gTextStyle.microStrong),
]);

const colorRow = view("x").style({ gap: "16px", height: "20px", marginTop: "8px" }).addInto(typeCard);
for (const [name, color] of Object.entries(gTextStyle.color)) {
    colorRow.add(
        view("x")
            .style({ alignItems: "center", gap: "6px" })
            .add([
                view().style({
                    width: "14px",
                    height: "14px",
                    flexShrink: "0",
                    borderRadius: "4px",
                    background: color,
                    border: "1px solid #00000014",
                    boxSizing: "border-box",
                }),
                aLineText()
                    .sv(name)
                    .style({ ...gTextStyle.micro, color: gTextStyle.color.secondary, width: "44px" }),
            ]),
    );
}

// 来源标签
tokenSection.add(
    aLineText()
        .sv("来源标签")
        .style({ ...gTextStyle.title, color: gTextStyle.color.primary }),
);

const tagCard = view("x")
    .style({
        width: "440px",
        height: "56px",
        padding: "0 12px",
        boxSizing: "border-box",
        alignItems: "center",
        gap: "8px",
        borderRadius: px(gRadius.container),
        background: "#fff",
        boxShadow: gShadowStyle.panel,
        flexShrink: "0",
    })
    .addInto(tokenSection);
tagCard.add(["应用", "窗口", "虚拟屏", "设置"].map((label) => sourceTag(label)));

// 托盘选择标记：勾 / 圆只在 tray 出现，左侧图标与右侧标记对齐
tokenSection.add(
    aLineText()
        .sv("托盘选择标记")
        .style({ ...gTextStyle.title, color: gTextStyle.color.primary }),
);

const choiceDemo = ui.bar([
    ui.barItem().add([
        uChoiceRow({
            label: "开关：开",
            icon: view().add(getIconXEl("music", { size: 16 })),
            mark: "check",
            selected: true,
            size: 1,
            emphasize: false,
        }).el,
        uChoiceRow({
            label: "开关：关",
            icon: view().add(getIconXEl("settings", { size: 16 })),
            mark: "check",
            selected: false,
            size: 1,
            emphasize: false,
        }).el,
        uChoiceRow({
            label: "单选：已选",
            icon: view().add(getIconXEl("speaker", { size: 16 })),
            mark: "radio",
            selected: true,
            size: 1,
            emphasize: false,
        }).el,
        uChoiceRow({
            label: "单选：未选",
            icon: view().add(getIconXEl("wifi", { size: 16 })),
            mark: "radio",
            selected: false,
            size: 1,
            emphasize: false,
        }).el,
    ]),
]);
choiceDemo.el.style({ width: px(sSize(6)) }).addInto(tokenSection);

// 阴影：窗口框架 / 工具弹窗与搜索框
tokenSection.add(
    aLineText()
        .sv("阴影")
        .style({ ...gTextStyle.title, color: gTextStyle.color.primary }),
);

function shadowCard(title: string, value: string, shadow: string) {
    return view("y")
        .style({
            width: "230px",
            height: "96px",
            padding: "14px",
            boxSizing: "border-box",
            borderRadius: px(gRadius.container),
            background: "#fff",
            boxShadow: shadow,
            gap: "4px",
            flexShrink: "0",
        })
        .add([
            aLineText()
                .sv(title)
                .style({ ...gTextStyle.title, color: gTextStyle.color.primary }),
            // 刻意多行：完整展示阴影值，不按单行省略
            txt(value).style({
                ...gTextStyle.micro,
                color: gTextStyle.color.secondary,
                fontFamily: gTextStyle.monoFamily,
                wordBreak: "break-all",
            }),
        ]);
}

view("x")
    .style({
        width: "540px",
        height: "152px",
        padding: "28px",
        boxSizing: "border-box",
        gap: "24px",
        borderRadius: px(gRadius.container),
        background: "linear-gradient(135deg, #e7ecf2, #f6f7f9)",
    })
    .addInto(tokenSection)
    .add([
        shadowCard("window · 窗口框架", gShadowStyle.window, gShadowStyle.window),
        shadowCard("panel · 工具弹窗 / 搜索框", gShadowStyle.panel, gShadowStyle.panel),
    ]);

// 圆角与三层材质
tokenSection.add(
    aLineText()
        .sv("圆角与三层材质")
        .style({ ...gTextStyle.title, color: gTextStyle.color.primary }),
);

const layerStage = view("x")
    .style({
        width: "640px",
        height: "196px",
        padding: "24px",
        boxSizing: "border-box",
        gap: "24px",
        alignItems: "flex-start",
        borderRadius: px(gRadius.container),
        background: "linear-gradient(135deg, #dce7f5, #f7e8df)",
    })
    .addInto(tokenSection);

const radiusCard = view("y")
    .style({
        width: "260px",
        height: "140px",
        padding: "14px",
        boxSizing: "border-box",
        borderRadius: px(gRadius.container),
        background: "#fff",
        boxShadow: gShadowStyle.panel,
        gap: "10px",
        flexShrink: "0",
    })
    .addInto(layerStage);
radiusCard.add(
    aLineText()
        .sv("圆角")
        .style({ ...gTextStyle.title, color: gTextStyle.color.primary }),
);

const radiusRow = view("x").style({ gap: "16px", alignItems: "flex-end" }).addInto(radiusCard);

function radiusSwatch(label: string, radius: number) {
    return view("y")
        .style({ width: "64px", gap: "4px", alignItems: "center" })
        .add([
            view().style({
                width: "64px",
                height: "64px",
                borderRadius: px(radius),
                background: "#eef2f7",
                border: "1px solid #00000012",
                boxSizing: "border-box",
                flexShrink: "0",
            }),
            aLineText()
                .sv(`${label} ${radius}`)
                .style({
                    ...gTextStyle.micro,
                    color: gTextStyle.color.secondary,
                    width: "64px",
                    textAlign: "center",
                }),
        ]);
}

radiusRow.add([
    radiusSwatch("container", gRadius.container),
    radiusSwatch("item", gRadius.item),
    radiusSwatch("icon", gRadius.icon),
]);

const layerColumn = view("y").style({ gap: "6px", alignItems: "flex-start" }).addInto(layerStage);
layerColumn.add(
    aLineText()
        .sv("L1 · 背景毛玻璃")
        .style({ ...gTextStyle.micro, color: gTextStyle.color.secondary }),
);

const layerCard = view("y")
    .style({
        width: "300px",
        height: "112px",
        padding: px(sSize2.padding),
        boxSizing: "border-box",
        borderRadius: px(gRadius.container),
        ...gSurfaceStyle.backdrop,
        color: gTextStyle.color.primary,
    })
    .addInto(layerColumn);

// L1 内部只放 L2 面板，不放文字
const layerPanel = ui.barItem().style({ width: "100%" }).addInto(layerCard);
["列表项", "当前项", "列表项"].forEach((label, index) => {
    // L3 item 用 iItem，自带 item 圆角；当前项用实心白强调
    layerPanel.add(
        iItem({ type: "h", size: 1 })
            .style({
                display: "flex",
                alignItems: "center",
                padding: `0 ${px(sSize2.paddingx)}`,
                boxSizing: "border-box",
                background: index === 1 ? gSurfaceStyle.solid.backgroundColor : "transparent",
            })
            .add(aLineText().sv(label)),
    );
});
layerColumn.add(
    aLineText()
        .sv("L2 面板透明 · L3 条目实心白")
        .style({
            ...gTextStyle.micro,
            color: gTextStyle.color.secondary,
        }),
);

// 密码输入组件测试
const i = ui.passwd();
i.placeholder("input your p");
const p = i.el.style({
    width: "200px",
});
const r = view();
view().add(["passwd", p, r]).addInto();
p.on("change", () => {
    r.clear().add(p.gv);
});

// 下拉弹窗
// 内部有子元素
// 测试不同背景下的半透明模糊背景可读性
const bgTestSectionP = view("x", "wrap")
    .style({
        marginTop: "30px",
    })
    .addInto();
bgTestSectionP.add(txt("测试半透明模糊背景在不同背景下的可读性"));
const bgTestSection = view("x", "wrap").addInto(bgTestSectionP);

function createPopupWithBackground(bgStyle: Record<string, string>, label: string) {
    const container = view().style({
        position: "relative",
        width: "300px",
        height: "300px",
        overflow: "hidden",
        ...bgStyle,
    });

    container.add(
        txt(label).style({
            position: "absolute",
            top: "10px",
            left: "10px",
            fontSize: "14px",
            color: bgStyle.color || "#000",
            zIndex: 1,
        }),
    );

    const list = dynamicScrollList<string>({
        itemSize: sSize(1.5),
        containerSize: 100,
        direction: "down",
        keyExtractor: (x) => x,
        renderItem: (k) => {
            if (k === "1") {
                return iItem({ type: "h", size: 1.5 }).style({ backgroundColor: "#fff" }).add(k);
            }
            return iItem({ type: "h", size: 1.5 }).add(k);
        },
    });

    const popup = ui.bar([
        ui.barItem().add(iItem({ type: "h", size: 1 }).add(txt("测试文本"))),
        ui.barItem().add(list.el.style({ width: "100%" })),
    ]);
    list.setList(["1", "2", "3", "4"]);
    popup.el.style({
        color: "#000",
        width: "200px",
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
    });

    container.add(popup.el);
    return container;
}

// 1. 白色背景
const whiteBgPopup = createPopupWithBackground(
    {
        background: "#ffffff",
        color: "#333333",
    },
    "白色背景",
);
bgTestSection.add(whiteBgPopup);

// 2. 黑色背景
const blackBgPopup = createPopupWithBackground(
    {
        background: "#000000",
        color: "#ffffff",
    },
    "黑色背景",
);
bgTestSection.add(blackBgPopup);

// 3. 纯色背景（蓝色）
const solidBgPopup = createPopupWithBackground(
    {
        background: "#2196F3",
        color: "#ffffff",
    },
    "纯色背景（蓝色）",
);
bgTestSection.add(solidBgPopup);

// 4. 复杂图案背景（红绿拼接）
const gradientBgPopup = createPopupWithBackground(
    {
        background: "linear-gradient(to right, #ff0000 50%, #00ff00 50%)",
        color: "#ffffff",
    },
    "红绿拼接背景",
);
bgTestSection.add(gradientBgPopup);

// 5. 复杂图案背景（条纹）
const stripedBgPopup = createPopupWithBackground(
    {
        background: `repeating-linear-gradient(
            45deg,
            #f0f0f0,
            #f0f0f0 10px,
            #e0e0e0 10px,
            #e0e0e0 20px
        )`,
        color: "#333333",
    },
    "条纹背景",
);
bgTestSection.add(stripedBgPopup);

// 6. 复杂图案背景（点状）
const dottedBgPopup = createPopupWithBackground(
    {
        background: `
            radial-gradient(circle at 25% 25%, #ff6b6b 6px, transparent 2px),
            radial-gradient(circle at 75% 75%, #4ecdc4 6px, transparent 2px),
            #f8f9fa
        `,
        backgroundSize: "50px 50px",
        color: "#333333",
    },
    "点状图案背景",
);
bgTestSection.add(dottedBgPopup);

// ── 工具弹窗 mock ────────────────────────────────────────────────────────────────────────────────
// 静态 mock：复用 uToggleRow / uChoiceRow / uSwitch / mMedia。
// 真实弹窗依赖 registry 数据，不能直接 import；改列表行配置时要和 main.ts 同步。
const popupDemo = view("y").style({ marginTop: "30px", gap: "12px" }).addInto();
popupDemo.add(
    aLineText()
        .sv("工具弹窗 mock")
        .style({ ...gTextStyle.display, color: gTextStyle.color.primary }),
);
const popupRow = view("x", "wrap").style({ gap: "24px", alignItems: "flex-start" }).addInto(popupDemo);

function popupColumn(title: string, el: ElType<HTMLElement>) {
    return view("y")
        .style({ gap: "6px", alignItems: "flex-start" })
        .add([
            aLineText()
                .sv(title)
                .style({ ...gTextStyle.caption, color: gTextStyle.color.secondary }),
            el,
        ]);
}

const n = nNotiList({
    map: (k) => {
        return Promise.resolve({
            ...noMap[k],
            delete: () => {
                noSet.delete(k);
                n.setList(Array.from(noSet));
            },
        });
    },
});
const noMap = {
    a: { title: "title", content: "aaaaaaaaaaaaaaaaa" },
    b: { title: "title", content: "bb bb" },
    c: {
        title: "title",
        content: "xx xx xx x xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    },
};
const noSet = new Set<string>();
n.el.style({ width: "fit-content" });
const noB = button("show").on("click", () => {
    n.setList(["a", "b", "c"]);
    noSet.clear();
    noSet.add("a");
    noSet.add("b");
    noSet.add("c");
});
const notificationColumn = popupColumn("通知", n.el);
notificationColumn.add(noB);
popupRow.add(notificationColumn);
setTimeout(() => {
    noB.el.click();
}, 800);

function createMockClipboardStation(): ClipboardStation {
    const listeners = new Set<() => void>();
    const items: ClipboardItem[] = [
        {
            id: "clip-1",
            mimes: ["text/plain;charset=utf-8"],
            bytes: new Map<string, Uint8Array>(),
            size: 0,
            text: "hello world",
            appid: "firefox",
            seat: "seat0",
            time: Date.now(),
            kind: "clipboard",
        },
        {
            id: "clip-2",
            mimes: ["text/plain;charset=utf-8"],
            bytes: new Map<string, Uint8Array>(),
            size: 0,
            text: "拖拽进来的内容",
            appid: "files",
            seat: "seat0",
            time: Date.now() - 60_000,
            kind: "drag",
        },
        {
            id: "clip-3",
            mimes: ["text/plain;charset=utf-8"],
            bytes: new Map<string, Uint8Array>(),
            size: 0,
            text: "another clipboard item",
            appid: "code",
            seat: "seat0",
            time: Date.now() - 120_000,
            kind: "clipboard",
        },
    ];
    const notify = () => {
        for (const listener of listeners) listener();
    };
    return {
        items,
        offer: () => {},
        copy: () => {},
        remove: (id) => {
            const index = items.findIndex((item) => item.id === id);
            if (index >= 0) items.splice(index, 1);
            notify();
        },
        clear: (kind) => {
            if (!kind) {
                items.length = 0;
            } else {
                for (let i = items.length - 1; i >= 0; i--) {
                    if (items[i].kind === kind) items.splice(i, 1);
                }
            }
            notify();
        },
        add: async () => undefined,
        subscribe: (fn) => {
            listeners.add(fn);
            return () => {
                listeners.delete(fn);
            };
        },
        dispose: () => listeners.clear(),
    };
}

const clipboardHost = view();
createClipboardStationTool({
    station: createMockClipboardStation(),
    tipEl: clipboardHost.el,
});
popupRow.add(popupColumn("剪贴板", clipboardHost));

const volume = vVolume();
popupRow.add(popupColumn("音量", volume.el));

const brightnessList = uBrightnessList();
brightnessList.setSliders([uBrightnessSlider({ value: 0.72 }).el, uBrightnessSlider({ value: 0.38 }).el]);
popupRow.add(popupColumn("亮度", brightnessList.el));

const imePopupEntries = [
    { uniqueName: "keyboard-us", name: "英语（美国）", label: "en", off: true },
    { uniqueName: "rime", name: "中州韵", label: "中" },
    { uniqueName: "pinyin", name: "拼音", label: "拼" },
];
let imePopupStatus: ImeTrayStatus = {
    available: true,
    currentUniqueName: "rime",
    entries: imePopupEntries,
    hint: "激活 Ctrl+Space · 切换 Super+Space / Super+Shift+Space",
};
const imePopupTray = imeTrayPanel(
    {
        select: (uniqueName) => {
            imePopupStatus = { ...imePopupStatus, currentUniqueName: uniqueName };
            imePopupTray.setStatus(imePopupStatus);
        },
    },
    imePopupStatus,
);
popupRow.add(popupColumn("输入法", imePopupTray.el));

const systemMenu = uSystemMenu({
    onLock: () => {},
    onShutdown: () => {},
    onReboot: () => {},
    onSuspend: () => {},
});
popupRow.add(popupColumn("系统菜单", systemMenu.el));

function popupPanel(els: ElType<HTMLElement>[]) {
    const p = ui.bar(els);
    p.el.style({ width: px(sSize(6)) });
    return p.el;
}

function listPanel(rows: ElType<HTMLElement>[], height: number) {
    return ui
        .barItem()
        .style({ height: px(height) })
        .add(rows);
}

function toggleRow(label: string, on: boolean) {
    return uToggleRow(label, uSwitch(on, () => {}).el);
}

const wifiPopup = popupPanel([
    toggleRow("Wi-Fi", true),
    listPanel(
        [
            uChoiceRow({ label: "Home-5G", selected: true }).el,
            uChoiceRow({ label: "Office" }).el,
            uChoiceRow({ label: "访客网络" }).el,
            uChoiceRow({ label: "Coffee Shop" }).el,
        ],
        sSize(1.5) * 4,
    ),
]);
popupRow.add(popupColumn("Wi-Fi", wifiPopup));

const bluePopup = popupPanel([
    toggleRow("蓝牙", true),
    listPanel(
        [
            uChoiceRow({ label: "MX Master 3S", selected: true }).el,
            uChoiceRow({ label: "AirPods Pro" }).el,
            uChoiceRow({ label: "键盘", selected: true }).el,
            uChoiceRow({ label: "旧音箱" }).el,
        ],
        sSize(1.5) * 4,
    ),
]);
popupRow.add(popupColumn("蓝牙", bluePopup));

const connectPopup = popupPanel([
    toggleRow("互联", true),
    ui
        .barItem()
        .style({
            height: px(sSize(1.5)),
            display: "flex",
            alignItems: "center",
            gap: px(sSize2.paddingx),
            padding: `0 ${px(sSize2.paddingx)}`,
            boxSizing: "border-box",
        })
        .add([
            aLineText()
                .sv("本机 ID")
                .style({
                    ...gTextStyle.caption,
                    color: gTextStyle.color.secondary,
                    flexShrink: "0",
                }),
            aLineText()
                .sv("7f3a-92c1")
                .style({
                    ...gTextStyle.caption,
                    color: gTextStyle.color.secondary,
                    fontFamily: gTextStyle.monoFamily,
                    flexGrow: "1",
                    minWidth: "0",
                    textAlign: "right",
                }),
        ]),
    listPanel(
        [
            uChoiceRow({ label: "工作室 Mac", detail: "已连接", selected: true }).el,
            uChoiceRow({ label: "客厅主机", detail: "已记忆" }).el,
            uChoiceRow({ label: "临时设备", detail: "临时" }).el,
            uChoiceRow({ label: "备用设备", detail: "已记忆" }).el,
        ],
        sSize(1.5) * 4,
    ),
]);
popupRow.add(popupColumn("互联", connectPopup));

const batteryInfo = uBatteryInfo({ percentage: 86, charging: false });
const batteryPopup = popupPanel([
    ui
        .barItem()
        .style({
            height: px(sSize(1.5)),
            display: "flex",
            alignItems: "center",
            padding: `0 ${px(sSize2.paddingx)}`,
            boxSizing: "border-box",
        })
        .add(batteryInfo.el),
    ui
        .barItem()
        .style({ height: px(sSize(1)) })
        .add(
            uSegmented({
                items: [
                    { label: "节能", value: "power-saver" },
                    { label: "平衡", value: "balanced" },
                    { label: "性能", value: "performance" },
                ],
                value: "balanced",
            }).el,
        ),
    listPanel(
        [
            uBatteryRow("鼠标", 64).el,
            uBatteryRow("键盘", 92).el,
            uBatteryRow("手柄", 30).el,
            uBatteryRow("耳机", 55).el,
        ],
        sSize(1.5) * 4,
    ),
]);
popupRow.add(popupColumn("电源", batteryPopup));

function fakeBinding<T>(initial: T): BindingSource<T> {
    let value = initial;
    const subscribers = new Set<(next: T) => void>();
    return {
        get: async () => value,
        subscribe: (cb) => {
            subscribers.add(cb);
            cb(value);
            return () => subscribers.delete(cb);
        },
        getAndSubscribe: (cb) => {
            const wrapped = (next: T) => cb(next, false);
            subscribers.add(wrapped);
            cb(value, true);
            return () => subscribers.delete(wrapped);
        },
        set: async (next) => {
            value = next;
            for (const cb of subscribers) cb(value);
        },
    };
}

const mediaMock = mMedia({
    map: async () => ({
        data: fakeBinding({
            title: "夜航星",
            cover: "",
            artist: ["不才"],
            duration: 253,
        }),
        play: fakeBinding(false),
        currentTime: fakeBinding(42),
        next: () => {},
        previous: () => {},
    }),
});
let mediaMockHasItem = true;
mediaMock.setList(["org.mpris.MediaPlayer2.mock"]);
const mediaColumn = popupColumn("媒体", mediaMock.el);
mediaColumn.add(
    button("空 / 有").on("click", () => {
        mediaMockHasItem = !mediaMockHasItem;
        mediaMock.setList(mediaMockHasItem ? ["org.mpris.MediaPlayer2.mock"] : []);
    }),
);
popupRow.add(mediaColumn);

const trayPopup = popupPanel([
    ui
        .barItem()
        .style({ height: px(sSize(1)), display: "flex", alignItems: "center", justifyContent: "center" })
        .add(
            aLineText()
                .sv("music")
                .style({
                    ...gTextStyle.caption,
                    color: gTextStyle.color.secondary,
                    textAlign: "center",
                }),
        ),
    listPanel(
        [
            uChoiceRow({
                label: "显示歌词",
                icon: view().add(getIconXEl("music", { size: 16 })),
                mark: "check",
                selected: true,
                size: 1,
                emphasize: false,
            }).el,
            uChoiceRow({
                label: "均衡器",
                icon: view().add(getIconXEl("settings", { size: 16 })),
                mark: "radio",
                selected: true,
                size: 1,
                emphasize: false,
            }).el,
            uChoiceRow({
                label: "播放列表",
                icon: view().add(getIconXEl("clipboard", { size: 16 })),
                right: view().add(getIconXEl("chevron.right", { size: 14, width: 16, height: 16 })),
                size: 1,
                emphasize: false,
            }).el,
            uChoiceRow({
                label: "音量增强",
                icon: view().add(getIconXEl("speaker", { size: 16 })),
                mark: "check",
                selected: false,
                size: 1,
                emphasize: false,
            }).el,
            uChoiceRow({
                label: "禁止休眠",
                icon: view().add(getIconXEl("sun", { size: 16 })),
                mark: "check",
                selected: true,
                size: 1,
                emphasize: false,
            }).el,
            uChoiceRow({
                label: "网络",
                icon: view().add(getIconXEl("wifi", { size: 16 })),
                right: view().add(getIconXEl("chevron.right", { size: 14, width: 16, height: 16 })),
                size: 1,
                emphasize: false,
            }).el,
            uChoiceRow({
                label: "设备",
                icon: view().add(getIconXEl("blue", { size: 16 })),
                right: view().add(getIconXEl("chevron.right", { size: 14, width: 16, height: 16 })),
                size: 1,
                emphasize: false,
            }).el,
            uChoiceRow({
                label: "退出",
                icon: view().add(getIconXEl("shutdown", { size: 16 })),
                size: 1,
                emphasize: false,
            }).el,
        ],
        sSize(1) * 8,
    ),
]);
popupRow.add(popupColumn("托盘", trayPopup));

const range = rRange();
const rangePel = view().addInto().style({ width: "300px", height: "20px" });
range.el.addInto(rangePel);
const rangeText = txt().addInto(rangePel);
range.onChange((v) => rangeText.sv(v.toString()));

// 动态滚动列表测试（垂直向下）
const scrollListDemo = view()
    .style({
        marginTop: "20px",
    })
    .addInto();

scrollListDemo.add(txt("动态滚动列表测试（垂直向下）"));

const scrollData = Array.from({ length: 300 }, (_, i) => `项目 ${i + 1}`);

const scrollList = dynamicScrollList<string>({
    itemSize: 40,
    containerSize: 200,
    direction: "down",
    renderItem: (item) => {
        return view("x")
            .style({
                alignItems: "center",
                padding: "0 10px",
                background: "#f5f5f5",
            })
            .add(txt(item));
    },
    keyExtractor: (item) => item,
});

scrollListDemo.add(scrollList.el.style({ width: "300px" }));

scrollList.setList(scrollData, true);

// 动态滚动列表测试，数据动画
const scrollListDataDemo = view()
    .style({
        marginTop: "20px",
    })
    .addInto();

scrollListDataDemo.add(txt("动态滚动列表测试（垂直向下）"));

const scrollDataData = Array.from({ length: 300 }, (_, i) => `项目 ${i + 1}`);

const scrollDataList = dynamicScrollList<string>({
    itemSize: 30,
    containerSize: 200,
    direction: "down",
    renderItem: (item) => {
        return view("x")
            .style({
                alignItems: "center",
                padding: "0 10px",
                background: "#f5f5f5",
            })
            .add(txt(item));
    },
    keyExtractor: (item) => item,
});

scrollListDataDemo.add(scrollDataList.el.style({ width: "300px" }));

scrollDataList.setList(scrollDataData, true);

const ndata = [
    "000",
    scrollDataData[1],
    scrollDataData[3],
    "nn",
    scrollData[4],
    scrollDataData[299],
    ...scrollDataData.slice(5, 299),
];

let scrollDataChange = false;
scrollListDataDemo.add(
    button("改变").on("click", () => {
        if (scrollDataChange) {
            scrollDataList.setList(scrollDataData);
        } else {
            scrollDataList.setList(ndata);
        }
        scrollDataChange = !scrollDataChange;
    }),
);

// 横向滚动列表测试
const hListDemo = view()
    .style({
        marginTop: "20px",
    })
    .addInto();

hListDemo.add(txt("横向滚动列表测试（向右，支持纵向滚动映射）"));

const hList = dynamicScrollList<string>({
    itemSize: 120,
    containerSize: 400,
    direction: "right",
    renderItem: (item) => {
        return view()
            .style({
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "#e3f2fd",
            })
            .add(txt(item));
    },
    keyExtractor: (item) => item,
});

hListDemo.add(hList.el);
hList.setList(
    Array.from({ length: 20 }, (_, i) => `卡片 ${i + 1}`),
    true,
);

// 带空提示的滚动列表
const emptyListDemo = view("y").style({ marginTop: "20px", gap: "8px" }).addInto();
emptyListDemo.add(
    aLineText()
        .sv("带空提示的滚动列表")
        .style({ ...gTextStyle.title, color: gTextStyle.color.primary }),
);
const emptyList = uScrollList<string>({
    itemSize: 40,
    containerSize: 160,
    direction: "down",
    crossSize: "300px",
    keyExtractor: (item) => item,
    renderItem: (item) =>
        view("x")
            .style({
                height: "40px",
                alignItems: "center",
                padding: "0 10px",
                background: "#f5f5f5",
                borderRadius: px(gRadius.item),
            })
            .add(aLineText().sv(item)),
    empty: "没有内容",
});
emptyList.setList([]);
emptyList.el.addInto(emptyListDemo);
view("x")
    .style({ gap: "8px" })
    .addInto(emptyListDemo)
    .add([
        button("空列表").on("click", () => emptyList.setList([])),
        button("2 项").on("click", () => emptyList.setList(["项目 1", "项目 2"])),
        button("10 项").on("click", () =>
            emptyList.setList(Array.from({ length: 10 }, (_, index) => `项目 ${index + 1}`)),
        ),
    ]);

// Carousel测试（垂直，带指示器）
const carouselDemo = view()
    .style({
        marginTop: "20px",
    })
    .addInto();

carouselDemo.add(txt("Carousel测试"));

const carouselItems = Array.from({ length: 12 }, (_, i) => `页面 ${i + 1}`);

// 创建指示器
const indicator = view("x").style({
    gap: "8px",
    marginTop: "12px",
    height: "20px",
    alignItems: "center",
});

const dots: ReturnType<typeof view>[] = [];
const progressIndicator = view().style({
    width: "40px",
    height: "4px",
    background: "#1976d2",
    borderRadius: "2px",
    overflow: "hidden",
    position: "relative",
});

const progressBar = view().style({
    height: "100%",
    width: "0%",
    background: "#64b5f6",
});

progressIndicator.add(progressBar);

carouselItems.forEach((_, i) => {
    const dot = view()
        .style({
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: i === 0 ? "#1976d2" : "#ccc",
        })
        .on("click", () => {
            carouselView.goToPage(i);
        });
    dots.push(dot);
    indicator.add(dot);
});

indicator.add(progressIndicator);

const carouselView = carousel<string>({
    itemSize: 120,
    direction: "right",
    renderItem: (item) => {
        return view()
            .style({
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "#e8f4e8",
            })
            .add(txt(item));
    },
    keyExtractor: (item) => item,
    onScroll: (index, progress) => {
        // 更新指示器
        dots.forEach((dot, i) => {
            const p = Math.max(0, 1 - Math.abs(index + progress - i));
            dot.style({
                background: `color-mix(in oklch, #1976d2 ${p * 100}%, #ccc)`,
            });
        });

        // 更新进度条
        const totalProgress = (index + progress) / (carouselItems.length - 1);
        progressBar.style({
            width: `${totalProgress * 100}%`,
        });
    },
});

carouselDemo.add(carouselView.el);
carouselDemo.add(indicator);

const carouselControls = view("x").style({ marginTop: "10px", gap: "10px" }).addInto();
carouselControls.add(
    button("上一页").on("click", () => {
        carouselView.prevPage();
    }),
);
carouselControls.add(
    button("下一页").on("click", () => {
        carouselView.nextPage();
    }),
);

carouselView.setList(carouselItems, true);

// 输入法界面：候选窗和托盘弹窗，用于手动调整圆角/高亮/间距
const imeDemo = view("y").style({ marginTop: "30px", gap: "12px", position: "relative" }).addInto();
imeDemo.add(aLineText().sv("输入法界面"));

const imePreview = view()
    .style({
        position: "relative",
        height: "300px",
        border: "1px dashed #bbb",
        borderRadius: px(12),
        overflow: "hidden",
    })
    .addInto(imeDemo);

const imeCandidate = imeCandidatePopup({
    select: (index) => console.log("select", index),
    nextPage: () => console.log("next page"),
    prevPage: () => console.log("prev page"),
});
imeCandidate.el.addInto(imePreview);

function imeSampleState(op = { layout: 0, cursor: 0, prev: false, next: true }) {
    return {
        preedit: "zhen bu cuo",
        preeditCursor: 11,
        panelPreedit: "zhen bu cuo",
        clientPreedit: "zhen bu cuo",
        clientPreeditEnabled: true,
        auxiliary: "",
        candidates: ["真不错", "真不搓", "真步错", "针不错", "甄不错"],
        candidateLabels: ["1", "2", "3", "4", "5"],
        candidateCursor: op.cursor,
        candidateLayout: op.layout,
        hasPrev: op.prev,
        hasNext: op.next,
    };
}

let imePanelMode: PanelPreeditMode = "auto";
let imeState = imeSampleState();

function imeRender(state = imeState) {
    imeState = state;
    const { panel } = resolveImePreedit(state, imePanelMode);
    imeCandidate.update({ ...state, preedit: panel });
}

imeCandidate.setAnchor({ x: 24, y: 24, w: 2, h: 16 });
imeRender();

view("x")
    .style({ gap: "8px", padding: "8px", flexWrap: "wrap" })
    .addInto(imePreview)
    .add([
        button("纵向").on("click", () => imeRender(imeSampleState())),
        button("横向").on("click", () => imeRender(imeSampleState({ layout: 2, cursor: 1, prev: true, next: true }))),
        button("预编辑 auto").on("click", () => {
            imePanelMode = "auto";
            imeRender();
        }),
        button("预编辑 always").on("click", () => {
            imePanelMode = "always";
            imeRender();
        }),
        button("预编辑 never").on("click", () => {
            imePanelMode = "never";
            imeRender();
        }),
        button("无内联（面板兜底）").on("click", () => {
            imeRender({ ...imeSampleState(), clientPreedit: "", clientPreeditEnabled: false });
        }),
        button("隐藏").on("click", () => imeCandidate.hide()),
    ]);
