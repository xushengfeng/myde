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

## 动态设备管理

支持动态添加和删除蓝牙设备、网络设备、电源设备、通知和音乐播放器。

```typescript
import {
    setupMydeMock,
    MockBlueManager, MockBlueDevice,
    MockNetworkManager, MockWifiDevice, MockAccessPoint,
    MockPowerManager, MockPowerDevice,
    MockNotificationManager,
    MockMprisManager, MockMprisPlayer,
} from "test/mock";

// 创建管理器
const blueManager = new MockBlueManager(console.log);
const networkManager = new MockNetworkManager(console.log);
const powerManager = new MockPowerManager(console.log);
const notificationManager = new MockNotificationManager(console.log);
const mprisManager = new MockMprisManager(console.log);

// 设置mock
setupMydeMock({
    blueManager,
    networkManager,
    powerManager,
    notificationManager,
    mprisManager,
});

// 动态添加蓝牙设备
const device = new MockBlueDevice("/org/bluez/dev1", "MyHeadphones", "AA:BB:CC:DD:EE:FF");
blueManager.addDevice(device);

// 动态添加WiFi设备和接入点
const wifiDev = new MockWifiDevice("/org/freedesktop/NetworkManager/Devices/1");
const ap = new MockAccessPoint("/org/freedesktop/AccessPoint/1", "MyWiFi");
wifiDev.addAccessPoint(ap);
networkManager.addWifiDevice(wifiDev);

// 动态添加电源设备
const battery = new MockPowerDevice("/org/freedesktop/UPower/devices/battery1", 75, "Discharging", false, "Battery", "Laptop Battery");
powerManager.addDevice(battery);

// 动态发送通知
notificationManager.sendNotification({
    app_name: "TestApp",
    replaces_id: 0,
    app_icon: "icon",
    summary: "Test Notification",
    body: "This is a test",
    actions: [],
    hints: {},
    expire_timeout: 5000,
});

// 动态添加音乐播放器
const player = new MockMprisPlayer("spotify", "Spotify");
player.setMetadata({
    "xesam:title": "Test Song",
    "xesam:artist": ["Test Artist"],
});
player.setPlaybackStatus("Playing");
mprisManager.addPlayer(player);
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
| `MockBlueManager` | 类 | 蓝牙设备管理器 |
| `MockBlueDevice` | 类 | 蓝牙设备mock |
| `MockNetworkManager` | 类 | 网络管理器 |
| `MockWifiDevice` | 类 | WiFi设备mock |
| `MockAccessPoint` | 类 | WiFi接入点mock |
| `MockPowerManager` | 类 | 电源管理器 |
| `MockPowerDevice` | 类 | 电源设备mock |
| `MockNotificationManager` | 类 | 通知管理器 |
| `MockMprisManager` | 类 | MPRIS音乐播放器管理器 |
| `MockMprisPlayer` | 类 | MPRIS播放器mock |
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
    blueManager?: MockBlueManager;      // 蓝牙管理器
    networkManager?: MockNetworkManager; // 网络管理器
    powerManager?: MockPowerManager;    // 电源管理器
    notificationManager?: MockNotificationManager; // 通知管理器
    mprisManager?: MockMprisManager;    // MPRIS管理器
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
| `media` | ✅ | 支持动态添加/删除播放器 |
| `notification` | ✅ | 支持动态发送通知 |
| `tray` | ✅ | init/tarysService |
| `power` | ✅ | 支持动态添加/删除设备 |
| `blue` | ✅ | 支持动态添加/删除设备 |
| `network` | ✅ | 支持动态添加/删除WiFi设备和接入点 |
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

## 设备管理器 API

### MockBlueManager

```typescript
const manager = new MockBlueManager(log);

// 添加设备
const device = new MockBlueDevice(path, name, address, connected, trusted);
manager.addDevice(device);

// 移除设备
manager.removeDevice(path);

// 获取设备
const dev = manager.getDevice(path);

// 创建mock实例
const blueMock = manager.createMock();
```

### MockBlueDevice

```typescript
const device = new MockBlueDevice(
    "/org/bluez/dev1",  // path
    "MyDevice",         // name
    "AA:BB:CC:DD:EE",   // address
    false,              // connected
    false               // trusted
);

// 修改状态
device.setConnected(true);
device.setTrusted(true);
device.setName("NewName");
```

### MockNetworkManager

```typescript
const manager = new MockNetworkManager(log);

// 添加WiFi设备
const wifiDev = new MockWifiDevice(path, iface, state, deviceType);
manager.addWifiDevice(wifiDev);

// 添加接入点
const ap = new MockAccessPoint(path, ssid, strength, frequency, hwAddress, maxBitrate);
wifiDev.addAccessPoint(ap);

// 设置活跃接入点
wifiDev.setActiveAccessPoint(ap);

// 设置网络状态
manager.setState(70);  // 70 = connected
manager.setWirelessEnabled(true);
manager.setActiveConnection({
    path: "/conn/1",
    id: "MyWiFi",
    type: "802-11-wireless",
    state: 2,
    specificObject: "/ap/1",
    devicePath: "/dev/1",
});
```

### MockPowerManager

```typescript
const manager = new MockPowerManager(log);

// 添加电源设备
const battery = new MockPowerDevice(
    "/org/freedesktop/UPower/devices/battery1",
    75,              // percentage
    "Discharging",   // state
    false,           // powerSupply
    "Battery",       // type
    "Laptop Battery" // model
);
manager.addDevice(battery);

// 修改设备状态
battery.setPercentage(50);
battery.setState("Charging");
```

### MockNotificationManager

```typescript
const manager = new MockNotificationManager(log);

// 发送通知
const id = manager.sendNotification({
    app_name: "TestApp",
    replaces_id: 0,
    app_icon: "icon",
    summary: "标题",
    body: "内容",
    actions: [],
    hints: {},
    expire_timeout: 5000,
});

// 删除通知
manager.removeNotification(id);

// 清空所有通知
manager.clearNotifications();

// 获取所有通知
const notifications = manager.getNotifications();

// 监听通知
const mock = manager.createMock();
mock.on("new", (data) => {
    console.log("新通知:", data);
});
```

### MockMprisManager

```typescript
const manager = new MockMprisManager(log);

// 创建播放器
const player = new MockMprisPlayer("spotify", "Spotify");

// 设置元数据
player.setMetadata({
    "xesam:title": "歌曲名",
    "xesam:artist": ["艺术家"],
    "mpris:artUrl": "file:///path/to/cover.jpg",
    "mpris:length": BigInt(300000000), // 300秒
});
player.setDuration(300);

// 设置播放状态
player.setPlaybackStatus("Playing"); // "Playing" | "Paused" | "Stopped"

// 添加到管理器
manager.addPlayer(player);

// 监听事件
const mock = manager.createMock();
mock.on("new-player", (p) => {
    console.log("新播放器:", p);
});

// 移除播放器
manager.removePlayer("spotify");
```
