import { addStyle, initDKH, pack } from "dkh-ui";
import { setupMydeMock, MockVfsStore, type MockConfig } from "../../../../test/mock";

// 外部可配置的数据
const mockData = {
    desktopEntries: [] as Array<{ name: string; exec: string; icon: string }>,
    envVars: {} as Record<string, string>,
    settingValues: {} as Record<string, unknown>,
    passwordValid: false,
    validPasswords: new Set<string>(),
    vfsStore: new MockVfsStore(),
};

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

// 加载壁纸并启动
async function init() {
    // 通过fetch加载壁纸
    const resp = await fetch(new URL("../../assets/wallpaper/1.svg", import.meta.url));
    const wallpaper = await resp.arrayBuffer();
    mockData.vfsStore.addBinaryFile("/assets/wallpaper/1.svg", wallpaper);

    // 创建带自定义数据的mock配置
    const mockConfig: MockConfig = {
        verbose: true,
        vfsStore: mockData.vfsStore,
        sysApi: {
            getDesktopEntries: async () => mockData.desktopEntries as any,
            getDesktopEntry: async (id: string) => {
                return mockData.desktopEntries.find((e) => e.name === id) as any;
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
