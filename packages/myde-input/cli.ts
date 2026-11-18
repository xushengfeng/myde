#!/usr/bin/env node
/**
 * myde-input CLI — 类似 evtest 的输入设备交互工具
 *
 * 用法:
 *   npx tsx cli.ts list                 列出所有输入设备
 *   npx tsx cli.ts info <path>          显示设备详细能力
 *   npx tsx cli.ts monitor [path]       实时监听设备事件
 */

import * as readline from "node:readline";
import {
  ABS_MT_BLOB_ID,
  ABS_MT_DISTANCE,
  ABS_MT_ORIENTATION,
  ABS_MT_POSITION_X,
  ABS_MT_POSITION_Y,
  ABS_MT_PRESSURE,
  ABS_MT_SLOT,
  ABS_MT_TOOL_TYPE,
  ABS_MT_TOUCH_MAJOR,
  ABS_MT_TOUCH_MINOR,
  ABS_MT_TRACKING_ID,
  ABS_MT_WIDTH_MAJOR,
  ABS_MT_WIDTH_MINOR,
  ABS_X,
  ABS_Y,
  BTN_A,
  BTN_B,
  BTN_BACK,
  BTN_EXTRA,
  BTN_FORWARD,
  BTN_LEFT,
  BTN_MIDDLE,
  BTN_MODE,
  BTN_RIGHT,
  BTN_SELECT,
  BTN_SIDE,
  BTN_START,
  BTN_STYLUS,
  BTN_STYLUS2,
  BTN_STYLUS3,
  BTN_THUMBL,
  BTN_THUMBR,
  BTN_TL,
  BTN_TL2,
  BTN_TOOL_AIRBRUSH,
  BTN_TOOL_BRUSH,
  BTN_TOOL_DOUBLETAP,
  BTN_TOOL_FINGER,
  BTN_TOOL_LENS,
  BTN_TOOL_MOUSE,
  BTN_TOOL_PEN,
  BTN_TOOL_PENCIL,
  BTN_TOOL_QUADTAP,
  BTN_TOOL_QUINTTAP,
  BTN_TOOL_RUBBER,
  BTN_TOOL_TRIPLETAP,
  BTN_TOUCH,
  BTN_TR,
  BTN_TR2,
  BTN_X,
  BTN_Y,
  BTN_Z,
  LINUX_TO_WEB_KEY,
  REL_HWHEEL,
  REL_HWHEEL_HI_RES,
  REL_WHEEL,
  REL_WHEEL_HI_RES,
  REL_X,
  REL_Y,
} from "./src/codes.ts";
import { type DeviceInfo, ErrorCode, type InputDevice, InputManager } from "./src/index.ts";

// ── ANSI 颜色 ──────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function dim(s: string) {
  return `${c.dim}${s}${c.reset}`;
}
function bold(s: string) {
  return `${c.bold}${s}${c.reset}`;
}
function green(s: string) {
  return `${c.green}${s}${c.reset}`;
}
function yellow(s: string) {
  return `${c.yellow}${s}${c.reset}`;
}
function red(s: string) {
  return `${c.red}${s}${c.reset}`;
}
function blue(s: string) {
  return `${c.blue}${s}${c.reset}`;
}
function cyan(s: string) {
  return `${c.cyan}${s}${c.reset}`;
}
function magenta(s: string) {
  return `${c.magenta}${s}${c.reset}`;
}
function gray(s: string) {
  return `${c.gray}${s}${c.reset}`;
}

// ── 事件码名称查找 ─────────────────────────────────────────

const EVENT_TYPE_NAMES: Record<number, string> = {
  0: "EV_SYN",
  1: "EV_KEY",
  2: "EV_REL",
  3: "EV_ABS",
  4: "EV_MSC",
  5: "EV_SW",
  6: "EV_LED",
  7: "EV_SND",
  8: "EV_REP",
  9: "EV_FF",
  10: "EV_PWR",
  11: "EV_FF_STATUS",
};

