import { EventEmitter } from "../../src/event-emitter/event-emitter";
import type { BrightnessDisplay, BrightnessEvents, BrightnessKind, brightness } from "../../src/sys_api/brightness";

/**
 * 提取类的公共成员（排除构造函数和private成员）
 */
type MockType<T> = Omit<T, "constructor">;

export class MockBrightnessDisplay implements BrightnessDisplay {
    id: string;
    kind: BrightnessKind;
    name: string;
    brightness: number;
    writable: boolean;

    constructor(id: string, kind: BrightnessKind, name: string, brightness = 60, writable = true) {
        this.id = id;
        this.kind = kind;
        this.name = name;
        this.brightness = brightness;
        this.writable = writable;
    }

    setBrightness(brightness: number) {
        this.brightness = Math.min(100, Math.max(0, brightness));
    }
}

export class MockBrightnessManager {
    private displays = new Map<string, MockBrightnessDisplay>();
    private emitter = new EventEmitter<BrightnessEvents>();
    private log: (...args: any[]) => void;

    constructor(log: (...args: any[]) => void) {
        this.log = log;
    }

    addDisplay(display: MockBrightnessDisplay) {
        this.displays.set(display.id, display);
        this.emitter.emit("added", { ...display });
    }

    removeDisplay(id: string) {
        if (!this.displays.delete(id)) return;
        this.emitter.emit("removed", id);
    }

    getDisplay(id: string) {
        return this.displays.get(id);
    }

    getDisplays() {
        return Array.from(this.displays.values());
    }

    setBrightness(id: string, brightness: number): number {
        const display = this.displays.get(id);
        if (!display) throw new Error(`未知的显示设备: ${id}`);
        if (!display.writable) throw new Error(`显示设备不可写: ${display.name}`);
        display.setBrightness(brightness);
        this.emitter.emit("changed", id, display.brightness);
        return display.brightness;
    }

    createMock(): MockType<brightness> {
        const manager = this;
        return {
            async init() {
                manager.log("brightness.init");
            },
            getDisplays() {
                return Array.from(manager.displays.values(), (display) => ({ ...display }));
            },
            getDisplay(id: string) {
                const display = manager.displays.get(id);
                return display ? { ...display } : undefined;
            },
            async setBrightness(id: string, brightness: number) {
                manager.log("brightness.setBrightness", id, brightness);
                return manager.setBrightness(id, brightness);
            },
            async refresh() {
                return Array.from(manager.displays.values(), (display) => ({ ...display }));
            },
            destroy() {},
            on: manager.emitter.on.bind(manager.emitter),
            off: manager.emitter.off.bind(manager.emitter),
            once: manager.emitter.once.bind(manager.emitter),
            emit: manager.emitter.emit.bind(manager.emitter),
            waitFor: manager.emitter.waitFor.bind(manager.emitter),
            removeAllListeners: manager.emitter.removeAllListeners.bind(manager.emitter),
            listenerCount: manager.emitter.listenerCount.bind(manager.emitter),
            hasListeners: manager.emitter.hasListeners.bind(manager.emitter),
            respond: manager.emitter.respond.bind(manager.emitter),
            request: manager.emitter.request.bind(manager.emitter),
        };
    }
}

/** 默认 mock：一个内置屏 + 一个外接屏，方便桌面调试多屏亮度条 */
export function createMockBrightness(log: (...args: any[]) => void): MockType<brightness> {
    const manager = new MockBrightnessManager(log);
    manager.addDisplay(new MockBrightnessDisplay("backlight:eDP-1", "backlight", "eDP-1", 60));
    manager.addDisplay(new MockBrightnessDisplay("ddc:card0-DP-1", "ddc", "DEL U2720Q (DP-1)", 80));
    return manager.createMock();
}
