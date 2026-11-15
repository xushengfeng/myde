import { addStyle, ele, initDKH, txt, view } from "dkh-ui";
import { CURSOR_SHAPES, CursorShapeAnimator, cursorDesign, lineRotationDelta } from "../../src/cursor";

/** 单元格边长（px） */
const CELL_SIZE = 40;
/** 行标题宽度（px） */
const ROW_LABEL_WIDTH = 156;
/** 列标题高度（px），竖排名字需要放下最长的一个 */
const COL_LABEL_HEIGHT = 120;

const COLORS = {
    page: "#16161c",
    text: "#d5d8e0",
    muted: "#9298a6",
    line: "#34343e",
    cell: "#1d1d24",
    diagonal: "#2a2a36",
    colHeader: "#2c2c36",
    rowHeader: "#262630",
    corner: "#202028",
};

/** 矩阵轴上的一个光标：label 用于表头，shape 决定画什么 */
type PreviewCursor = { label: string; shape: string };

/**
 * 桌面自身的默认常规静态状态（不是客户端 shape），排在最前。
 * 目前和协议 default 形状画法一致；以后两者可以各自演化。
 */
const NORMAL_CURSOR: PreviewCursor = { label: "normal", shape: "default" };

const PREVIEW_CURSORS: PreviewCursor[] = [NORMAL_CURSOR, ...CURSOR_SHAPES.map((shape) => ({ label: shape, shape }))];

/** 预览用慢一点的过渡，方便观察中间形态 */
const PREVIEW_DURATION = 420;
/** 到达一个状态后停留的时间，给观察留出时间 */
const STATE_HOLD_MS = 1000;
/** 错开各单元格的初相位，避免整张矩阵同时闪烁，也降低峰值开销 */
const STAGGER_GROUPS = 12;
const STAGGER_STEP_MS = 70;

/** 自动在行形状和列形状之间来回播放，每到一个状态停一会儿 */
function autoPlayCell(animator: CursorShapeAnimator, fromShape: string, toShape: string, phase: number) {
    // 页面打开时已经静态显示目标形状，动画从目标状态开始往行形状走
    let showingTo = true;
    const step = () => {
        showingTo = !showingTo;
        animator.setShape(showingTo ? toShape : fromShape, PREVIEW_DURATION);
        window.setTimeout(step, PREVIEW_DURATION + STATE_HOLD_MS);
    };
    window.setTimeout(step, phase * STAGGER_STEP_MS);
}

function headerCell(extra: Record<string, string | number>) {
    return ele("th").style({
        padding: "0",
        border: `1px solid ${COLORS.line}`,
        color: COLORS.text,
        fontWeight: "400",
        verticalAlign: "middle",
        ...extra,
    });
}

