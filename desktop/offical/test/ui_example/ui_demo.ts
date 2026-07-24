import { addStyle, button, initDKH, txt, view } from "dkh-ui";
import { carousel, dynamicScrollList } from "../../src/scroll-list";
import { iItem, sSize, ui } from "../../src/ui";

addStyle({ body: { userSelect: "none", padding: "8px" } });
initDKH({ pureStyle: true });

// 原有密码输入组件测试
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
        itemSize: sSize.item,
        containerSize: 100,
        direction: "down",
        keyExtractor: (x) => x,
        renderItem: (k) => {
            if (k === "1") {
                return iItem({ type: "h", size: "item" }).style({ backgroundColor: "#fff" }).add(k);
            }
            return iItem({ type: "h", size: "item" }).add(k);
        },
    });

    const popup = ui.bar([
        ui.barItem().add(iItem({ type: "h", size: "oneLine" }).add(txt("测试文本"))),
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
