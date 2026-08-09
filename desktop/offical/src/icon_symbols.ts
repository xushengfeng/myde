import type { Icon, Point } from "./icon";

function buildZb(size: number) {
    return {
        size,
        center: { x: size / 2, y: size / 2 } as Point,
    };
}

function p(startPoint: Point, angle: number, size: number) {
    const ax = (angle / 180) * Math.PI;
    return {
        x: startPoint.x + size * Math.cos(ax),
        y: startPoint.y + size * Math.sin(ax),
    } as Point;
}

export const iconsName: Record<string, (env: { color: string; data?: Record<string, any> }) => Icon> = {
    line: (env) => {
        const { size, center } = buildZb(256);
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: p(center, 180, size / 2), ro: 4, ri: 0 },
                                    { p: p(center, 0, size / 2), ro: 4, ri: 0 },
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
        const { size, center } = buildZb(256);
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: p(center, 180, size / 2 - 30), ro: 4, ri: 0 },
                                    { p: p(center, -90, size / 2 - 30), ro: 24, ri: 4 },
                                    { p: p(center, 90, size / 2 - 30), ro: 24, ri: 4 },
                                    { p: p(center, 0, size / 2 - 30), ro: 4, ri: 0 },
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
        const { size, center } = buildZb(256);
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "dot",
                            data: { p: center, sizeWidth: 20, color: env.color },
                        },
                    ],
                },
            ],
        };
    },
    rect: (env) => {
        const { size } = buildZb(256);
        return {
            size,
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
        const { size } = buildZb(256);
        return {
            size,
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
        const { size } = buildZb(256);
        return {
            size,
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
        const { size, center } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const radius = 8;
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: p(center, -150, size / 2 - padding), ri: 0, ro: radius },
                                    { p: p(center, 30, size / 2 - padding), ri: 0, ro: padding },
                                    { p: p(center, 90, size / 2 - padding), ri: 0, ro: padding },
                                    { p: p(center, -90, size / 2 - padding), ri: 0, ro: padding },
                                    { p: p(center, -30, size / 2 - padding), ri: 0, ro: padding },
                                    { p: p(center, 150, size / 2 - padding), ri: 0, ro: radius },
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
    battery: (env) => {
        const { size, center } = buildZb(256);
        const w = 16;
        const padding = w / 2;
        const radius = 8;

        const centerGap = 8;

        const rb0 = 8;
        const rb1 = rb0 + centerGap;
        const rb2 = rb1 + w;

        const by = size / 2 - 64;
        const by1 = size / 2 + 64;

        const centerW100 = size - w - w - w - centerGap - centerGap;
        const centerW = Math.max(centerW100 * Math.min(1, env.data?.value ?? 1), rb0 * 2);

        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: padding, y: by }, ri: rb1, ro: rb2 },
                                    { p: { x: size - (padding + w), y: by }, ri: rb1, ro: rb2 },
                                    { p: { x: size - (padding + w), y: by1 }, ri: rb1, ro: rb2 },
                                    { p: { x: padding, y: by1 }, ri: rb1, ro: rb2 },
                                ],
                                close: true,
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: size - padding, y: size / 2 - 24 }, ri: 0, ro: radius },
                                    { p: { x: size - padding, y: size / 2 + 24 }, ri: 0, ro: radius },
                                ],
                                close: true,
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
                {
                    name: "v",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: {
                                            x: w + centerGap,
                                            y: center.y,
                                        },
                                        ri: 0,
                                        ro: rb0,
                                    },
                                    {
                                        p: {
                                            x: w + centerGap + centerW,
                                            y: center.y,
                                        },
                                        ri: 0,
                                        ro: rb0,
                                    },
                                ],
                                width: by1 - by - w - centerGap - centerGap,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    wifi: (env) => {
        const { size, center } = buildZb(256);
        const maxR = (size / 2) * Math.sqrt(2);
        const b = 8;
        const maxRb = Math.floor(maxR / 8);
        const gapb = 2;
        const lOther = Math.floor((maxRb - gapb - gapb) / 3);
        const centerx = maxRb - gapb - gapb - lOther - lOther;
        return {
            size,
            edgeTrim: { top: size - maxRb * b },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: size },
                                fromAngle: -90 - 45,
                                endAngle: -45,
                                r: (centerx + gapb + lOther + gapb + lOther / 2) * b,
                                width: lOther * b,
                                color: env.color,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: size },
                                fromAngle: -90 - 45,
                                endAngle: -45,
                                r: (centerx + gapb + lOther / 2) * b,
                                width: lOther * b,
                                color: env.color,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: size },
                                fromAngle: -90 - 45,
                                endAngle: -45,
                                r: (centerx / 2) * b,
                                width: centerx * b,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    shutdown: (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "arc",
                            data: {
                                center,
                                color: env.color,
                                r: size / 2 - padding,
                                width: w,
                                fromAngle: -45,
                                endAngle: -90 - 45,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x, y: 0 }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x, y: center.y }, ro: w / 2, ri: 0 },
                                ],
                                color: env.color,
                                width: w,
                            },
                        },
                    ],
                },
            ],
        };
    },
    reboot: (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const r = size / 2 - padding;
        const xAngle = -90 - 45 - 10;
        const xPoint = p(center, xAngle, r);
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "arc",
                            data: {
                                center,
                                color: env.color,
                                r,
                                width: w,
                                fromAngle: xAngle,
                                endAngle: xAngle - 30,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: p(xPoint, 0, 56), ro: w / 2, ri: 0 },
                                    { p: xPoint, ro: w / 2, ri: 0 },
                                    { p: p(xPoint, -90, 56), ro: w / 2, ri: 0 },
                                ],
                                color: env.color,
                                width: w,
                            },
                        },
                    ],
                },
            ],
        };
    },
    suspend: (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const r = size / 2 - padding;
        const p0 = { x: 160, y: 32 };
        const p1 = p(p0, 0, 48);
        const p2 = p(p1, 90 + 40, 48 / Math.sin((40 / 180) * Math.PI));
        const p3 = p(p2, 0, 48);
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "arc",
                            data: {
                                center,
                                color: env.color,
                                r,
                                width: w,
                                fromAngle: 30,
                                endAngle: -90 - 30,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: p(p0, -180, padding), ro: w / 2, ri: 0 },
                                    { p: p1, ro: w / 2, ri: 0 },
                                    { p: p2, ro: w / 2, ri: 0 },
                                    { p: p(p3, 0, padding), ro: w / 2, ri: 0 },
                                ],
                                color: env.color,
                                width: w,
                            },
                        },
                    ],
                },
            ],
        };
    },
    lock: (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const r = 80 - 16 - 16;
        const c = center.y - 16;
        const bodyW = 160;
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: r + padding },
                                color: env.color,
                                r: r,
                                width: w,
                                fromAngle: -180,
                                endAngle: 0,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x - r, y: r + padding }, ro: 0, ri: 0 },
                                    { p: { x: center.x - r, y: c }, ro: 0, ri: 0 },
                                ],
                                color: env.color,
                                width: w,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x + r, y: r + padding }, ro: 0, ri: 0 },
                                    { p: { x: center.x + r, y: c }, ro: 0, ri: 0 },
                                ],
                                color: env.color,
                                width: w,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x - bodyW / 2, y: c }, ro: w + 8, ri: 8 },
                                    { p: { x: center.x + bodyW / 2, y: c }, ro: w + 8, ri: 8 },
                                    { p: { x: center.x + bodyW / 2, y: size - padding }, ro: w + 8, ri: 8 },
                                    { p: { x: center.x - bodyW / 2, y: size - padding }, ro: w + 8, ri: 8 },
                                ],
                                close: true,
                                color: env.color,
                                width: w,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "chevron.left": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        return {
            size,
            edgeTrim: { right: center.x + padding },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: p({ x: center.x, y: padding }, -45, w / 2), ro: w / 2, ri: 0 },
                                    { p: { x: padding, y: center.y }, ro: w / 2, ri: 0 },
                                    { p: p({ x: center.x, y: size - padding }, 45, w / 2), ro: w / 2, ri: 0 },
                                ],
                                color: env.color,
                                width: w,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "chevron.right": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        return {
            size,
            edgeTrim: { right: center.x + padding },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: p({ x: padding, y: padding }, -90 - 45, w / 2), ro: w / 2, ri: 0 },
                                    { p: center, ro: w / 2, ri: 0 },
                                    { p: p({ x: padding, y: size - padding }, 180 - 45, w / 2), ro: w / 2, ri: 0 },
                                ],
                                color: env.color,
                                width: w,
                            },
                        },
                    ],
                },
            ],
        };
    },
    music: (env) => {
        const { size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const r = 48;
        const fw = 64;
        return {
            size,
            edgeTrim: { right: r * 2 + fw },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "arc",
                            data: {
                                center: { x: r, y: size - r },
                                r: r - r / 2,
                                endAngle: 0,
                                fromAngle: 0,
                                color: env.color,
                                width: r,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: r * 2 - padding, y: size - r }, ro: 0, ri: 0 },
                                    { p: { x: r * 2 - padding, y: 32 }, ro: 0, ri: 0 },
                                ],
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: r * 2 - padding, y: 24 }, ro: w / 2, ri: 0 },
                                    { p: { x: r * 2 - padding + fw, y: padding }, ro: w / 2, ri: 0 },
                                    { p: { x: r * 2 - padding + fw, y: padding + 48 }, ro: w / 2, ri: 0 },
                                    { p: { x: r * 2 - padding, y: 24 + 48 }, ro: w / 2, ri: 0 },
                                ],
                                close: true,
                                fill: true,
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "media.forward.fill": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const y1 = center.y - 64;
        const y2 = center.y + 64;
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: padding, y: y1 }, ro: w / 2, ri: 0 },
                                    { p: center, ro: w / 2, ri: 0 },
                                    { p: { x: padding, y: y2 }, ro: w / 2, ri: 0 },
                                ],
                                close: true,
                                fill: true,
                                color: env.color,
                                width: w,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x, y: y1 }, ro: w / 2, ri: 0 },
                                    { p: { x: size - padding, y: center.y }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x, y: y2 }, ro: w / 2, ri: 0 },
                                ],
                                close: true,
                                fill: true,
                                color: env.color,
                                width: w,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "media.backward.fill": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const y1 = center.y - 64;
        const y2 = center.y + 64;
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x, y: y1 }, ro: w / 2, ri: 0 },
                                    { p: { x: padding, y: center.y }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x, y: y2 }, ro: w / 2, ri: 0 },
                                ],
                                close: true,
                                fill: true,
                                color: env.color,
                                width: w,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: size - padding, y: y1 }, ro: w / 2, ri: 0 },
                                    { p: center, ro: w / 2, ri: 0 },
                                    { p: { x: size - padding, y: y2 }, ro: w / 2, ri: 0 },
                                ],
                                close: true,
                                fill: true,
                                color: env.color,
                                width: w,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "media.play.fill": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const ww = 8 * 24;
        return {
            size,
            edgeTrim: { right: ww + padding },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: padding, y: padding }, ro: w / 2, ri: 0 },
                                    { p: { x: ww, y: center.y }, ro: w / 2, ri: 0 },
                                    { p: { x: padding, y: size - padding }, ro: w / 2, ri: 0 },
                                ],
                                close: true,
                                fill: true,
                                color: env.color,
                                width: w,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "media.pause.fill": (env) => {
        const { size } = buildZb(256);
        const w = 80;
        const padding = w / 2;
        const radius = 16;
        const gap = 32;
        return {
            size,
            edgeTrim: { right: w + w + gap },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: padding, y: 0 }, ro: radius, ri: 0 },
                                    { p: { x: padding, y: size }, ro: radius, ri: 0 },
                                ],
                                close: true,
                                fill: true,
                                color: env.color,
                                width: w,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: padding + w + gap, y: 0 }, ro: radius, ri: 0 },
                                    { p: { x: padding + w + gap, y: size }, ro: radius, ri: 0 },
                                ],
                                close: true,
                                fill: true,
                                color: env.color,
                                width: w,
                            },
                        },
                    ],
                },
            ],
        };
    },
    cross: (env) => {
        const { size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const pd = padding * (1 - Math.SQRT1_2);
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: pd, y: pd }, ro: w / 2, ri: 0 },
                                    { p: { x: size - pd, y: size - pd }, ro: w / 2, ri: 0 },
                                ],
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: size - pd, y: pd }, ro: w / 2, ri: 0 },
                                    { p: { x: pd, y: size - pd }, ro: w / 2, ri: 0 },
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
    mutiWinView: (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const cW = 8 * 16;
        const cH = 8 * 10;
        const dt = (cW - cH) / 2;
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x - cW / 2, y: center.y - cH / 2 }, ro: w, ri: 0 },
                                    { p: { x: center.x + cW / 2, y: center.y - cH / 2 }, ro: w, ri: 0 },
                                    { p: { x: center.x + cW / 2, y: center.y + cH / 2 }, ro: w, ri: 0 },
                                    { p: { x: center.x - cW / 2, y: center.y + cH / 2 }, ro: w, ri: 0 },
                                ],
                                close: true,
                                fill: true,
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x - cW / 2 - padding, y: padding + dt }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x + cW / 2 + padding, y: padding + dt }, ro: w / 2, ri: 0 },
                                ],
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x - cW / 2 - padding, y: size - padding - dt }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x + cW / 2 + padding, y: size - padding - dt }, ro: w / 2, ri: 0 },
                                ],
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: padding, y: center.y - cH / 2 - padding }, ro: w / 2, ri: 0 },
                                    { p: { x: padding, y: center.y + cH / 2 + padding }, ro: w / 2, ri: 0 },
                                ],
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: size - padding, y: center.y - cH / 2 - padding }, ro: w / 2, ri: 0 },
                                    { p: { x: size - padding, y: center.y + cH / 2 + padding }, ro: w / 2, ri: 0 },
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