const REL_NAMES: Record<number, string> = {
  [REL_X]: "REL_X",
  [REL_Y]: "REL_Y",
  2: "REL_Z",
  3: "REL_RX",
  4: "REL_RY",
  5: "REL_RZ",
  [REL_HWHEEL]: "REL_HWHEEL",
  7: "REL_DIAL",
  [REL_WHEEL]: "REL_WHEEL",
  9: "REL_MISC",
  [REL_WHEEL_HI_RES]: "REL_WHEEL_HI_RES",
  [REL_HWHEEL_HI_RES]: "REL_HWHEEL_HI_RES",
};

const ABS_NAMES: Record<number, string> = {
  [ABS_X]: "ABS_X",
  [ABS_Y]: "ABS_Y",
  2: "ABS_Z",
  3: "ABS_RX",
  4: "ABS_RY",
  5: "ABS_RZ",
  6: "ABS_THROTTLE",
  7: "ABS_RUDDER",
  8: "ABS_WHEEL",
  9: "ABS_GAS",
  10: "ABS_BRAKE",
  16: "ABS_HAT0X",
  17: "ABS_HAT0Y",
  18: "ABS_HAT1X",
  19: "ABS_HAT1Y",
  20: "ABS_HAT2X",
  21: "ABS_HAT2Y",
  22: "ABS_HAT2X",
  23: "ABS_HAT3Y",
  24: "ABS_PRESSURE",
  25: "ABS_DISTANCE",
  26: "ABS_TILT_X",
  27: "ABS_TILT_Y",
  28: "ABS_TOOL_WIDTH",
  32: "ABS_VOLUME",
  40: "ABS_MISC",
  [ABS_MT_SLOT]: "ABS_MT_SLOT",
  [ABS_MT_TOUCH_MAJOR]: "ABS_MT_TOUCH_MAJOR",
  [ABS_MT_TOUCH_MINOR]: "ABS_MT_TOUCH_MINOR",
  [ABS_MT_WIDTH_MAJOR]: "ABS_MT_WIDTH_MAJOR",
  [ABS_MT_WIDTH_MINOR]: "ABS_MT_WIDTH_MINOR",
  [ABS_MT_ORIENTATION]: "ABS_MT_ORIENTATION",
  [ABS_MT_POSITION_X]: "ABS_MT_POSITION_X",
  [ABS_MT_POSITION_Y]: "ABS_MT_POSITION_Y",
  [ABS_MT_TOOL_TYPE]: "ABS_MT_TOOL_TYPE",
  [ABS_MT_BLOB_ID]: "ABS_MT_BLOB_ID",
  [ABS_MT_TRACKING_ID]: "ABS_MT_TRACKING_ID",
  [ABS_MT_PRESSURE]: "ABS_MT_PRESSURE",
  [ABS_MT_DISTANCE]: "ABS_MT_DISTANCE",
};

