# MyDE Mock

提供myde全局变量的mock实现，用于桌面开发者快速开发参考界面，无需真实dbus/系统服务。

## 快速开始

```typescript
import { setupMydeMock, MockVfsStore } from "test/mock";

const vfsStore = new MockVfsStore();
vfsStore.addTextFile("/path/to/file", "content");

setupMydeMock({
    verbose: true,
    vfsStore,
    sysApi: {
        getDesktopEntries: async () => [{ name: "MyApp", exec: "myapp", icon: "icon" }],
        verifyUserPassword: async (pwd) => pwd === "123456",
    },
});

// 此时全局 myde 可用
const { MSysApi, MInputMap, MSetting } = myde;
```

## 导出

| 名称 | 类型 | 说明 |
|------|------|------|
| `createMockMyde` | 函数 | 创建mock对象，不设置全局 |
| `setupMydeMock` | 函数 | 创建并设置全局myde |
| `clearMydeMock` | 函数 | 清除全局myde |
| `createObservableMock` | 函数 | 创建可观察mock，记录调用 |
| `createMockClient` | 函数 | 创建mock Wayland客户端 |
| `createMockWindow` | 函数 | 创建mock窗口 |
| `MockVfsStore` | 类 | 内存文件系统 |
| `MockConfig` | 类型 | 配置选项 |

## MockConfig 配置

```typescript
interface MockConfig {
    verbose?: boolean;           // 打印调用日志
    vfsStore?: MockVfsStore;     // 自定义文件存储
    sysApi?: Partial<MSysApi>;   // 覆盖系统API
    inputMap?: Partial<MInputMap>; // 覆盖输入映射
    setting?: MSetting;          // 覆盖设置模块
    connect?: MConnect;          // 覆盖远程连接
}
```

## 已覆盖 API

### MSysApi

| API | 状态 | 说明 |
|-----|------|------|
| `getDesktopEntries` | ✅ | 可通过外部数据配置 |
| `getDesktopEntry` | ✅ | 可通过外部数据配置 |
| `getDesktopIcon` | ✅ | 返回icon字符串 |
| `refreshDesktopEntries` | ✅ | 空实现 |
| `getEnv` | ✅ | 返回mock环境变量，可扩展 |
| `server` | ✅ | 返回mock WaylandServer |
| `fs` | ✅ | MockVfsStore内存文件系统 |
| `login` | ✅ | 空实现 |
| `media` | ✅ | init/onNewPlayer |
| `notification` | ✅ | init/on |
| `tray` | ✅ | init/tarysService |
| `power` | ✅ | init/getDevices |
| `blue` | ✅ | init/isPowered/getDevices |
| `network` | ✅ | init/getActiveWifiConnection/getWifiDevices |
| `display` | ✅ | onMessage/send |
| `input` | ✅ | init/on/getDevices |
| `verifyUserPassword` | ✅ | 可配置密码验证 |
| `appControl` | ✅ | getPidTree/getPid |

### MInputMap

| API | 状态 | 说明 |
|-----|------|------|
| `mapKeyCode` | ✅ | 返回0 |

### MUtils

| API | 状态 | 说明 |
|-----|------|------|
| `renderToolsHtmlEl` | ✅ | 实现renderTools接口 |

### MSetting

| API | 状态 | 说明 |
|-----|------|------|
| `init` | ✅ | 返回get/set/nget/nset |

### MConnect

| API | 状态 | 说明 |
|-----|------|------|
| 工厂函数 | ✅ | 返回空对象 |

### WaylandServer

| API | 状态 | 说明 |
|-----|------|------|
| `clients` | ✅ | Map |
| `on/off/emit` | ✅ | 事件监听 |
| `destroy` | ✅ | 清理 |

### WaylandClient

| API | 状态 | 说明 |
|-----|------|------|
| `getWindows` | ✅ | 返回窗口Map |
| `win` | ✅ | 获取窗口 |
| `on/onSync` | ✅ | 事件监听 |
| `keyboard.sendKey` | ✅ | 键盘输入 |
| `pointer` | ✅ | 鼠标操作 |

## MockVfsStore

内存文件系统，支持预置文件供桌面读取。

```typescript
const store = new MockVfsStore();

store.addTextFile("/path/file.txt", "content");
store.addBinaryFile("/path/image.png", arrayBuffer);
store.addDir("/path/");

store.removeFile("/path/file.txt");
store.clear();

// 传入mock配置
setupMydeMock({ vfsStore: store });
```

## 外部数据配置示例

```typescript
// desktop/offical/test/mock/mock_demo.ts 提供了完整示例
import { setMockDesktopEntries, addMockValidPassword, getMockVfsStore } from "./mock_demo";

// 设置桌面应用列表
setMockDesktopEntries([
    { name: "Firefox", exec: "firefox", icon: "firefox" },
    { name: "Terminal", exec: "gnome-terminal", icon: "terminal" },
]);

// 添加有效密码
addMockValidPassword("myde123");

// 获取vfs存储并添加文件
const store = getMockVfsStore();
store.addTextFile("/home/mock/.config/app.conf", "key=value");
```
