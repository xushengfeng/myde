import { MockApp } from "./base";

interface Ball {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    color: string;
}

export class BouncingBallApp extends MockApp {
    private balls: Ball[] = [];
    private colors = ["#ff6b6b", "#4ecdc4", "#45b7d1", "#96ceb4", "#feca57", "#ff9ff3", "#54a0ff"];

    init(): void {
        this.balls = [];
        for (let i = 0; i < 5; i++) {
            this.addBall(Math.random() * (this.width - 100) + 50, Math.random() * (this.height - 100) + 50);
        }
    }

    private addBall(x: number, y: number): void {
        const radius = 15 + Math.random() * 20;
        this.balls.push({
            x,
            y,
            vx: (Math.random() - 0.5) * 6,
            vy: (Math.random() - 0.5) * 6,
            radius,
            color: this.colors[Math.floor(Math.random() * this.colors.length)],
        });
    }

    renderContent(): void {
        this.ctx.fillStyle = "#1a1a2e";
        this.ctx.fillRect(0, 0, this.width, this.height);

        for (const ball of this.balls) {
            ball.x += ball.vx;
            ball.y += ball.vy;

            if (ball.x - ball.radius < 0 || ball.x + ball.radius > this.width) {
                ball.vx = -ball.vx;
                ball.x = Math.max(ball.radius, Math.min(this.width - ball.radius, ball.x));
            }
            if (ball.y - ball.radius < 0 || ball.y + ball.radius > this.height) {
                ball.vy = -ball.vy;
                ball.y = Math.max(ball.radius, Math.min(this.height - ball.radius, ball.y));
            }

            this.ctx.beginPath();
            this.ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
            this.ctx.fillStyle = ball.color;
            this.ctx.fill();

            this.ctx.beginPath();
            this.ctx.arc(ball.x - ball.radius * 0.3, ball.y - ball.radius * 0.3, ball.radius * 0.2, 0, Math.PI * 2);
            this.ctx.fillStyle = "rgba(255,255,255,0.4)";
            this.ctx.fill();
        }
    }

    handlePointerInContent(event: "move" | "down" | "up", x: number, y: number): void {
        if (event === "down") {
            this.addBall(x, y);
        }
    }

    handleKey(_key: string, _state: "pressed" | "released"): void {}
}