const BTN_NAMES: Record<number, string> = {
  [BTN_LEFT]: "BTN_LEFT",
  [BTN_RIGHT]: "BTN_RIGHT",
  [BTN_MIDDLE]: "BTN_MIDDLE",
  [BTN_SIDE]: "BTN_SIDE",
  [BTN_EXTRA]: "BTN_EXTRA",
  [BTN_FORWARD]: "BTN_FORWARD",
  [BTN_BACK]: "BTN_BACK",
  [BTN_A]: "BTN_A",
  [BTN_B]: "BTN_B",
  [BTN_X]: "BTN_X",
  [BTN_Y]: "BTN_Y",
  [BTN_Z]: "BTN_Z",
  [BTN_TL]: "BTN_TL",
  [BTN_TR]: "BTN_TR",
  [BTN_TL2]: "BTN_TL2",
  [BTN_TR2]: "BTN_TR2",
  [BTN_SELECT]: "BTN_SELECT",
  [BTN_START]: "BTN_START",
  [BTN_MODE]: "BTN_MODE",
  [BTN_THUMBL]: "BTN_THUMBL",
  [BTN_THUMBR]: "BTN_THUMBR",
  [BTN_TOOL_PEN]: "BTN_TOOL_PEN",
  [BTN_TOOL_RUBBER]: "BTN_TOOL_RUBBER",
  [BTN_TOOL_BRUSH]: "BTN_TOOL_BRUSH",
  [BTN_TOOL_PENCIL]: "BTN_TOOL_PENCIL",
  [BTN_TOOL_AIRBRUSH]: "BTN_TOOL_AIRBRUSH",
  [BTN_TOOL_FINGER]: "BTN_TOOL_FINGER",
  [BTN_TOOL_MOUSE]: "BTN_TOOL_MOUSE",
  [BTN_TOOL_LENS]: "BTN_TOOL_LENS",
  [BTN_TOOL_QUINTTAP]: "BTN_TOOL_QUINTTAP",
  [BTN_STYLUS3]: "BTN_STYLUS3",
  [BTN_TOUCH]: "BTN_TOUCH",
  [BTN_STYLUS]: "BTN_STYLUS",
  [BTN_STYLUS2]: "BTN_STYLUS2",
  [BTN_TOOL_DOUBLETAP]: "BTN_TOOL_DOUBLETAP",
  [BTN_TOOL_TRIPLETAP]: "BTN_TOOL_TRIPLETAP",
  [BTN_TOOL_QUADTAP]: "BTN_TOOL_QUADTAP",
};

// ── 辅助函数 ───────────────────────────────────────────────

function eventTypeName(type: number): string {
  return EVENT_TYPE_NAMES[type] ?? `EV_???(${type})`;
}

function codeName(type: number, code: number): string {
  switch (type) {
    case 1:
      return BTN_NAMES[code] ?? LINUX_TO_WEB_KEY[code] ?? `KEY_???(${code})`;
    case 2:
      return REL_NAMES[code] ?? `REL_???(${code})`;
    case 3:
      return ABS_NAMES[code] ?? `ABS_???(${code})`;
    default:
      return `CODE_${code}`;
  }
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function capabilityList(caps: DeviceCapabilities): string[] {
  const items: string[] = [];
  for (const t of caps.eventTypes) {
    items.push(eventTypeName(t));
  }
  return items;
}

function deviceTypeName(type: string): string {
  const icons: Record<string, string> = {
    keyboard: "⌨ ",
    mouse: "🖱 ",
    touchpad: "⊡ ",
    touchscreen: "👆",
    tablet: "🖊 ",
    gamepad: "🎮",
    unknown: "? ",
  };
  return icons[type] ?? "? ";
}

/** 等待初始设备列表到达 */
function waitForDevices(manager: InputManager, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    if (manager.getDevices().length > 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    manager.on("deviceAdded", () => {
      // 收到第一个设备后多等 200ms 让其余设备到达
      clearTimeout(timer);
      setTimeout(resolve, 200);
    });
  });
}

type DeviceCapabilities = DeviceInfo["capabilities"];

// ── 命令: list ─────────────────────────────────────────────

