import { MockApp, type MockAppConfig } from "./base";

interface Point {
    x: number;
    y: number;
    timestamp: number;
}

export class MouseTrailApp extends MockApp {
    private points: Point[] = [];
    private isDrawing = false;
    private hue = 0;

    constructor(config: MockAppConfig) {
        super(config);
    }

    init(): void {
        this.points = [];
        this.isDrawing = false;
        this.hue = 0;
    }

    renderContent(): void {
        this.ctx.fillStyle = "rgba(10, 10, 30, 0.1)";
        this.ctx.fillRect(0, 0, this.width, this.height);

        if (this.points.length < 2) return;

        const now = Date.now();
        this.points = this.points.filter(p => now - p.timestamp < 3000);

        for (let i = 1; i < this.points.length; i++) {
            const prev = this.points[i - 1];
            const curr = this.points[i];
            const age = (now - curr.timestamp) / 3000;
            const alpha = 1 - age;
            const width = Math.max(1, (1 - age) * 8);

            this.ctx.beginPath();
            this.ctx.moveTo(prev.x, prev.y);
            this.ctx.lineTo(curr.x, curr.y);
            this.ctx.strokeStyle = `hsla(${(this.hue + i * 2) % 360}, 100%, 60%, ${alpha})`;
            this.ctx.lineWidth = width;
            this.ctx.lineCap = "round";
            this.ctx.stroke();
        }

        this.hue = (this.hue + 0.5) % 360;
    }

    handlePointerInContent(event: "move" | "down" | "up", x: number, y: number): void {
        if (event === "down") {
            this.isDrawing = true;
            this.points = [];
        } else if (event === "up") {
            this.isDrawing = false;
        } else if (event === "move" && this.isDrawing) {
            this.points.push({ x, y, timestamp: Date.now() });
        }
    }

    handleKey(key: string, state: "pressed" | "released"): void {
        if (state === "pressed" && key === "KeyC") {
            this.points = [];
        }
    }
}
