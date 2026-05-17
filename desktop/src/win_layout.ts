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
        const xWins = this.findSameDirectionWindows(id, "x");
        const yWins = this.findSameDirectionWindows(id, "y");
        const xSize = xWins.reduce((sum, id) => sum + this.getWindow(id).width * this.getWindow(id).height, 0);
        const ySize = yWins.reduce((sum, id) => sum + this.getWindow(id).width * this.getWindow(id).height, 0);
        if (xSize > ySize) {
            const start = this.getWindow(xWins[0]).x;
            const end = this.getWindow(xWins[xWins.length - 1]).x + this.getWindow(xWins[xWins.length - 1]).width;
            this.adaptSize(
                xWins.filter((winid) => winid !== id),
                "x",
                start,
                end,
            );
        } else if (ySize > xSize) {
            const start = this.getWindow(yWins[0]).y;
            const end = this.getWindow(yWins[yWins.length - 1]).y + this.getWindow(yWins[yWins.length - 1]).height;
            this.adaptSize(
                yWins.filter((winid) => winid !== id),
                "y",
                start,
                end,
            );
        } else if (xWins.length === 1 && yWins.length === 1) {
            // 这种情况是找不到“栏”了，或者说有更复杂的“栏”，那么就不变动太多了，如果临近有可变的尽量变
            // 不进行整体计算，而是类似挤压的方式，被移除的窗口向内挤压，使得自己面积为0，其他窗口跟着动
            const rmWinRect = this.getWindow(id);
            const topCenter = { x: rmWinRect.x + rmWinRect.width / 2, y: rmWinRect.y };
            const bottomCenter = {
                x: rmWinRect.x + rmWinRect.width / 2,
                y: rmWinRect.y + rmWinRect.height,
            };
            const leftCenter = { x: rmWinRect.x, y: rmWinRect.y + rmWinRect.height / 2 };
            const rightCenter = {
                x: rmWinRect.x + rmWinRect.width,
                y: rmWinRect.y + rmWinRect.height / 2,
            };
            const canMoveTop = this.canMove(topCenter);
            const canMoveBottom = this.canMove(bottomCenter);
            const canMoveLeft = this.canMove(leftCenter);
            const canMoveRight = this.canMove(rightCenter);

            const zipX = () => {
                let xend = leftCenter.x + rmWinRect.width / 2;
                if (!canMoveLeft) xend = leftCenter.x;
                if (!canMoveRight) xend = rightCenter.x;
                this.moveStart(leftCenter);
                // todo 整数
                // todo 最小宽高限制
                this.move({ x: xend, y: leftCenter.y });
                this.moveEnd();
                this.moveStart(rightCenter);
                this.move({ x: xend, y: rightCenter.y });
                this.moveEnd();
            };
            const zipY = () => {
                let yend = topCenter.y + rmWinRect.height / 2;
                if (!canMoveTop) yend = topCenter.y;
                if (!canMoveBottom) yend = bottomCenter.y;
                this.moveStart(topCenter);
                this.move({ x: topCenter.x, y: yend });
                this.moveEnd();
                this.moveStart(bottomCenter);
                this.move({ x: bottomCenter.x, y: yend });
                this.moveEnd();
            };

            if ((canMoveTop || canMoveBottom) && (canMoveLeft || canMoveRight)) {
                // 两个方向都可以挤压，选择把短边挤掉，即挤压位移小的那个
                if (rmWinRect.width < rmWinRect.height) {
                    zipX();
                } else {
                    zipY();
                }
            } else {
                if (canMoveTop || canMoveBottom) {
                    zipY();
                } else {
                    zipX();
                }
            }
        } else if (xSize === ySize) {
            const sizeX = this.outRect(xWins);
            const sizeY = this.outRect(yWins);
            const rX = Math.max(sizeX.width, sizeX.height) / Math.min(sizeX.width, sizeX.height);
            const rY = Math.max(sizeY.width, sizeY.height) / Math.min(sizeY.width, sizeY.height);
            // 比较哪个更接近正方形，保持更平衡的布局
            // 不可能相等，向两个方向扩张的栏比例不可能一样，除非没有栏
            if (rX < rY) {
                this.adaptSize(
                    xWins.filter((winid) => winid !== id),
                    "x",
                    sizeX.left,
                    sizeX.right,
                );
            } else {
                this.adaptSize(
                    yWins.filter((winid) => winid !== id),
                    "y",
                    sizeY.top,
                    sizeY.bottom,
                );
            }
        }
        this.windows.delete(id);
        // todo callback
    }
    private outRect(ids: number[]) {
        let left = this.baseWidth;
        let top = this.baseHeight;
        let right = 0;
        let bottom = 0;
        for (const id of ids) {
            const win = this.getWindow(id);
            left = Math.min(left, win.x);
            top = Math.min(top, win.y);
            right = Math.max(right, win.x + win.width);
            bottom = Math.max(bottom, win.y + win.height);
        }
        return { left, top, right, bottom, width: right - left, height: bottom - top };
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

        const sameDirWins = this.findSameDirectionWindows(id, isThin ? "y" : "x");
        const winsStart = this.getWindow(sameDirWins[0]);
        // biome-ignore lint/style/noNonNullAssertion: 必然包括自己
        const winsEnd = this.getWindow(sameDirWins.at(-1)!);
        this.adaptSize(
            sameDirWins,
            isThin ? "y" : "x",
            isThin ? winsStart.y : winsStart.x,
            isThin ? winsEnd.y + winsEnd.height : winsEnd.x + winsEnd.width,
        );

        return id;
    }

    /** 调整比例，保持平衡，比如同个方向三分时不是一大两小，应该保持均匀 */
    adaptSize(winids: number[], t: "x" | "y", start: number, end: number) {
        if (winids.length === 0) return;
        if (t === "x") {
            const totalWidth = end - start;
            const avgWidth = totalWidth / winids.length;
            let currentX = start;
            for (const id of winids) {
                const win = this.getWindow(id);
                this.setWindow(id, currentX, win.y, avgWidth, win.height);
                currentX += avgWidth;
            }
        } else {
            const totalHeight = end - start;
            const avgHeight = totalHeight / winids.length;
            let currentY = start;
            for (const id of winids) {
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
            // todo 挨着
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
    canMove(posi: { x: number; y: number }, round = 0) {
        return this.findLines(posi, round).length > 0;
    }
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
        // 逐步移动，每次移动1px，检测是否有窗口宽高小于等于0，如果有则停止移动，禁止继续移动导致窗口消失
        xl: for (let x = 1; x <= Math.abs(dx); x++) {
            const ddx = dx > 0 ? 1 : -1;
            for (const { id, type } of t) {
                const win = winOlds[id];
                if (type === "left") {
                    win.x += ddx;
                    win.width -= ddx;
                } else if (type === "right") {
                    win.width += ddx;
                }
            }
            for (const win of Object.values(winOlds)) {
                if (win.width <= 1) {
                    break xl; // 禁止移动导致窗口消失
                }
            }
        }
        yl: for (let y = 1; y <= Math.abs(dy); y++) {
            const ddy = dy > 0 ? 1 : -1;
            for (const { id, type } of t) {
                const win = winOlds[id];
                if (type === "top") {
                    win.y += ddy;
                    win.height -= ddy;
                } else if (type === "bottom") {
                    win.height += ddy;
                }
            }
            for (const win of Object.values(winOlds)) {
                if (win.height <= 1) {
                    break yl;
                }
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
                if (win.x !== 0) if (y1 <= posi.y && posi.y <= y2) lines.push({ id, type: "left" });
            } else if (Math.abs(posi.x - (win.x + win.width)) <= round) {
                if (win.x + win.width !== this.baseWidth)
                    if (y1 <= posi.y && posi.y <= y2) lines.push({ id, type: "right" });
            }
            if (Math.abs(posi.y - win.y) <= round) {
                if (win.y !== 0) if (x1 <= posi.x && posi.x <= x2) lines.push({ id, type: "top" });
            } else if (Math.abs(posi.y - (win.y + win.height)) <= round) {
                if (win.y + win.height !== this.baseHeight)
                    if (x1 <= posi.x && posi.x <= x2) lines.push({ id, type: "bottom" });
            }
        }
        return lines;
    }
}

export { freeLayout };