function buildMatrix() {
    const table = ele("table").style({
        borderCollapse: "separate",
        borderSpacing: "0",
        fontFamily: "monospace",
        fontSize: "11px",
    });

    const thead = ele("thead").addInto(table);
    const headRow = ele("tr").addInto(thead);

    // 左上角：标明行列方向
    headerCell({
        position: "sticky",
        left: "0",
        top: "0",
        zIndex: "3",
        width: `${ROW_LABEL_WIDTH}px`,
        minWidth: `${ROW_LABEL_WIDTH}px`,
        height: `${COL_LABEL_HEIGHT}px`,
        background: COLORS.corner,
        textAlign: "left",
        paddingLeft: "8px",
    })
        .add(txt("起始 \\ 目标").style({ fontFamily: "sans-serif", color: COLORS.muted }))
        .addInto(headRow);

    // 列：目标光标，竖排以免把矩阵撑得太宽
    for (const to of PREVIEW_CURSORS) {
        headerCell({
            position: "sticky",
            top: "0",
            zIndex: "2",
            width: `${CELL_SIZE}px`,
            minWidth: `${CELL_SIZE}px`,
            height: `${COL_LABEL_HEIGHT}px`,
            background: COLORS.colHeader,
        })
            .add(
                txt(to.label).style({
                    writingMode: "vertical-rl",
                    whiteSpace: "nowrap",
                    fontSize: "10px",
                    color: COLORS.text,
                }),
            )
            .addInto(headRow);
    }

    const tbody = ele("tbody").addInto(table);
    let animatedIndex = 0;
    PREVIEW_CURSORS.forEach((from, fromIndex) => {
        const row = ele("tr").addInto(tbody);

        // 行：起始光标
        headerCell({
            position: "sticky",
            left: "0",
            zIndex: "1",
            width: `${ROW_LABEL_WIDTH}px`,
            minWidth: `${ROW_LABEL_WIDTH}px`,
            height: `${CELL_SIZE}px`,
            background: COLORS.rowHeader,
            textAlign: "left",
            paddingLeft: "8px",
        })
            .add(txt(from.label))
            .addInto(row);

        // 只保留上三角：过渡动画来回播放，from → to 与 to → from 是同一个格子，
        // 下三角用透明 colspan 占位，保证列仍然对齐，但不画内容
        if (fromIndex > 0) {
            ele("td")
                .attr({ colSpan: fromIndex })
                .style({ padding: "0", border: "0", background: "transparent" })
                .addInto(row);
        }

        // 单元格：平时显示目标形状，悬停时在选中的两个形状之间来回补间
        for (let toIndex = fromIndex; toIndex < PREVIEW_CURSORS.length; toIndex++) {
            const to = PREVIEW_CURSORS[toIndex];
            const cell = ele("td")
                .style({
                    position: "relative",
                    width: `${CELL_SIZE}px`,
                    minWidth: `${CELL_SIZE}px`,
                    height: `${CELL_SIZE}px`,
                    padding: "0",
                    border: `1px solid ${COLORS.line}`,
                    background: fromIndex === toIndex ? COLORS.diagonal : COLORS.cell,
                })
                .attr({ title: `${from.label} → ${to.label}` })
                .addInto(row);

            const animator = new CursorShapeAnimator();
            animator.el.style({ left: "50%", top: "50%" });
            animator.setShape(to.shape, 0, true);
            cell.add(animator.el);

            // normal 行是静态帧，用红圈标出该形状的热点（鼠标位置）
            if (from.label === "normal") {
                cell.add(
                    view().style({
                        position: "absolute",
                        left: "50%",
                        top: "50%",
                        width: "9px",
                        height: "9px",
                        border: "1px solid #ff5a5f",
                        borderRadius: "50%",
                        transform: "translate(-50%, -50%)",
                        zIndex: "99",
                        pointerEvents: "none",
                    }),
                );
            }

            // normal 是静态基准；设计相同且线方向也没有变化的 pair 不用补间
            const involvesNormal = from.label === "normal" || to.label === "normal";
            const lineDelta = lineRotationDelta(from.shape, to.shape);
            if (!involvesNormal && (cursorDesign(from.shape).key !== cursorDesign(to.shape).key || lineDelta !== 0)) {
                cell.data({ "cursor-animate": "auto" });
                autoPlayCell(animator, from.shape, to.shape, animatedIndex++ % STAGGER_GROUPS);
            }
        }
    });

    return table;
}

if ("document" in globalThis) {
    initDKH({ pureStyle: true });
    addStyle({
        body: {
            background: COLORS.page,
            color: COLORS.text,
            fontFamily: "sans-serif",
        },
    });

    const root = view("y").style({
        padding: "16px",
        gap: "10px",
        alignItems: "flex-start",
    });

    const title = view("y").style({ gap: "4px" });
    title.add(txt("Cursor 预览").style({ fontSize: "20px", fontWeight: "700" }));
    title.add(
        txt(
            "行 = 起始形状，列 = 目标形状；只铺上三角（过渡来回播放，反方向共用同一格）。normal 是桌面自身的默认常规静态状态，不参与动画；其余可变化的单元格自动播放 from ↔ to，并在两端各停留约 1 秒。没单独设计的 resize 复用最近的横/竖/斜线，其他未设计的形状用默认圆点代替。线 resize 的方向切换会按内部方向旋转，双向与单向共线时不转；resize 与 move 之间优先用十字臂过渡；text 与 crosshair 之间竖线保持为 body，横线作为装饰淡入/淡出。normal 行的红圈标出各形状的热点（鼠标位置）。",
        ).style({ fontSize: "12px", color: COLORS.muted }),
    );

    const scroller = view().style({
        display: "block",
        overflow: "auto",
        maxWidth: "calc(100vw - 32px)",
        maxHeight: "calc(100vh - 110px)",
        border: `1px solid ${COLORS.line}`,
        borderRadius: "10px",
    });
    scroller.add(buildMatrix());

    root.add([title, scroller]);
    root.addInto();
}
