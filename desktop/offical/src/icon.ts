type Icon = {
    /** 视觉重心 */
    center: { x: number; y: number };
    layout: { name: string; shapes: xShape[] }[];
};

type Point = { x: number; y: number };
type zLinePoint = { p: Point; ro: number; ri: number };
type zLine = { ps: zLinePoint[]; width: number; close?: boolean; fill?: boolean; color: string };
type dot = { p: Point; sizeWidth: number; color: string };

type xShape = { type: "zline"; data: zLine } | { type: "dot"; data: dot };

function p(startPoint: Point, angle: number, size: number) {
    const ax = (angle / 180) * Math.PI;
    return {
        x: startPoint.x + size * Math.cos(ax),
        y: startPoint.y + size * Math.sin(ax),
    } as Point;
}

// 向量计算函数
function vecSub(a: Point, b: Point): Point {
    return { x: a.x - b.x, y: a.y - b.y };
}

function vecAdd(a: Point, b: Point): Point {
    return { x: a.x + b.x, y: a.y + b.y };
}

function vecLen(v: Point): number {
    return Math.sqrt(v.x * v.x + v.y * v.y);
}

function vecNorm(v: Point): Point {
    const len = vecLen(v);
    if (len === 0) return { x: 0, y: 0 };
    return { x: v.x / len, y: v.y / len };
}

function vecDot(a: Point, b: Point): number {
    return a.x * b.x + a.y * b.y;
}

function vecCross(a: Point, b: Point): number {
    return a.x * b.y - a.y * b.x;
}

function vecScale(v: Point, s: number): Point {
    return { x: v.x * s, y: v.y * s };
}

// 计算圆角的切点和圆弧
function computeFillet(
    p: Point,
    v1: Point, // 进入边方向（单位向量，从 P0 指向 P）
    v2: Point, // 离开边方向（单位向量，从 P 指向 P2）
    r: number, // 圆角半径
): { tp1: Point; tp2: Point; arc: string } | null {
    if (r <= 0) return null;

    const dir1 = vecScale(v1, -1);
    const dir2 = v2;

    const cosTheta = vecDot(dir1, dir2);
    const sinHalfAngle = Math.sqrt((1 - cosTheta) / 2);
    const cosHalfAngle = Math.sqrt((1 + cosTheta) / 2);

    if (sinHalfAngle < 1e-10) return null;

    const halfAngle = Math.atan2(sinHalfAngle, cosHalfAngle);
    const d = r / Math.tan(halfAngle);

    const tp1 = vecAdd(p, vecScale(dir1, d));
    const tp2 = vecAdd(p, vecScale(dir2, d));

    const cross = vecCross(v1, v2);
    const sweep = cross > 0 ? 1 : 0;

    const arc = `A ${r} ${r} 0 0 ${sweep} ${n(tp2.x)} ${n(tp2.y)}`;

    return { tp1, tp2, arc };
}

function n(v: number): number {
    return Math.round(v * 100) / 100;
}

// 左法向量（垂直于方向，指向左侧）
function leftNormal(d: Point): Point {
    return { x: -d.y, y: d.x };
}

// 右法向量（垂直于方向，指向右侧）
function rightNormal(d: Point): Point {
    return { x: d.y, y: -d.x };
}

// 计算两条偏移边的交点（miter point）
function miterPoint(p: Point, d1: Point, d2: Point, hw: number, side: number): Point {
    const n1 = side > 0 ? leftNormal(d1) : rightNormal(d1);
    const n2 = side > 0 ? leftNormal(d2) : rightNormal(d2);
    const cross = vecCross(d1, d2);
    if (Math.abs(cross) < 1e-10) {
        return vecAdd(p, vecScale(n1, hw));
    }
    const diff = vecSub(n2, n1);
    const t = (hw * vecCross(diff, d2)) / cross;
    return vecAdd(p, vecAdd(vecScale(n1, hw), vecScale(d1, t)));
}

