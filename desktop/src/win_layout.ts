class freeLayout {
    private baseWidth: number;
    private baseHeight: number;

    // todo 改成x1,y1,x2,y2更好处理小数
    private windows: Map<number, { x: number; y: number; width: number; height: number }>;

    constructor(baseWidth: number, baseHeight: number) {
        this.baseWidth = baseWidth;
        this.baseHeight = baseHeight;
        this.windows = new Map();
        this.setWindow(1, 0, 0, baseWidth, baseHeight);
    }
    setBaseSize(width: number, height: number) {
        const ratioX = width / this.baseWidth;
        const ratioY = height / this.baseHeight;

        for (const [id, win] of this.windows) {
            this.setWindow(id, win.x * ratioX, win.y * ratioY, win.width * ratioX, win.height * ratioY);
        }
        this.baseWidth = width;
        this.baseHeight = height;
    }
    getWindow(id: number) {
        const win = this.windows.get(id);
        if (win) return win;
        throw new Error(`Window with id ${id} not found.`);
    }
    getAllWindows() {
        return Array.from(this.windows.entries()).map(([id, win]) => ({ id, ...win, size: win.width * win.height }));
    }
    removeWindow(id: number) {
        this.windows.delete(id);
        // todo 调整比例
    }
    private setWindow(id: number, x: number, y: number, width: number, height: number) {
        const win = this.windows.get(id);
        const nx = Math.max(0, Math.min(Math.round(x), this.baseWidth));
        const ny = Math.max(0, Math.min(Math.round(y), this.baseHeight));
        const nwidth = Math.max(1, Math.min(Math.round(width), this.baseWidth - nx));
        const nheight = Math.max(1, Math.min(Math.round(height), this.baseHeight - ny));
        if (win) {
            win.x = nx;
            win.y = ny;
            win.width = nwidth;
            win.height = nheight;
        } else {
            this.windows.set(id, { x: nx, y: ny, width: nwidth, height: nheight });
        }
        // todo callback
    }
    findMaxWindow() {
        let maxArea = 0;
        let maxId = -1;
        for (const [id, win] of this.windows) {
            const area = win.width * win.height;
            if (area > maxArea) {
                maxArea = area;
                maxId = id;
            }
        }
        // todo 顺序
        return maxId;
    }
    private newWindowId() {
        let id = 1;
        while (this.windows.has(id)) {
            id++;
        }
        return id;
    }
    /** 分割窗口来新建，默认找面积最大的窗口，否则根据指定位置找到包含该位置的窗口
     *  如果目标窗口较宽则纵向分割，否则横向分割
     */
    addWindow(posi?: { x: number; y: number }) {
        const id = this.newWindowId();
        let targetWid = this.findMaxWindow();
        if (posi) {
            for (const [id, win] of this.windows) {
                if (posi.x >= win.x && posi.x <= win.x + win.width && posi.y >= win.y && posi.y <= win.y + win.height) {
                    targetWid = id;
                    break;
                }
            }
        }
        const targetWin = this.getWindow(targetWid);
        const isThin = targetWin.width < targetWin.height;
        if (isThin) {
            const newHeight = targetWin.height / 2;
            this.setWindow(targetWid, targetWin.x, targetWin.y, targetWin.width, newHeight);
            this.setWindow(id, targetWin.x, targetWin.y + newHeight, targetWin.width, newHeight);
        } else {
            const newWidth = targetWin.width / 2;
            this.setWindow(targetWid, targetWin.x, targetWin.y, newWidth, targetWin.height);
            this.setWindow(id, targetWin.x + newWidth, targetWin.y, newWidth, targetWin.height);
        }

        this.adaptSize(id, isThin ? "y" : "x");

        return id;
    }

    /** 调整比例，保持平衡，比如同个方向三分时不是一大两小，应该保持均匀 */
    adaptSize(winid: number, t: "x" | "y") {
        const sameDirWins = this.findSameDirectionWindows(winid, t);
        if (sameDirWins.length <= 1) return;
        if (t === "x") {
            const totalWidth = sameDirWins.reduce((sum, id) => sum + this.getWindow(id).width, 0);
            const avgWidth = totalWidth / sameDirWins.length;
            let currentX = this.getWindow(sameDirWins[0]).x;
            for (const id of sameDirWins) {
                const win = this.getWindow(id);
                this.setWindow(id, currentX, win.y, avgWidth, win.height);
                currentX += avgWidth;
            }
        } else {
            const totalHeight = sameDirWins.reduce((sum, id) => sum + this.getWindow(id).height, 0);
            const avgHeight = totalHeight / sameDirWins.length;
            let currentY = this.getWindow(sameDirWins[0]).y;
            for (const id of sameDirWins) {
                const win = this.getWindow(id);
                this.setWindow(id, win.x, currentY, win.width, avgHeight);
                currentY += avgHeight;
            }
        }
    }

    private findSameDirectionWindows(winid: number, t: "x" | "y") {
        const targetWin = this.getWindow(winid);
        const sameDirWins: number[] = [winid];
        for (const [id, win] of this.windows) {
            if (id === winid) continue;
            if (t === "x") {
                if (win.y === targetWin.y && win.height === targetWin.height) {
                    sameDirWins.push(id);
                }
            } else {
                if (win.x === targetWin.x && win.width === targetWin.width) {
                    sameDirWins.push(id);
                }
            }
        }
        return sameDirWins.toSorted((a, b) => {
            const wa = this.getWindow(a);
            const wb = this.getWindow(b);
            if (t === "x") {
                return wa.x - wb.x;
            } else {
                return wa.y - wb.y;
            }
        });
    }

    private moveT: {
        id: number;
        type: "left" | "right" | "top" | "bottom";
        oldWin: { x: number; y: number; width: number; height: number };
    }[] = [];
    private moveStartPosi: { x: number; y: number } | null = null;
    moveStart(posi: { x: number; y: number }, round = 0) {
        this.moveStartPosi = posi;
        const lines = this.findLines(posi, round);
        this.moveT = lines.map((line) => {
            const win = this.getWindow(line.id);
            return { id: line.id, type: line.type, oldWin: { ...win } };
        });
    }
    move(posi: { x: number; y: number }) {
        if (this.moveT.length === 0) return;
        const dx = posi.x - (this.moveStartPosi?.x ?? 0);
        const dy = posi.y - (this.moveStartPosi?.y ?? 0);
        const t = structuredClone(this.moveT);
        const winOlds: Record<number, { x: number; y: number; width: number; height: number }> = {};
        for (const { id, oldWin } of t) {
            winOlds[id] = oldWin;
        }
        for (const { id, type } of t) {
            const win = winOlds[id];
            if (type === "left") {
                win.x += dx;
                win.width -= dx;
            } else if (type === "right") {
                win.width += dx;
            } else if (type === "top") {
                win.y += dy;
                win.height -= dy;
            } else if (type === "bottom") {
                win.height += dy;
            }
        }
        for (const [id, win] of Object.entries(winOlds)) {
            this.setWindow(Number(id), win.x, win.y, win.width, win.height);
        }
    }
    moveEnd() {
        this.moveT = [];
        this.moveStartPosi = null;
    }
    /** 找到相关线，线拓展，不一定属于同一个window，以十字点为端点 */
    private findLines(posi: { x: number; y: number }, round = 0) {
        const lines = this.findLinesInDot(posi, round);
        const set = new Set<string>();
        for (const line of lines) {
            set.add(`${line.id}-${line.type}`);
        }
        const max = this.windows.size * 8 * 2; // 总共8条线，2用来稍微宽松一点，避免误判循环
        let count = 0;
        const findDotByLine = (line: { id: number; type: "left" | "right" | "top" | "bottom" }) => {
            const win = this.getWindow(line.id);
            const x1 = win.x;
            const y1 = win.y;
            const x2 = win.x + win.width;
            const y2 = win.y + win.height;
            if (line.type === "left") {
                return [
                    { x: x1, y: y1 },
                    { x: x1, y: y2 },
                ];
            } else if (line.type === "right") {
                return [
                    { x: x2, y: y1 },
                    { x: x2, y: y2 },
                ];
            } else if (line.type === "top") {
                return [
                    { x: x1, y: y1 },
                    { x: x2, y: y1 },
                ];
            } else {
                return [
                    { x: x1, y: y2 },
                    { x: x2, y: y2 },
                ];
            }
        };
        const findAndAddNextLines = (posi: { x: number; y: number }, promptA: "x" | "y") => {
            count++;
            if (count > max) {
                console.warn("Too many lines found, possible loop. Stopping search.");
                return;
            }
            const nextLines = this.findLinesInDot(posi);
            if (nextLines.length === 8) return;
            const sameLines = nextLines.filter((line) => {
                if (promptA === "y") {
                    return line.type === "left" || line.type === "right";
                } else {
                    return line.type === "top" || line.type === "bottom";
                }
            });
            const newLines = sameLines.filter((line) => {
                const key = `${line.id}-${line.type}`;
                if (set.has(key)) {
                    return false;
                } else {
                    set.add(key);
                    return true;
                }
            });
            if (newLines.length === 0) return;
            lines.push(...newLines);
            for (const line of newLines) {
                const dots = findDotByLine(line);
                for (const dot of dots) {
                    findAndAddNextLines(dot, promptA);
                }
            }
        };
        for (const line of lines) {
            const dots = findDotByLine(line);
            for (const dot of dots) {
                if (dot.x === posi.x && dot.y === posi.y) continue;
                findAndAddNextLines(dot, line.type === "left" || line.type === "right" ? "y" : "x");
            }
        }
        return lines;
    }
    private findLinesInDot(posi: { x: number; y: number }, round = 0) {
        const lines: { id: number; type: "left" | "right" | "top" | "bottom" }[] = [];
        for (const [id, win] of this.windows) {
            const x1 = win.x - round;
            const y1 = win.y - round;
            const x2 = win.x + win.width + round;
            const y2 = win.y + win.height + round;
            if (Math.abs(posi.x - win.x) <= round) {
                if (y1 <= posi.y && posi.y <= y2) lines.push({ id, type: "left" });
            } else if (Math.abs(posi.x - (win.x + win.width)) <= round) {
                if (y1 <= posi.y && posi.y <= y2) lines.push({ id, type: "right" });
            }
            if (Math.abs(posi.y - win.y) <= round) {
                if (x1 <= posi.x && posi.x <= x2) lines.push({ id, type: "top" });
            } else if (Math.abs(posi.y - (win.y + win.height)) <= round) {
                if (x1 <= posi.x && posi.x <= x2) lines.push({ id, type: "bottom" });
            }
        }
        return lines;
    }
}

export { freeLayout };
