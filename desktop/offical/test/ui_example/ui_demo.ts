import { view, txt, button, addStyle } from "dkh-ui";
import { uPasswdInput } from "../../src/ui";
import { dynamicScrollList, carousel } from "../../src/scroll-list";

addStyle({ body: { userSelect: "none" } });

// 原有密码输入组件测试
const i = uPasswdInput();
i.placeholder("input your p");
const p = i.el.style({
    width: "200px",
    height: "24px",
    background: "#eee",
});
const r = view();
view().add(["passwd", p, r]).addInto();
p.on("change", () => {
    r.clear().add(p.gv);
});

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