async function cmdList(showAll: boolean): Promise<void> {
  const manager = new InputManager();
  setupCleanup(manager);

  const initResult = await manager.init();
  if (!initResult.ok) {
    console.error(red(`错误: ${initResult.error.message}`));
    process.exit(1);
  }

  manager.on("error", (err) => {
    if (err.code !== ErrorCode.ProcessExited) {
      console.error(gray(`  [错误] ${err.message}`));
    }
  });

  await waitForDevices(manager);

  const devices = manager.getDevices();
  if (devices.length === 0) {
    console.log(yellow("未发现输入设备。"));
    console.log(dim("提示: 确认有 /dev/input/event* 设备，且有访问权限。"));
    await manager.destroy();
    return;
  }

  console.log(bold(`\n发现 ${devices.length} 个输入设备:\n`));

  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    const icon = deviceTypeName(d.type);
    const num = dim(`  ${String(i + 1).padStart(2)}.`);

    if (!showAll && d.type === "unknown") continue;

    console.log(`${num} ${icon} ${bold(d.path)}`);
    console.log(`      名称: ${d.name}`);
    console.log(`      类型: ${d.type}`);
    if (d.phys) console.log(`      物理: ${d.phys}`);
    console.log(
      `      ID:   vendor=${hex(d.vendor)} product=${hex(d.product)} version=${hex(d.version)}`,
    );
    console.log(`      能力: ${capabilityList(d.capabilities).join(", ")}`);

    if (d.capabilities.maxTouchSlots != null) {
      console.log(`      触控槽数: ${d.capabilities.maxTouchSlots}`);
    }

    if (d.touchInfo) {
      const ti = d.touchInfo;
      console.log(
        `      触屏: X[${ti.positionX.min}..${ti.positionX.max}] Y[${ti.positionY.min}..${ti.positionY.max}]`,
      );
      if (ti.mtProtocol) console.log(`      MT 协议: ${ti.mtProtocol}`);
    }

    if (d.errors.length > 0) {
      for (const err of d.errors) {
        console.log(red(`      ⚠ ${err.field}: ${err.message}`));
      }
    }

    console.log();
  }

  await manager.destroy();
}

function hex(n: number): string {
  return `0x${n.toString(16).padStart(4, "0")}`;
}

// ── 命令: info ─────────────────────────────────────────────

async function cmdInfo(devicePath: string): Promise<void> {
  const manager = new InputManager();
  setupCleanup(manager);

  const initResult = await manager.init();
  if (!initResult.ok) {
    console.error(red(`错误: ${initResult.error.message}`));
    process.exit(1);
  }

  await waitForDevices(manager);

  const device = findDevice(manager, devicePath);
  if (!device) {
    console.error(red(`设备未找到: ${devicePath}`));
    listDevicesBrief(manager);
    await manager.destroy();
    process.exit(1);
  }

  const d = device.info;
  const caps = d.capabilities;

  console.log();
  console.log(bold("═══ 设备信息 ═══"));
  console.log();
  console.log(`  路径:     ${cyan(d.path)}`);
  console.log(`  名称:     ${bold(d.name)}`);
  console.log(`  类型:     ${deviceTypeName(d.type)} ${d.type}`);
  if (d.phys) console.log(`  物理路径: ${d.phys}`);
  console.log(
    `  总线 ID:  vendor=${hex(d.vendor)} product=${hex(d.product)} version=${hex(d.version)}`,
  );

  console.log();
  console.log(bold("  ── 支持的事件类型 ──"));
  for (const t of caps.eventTypes) {
    console.log(`    ${eventTypeName(t)}`);
  }

  if (caps.keyCodes.length > 0) {
    console.log();
    console.log(bold(`  ── 按键/按钮 (${caps.keyCodes.length} 个) ──`));
    const names = caps.keyCodes.slice(0, 30).map((c) => codeName(1, c));
    console.log(`    ${names.join(", ")}`);
    if (caps.keyCodes.length > 30) {
      console.log(dim(`    ... 及另外 ${caps.keyCodes.length - 30} 个`));
    }
  }

  if (caps.relAxes.length > 0) {
    console.log();
    console.log(bold(`  ── 相对轴 (${caps.relAxes.length} 个) ──`));
    for (const a of caps.relAxes) {
      console.log(`    ${codeName(2, a)}`);
    }
  }

  if (caps.absAxes.length > 0) {
    console.log();
    console.log(bold(`  ── 绝对轴 (${caps.absAxes.length} 个) ──`));
    for (const a of caps.absAxes) {
      console.log(`    ${codeName(3, a)}`);
    }
  }

  console.log();
  console.log(bold("  ── 设备特性 ──"));
  console.log(`    键盘:      ${caps.hasKeyboard ? green("是") : dim("否")}`);
  console.log(`    鼠标:      ${caps.hasMouse ? green("是") : dim("否")}`);
  console.log(`    触摸板:    ${caps.hasTouchpad ? green("是") : dim("否")}`);
  console.log(`    触摸屏:    ${caps.hasTouchscreen ? green("是") : dim("否")}`);

  if (caps.maxTouchSlots != null) {
    console.log(`    多点触控槽: ${cyan(String(caps.maxTouchSlots))}`);
  }

  if (d.touchInfo) {
    console.log();
    console.log(bold("  ── 触屏物理参数 ──"));
    const ti = d.touchInfo;
    console.log(
      `    位置 X: min=${ti.positionX.min} max=${ti.positionX.max} fuzz=${ti.positionX.fuzz} flat=${ti.positionX.flat}`,
    );
    console.log(
      `    位置 Y: min=${ti.positionY.min} max=${ti.positionY.max} fuzz=${ti.positionY.fuzz} flat=${ti.positionY.flat}`,
    );
    if (ti.pressure) console.log(`    压力:   min=${ti.pressure.min} max=${ti.pressure.max}`);
    if (ti.touchMajor)
      console.log(`    触摸长轴: min=${ti.touchMajor.min} max=${ti.touchMajor.max}`);
    if (ti.touchMinor)
      console.log(`    触摸短轴: min=${ti.touchMinor.min} max=${ti.touchMinor.max}`);
    if (ti.orientation)
      console.log(`    方向:   min=${ti.orientation.min} max=${ti.orientation.max}`);
    if (ti.mtProtocol) console.log(`    MT 协议: ${ti.mtProtocol}`);
  }

  if (d.errors.length > 0) {
    console.log();
    console.log(bold("  ── 错误 ──"));
    for (const err of d.errors) {
      console.log(red(`    ⚠ ${err.field}: ${err.message}`));
    }
  }

  console.log();
  await manager.destroy();
}

