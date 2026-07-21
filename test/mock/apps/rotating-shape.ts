import { MockApp, type MockAppConfig } from "./base";

interface Shape {
    x: number;
    y: number;
    size: number;
    rotation: number;
    rotationSpeed: number;
    sides: number;
    color: string;
    orbitRadius: number;
    orbitAngle: number;
    orbitSpeed: number;
}

export class RotatingShapeApp extends MockApp {
    private shapes: Shape[] = [];
    private speedMultiplier = 1;
    private centerX = 0;
    private centerY = 0;

    constructor(config: MockAppConfig) {
        super(config);
    }

    init(): void {
        this.centerX = this.width / 2;
        this.centerY = this.height / 2;
        this.shapes = [];

        const colors = ["#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4", "#feca57", "#ff9ff3", "#54a0ff"];
        const sidesOptions = [3, 4, 5, 6, 8];

        for (let i = 0; i < 7; i++) {
            this.shapes.push({
                x: 0,
                y: 0,
                size: 20 + Math.random() * 30,
                rotation: Math.random() * Math.PI * 2,
                rotationSpeed: (Math.random() - 0.5) * 0.05,
                sides: sidesOptions[Math.floor(Math.random() * sidesOptions.length)],
                color: colors[i % colors.length],
                orbitRadius: 80 + i * 40,
                orbitAngle: (i / 7) * Math.PI * 2,
                orbitSpeed: 0.01 + Math.random() * 0.02,
            });
        }
    }

    private drawShape(shape: Shape): void {
        this.ctx.save();
        this.ctx.translate(shape.x, shape.y);
        this.ctx.rotate(shape.rotation);

        this.ctx.beginPath();
        for (let i = 0; i <= shape.sides; i++) {
            const angle = (i / shape.sides) * Math.PI * 2;
            const x = Math.cos(angle) * shape.size;
            const y = Math.sin(angle) * shape.size;
            if (i === 0) {
                this.ctx.moveTo(x, y);
            } else {
                this.ctx.lineTo(x, y);
            }
        }
        this.ctx.closePath();
        this.ctx.fillStyle = shape.color;
        this.ctx.fill();
        this.ctx.strokeStyle = "rgba(255,255,255,0.3)";
        this.ctx.lineWidth = 2;
        this.ctx.stroke();

        this.ctx.restore();
    }

    renderContent(): void {
        this.ctx.fillStyle = "#0a0a1e";
        this.ctx.fillRect(0, 0, this.width, this.height);

        this.ctx.beginPath();
        this.ctx.arc(this.centerX, this.centerY, 5, 0, Math.PI * 2);
        this.ctx.fillStyle = "#ffffff";
        this.ctx.fill();

        for (const shape of this.shapes) {
            shape.orbitAngle += shape.orbitSpeed * this.speedMultiplier;
            shape.rotation += shape.rotationSpeed * this.speedMultiplier;

            shape.x = this.centerX + Math.cos(shape.orbitAngle) * shape.orbitRadius;
            shape.y = this.centerY + Math.sin(shape.orbitAngle) * shape.orbitRadius;

            this.ctx.beginPath();
            this.ctx.moveTo(this.centerX, this.centerY);
            this.ctx.lineTo(shape.x, shape.y);
            this.ctx.strokeStyle = "rgba(255,255,255,0.1)";
            this.ctx.lineWidth = 1;
            this.ctx.stroke();

            this.drawShape(shape);
        }
    }

    handlePointerInContent(_event: "move" | "down" | "up", _x: number, _y: number): void {}

    handleKey(key: string, state: "pressed" | "released"): void {
        if (state === "pressed") {
            if (key === "ArrowUp" || key === "KeyW") {
                this.speedMultiplier = Math.min(3, this.speedMultiplier + 0.2);
            } else if (key === "ArrowDown" || key === "KeyS") {
                this.speedMultiplier = Math.max(0.1, this.speedMultiplier - 0.2);
            } else if (key === "Space") {
                this.speedMultiplier = 1;
            }
        }
    }
}
