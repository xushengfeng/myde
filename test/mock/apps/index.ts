import type { renderTools } from "../../../src/wayland/render_tools";
import type { MockWaylandClient } from "../myde-mock";
import type { MockApp, MockAppConfig } from "./base";
import { BouncingBallApp } from "./bouncing-ball";
import { MouseTrailApp } from "./mouse-trail";
import { RotatingShapeApp } from "./rotating-shape";

export type { MockApp, MockAppConfig };

export const mockApps: Record<string, MockAppConfig> = {
    "bouncing-ball": {
        id: "bouncing-ball",
        name: "Bouncing Ball",
        icon: "🎯",
        width: 800,
        height: 600,
    },
    "mouse-trail": {
        id: "mouse-trail",
        name: "Mouse Trail",
        icon: "🖱️",
        width: 800,
        height: 600,
    },
    "rotating-shape": {
        id: "rotating-shape",
        name: "Rotating Shape",
        icon: "🔄",
        width: 800,
        height: 600,
    },
};

export function createMockApp(
    id: string,
    client: MockWaylandClient,
    renderTools: renderTools,
): { app: MockApp; renderId: string } | null {
    const config = mockApps[id];
    if (!config) return null;

    let app: MockApp;
    switch (id) {
        case "bouncing-ball":
            app = new BouncingBallApp(config);
            break;
        case "mouse-trail":
            app = new MouseTrailApp(config);
            break;
        case "rotating-shape":
            app = new RotatingShapeApp(config);
            break;
        default:
            return null;
    }

    app.setClient(client);
    app.setRenderTools(renderTools);
    const renderId = app.createWindow();
    if (!renderId) return null;

    return { app, renderId };
}

export function getMockAppIcon(icon: string, size: number = 48): string {
    // 使用一个简单的SVG作为图标
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#2a2a4a"/>
        <text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central" font-size="${size * 0.5}" fill="white">${icon}</text>
    </svg>`;
    // 使用encodeURIComponent而不是btoa，因为emoji字符不能用btoa编码
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function getMockAppList(): Array<{ id: string; name: string; icon: string }> {
    return Object.values(mockApps).map((app) => ({
        id: app.id,
        name: app.name,
        icon: app.icon,
    }));
}
