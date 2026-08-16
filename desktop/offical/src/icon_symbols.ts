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

function computPOfCircleAngle(p: Point, cCenter: Point, cR: number) {
    const base = Math.atan2(p.y - cCenter.y, p.x - cCenter.x);
    const d = Math.sqrt((p.y - cCenter.y) ** 2 + (p.x - cCenter.x) ** 2);
    const a = Math.acos(cR / d);
    return [((base + a) / Math.PI) * 180, ((base - a) / Math.PI) * 180];
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
                                    { p: p0, ro: w / 2, ri: 0 },
                                    { p: p1, ro: w / 2, ri: 0 },
                                    { p: p2, ro: w / 2, ri: 0 },
                                    { p: p3, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
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
                                    { p: { x: center.x, y: padding }, ro: w / 2, ri: 0 },
                                    { p: { x: padding, y: center.y }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x, y: size - padding }, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
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
                                    { p: { x: padding, y: padding }, ro: w / 2, ri: 0 },
                                    { p: center, ro: w / 2, ri: 0 },
                                    { p: { x: padding, y: size - padding }, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
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
                                    { p: { x: padding, y: padding }, ro: w / 2, ri: 0 },
                                    { p: { x: size - padding, y: size - padding }, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: size - padding, y: padding }, ro: w / 2, ri: 0 },
                                    { p: { x: padding, y: size - padding }, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    notification: (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const ts = 8 * 9;
        const tr = 8 * 5;
        const br = 8 * 4; // todo nagitive
        const p0 = { x: center.x, y: padding };
        const p1l = { x: center.x - ts, y: padding + ts };
        const p1r = { x: center.x + ts, y: padding + ts };
        const p2l = { x: padding, y: size - padding - br };
        const p2r = { x: size - padding, y: size - padding - br };
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "path",
                            data: {
                                ps: [
                                    {
                                        p: p0,
                                        c1: p0,
                                        c2: p(p0, -180, tr),
                                    },
                                    {
                                        p: p1l,
                                        c1: p(p1l, -90, tr),
                                        c2: p(p1l, 90, tr),
                                    },
                                    {
                                        p: p2l,
                                        c1: p(p2l, -30, 40),
                                        c2: p(p2l, 0, 40),
                                    },
                                    {
                                        p: p2r,
                                        c1: p(p2r, -180, 40),
                                        c2: p(p2r, -180 + 30, 40),
                                    },
                                    {
                                        p: p1r,
                                        c1: p(p1r, 90, tr),
                                        c2: p(p1r, -90, tr),
                                    },
                                    {
                                        p: p0,
                                        c1: p(p0, 0, tr),
                                        c2: p0,
                                    },
                                ],
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: p2l.y },
                                r: br,
                                fromAngle: 0,
                                endAngle: 180,
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
    speaker: (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const a1 = 8 * 4;
        const a2 = 8 * 4;
        const a3 = 8 * 7;
        const ag = 30;
        const wr: Point = { x: center.x - 8 * 5, y: center.y };
        const wd = 8 * 6;
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
                                    { p: { x: padding, y: center.y - a1 }, ri: 0, ro: w / 2 },
                                    { p: { x: padding, y: center.y + a1 }, ri: 0, ro: w / 2 },
                                    { p: { x: padding + a2, y: center.y + a1 }, ri: 0, ro: w / 2 },
                                    { p: { x: padding + a2 + a3, y: center.y + a1 + a3 }, ri: 0, ro: w / 2 },
                                    { p: { x: padding + a2 + a3, y: center.y - a1 - a3 }, ri: 0, ro: w / 2 },
                                    { p: { x: padding + a2, y: center.y - a1 }, ri: 0, ro: w / 2 },
                                ],
                                close: true,
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: wr,
                                fromAngle: -ag,
                                endAngle: ag,
                                r: size - wr.x - padding - wd * 2,
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: wr,
                                fromAngle: -ag,
                                endAngle: ag,
                                r: size - wr.x - padding - wd * 1,
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: wr,
                                fromAngle: -ag,
                                endAngle: ag,
                                r: size - wr.x - padding,
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    mic: (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const r = 8 * 4;
        const dr = 8 * 9;
        const drc: Point = { x: center.x, y: center.y };
        const dd = 8 * 6;
        return {
            size,
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: padding + r },
                                color: env.color,
                                fromAngle: -180,
                                endAngle: 0,
                                r,
                                width: w,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: drc,
                                color: env.color,
                                fromAngle: 0,
                                endAngle: -180,
                                r,
                                width: w,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x - r, y: padding + r }, ri: 0, ro: w / 2 },
                                    { p: { x: center.x - r, y: drc.y }, ri: 0, ro: w / 2 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x + r, y: padding + r }, ri: 0, ro: w / 2 },
                                    { p: { x: center.x + r, y: drc.y }, ri: 0, ro: w / 2 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
                {
                    name: "baseb",
                    shapes: [
                        {
                            type: "arc",
                            data: {
                                center: drc,
                                color: env.color,
                                fromAngle: 0,
                                endAngle: -180,
                                r: dr,
                                width: w,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x, y: drc.y + dr }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x, y: size - padding }, ro: w / 2, ri: 0 },
                                ],
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x - dd, y: size - padding }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x + dd, y: size - padding }, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.0": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const r = (8 * 19) / 2 - padding;
        return {
            size,
            edgeTrim: { left: center.x - r - padding, right: center.x + r + padding },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: padding + r },
                                color: env.color,
                                fromAngle: -180,
                                endAngle: 0,
                                r,
                                width: w,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: size - (padding + r) },
                                color: env.color,
                                fromAngle: 0,
                                endAngle: -180,
                                r,
                                width: w,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x - r, y: padding + r }, ri: 0, ro: w / 2 },
                                    { p: { x: center.x - r, y: size - (padding + r) }, ri: 0, ro: w / 2 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x + r, y: padding + r }, ri: 0, ro: w / 2 },
                                    { p: { x: center.x + r, y: size - (padding + r) }, ri: 0, ro: w / 2 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.1": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        return {
            size,
            edgeTrim: {
                left: center.x - 64 - padding,
                right: center.x + padding,
            },
            viewCenter: { x: center.x - 8 * 2, y: center.y },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x - 64, y: 64 }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x, y: padding }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x, y: size }, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "start",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.2": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const d2 = 8 * 19;
        const [_, xAngle] = computPOfCircleAngle(
            { x: center.x - d2 / 2 + padding, y: size - padding },
            { x: center.x, y: d2 / 2 },
            d2 / 2 - padding,
        );
        return {
            size,
            edgeTrim: { left: center.x - d2 / 2, right: center.x + d2 / 2 },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: d2 / 2 },
                                endAngle: xAngle,
                                fromAngle: -170,
                                r: d2 / 2 - padding,
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: p({ x: center.x, y: d2 / 2 }, xAngle, d2 / 2 - padding), ri: 0, ro: w / 2 },
                                    {
                                        p: { x: center.x - d2 / 2 + padding, y: size - padding },
                                        ri: 0,
                                        ro: w / 2,
                                    },
                                    {
                                        p: { x: center.x + d2 / 2 - padding, y: size - padding },
                                        ri: 0,
                                        ro: w / 2,
                                    },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.3": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const d2 = 8 * 20;
        const ww = 8 * 7;
        const xAngle = -90 - 30;
        return {
            size,
            edgeTrim: { left: center.x - d2 / 2, right: center.x + d2 / 2 },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x - ww, y: padding }, ri: 0, ro: w / 2 },
                                    { p: { x: center.x + ww, y: padding }, ri: 0, ro: w / 2 },
                                    {
                                        p: p({ x: center.x, y: size - d2 / 2 }, xAngle, d2 / 2 - padding),
                                        ri: 0,
                                        ro: w / 2,
                                    },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: size - d2 / 2 },
                                endAngle: -180,
                                fromAngle: xAngle,
                                r: d2 / 2 - padding,
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.4": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        return {
            size,
            edgeTrim: {
                left: center.x - 8 * 12 - padding,
                right: center.x + 8 * 5 + padding,
            },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x, y: size - padding }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x, y: padding }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x - 8 * 12, y: center.y + 8 * 8 }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x + 8 * 5, y: center.y + 8 * 8 }, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.5": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const d2 = 8 * 20;
        const ww = 8 * 5;
        const xAngle = -90 - 55;
        return {
            size,
            edgeTrim: { left: center.x - d2 / 2, right: center.x + d2 / 2 },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x + ww, y: padding }, ri: 0, ro: w / 2 },
                                    { p: { x: center.x - ww, y: padding }, ri: 0, ro: w / 2 },
                                    {
                                        p: p({ x: center.x, y: size - d2 / 2 }, xAngle, d2 / 2 - padding),
                                        ri: 0,
                                        ro: w / 2,
                                    },
                                ],
                                extendNode: "both",
                                color: env.color,
                                width: w,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: size - d2 / 2 },
                                endAngle: -180 - 15,
                                fromAngle: xAngle,
                                r: d2 / 2 - padding,
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.6": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const d2 = 8 * 19;
        const p0 = { x: center.x + 8, y: padding };
        const [_, xAngle] = computPOfCircleAngle(p0, { x: center.x, y: size - d2 / 2 }, d2 / 2 - padding);
        return {
            size,
            edgeTrim: { left: center.x - d2 / 2, right: center.x + d2 / 2 },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: p0, ro: w / 2, ri: 0 },
                                    {
                                        p: p({ x: center.x, y: size - d2 / 2 }, xAngle, d2 / 2 - padding),
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: size - d2 / 2 },
                                endAngle: 0,
                                fromAngle: 0,
                                r: d2 / 2 - padding,
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.7": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        return {
            size,
            edgeTrim: { left: center.x - 8 * 8 - padding, right: center.y + 8 * 8 + padding },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    { p: { x: center.x - 8 * 8, y: padding }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x + 8 * 8, y: padding }, ro: w / 2, ri: 0 },
                                    { p: { x: center.x - 8 * 5, y: size - padding }, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.8": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const d2 = 8 * 19;
        const d1 = size - d2 + w;
        return {
            size,
            edgeTrim: { left: center.x - d2 / 2, right: center.x + d2 / 2 },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: d1 / 2 },
                                endAngle: 0,
                                fromAngle: 0,
                                r: d1 / 2 - padding,
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: size - d2 / 2 },
                                endAngle: 0,
                                fromAngle: 0,
                                r: d2 / 2 - padding,
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.9": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const d2 = 8 * 19;
        const p0 = { x: center.x - 8, y: size - padding };
        const [_, xAngle] = computPOfCircleAngle(p0, { x: center.x, y: d2 / 2 }, d2 / 2 - padding);
        return {
            size,
            edgeTrim: { left: center.x - d2 / 2, right: center.x + d2 / 2 },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: d2 / 2 },
                                endAngle: 0,
                                fromAngle: 0,
                                r: d2 / 2 - padding,
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: p({ x: center.x, y: d2 / 2 }, xAngle, d2 / 2 - padding),
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                    { p: p0, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.dot": (env) => {
        const { center, size } = buildZb(256);
        const w = 32;
        const padding = w / 2;
        return {
            size,
            edgeTrim: {
                left: center.x - padding,
                right: center.x + padding,
            },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "dot",
                            data: {
                                p: { x: center.x, y: size - padding },
                                sizeWidth: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.:": (env) => {
        const { center, size } = buildZb(256);
        const w = 32;
        const padding = w / 2;
        const x = 8 * 6;
        return {
            size,
            edgeTrim: {
                left: center.x - padding,
                right: center.x + padding,
            },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "dot",
                            data: {
                                p: { x: center.x, y: center.y - x },
                                sizeWidth: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "dot",
                            data: {
                                p: { x: center.x, y: center.y + x },
                                sizeWidth: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.,": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        return {
            size,
            edgeTrim: {
                left: center.x - padding - 8 * 3,
                right: center.x + padding,
            },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: { x: center.x, y: size - 8 * 6 },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                    { p: { x: center.x - 8 * 3, y: size - padding }, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.hash": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const d = 8 * 4;
        const dd = 8 * 10;
        return {
            size,
            edgeTrim: {
                left: center.x - dd,
                right: center.x + dd,
            },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: { x: center.x - dd, y: center.y - d },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                    { p: { x: center.x + dd, y: center.y - d }, ro: w / 2, ri: 0 },
                                ],
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: { x: center.x - dd, y: center.y + d },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                    { p: { x: center.x + dd, y: center.y + d }, ro: w / 2, ri: 0 },
                                ],
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: { x: center.x - d, y: padding },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                    { p: { x: center.x - d, y: size - padding }, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: { x: center.x + d, y: padding },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                    { p: { x: center.x + d, y: size - padding }, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.slash": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const dd = 8 * 6;
        return {
            size,
            edgeTrim: {
                left: center.x - padding - dd,
                right: center.x + padding + dd,
            },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: { x: center.x + dd, y: padding },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                    { p: { x: center.x - dd, y: size - padding }, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.backslash": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const dd = 8 * 6;
        return {
            size,
            edgeTrim: {
                left: center.x - padding - dd,
                right: center.x + padding + dd,
            },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: { x: center.x - dd, y: padding },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                    { p: { x: center.x + dd, y: size - padding }, ro: w / 2, ri: 0 },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.percent": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const dd = 8 * 8;
        const cdx = 8 * 5;
        const cdy = 8 * 9;
        const r = 8 * 4;
        const t = Math.max(dd + padding, cdx + r + padding);
        return {
            size,
            edgeTrim: {
                left: center.x - t,
                right: center.x + t,
            },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: { x: center.x + dd, y: padding },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                    {
                                        p: { x: center.x - dd, y: size - padding },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x - cdx, y: center.y - cdy },
                                endAngle: 0,
                                fromAngle: 0,
                                r,
                                color: env.color,
                                width: w,
                            },
                        },
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x + cdx, y: center.y + cdy },
                                endAngle: 0,
                                fromAngle: 0,
                                r,
                                color: env.color,
                                width: w,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.minus": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const dd = 8 * 8;
        return {
            size,
            edgeTrim: {
                left: center.x - dd - padding,
                right: center.x + dd + padding,
            },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: { x: center.x + dd, y: center.y },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                    {
                                        p: { x: center.x - dd, y: center.y },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.plus": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const dd = 8 * 8;
        return {
            size,
            edgeTrim: {
                left: center.x - dd - padding,
                right: center.x + dd + padding,
            },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: { x: center.x + dd, y: center.y },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                    {
                                        p: { x: center.x - dd, y: center.y },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: { x: center.x, y: center.y - dd },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                    {
                                        p: { x: center.x, y: center.y + dd },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "number.degree": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const r = 8 * 4;
        return {
            size,
            edgeTrim: {
                left: center.x - r - padding,
                right: center.x + r + padding + r + r,
            },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "arc",
                            data: {
                                center: { x: center.x, y: r + padding },
                                r,
                                endAngle: 0,
                                fromAngle: 0,
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "font.underscore": (env) => {
        const { center, size } = buildZb(256);
        const w = 24;
        const padding = w / 2;
        const dd = 8 * 4;
        return {
            size,
            edgeTrim: {
                left: center.x - dd - padding,
                right: center.x + dd + padding,
            },
            layout: [
                {
                    name: "base",
                    shapes: [
                        {
                            type: "zline",
                            data: {
                                ps: [
                                    {
                                        p: { x: center.x + dd, y: size - padding },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                    {
                                        p: { x: center.x - dd, y: size - padding },
                                        ro: w / 2,
                                        ri: 0,
                                    },
                                ],
                                extendNode: "both",
                                width: w,
                                color: env.color,
                            },
                        },
                    ],
                },
            ],
        };
    },
    "font.space": () => {
        const { center, size } = buildZb(256);
        return {
            size,
            edgeTrim: {
                left: center.x - 8 * 2,
                right: center.x + 8 * 2,
            },
            layout: [],
        };
    },
};