// 生成zline的路径
function generateZLinePath(zline: zLine): string {
    const { ps, width } = zline;
    if (ps.length < 2) return "";

    const hw = width / 2;
    const len = ps.length;

    // 计算每条边的方向
    const edgeDirs: Point[] = [];
    for (let i = 0; i < len - 1; i++) {
        edgeDirs.push(vecNorm(vecSub(ps[i + 1].p, ps[i].p)));
    }

    let leftPath = "";
    let rightPath = "";

    if (zline.close && len > 2) {
        // close 模式：起点终点重合，需要手动处理
        // 闭合边方向：从最后一个点到第一个点
        const closeDir = vecNorm(vecSub(ps[0].p, ps[len - 1].p));
        const allDirs = [...edgeDirs, closeDir];

        if (zline.fill) {
            // fill 模式：左右轮廓同向遍历，都用 ro
            for (let i = 0; i < len; i++) {
                const prev = (i - 1 + len) % len;
                const d1 = allDirs[prev];
                const d2 = allDirs[i];
                const r = ps[i].ro;

                // 左侧 miter
                const miterL = miterPoint(ps[i].p, d1, d2, hw, 1);
                const filletL = computeFillet(miterL, d1, d2, r);
                if (i === 0) {
                    if (filletL) {
                        leftPath = `M ${n(filletL.tp1.x)} ${n(filletL.tp1.y)}`;
                        leftPath += ` ${filletL.arc}`;
                    } else {
                        leftPath = `M ${n(miterL.x)} ${n(miterL.y)}`;
                    }
                } else {
                    if (filletL) {
                        leftPath += ` L ${n(filletL.tp1.x)} ${n(filletL.tp1.y)}`;
                        leftPath += ` ${filletL.arc}`;
                    } else {
                        leftPath += ` L ${n(miterL.x)} ${n(miterL.y)}`;
                    }
                }

                // 右侧 miter（同向）
                const miterR = miterPoint(ps[i].p, d1, d2, hw, -1);
                const filletR = computeFillet(miterR, d1, d2, r);
                if (i === 0) {
                    if (filletR) {
                        rightPath = `M ${n(filletR.tp1.x)} ${n(filletR.tp1.y)}`;
                        rightPath += ` ${filletR.arc}`;
                    } else {
                        rightPath = `M ${n(miterR.x)} ${n(miterR.y)}`;
                    }
                } else {
                    if (filletR) {
                        rightPath += ` L ${n(filletR.tp1.x)} ${n(filletR.tp1.y)}`;
                        rightPath += ` ${filletR.arc}`;
                    } else {
                        rightPath += ` L ${n(miterR.x)} ${n(miterR.y)}`;
                    }
                }
            }
        } else {
            // 非 fill 模式：左轮廓正向，右轮廓反向
            // 左轮廓：正向遍历
            for (let i = 0; i < len; i++) {
                const prev = (i - 1 + len) % len;
                const d1 = allDirs[prev];
                const d2 = allDirs[i];
                const cross = vecCross(d1, d2);
                const r = cross > 0 ? ps[i].ri : ps[i].ro;

                const miterL = miterPoint(ps[i].p, d1, d2, hw, 1);
                const filletL = computeFillet(miterL, d1, d2, r);
                if (i === 0) {
                    if (filletL) {
                        leftPath = `M ${n(filletL.tp1.x)} ${n(filletL.tp1.y)}`;
                        leftPath += ` ${filletL.arc}`;
                    } else {
                        leftPath = `M ${n(miterL.x)} ${n(miterL.y)}`;
                    }
                } else {
                    if (filletL) {
                        leftPath += ` L ${n(filletL.tp1.x)} ${n(filletL.tp1.y)}`;
                        leftPath += ` ${filletL.arc}`;
                    } else {
                        leftPath += ` L ${n(miterL.x)} ${n(miterL.y)}`;
                    }
                }
            }

            // 右轮廓：反向遍历
            for (let i = len - 1; i >= 0; i--) {
                const prev = (i - 1 + len) % len;
                const d2 = vecScale(allDirs[i], 1); // 反向：从当前点到下一个点
                const d1 = vecScale(allDirs[prev], 1); // 反向：从下一个点到下下个点
                const cross = vecCross(d1, d2);
                const r = cross < 0 ? ps[i].ri : ps[i].ro;

                const miterR = miterPoint(ps[i].p, d1, d2, hw, -1);
                const filletR = computeFillet(miterR, vecScale(d2, -1), vecScale(d1, -1), r);

                if (i === len - 1) {
                    if (filletR) {
                        rightPath = `M ${n(filletR.tp1.x)} ${n(filletR.tp1.y)}`;
                        rightPath += ` ${filletR.arc}`;
                    } else {
                        rightPath = `M ${n(miterR.x)} ${n(miterR.y)}`;
                    }
                } else {
                    if (filletR) {
                        rightPath += ` L ${n(filletR.tp1.x)} ${n(filletR.tp1.y)}`;
                        rightPath += ` ${filletR.arc}`;
                    } else {
                        rightPath += ` L ${n(miterR.x)} ${n(miterR.y)}`;
                    }
                }
            }
        }

        // 闭合左右轮廓
        leftPath += " Z ";
        rightPath += " Z";
    } else {
        // 非 close 模式：起点终点有端点修饰
        const startRo = ps[0].ro;
        const endRo = ps[len - 1].ro;

        const startV = edgeDirs[0];
        const startN = leftNormal(startV);
        const startLeft = vecAdd(ps[0].p, vecScale(startN, hw));
        const startRight = vecAdd(ps[0].p, vecScale(startN, -hw));

        const endV = edgeDirs[len - 2];
        const endN = leftNormal(endV);
        const endLeft = vecAdd(ps[len - 1].p, vecScale(endN, hw));
        const endRight = vecAdd(ps[len - 1].p, vecScale(endN, -hw));

        const startLeftFillet = computeFillet(startLeft, startN, startV, startRo);
        const startRightFillet = computeFillet(startRight, vecScale(startV, -1), startN, startRo);
        const endLeftFillet = computeFillet(endLeft, endV, vecScale(endN, -1), endRo);
        const endRightFillet = computeFillet(endRight, vecScale(endN, -1), vecScale(endV, -1), endRo);

        // 左侧轮廓
        if (startLeftFillet) {
            leftPath = `M ${n(startLeftFillet.tp1.x)} ${n(startLeftFillet.tp1.y)}`;
            leftPath += ` ${startLeftFillet.arc}`;
        } else {
            leftPath = `M ${n(startLeft.x)} ${n(startLeft.y)}`;
        }

        for (let i = 1; i < len - 1; i++) {
            const d1 = edgeDirs[i - 1];
            const d2 = edgeDirs[i];
            const cross = vecCross(d1, d2);
            const r = cross > 0 ? ps[i].ri : ps[i].ro;
            const miter = miterPoint(ps[i].p, d1, d2, hw, 1);
            const fillet = computeFillet(miter, d1, d2, r);
            if (fillet) {
                leftPath += ` L ${n(fillet.tp1.x)} ${n(fillet.tp1.y)}`;
                leftPath += ` ${fillet.arc}`;
            } else {
                leftPath += ` L ${n(miter.x)} ${n(miter.y)}`;
            }
        }

        if (endLeftFillet) {
            leftPath += ` L ${n(endLeftFillet.tp1.x)} ${n(endLeftFillet.tp1.y)}`;
            leftPath += ` ${endLeftFillet.arc}`;
        } else {
            leftPath += ` L ${n(endLeft.x)} ${n(endLeft.y)}`;
        }

        // 右侧轮廓
        if (endRightFillet) {
            rightPath = `L ${n(endRightFillet.tp1.x)} ${n(endRightFillet.tp1.y)}`;
            rightPath += ` ${endRightFillet.arc}`;
        } else {
            rightPath = `L ${n(endRight.x)} ${n(endRight.y)}`;
        }

        for (let i = len - 2; i >= 1; i--) {
            const d1 = edgeDirs[i];
            const d2 = edgeDirs[i - 1];
            const cross = vecCross(d1, d2);
            const r = cross > 0 ? ps[i].ri : ps[i].ro;
            const miter = miterPoint(ps[i].p, d1, d2, hw, -1);
            const fillet = computeFillet(miter, vecScale(d1, -1), vecScale(d2, -1), r);
            if (fillet) {
                rightPath += ` L ${n(fillet.tp1.x)} ${n(fillet.tp1.y)}`;
                rightPath += ` ${fillet.arc}`;
            } else {
                rightPath += ` L ${n(miter.x)} ${n(miter.y)}`;
            }
        }

        if (startRightFillet) {
            rightPath += ` L ${n(startRightFillet.tp1.x)} ${n(startRightFillet.tp1.y)}`;
            rightPath += ` ${startRightFillet.arc}`;
        } else {
            rightPath += ` L ${n(startRight.x)} ${n(startRight.y)}`;
        }
    }

    return leftPath + rightPath;
}