// ── 命令: monitor ──────────────────────────────────────────

async function cmdMonitor(
  devicePath: string | null,
  filterEventTypes: number[] | null,
): Promise<void> {
  const manager = new InputManager();
  setupCleanup(manager);

  const initResult = await manager.init();
  if (!initResult.ok) {
    console.error(red(`错误: ${initResult.error.message}`));
    process.exit(1);
  }

  manager.on("error", (err) => {
    if (err.code !== ErrorCode.ProcessExited) {
      console.error(red(`  [错误] ${err.message}`));
    }
  });

  let device: InputDevice | undefined;

  if (devicePath) {
    await waitForDevices(manager);
    device = findDevice(manager, devicePath);
    if (!device) {
      console.error(red(`设备未找到: ${devicePath}`));
      listDevicesBrief(manager);
      await manager.destroy();
      process.exit(1);
    }
  } else {
    device = await selectDevice(manager);
    if (!device) {
      await manager.destroy();
      return;
    }
  }

  monitorDevice(device, filterEventTypes);
}

function monitorDevice(device: InputDevice, filterEventTypes: number[] | null): void {
  const info = device.info;
  const icon = deviceTypeName(info.type);

  console.log();
  console.log(
    `${bold("正在监听")} ${icon} ${cyan(info.path)} ${dim("(")}${bold(info.name)}${dim(")")}`,
  );
  if (filterEventTypes) {
    const names = filterEventTypes.map(eventTypeName).join(", ");
    console.log(dim(`  过滤: ${names}`));
  }
  console.log(dim("  按 Ctrl+C 退出\n"));

  const startHr = process.hrtime.bigint();

  device.on("raw", (event) => {
    if (filterEventTypes && !filterEventTypes.includes(event.type)) return;

    const elapsed = Number(process.hrtime.bigint() - startHr) / 1_000_000;
    const ts = (elapsed / 1000).toFixed(3);
    const tsStr = gray(pad(ts, 10));

    const typeStr = colorEventType(event.type);
    const codeStr = colorCode(event.type, event.code);

    let valueStr: string;
    if (event.type === 1) {
      valueStr = colorKeyValue(event.value);
    } else if (event.type === 2) {
      valueStr = colorRelValue(event.value);
    } else if (event.type === 3) {
      valueStr = colorAbsValue(event.code, event.value);
    } else {
      valueStr = String(event.value);
    }

    const typePad = pad(eventTypeName(event.type), 11);
    const codePad = pad(codeName(event.type, event.code), 22);

    console.log(`  ${tsStr} ${typeStr(typePad)} ${codeStr(codePad)} ${valueStr}`);
  });

  device.on("error", (err) => {
    console.error(red(`  [设备错误] ${err.message}`));
  });

  const readResult = device.startReading();
  if (!readResult.ok) {
    console.error(red(`无法开始读取: ${readResult.error.message}`));
  }
}

