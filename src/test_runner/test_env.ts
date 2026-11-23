import * as fs from "node:fs";
import type { HeadlessDisplay } from "./headless_display";
import type { PrivateBus } from "./private_bus";

/** 模块载入时从宿主继承的总线；测试在 beforeAll 里设置的值和它不同，需要保留。 */
const inheritedInternalBus = process.env.MYDE_INTERNAL_BUS_ADDRESS;
const inheritedSessionBus = process.env.DBUS_SESSION_BUS_ADDRESS;

export type TestEnvOptions = {
    /** desktop-loader 要加载的桌面包；测试桌面是临时目录，完整桌面是 desktop/<name> */
    desktop: string;
    /** 私有显示；没有时用 headless ozone */
    display: HeadlessDisplay | undefined;
    /** 私有 session bus；测试自己设置了总线时不使用 */
    bus?: PrivateBus;
    /** 调用方额外的环境变量，最后合并，优先级最高 */
    extraEnv?: NodeJS.ProcessEnv;
};

/**
 * 测试实例的子进程环境。
 *
 * 不接宿主显示服务：宿主可能同时在跑多个桌面实现，WAYLAND_DISPLAY/DISPLAY
 * 指向哪一个都不确定，接上去就会在别人的桌面上开窗口。有私有显示就用它，
 * 没有就交给 Electron 的 headless ozone 平台。
 *
 * 也不接宿主桌面私有的 dbus；测试自己创建的总线（DBusTestEnv、内部 portal）
 * 不受影响：外部总线只在 socket 仍然存在时沿用，内部总线只丢弃继承值。
 */
export function createTestEnv(op: TestEnvOptions): NodeJS.ProcessEnv {
    const testEnv: NodeJS.ProcessEnv = {
        ...process.env,
        desktop: op.desktop,
        testMode: "on",
    };
    delete testEnv.ELECTRON_RUN_AS_NODE;
    delete testEnv.ELECTRON_NO_ATTACH_CONSOLE;
    delete testEnv.WAYLAND_DISPLAY;
    if (op.display) {
        testEnv.DISPLAY = op.display.display;
        testEnv.XDG_SESSION_TYPE = "x11";
    } else {
        delete testEnv.DISPLAY;
    }
    delete testEnv.ELECTRON_OZONE_PLATFORM_HINT;
    delete testEnv.ELECTRON_CLI_ARGS;

    // 从正在运行的桌面继承来的环境变量会把测试实例接到别人的会话上：
    // MYDE_INTERNAL_BUS_ADDRESS 指向那个桌面私有的 dbus（桌面重启后常常已失效）。
    // 只丢弃“和模块载入时相同”的继承值，测试在 beforeAll 里自己设置的总线保留。
    // 测试自己需要内部总线时（tray/notification）也可以设置 MYDE_INTERNAL_PORTAL，
    // 由测试实例自己拉起 dbus，不依赖继承值。
    if (testEnv.MYDE_INTERNAL_BUS_ADDRESS === inheritedInternalBus) {
        delete testEnv.MYDE_INTERNAL_BUS_ADDRESS;
    }
    // MYDE_WRAP_* / runAsDesktop 会让测试实例按“桌面”而不是“测试窗口”启动
    delete testEnv.runAsDesktop;
    for (const name of Object.keys(testEnv)) {
        if (name.startsWith("MYDE_WRAP_")) delete testEnv[name];
    }
    // 测试自己设置的总线（DBusTestEnv 在 beforeAll 里改 process.env，或通过
    // extraEnv 传入）优先；否则用实例自己的私有总线，避免桌面把通知/托盘
    // watcher 注册到宿主会话。都没有时，失效的继承地址回退到 XDG_RUNTIME_DIR/bus。
    const explicitBus =
        op.extraEnv?.DBUS_SESSION_BUS_ADDRESS ??
        (process.env.DBUS_SESSION_BUS_ADDRESS !== inheritedSessionBus
            ? process.env.DBUS_SESSION_BUS_ADDRESS
            : undefined);
    if (explicitBus) {
        testEnv.DBUS_SESSION_BUS_ADDRESS = explicitBus;
    } else if (op.bus) {
        testEnv.DBUS_SESSION_BUS_ADDRESS = op.bus.address;
    } else {
        const busAddress = testEnv.DBUS_SESSION_BUS_ADDRESS;
        const busPath = busAddress ? /(?:^|;)unix:path=([^;]+)/.exec(busAddress)?.[1] : undefined;
        if (busPath && !fs.existsSync(decodeURIComponent(busPath))) {
            delete testEnv.DBUS_SESSION_BUS_ADDRESS;
        }
    }

    return { ...testEnv, ...op.extraEnv };
}
