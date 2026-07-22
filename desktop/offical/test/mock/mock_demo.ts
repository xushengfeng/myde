import { addStyle, initDKH, pack } from "dkh-ui";
import type { renderTools } from "../../../../src/wayland/render_tools";
import {
    createMockClient,
    type MockConfig,
    MockVfsStore,
    setGlobalRenderTools,
    setupMydeMock,
    MockBlueManager,
    MockBlueDevice,
    MockNetworkManager,
    MockWifiDevice,
    MockAccessPoint,
    MockPowerManager,
    MockPowerDevice,
    MockNotificationManager,
    MockMprisManager,
    MockMprisPlayer,
} from "../../../../test/mock";
import { createMockApp, getMockAppIcon, getMockAppList } from "../../../../test/mock/apps";
import { MockRenderTools } from "../../../../test/mock/render-tools";

type DesktopEntry = {
    name: string;
    nameLocal: string;
    comment: string;
    commentLocal: string;
    icon: string;
    exec: string;
    desktopFile: string;
};

// 外部可配置的数据
const mockData = {
    desktopEntries: [] as DesktopEntry[],
    envVars: {} as Record<string, string>,
    settingValues: {} as Record<string, unknown>,
    passwordValid: false,
    validPasswords: new Set<string>(),
    vfsStore: new MockVfsStore(),
};

// 创建设备管理器
const blueManager = new MockBlueManager(console.log);
const networkManager = new MockNetworkManager(console.log);
const powerManager = new MockPowerManager(console.log);
const notificationManager = new MockNotificationManager(console.log);
const mprisManager = new MockMprisManager(console.log);

let clientIdCounter = 0;

// 从外部设置数据的接口
export function setMockDesktopEntries(entries: typeof mockData.desktopEntries) {
    mockData.desktopEntries = entries;
}

export function setMockEnvVars(vars: Record<string, string>) {
    mockData.envVars = vars;
}

export function setMockSettingValues(values: Record<string, unknown>) {
    mockData.settingValues = values;
}

export function setMockPasswordValid(valid: boolean) {
    mockData.passwordValid = valid;
}

export function addMockValidPassword(password: string) {
    mockData.validPasswords.add(password);
}

export function removeMockValidPassword(password: string) {
    mockData.validPasswords.delete(password);
}

export function clearMockValidPasswords() {
    mockData.validPasswords.clear();
}

export function getMockVfsStore() {
    return mockData.vfsStore;
}

// 获取设备管理器
export function getMockBlueManager() {
    return blueManager;
}

export function getMockNetworkManager() {
    return networkManager;
}

export function getMockPowerManager() {
    return powerManager;
}

export function getMockNotificationManager() {
    return notificationManager;
}

export function getMockMprisManager() {
    return mprisManager;
}

// 添加蓝牙设备
export function addMockBlueDevice(path: string, name: string, address: string, connected = false, trusted = false) {
    const device = new MockBlueDevice(path, name, address, connected, trusted);
    blueManager.addDevice(device);
    return device;
}

// 添加WiFi设备
export function addMockWifiDevice(path: string, iface = "wlan0", state = 30) {
    const device = new MockWifiDevice(path, iface, state);
    networkManager.addWifiDevice(device);
    return device;
}

// 添加WiFi接入点
export function addMockAccessPoint(wifiDevice: MockWifiDevice, path: string, ssid: string, strength = 80) {
    const ap = new MockAccessPoint(path, ssid, strength);
    wifiDevice.addAccessPoint(ap);
    return ap;
}

// 添加电源设备
export function addMockPowerDevice(
    path: string,
    percentage = 100,
    state = "Charging",
    type = "Battery",
    model = "mock-battery",
) {
    const device = new MockPowerDevice(path, percentage, state, false, type, model);
    powerManager.addDevice(device);
    return device;
}

// 发送通知
export function sendMockNotification(appName: string, summary: string, body: string, appIcon = "icon") {
    return notificationManager.sendNotification({
        app_name: appName,
        replaces_id: 0,
        app_icon: appIcon,
        summary,
        body,
        actions: [],
        hints: {},
        expire_timeout: 5000,
    });
}

// 添加音乐播放器
export function addMockMprisPlayer(name: string, identity: string) {
    const player = new MockMprisPlayer(name, identity);
    mprisManager.addPlayer(player);
    return player;
}