function colorEventType(type: number): (s: string) => string {
  switch (type) {
    case 0:
      return gray;
    case 1:
      return blue;
    case 2:
      return green;
    case 3:
      return yellow;
    default:
      return magenta;
  }
}

function colorCode(type: number, code: number): (s: string) => string {
  switch (type) {
    case 1: {
      const name = BTN_NAMES[code] ?? LINUX_TO_WEB_KEY[code] ?? "";
      if (name.startsWith("BTN_TOOL_") || name === "BTN_TOUCH") return magenta;
      if (name.startsWith("BTN_")) return cyan;
      return bold;
    }
    case 2:
      return cyan;
    case 3: {
      if (code >= 0x2f && code <= 0x3d) return magenta;
      return cyan;
    }
    default:
      return (s: string) => s;
  }
}

function colorKeyValue(value: number): string {
  switch (value) {
    case 0:
      return gray("UP      ");
    case 1:
      return green("DOWN    ");
    case 2:
      return yellow("REPEAT  ");
    default:
      return String(value);
  }
}

function colorRelValue(value: number): string {
  if (value > 0) return green(`+${value}`);
  if (value < 0) return red(String(value));
  return gray(" 0");
}

function colorAbsValue(code: number, value: number): string {
  if (code >= 0x2f && code <= 0x3d) {
    return cyan(String(value));
  }
  if (value > 0) return cyan(String(value));
  if (value < 0) return red(String(value));
  return gray(String(value));
}

// ── 设备查找 / 选择 ────────────────────────────────────────

function findDevice(manager: InputManager, pathOrName: string): InputDevice | undefined {
  const byPath = manager.getDevice(pathOrName);
  if (byPath) return byPath;

  const basename = pathOrName.split("/").pop() ?? pathOrName;
  const byBase = manager.getDevice(`/dev/input/${basename}`);
  if (byBase) return byBase;

  const match = manager
    .getDevices()
    .find(
      (d) => d.path.includes(pathOrName) || d.name.toLowerCase().includes(pathOrName.toLowerCase()),
    );
  return match ? manager.getDevice(match.path) : undefined;
}

function listDevicesBrief(manager: InputManager): void {
  const devices = manager.getDevices();
  if (devices.length === 0) {
    console.log(dim("  无可用设备。"));
    return;
  }
  console.log(dim("\n可用设备:"));
  for (const d of devices) {
    const icon = deviceTypeName(d.type);
    console.log(dim(`  ${icon} ${d.path}  ${d.name}`));
  }
  console.log();
}

async function selectDevice(manager: InputManager): Promise<InputDevice | undefined> {
  await waitForDevices(manager);

  const devices = manager.getDevices();
  if (devices.length === 0) {
    console.error(yellow("未发现输入设备。"));
    console.log(dim("提示: 确认有 /dev/input/event* 设备，且有访问权限。"));
    return undefined;
  }

  if (devices.length === 1) {
    const d = devices[0];
    console.log(dim(`自动选择唯一设备: ${d.path}`));
    return manager.getDevice(d.path);
  }

  console.log(bold("\n可用输入设备:\n"));
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    const icon = deviceTypeName(d.type);
    console.log(`  ${cyan(String(i + 1))}. ${icon} ${bold(d.path)}  ${dim(d.name)}`);
  }
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question("选择设备编号: ", (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });

  const idx = Number.parseInt(answer, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= devices.length) {
    console.error(red("无效选择。"));
    return undefined;
  }

  const selected = devices[idx];
  return manager.getDevice(selected.path);
}