// 渲染dot为svg圆
function renderDot(dot: dot): string {
    const { p, sizeWidth, color } = dot;
    const radius = sizeWidth / 2;
    return `<circle cx="${p.x}" cy="${p.y}" r="${radius}" fill="${color}"/>`;
}

// 渲染zline为svg路径
function renderZLine(zline: zLine): string {
    const path = generateZLinePath(zline);
    return `<path d="${path}" fill="${zline.color}"/>`;
}

// 渲染单个shape
function renderShape(shape: xShape): string {
    if (shape.type === "dot") {
        return renderDot(shape.data);
    } else if (shape.type === "zline") {
        return renderZLine(shape.data);
    }
    return "";
}

// 渲染整个图标
function render(icon: Icon): string {
    let svgContent = "";

    for (const layer of icon.layout) {
        svgContent += `<g id="${layer.name}">`;
        for (const shape of layer.shapes) {
            svgContent += renderShape(shape);
        }
        svgContent += `</g>`;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${svgContent}</svg>`;
}

export function getIconX(name: string) {
    if (name in iconsName) {
        return render(iconsName[name]({ center: { x: 256 / 2, y: 256 / 2 }, size: 256, color: "#000" }));
    }
    return undefined;
}
export function getIconXEl(name: string, op?: { size: number }) {
    const size = op?.size ?? 16;
    const el = document.createElement("div");
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    if (name in iconsName) {
        el.innerHTML = render(iconsName[name]({ center: { x: 256 / 2, y: 256 / 2 }, size: 256, color: "#000" }));
    }
    return el;
}

const iconsName: Record<string, (env: { center: { x: number; y: number }; size: number; color: string }) => Icon> = {
    line: (env) => {
        return {
            center: { x: env.center.x, y: env.center.y },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: p(env.center, 180, env.size / 2), ro: 4, ri: 0 },
                                    { p: p(env.center, 0, env.size / 2), ro: 4, ri: 0 },
                                ],
                                width: 20,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    zline: (env) => {
        return {
            center: { x: env.center.x, y: env.center.y },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: p(env.center, 180, env.size / 2 - 30), ro: 4, ri: 0 },
                                    { p: p(env.center, -90, env.size / 2 - 30), ro: 24, ri: 4 },
                                    { p: p(env.center, 90, env.size / 2 - 30), ro: 24, ri: 4 },
                                    { p: p(env.center, 0, env.size / 2 - 30), ro: 4, ri: 0 },
                                ],
                                width: 20,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    dot: (env) => {
        return {
            center: { x: env.center.x, y: env.center.y },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "dot",
                            data: { p: env.center, sizeWidth: 20, color: env.color },
                        },
                    ],
                },
            ],
        };
    },
    rect: (env) => {
        return {
            center: { x: env.center.x, y: env.center.y },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: 10, y: 10 }, ri: 4, ro: 14 },
                                    { p: { x: 100, y: 10 }, ri: 4, ro: 14 },
                                    { p: { x: 100, y: 100 }, ri: 4, ro: 14 },
                                    { p: { x: 10, y: 100 }, ri: 4, ro: 14 },
                                ],
                                width: 10,
                                close: true,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "rect.r": (env) => {
        return {
            center: { x: env.center.x, y: env.center.y },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: 10, y: 100 }, ri: 4, ro: 14 },
                                    { p: { x: 100, y: 100 }, ri: 4, ro: 14 },
                                    { p: { x: 100, y: 10 }, ri: 4, ro: 14 },
                                    { p: { x: 10, y: 10 }, ri: 4, ro: 14 },
                                ],
                                width: 10,
                                close: true,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "rect.fill": (env) => {
        return {
            center: { x: env.center.x, y: env.center.y },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: 10, y: 10 }, ri: 4, ro: 14 },
                                    { p: { x: 100, y: 10 }, ri: 4, ro: 14 },
                                    { p: { x: 100, y: 100 }, ri: 4, ro: 14 },
                                    { p: { x: 10, y: 100 }, ri: 4, ro: 14 },
                                ],
                                width: 10,
                                close: true,
                                fill: true,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    blue: (env) => {
        const w = 24;
        const padding = w / 2;
        const radius = 8;
        return {
            center: { x: env.center.x, y: env.center.y },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: p(env.center, -150, env.size / 2 - padding), ri: 0, ro: radius },
                                    { p: p(env.center, 30, env.size / 2 - padding), ri: 0, ro: padding },
                                    { p: p(env.center, 90, env.size / 2 - padding), ri: 0, ro: padding },
                                    { p: p(env.center, -90, env.size / 2 - padding), ri: 0, ro: padding },
                                    { p: p(env.center, -30, env.size / 2 - padding), ri: 0, ro: padding },
                                    { p: p(env.center, 150, env.size / 2 - padding), ri: 0, ro: radius },
                                ],
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
};