// 初始化示例数据
function initMockData() {
    // 蓝牙设备示例
    addMockBlueDevice("/org/bluez/dev1", "WH-1000XM5", "AA:BB:CC:11:22:33", true, true);
    addMockBlueDevice("/org/bluez/dev2", "Galaxy Buds Pro", "DD:EE:FF:44:55:66", false, true);
    addMockBlueDevice("/org/bluez/dev3", "Magic Mouse", "11:22:33:AA:BB:CC", false, false);

    // WiFi设备和接入点示例
    const wifiDev = addMockWifiDevice("/org/freedesktop/NetworkManager/Devices/1", "wlan0", 100);
    const homeAp = addMockAccessPoint(wifiDev, "/org/freedesktop/AccessPoint/1", "HomeWiFi", 90);
    addMockAccessPoint(wifiDev, "/org/freedesktop/AccessPoint/2", "OfficeNetwork", 75);
    addMockAccessPoint(wifiDev, "/org/freedesktop/AccessPoint/3", "CoffeeShop_Guest", 45);

    // 设置活跃接入点和连接
    wifiDev.setActiveAccessPoint(homeAp);
    homeAp.setActive(true);
    networkManager.setState(70);
    networkManager.setActiveConnection({
        path: "/org/freedesktop/NetworkManager/Connection/1",
        id: "HomeWiFi",
        type: "802-11-wireless",
        state: 2,
        specificObject: "/org/freedesktop/AccessPoint/1",
        devicePath: "/org/freedesktop/NetworkManager/Devices/1",
    });

    // 电源设备示例
    addMockPowerDevice("/org/freedesktop/UPower/devices/battery_BAT0", 85, "Discharging", "Battery", "Laptop Battery");
    addMockPowerDevice("/org/freedesktop/UPower/devices/line_power_AC", 100, "Charging", "Line Power", "AC Adapter");

    // 通知示例
    sendMockNotification("系统更新", "系统更新可用", "有新的系统更新可用，点击查看详情。", "system-software-update");
    sendMockNotification("蓝牙", "设备已连接", "WH-1000XM5 已成功连接。", "bluetooth");

    // 音乐播放器示例
    const spotify = addMockMprisPlayer("spotify", "Spotify");
    spotify.setMetadata({
        "xesam:title": "Bohemian Rhapsody",
        "xesam:artist": ["Queen"],
        "xesam:album": "A Night at the Opera",
        "mpris:artUrl": "file:///mock/cover/queen.jpg",
        "mpris:length": BigInt(354000000),
    });
    spotify.setDuration(354);
    spotify.setPlaybackStatus("Playing");

    const vlc = addMockMprisPlayer("vlc", "VLC Media Player");
    vlc.setMetadata({
        "xesam:title": "Local Video File",
        "xesam:artist": [],
        "xesam:album": "",
    });
    vlc.setDuration(0);
    vlc.setPlaybackStatus("Paused");
}

// 注册mock应用到桌面条目
function registerMockApps() {
    const appList = getMockAppList();
    mockData.desktopEntries.push(
        ...appList.map((app) => ({
            name: app.name,
            nameLocal: app.name,
            comment: "",
            commentLocal: "",
            icon: app.icon,
            exec: app.id,
            desktopFile: `${app.id}.desktop`,
        })),
    );
}

// 加载壁纸并启动
async function init() {
    // 注册mock应用
    registerMockApps();

    // 初始化示例数据
    initMockData();

    // 通过fetch加载壁纸
    const resp = await fetch(new URL("../../assets/wallpaper/1.svg", import.meta.url));
    const wallpaper = await resp.arrayBuffer();
    mockData.vfsStore.addBinaryFile("/assets/wallpaper/1.svg", wallpaper);

    // 创建renderTools（不需要container）
    const renderTools = new MockRenderTools();
    setGlobalRenderTools(renderTools);

    // 创建带自定义数据的mock配置
    const mockConfig: MockConfig = {
        verbose: true,
        vfsStore: mockData.vfsStore,
        blueManager,
        networkManager,
        powerManager,
        notificationManager,
        mprisManager,
        sysApi: {
            getDesktopEntries: async () => mockData.desktopEntries as any,
            getDesktopEntry: async (id: string) => {
                return mockData.desktopEntries.find((e) => e.name === id) as any;
            },
            getDesktopIcon: async (icon: string, op?: { size?: number }) => {
                return getMockAppIcon(icon, op?.size || 48);
            },
            getEnv: () => ({
                HOME: "/home/mock",
                USER: "mock",
                XDG_RUNTIME_DIR: "/tmp/mock",
                LANG: "en_US.UTF-8",
                ...mockData.envVars,
            }),
            verifyUserPassword: async (password: string) => {
                if (mockData.validPasswords.size > 0) return mockData.validPasswords.has(password);
                return mockData.passwordValid;
            },
            server: (op: { dev?: boolean; render: renderTools }) => {
                const clients = new Map<number, any>();
                const listeners = new Map<string, Set<(...args: any[]) => void>>();

                // 使用传入的renderTools（来自op.render）
                const render = op.render || renderTools;

                const mockServer = {
                    socketDir: "/tmp/mock",
                    socketName: "mock-socket",
                    clients,
                    on(event: string, cb: (...args: any[]) => void) {
                        if (!listeners.has(event)) listeners.set(event, new Set());
                        listeners.get(event)?.add(cb);
                        return mockServer;
                    },
                    off(event: string, cb: (...args: any[]) => void) {
                        listeners.get(event)?.delete(cb);
                        return mockServer;
                    },
                    emit(event: string, ...args: any[]) {
                        listeners.get(event)?.forEach((cb) => {
                            cb(...args);
                        });
                    },
                    destroy() {
                        clients.clear();
                        listeners.clear();
                    },
                };

                return {
                    runApp: (exec: string) => {
                        // 为每个应用创建新的客户端
                        const clientId = ++clientIdCounter;
                        const mockClient = createMockClient();
                        clients.set(clientId, mockClient);

                        // 监听客户端的close事件，触发server的clientClose事件
                        mockClient.on("close", () => {
                            clients.delete(clientId);
                            mockServer.emit("clientClose", mockClient, clientId);
                        });

                        // 触发newClient事件
                        mockServer.emit("newClient", mockClient, clientId);

                        // 创建应用，传入render
                        const result = createMockApp(exec, mockClient, render);
                        if (result) {
                            // 在客户端上触发windowCreated事件，传递renderId
                            mockClient.emit("windowCreated", result.app.windowId, result.renderId);
                        }
                        return {} as any;
                    },
                    server: mockServer,
                } as any;
            },
        },
    };

    addMockValidPassword("myde123");

    // 设置mock
    setupMydeMock(mockConfig);

    initDKH({ pureStyle: true });
    pack(document.body).style({
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "black",
    });

    addStyle({
        "*": {
            cursor: "none !important",
        },
    });

    // 导入官方桌面实现
    await import("../../src/main");
}

init();
