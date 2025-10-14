export function getRectKeyPoint(
    rect: { x: number; y: number; width: number; height: number },
    a: "none" | "top" | "bottom" | "left" | "right" | "top_left" | "bottom_left" | "top_right" | "bottom_right",
): { x: number; y: number } {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    switch (a) {
        case "none":
            return { x: cx, y: cy };
        case "top":
            return { x: cx, y: rect.y };
        case "bottom":
            return { x: cx, y: bottom };
        case "left":
            return { x: rect.x, y: cy };
        case "right":
            return { x: right, y: cy };
        case "top_left":
            return { x: rect.x, y: rect.y };
        case "top_right":
            return { x: right, y: rect.y };
        case "bottom_left":
            return { x: rect.x, y: bottom };
        case "bottom_right":
            return { x: right, y: bottom };
    }
    return { x: 0, y: 0 };
}
