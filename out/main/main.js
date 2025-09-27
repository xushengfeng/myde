"use strict";
const electron = require("electron");
const path$2 = require("node:path");
const url = require("node:url");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path$2);
const { app } = require("electron");
const fs$1 = require("node:fs");
const path$1 = require("node:path");
class Store {
  configPath;
  constructor() {
    this.configPath = path$1.join(app.getPath("userData"), "config.json");
    if (!fs$1.existsSync(this.configPath)) {
      this.init();
    }
  }
  init() {
    fs$1.writeFileSync(this.configPath, "{}");
  }
  getStore() {
    let str = "{}";
    try {
      str = fs$1.readFileSync(this.configPath).toString() || "{}";
    } catch (error) {
      this.init();
    }
    return JSON.parse(str);
  }
  setStore(data) {
    fs$1.writeFileSync(this.configPath, JSON.stringify(data, null, 2));
  }
  set(keyPath, value) {
    const store2 = this.getStore();
    const pathx = keyPath.split(".");
    let obj = store2;
    for (let i = 0; i < pathx.length; i++) {
      const p = pathx[i];
      if (i === pathx.length - 1) obj[p] = value;
      else {
        if (obj[p]?.constructor !== Object) {
          if (!Number.isNaN(Number(pathx[i + 1]))) {
            obj[p] = [];
          } else {
            obj[p] = {};
          }
        }
        obj = obj[p];
      }
    }
    this.setStore(store2);
  }
  get(keyPath) {
    const store2 = this.getStore();
    const pathx = keyPath.split(".");
    const lastp = pathx.pop() ?? "";
    const lastobj = pathx.reduce((p, c) => {
      return p[c] || {};
    }, store2);
    return lastobj[lastp];
  }
  clear() {
    this.init();
  }
}
const path = require("node:path");
const fs = require("node:fs");
const rootDirL = __dirname.split(path.sep);
const outDir = rootDirL.lastIndexOf("out");
const rootDir = path.join(rootDirL.slice(0, outDir).join(path.sep), "./lib/translate");
let language = "";
function parseLan(lan2) {
  const lans = getLans();
  return matchFitLan(lan2, lans);
}
function matchFitLan(lan2, lanList, defaultLan = "zh-HANS") {
  const zhMap = {
    "zh-CN": "zh-HANS",
    "zh-SG": "zh-HANS",
    "zh-TW": "zh-HANT",
    "zh-HK": "zh-HANT"
  };
  const supportLan = lanList.map((i) => zhMap[i] || i);
  const mainLan = lan2?.split("-")[0] || "";
  const filterLans = supportLan.filter((i) => i.startsWith(`${mainLan}-`) || i === mainLan);
  if (filterLans.length === 0) return defaultLan;
  if (filterLans.includes(lan2)) return lan2;
  return filterLans[0];
}
function lan(lan2) {
  language = parseLan(lan2);
  if (language !== "zh-HANS") {
    require(path.join(rootDir, `./${language}.json`));
  }
}
require(path.join(rootDir, "./source.json"));
function getLans() {
  const lans = fs.readdirSync(rootDir).filter((file) => {
    return file.endsWith(".json") && !file.startsWith("source") && !file.startsWith(".");
  }).map((l2) => l2.replace(".json", ""));
  return ["zh-HANS"].concat(lans);
}
const run_path = path__namespace.join(path__namespace.resolve(__dirname, ""), "../../");
const store = new Store();
let dev;
let the_icon = path__namespace.join(run_path, "assets/logo/1024x1024.png");
if (process.platform === "win32") {
  the_icon = path__namespace.join(run_path, "assets/logo/icon.ico");
}
process.platform === "darwin";
function renderer_url(file_name, q = {
  query: { config_path: electron.app.getPath("userData") }
}) {
  if (!q.query) {
    q.query = { config_path: electron.app.getPath("userData") };
  } else {
    q.query.config_path = electron.app.getPath("userData");
  }
  let x;
  if (!electron.app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const main_url = `${process.env.ELECTRON_RENDERER_URL}/${file_name}`;
    x = new url.URL(main_url);
  } else {
    x = new url.URL(`file://${path__namespace.join(__dirname, "../renderer", file_name)}`);
  }
  if (q) {
    if (q.search) x.search = q.search;
    if (q.query) {
      for (const i in q.query) {
        x.searchParams.set(i, q.query[i]);
      }
    }
    if (q.hash) x.hash = q.hash;
  }
  return x.toString();
}
function rendererPath(window, file_name, q) {
  window.loadURL(renderer_url(file_name, q));
}
async function createWin() {
  const main_window = new electron.BrowserWindow({
    backgroundColor: electron.nativeTheme.shouldUseDarkColors ? "#0f0f0f" : "#ffffff",
    icon: the_icon,
    frame: false,
    show: true,
    width: store.get("appearance.size.normal.w") || 800,
    height: store.get("appearance.size.normal.h") || 600,
    maximizable: store.get("appearance.size.normal.m") || false
  });
  rendererPath(main_window.webContents, "main.html", {
    query: { userData: electron.app.getPath("userData") }
  });
  if (dev) main_window.webContents.openDevTools();
}
if (process.argv.includes("-d") || false) {
  dev = true;
} else {
  dev = false;
}
lan(store.get("lan"));
electron.app.commandLine.appendSwitch("enable-experimental-web-platform-features", "enable");
electron.app.whenReady().then(() => {
  createWin();
});
electron.app.on("will-quit", () => {
  electron.globalShortcut.unregisterAll();
});
