import { addStyle, initDKH, pack } from "dkh-ui";
import { setupMydeMock, MockVfsStore, type MockConfig, createMockClient, setGlobalRenderTools } from "../../../../test/mock";
import { mockApps, createMockApp, getMockAppIcon, getMockAppList } from "../../../../test/mock/apps";
import { MockRenderTools } from "../../../../test/mock/render-tools";
import type { renderTools } from "../../../../src/wayland/render_tools";

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

// 注册mock应用到桌面条目
function registerMockApps() {
    const appList = getMockAppList();
    mockData.desktopEntries.push(...appList.map(app => ({
        name: app.name,
        nameLocal: app.name,
        comment: "",
        commentLocal: "",
        icon: app.icon,
        exec: app.id,
        desktopFile: `${app.id}.desktop`,
    })));
}

// 加载壁纸并启动
async function init() {
    // 注册mock应用
    registerMockApps();

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
                        listeners.get(event)!.add(cb);
                        return mockServer;
                    },
                    off(event: string, cb: (...args: any[]) => void) {
                        listeners.get(event)?.delete(cb);
                        return mockServer;
                    },
                    emit(event: string, ...args: any[]) {
                        listeners.get(event)?.forEach((cb) => cb(...args));
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

                        // 触发newClient事件
                        mockServer.emit("newClient", mockClient, clientId);

                        // 创建应用，传入render
                        const result = createMockApp(exec, mockClient, render);
                        if (result) {
                            // 在客户端上触发windowCreated事件，传递renderId
                            mockClient.emit("windowCreated", result.app["windowId"], result.renderId);
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