// ── 进程清理 ───────────────────────────────────────────────

let cleanupManager: InputManager | null = null;

function setupCleanup(manager: InputManager): void {
  cleanupManager = manager;
}

async function cleanup(): Promise<void> {
  if (cleanupManager) {
    await cleanupManager.destroy();
    cleanupManager = null;
  }
}

process.on("SIGINT", async () => {
  console.log(dim("\n退出中..."));
  await cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(0);
});

// ── 参数解析 ───────────────────────────────────────────────

function parseArgs(): {
  command: string;
  args: string[];
  flags: Set<string>;
} {
  const raw = process.argv.slice(2);
  const flags = new Set<string>();
  const positional: string[] = [];

  for (const arg of raw) {
    if (arg.startsWith("-")) {
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0] ?? "monitor",
    args: positional.slice(1),
    flags,
  };
}

// ── 主入口 ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs();

  if (flags.has("--help") || flags.has("-h")) {
    printUsage();
    return;
  }

  switch (command) {
    case "list":
    case "ls":
      await cmdList(flags.has("--all") || flags.has("-a"));
      break;

    case "info":
    case "i":
      if (args.length === 0) {
        console.error(red("请指定设备路径，如: /dev/input/event0"));
        console.log(dim("用法: myde-input info <device>"));
        process.exit(1);
      }
      await cmdInfo(args[0]);
      break;

    case "monitor":
    case "mon":
    case "m": {
      const devicePath = args[0] ?? null;
      const filterTypes = parseEventFilter(flags);
      await cmdMonitor(devicePath, filterTypes);
      break;
    }

    default:
      console.error(red(`未知命令: ${command}`));
      printUsage();
      process.exit(1);
  }
}

function parseEventFilter(flags: Set<string>): number[] | null {
  const filterFlag = [...flags].find((f) => f.startsWith("--event="));
  if (!filterFlag) return null;

  const value = filterFlag.split("=")[1];
  if (!value) return null;

  const typeMap: Record<string, number> = {
    key: 1,
    rel: 2,
    abs: 3,
    syn: 0,
    msc: 4,
  };

  return value
    .split(",")
    .map((s) => {
      const trimmed = s.trim().toLowerCase();
      return typeMap[trimmed] ?? Number.parseInt(trimmed, 10);
    })
    .filter((n) => !Number.isNaN(n));
}

function printUsage(): void {
  console.log(`
${bold("myde-input")} — Linux 输入设备监控工具

${bold("用法:")}
  myde-input ${cyan("list")}    ${dim("[--all]")}                  列出所有输入设备
  myde-input ${cyan("info")}    ${dim("<device>")}                 显示设备详细能力
  myde-input ${cyan("monitor")} ${dim("[device] [--event=type,...]")} 实时监听事件

${bold("命令:")}
  ${cyan("list")}  ${dim("ls")}       列出系统上的所有输入设备
            ${dim("--all, -a")}    包含未知类型的设备

  ${cyan("info")}  ${dim("i")}        显示指定设备的详细信息和能力
            ${dim("<device>")}     设备路径 (如 /dev/input/event0)

  ${cyan("monitor")} ${dim("mon m")}   实时监听并显示输入事件（类似 evtest）
            ${dim("[device]")}     可选设备路径，省略则交互选择
            ${dim("--event=type")} 过滤事件类型: key, rel, abs, syn

${bold("示例:")}
  myde-input list
  myde-input list --all
  myde-input info /dev/input/event3
  myde-input monitor
  myde-input monitor /dev/input/event0
  myde-input monitor --event=key
  myde-input monitor /dev/input/event0 --event=key,rel
`);
}

main().catch((e) => {
  console.error(red(`致命错误: ${e}`));
  cleanup().then(() => process.exit(1));
});
