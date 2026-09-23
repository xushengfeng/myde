const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { dbusIO } = require("myde-dbus") as typeof import("myde-dbus");
const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

import { addStyle, button, ele, image, initDKH, input, pack, txt, view } from "dkh-ui";
import { _myde as myde } from "../../desktop-api";
import { getDesktopEntries, getDesktopIcon } from "../../sys_api/application";
import { type ImComposeState, inputMethod, type inputMethodContext } from "../../sys_api/input_method";
import { renderToolsHtmlEl } from "../../wayland/render_tools_el";
import type { WaylandClient } from "../../wayland/server";

function sendPointerEvent(type: "move" | "down" | "up", p: PointerEvent) {
    for (const [_id, client] of server.clients) {
        for (const [winId, _win] of client.getWindows()) {
            const xwin = client.win(winId);
            if (!xwin) continue;
            const winel = render.getXdgSurfaceEle(xwin.point.renderId());
            if (!winel) continue;
            const rect = winel.getBoundingClientRect();
            const nx = p.x - rect.left;
            const ny = p.y - rect.top;
            const inWin = xwin.point.inWin({ x: nx, y: ny });
            if (!inWin) continue;
            xwin.point.sendPointerEvent(
                type,
                new PointerEvent(p.type, { ...p, clientX: p.x - rect.left, clientY: p.y - rect.top }),
            );
            if (type === "down") {
                const f = xwin.focus();
                if (f) client.offerTo();
                for (const [otherWinId, _otherWin] of client.getWindows()) {
                    if (otherWinId !== winId) {
                        client.win(otherWinId)?.blur();
                    }
                }
            }
            break;
        }
    }
}

function sendScrollEvent(p: WheelEvent) {
    for (const [_, client] of server.clients) {
        for (const [winId, _win] of client.getWindows()) {
            const xwin = client.win(winId);
            if (!xwin) continue;
            const winel = render.getXdgSurfaceEle(xwin.point.renderId());
            if (!winel) continue;
            const rootEl = winel;
            const rect = rootEl.getBoundingClientRect();
            const nx = p.x - rect.left;
            const ny = p.y - rect.top;
            const inWin = xwin.point.inWin({ x: nx, y: ny });
            if (!inWin) continue;
            xwin.point.sendScrollEvent({
                p: p,
            });
        }
    }
}

function runApp(execPath: string, args: string[] = []) {
    console.log(`Running application: ${execPath}`);

    const subprocess = serverX.runApp(`${execPath} ${args.join(" ")}`, xServerNum);

    const logData: string[] = [];

    subprocess.stdout.on("data", (data) => {
        console.log(`Subprocess ${execPath} stdout:\n${data.toString("utf8")}`);
        logData.push(data.toString("utf8"));
    });

    subprocess.stderr.on("data", (data) => {
        const dataStr = data.toString("utf8");
        const m = dataStr.match(/\{Default Queue\}(.+?)#/)?.[1];
        if (m) {
            const p = (m as string)
                .replace("->", "")
                .replace(/^discarded/, "")
                .trim();
            if (!server.isProtocolSupported(p)) {
                console.error(`Unknown protocol in debug output: ${p}`);
            }
        }
        console.log(`Subprocess ${execPath} stderr:\n${data.toString("utf8")}`);
        logData.push(data.toString("utf8"));
    });

    subprocess.on("error", (err) => {
        console.error("Failed to start subprocess:", err);
    });

    subprocess.on("exit", (code, signal) => {
        console.log(`Subprocess ${execPath} exited with code ${code} and signal ${signal}`);
    });

    view()
        .add(
            button(`log ${execPath}`).on("click", () => {
                console.log(logData.map((line) => line.trim()).join("\n"));
            }),
        )
        .addInto();
}

const render = new renderToolsHtmlEl();

render.on({
    onToplevelCreate: (wid) => {
        body.add(render.getXdgSurfaceEle(wid));
    },
    onToplevelRemove: (wid) => {
        render.getXdgSurfaceEle(wid)?.remove();
    },
    onCursorUpdata(c, hx, hy) {
        console.log("cursor", c, hx, hy);

        if (c === undefined) {
            mouseEL.style({ opacity: 0 });
            return;
        } else {
            mouseEL.style({ opacity: 1 });
        }
        if (typeof c === "string") {
        } else {
            const cel = ele("canvas");

            cel.attr({ width: c.width, height: c.height });
            cel.el.getContext("2d")?.drawImage(c, 0, 0);
            mouseEL.clear().add(cel.style({ position: "absolute", left: `-${hx}px`, top: `-${hy}px` }));
        }
    },
});

const serverX = myde.MSysApi.server({
    dev: true,
    render: render,
});
const server = serverX.server;

server.on("newClient", (client, clientId) => {
    clientData.set(clientId, { client });
    client.onSync("windowBound", () => {
        return { width: window.innerWidth, height: window.innerHeight };
    });
    client.on("windowCreated", (windowId) => {
        console.log(`Client ${clientId} created window ${windowId}`);
        client.win(windowId)?.focus();
    });
    client.on("windowClosed", (windowId) => {
        console.log(`Client ${clientId} deleted window ${windowId}`);
    });
    client.on("windowMaximized", (windowId) => {
        const xwin = client.win(windowId);
        if (!xwin) return;

        const winEl = render.getXdgSurfaceEle(xwin.point.renderId());
        if (!winEl) return;
        const width = window.innerWidth;
        const height = window.innerHeight;
        pack(winEl).style({
            width: `${width}px`,
            height: `${height}px`,
            left: "0px",
            top: "0px",
        });
        xwin.maximize(width, height);
    });
    client.on("copy", (text: string) => {
        console.log(`Client ${clientId} copy text:`, text);
    });
    client.on("paste", () => {
        // todo copy后似乎抢占了，如果是自定义粘贴需要重新offer
        client.paste("hello");
    });
});
server.on("clientClose", (_, clientId) => {
    clientData.delete(clientId);
});

const clientData = new Map<string, { client: WaylandClient }>();

let xServerNum = NaN;

const mouseEL = view().addInto().style({
    position: "fixed",
    width: "10px",
    height: "10px",
    background: "rgba(0,0,0,0.5)",
    outline: "1px solid #fff",
    borderRadius: "50%",
    pointerEvents: "none",
    top: "0px",
    left: "0px",
    transform: "translate(-50%, -50%)",
    zIndex: 9999,
});

function mouseMove(x: number, y: number) {
    mouseEL.style({ top: `${y}px`, left: `${x}px` });
    sendPointerEvent("move", new PointerEvent("pointermove", { clientX: x, clientY: y }));
}

initDKH({ pureStyle: true });

const body = pack(document.body);

body.on("pointermove", (e) => {
    mouseMove(e.x, e.y);
});
body.on("pointerdown", (e) => {
    sendPointerEvent("down", e);
});
body.on("pointerup", (e) => {
    sendPointerEvent("up", e);
});

body.on("keydown", (e) => {
    if (e.repeat) return;
    for (const client of server.clients.values()) {
        client.keyboard.sendKey(mapKeyCode(e.code), "pressed");
    }
});
body.on("keyup", (e) => {
    if (e.repeat) return;
    for (const client of server.clients.values()) {
        client.keyboard.sendKey(mapKeyCode(e.code), "released");
    }
});

body.on("wheel", (e) => {
    sendScrollEvent(e);
});

function mapKeyCode(code: string): number {
    return myde.MInputMap.mapKeyCode(code);
}

body.style({
    background: 'url("file:///usr/share/wallpapers/ScarletTree/contents/images/5120x2880.png") center/cover no-repeat',
    height: "100vh",
    cursor: "none",
});

addStyle({
    "*": {
        cursor: "none !important",
    },
});

button("self")
    .on("click", () => {
        runApp(process.argv[0], process.argv.slice(1));
    })
    .addInto();

view()
    .add(
        [
            "google-chrome-stable",
            "firefox-nightly",
            "wayland-info",
            "weston-flower",
            "weston-simple-damage",
            "weston-simple-shm",
            "weston-simple-egl",
            "weston-editor",
            "weston-clickdot",
            "weston-subsurfaces",
            "glxgears",
            "kwrite",
            "gtk4-demo",
        ].map((app) =>
            button(app)
                .style({ padding: "4px 8px", background: "#fff" })
                .on("click", () => {
                    const execPath = `/usr/bin/${app}`;
                    runApp(execPath);
                }),
        ),
    )
    .addInto();

view()
    .add(
        ["queue-test"].map((app) =>
            button(app)
                .style({ padding: "4px 8px", background: "#fff" })
                .on("click", () => {
                    const execPath = path.join(__dirname, "../..", "test/offical", `wayland/build/tests/${app}`);
                    runApp(execPath);
                }),
        ),
    )
    .add(
        button("dma-buf-one-frame").on("click", () => {
            const execPath = path.join(__dirname, "../..", "test/simple_app/target/debug/dmabuf_one_frame");
            runApp(execPath);
        }),
    )
    .addInto();

view()
    .add(
        input().on("change", (_e, el) => {
            const command = el.gv;
            runApp(`/usr/bin/${command}`);
        }),
    )
    .addInto();

view()
    .add(
        button("xwayland").on("click", () => {
            for (let i = 0; i < 100; i++) {
                const socketPath = `/tmp/.X11-unix/X${i}`;
                if (!fs.existsSync(socketPath)) {
                    xServerNum = i;
                    runApp("/usr/bin/xwayland-satellite", [`:${xServerNum}`]);
                    break;
                }
            }
        }),
    )
    .addInto();

const allApps = await getDesktopEntries(["zh_CN", "zh", "zh-Hans"]);
console.log("Found desktop entries:", allApps);
const apps: typeof allApps = [];
const appNameSet = new Set<string>();

for (const app of allApps) {
    if (!appNameSet.has(app.name)) {
        appNameSet.add(app.name);
        // apps.push(app);
    }
}

view("y")
    .add(
        apps.map((app) => {
            const imageView = view();
            getDesktopIcon(app.icon).then((iconPath) => {
                if (iconPath) {
                    imageView.add(image(`file://${iconPath}`, app.name).style({ width: "24px" }));
                }
            });
            return view("x")
                .add([imageView, txt(app.nameLocal)])
                .on("click", () => {
                    const exec = app.exec.split(" ")[0]; // 简单处理参数
                    runApp(exec, app.exec.split(" ").slice(1));
                });
        }),
    )
    .addInto();

// —— 输入法测试：打字走输入法合成，带候选列表 ——
async function connectSessionBus() {
    const socket = new mus.USocket();
    socket.connect("/run/user/1000/bus");
    const io = new dbusIO({ socket });
    await io.connect();
    return io;
}

const imSys = new inputMethod(await connectSessionBus());
// 注意：不能用 input 等可编辑元素捕获按键——主机输入法会先行合成（Chromium IME 路径），
// 页面只能看到 Process/composition 事件拿不到原始按键；非编辑元素不激活主机 IME，
// keydown 即原始按键，才能喂给自己的输入法 API（真实桌面里这些键来自 evdev，天然无此问题）
const imCaptureView = view().attr({ tabIndex: 0 }).style({
    border: "1px solid #888",
    minHeight: "32px",
    padding: "4px",
    outline: "none",
    whiteSpace: "pre-wrap",
});
const imInfoLine = ele("div").style({ color: "#8af", fontSize: "12px" });
const imSwitchBox = view("x").style({ flexWrap: "wrap", gap: "4px" });
const imPreeditLine = ele("div").style({ color: "#0ff", minHeight: "24px" });
const imCandidateBox = view("x").style({ flexWrap: "wrap", gap: "4px", alignItems: "center" });
const imOutLine = ele("div").style({ color: "#ff0", minHeight: "24px" });
const imStatusLine = ele("div").style({ color: "#888", fontSize: "12px" });

let imCtx: inputMethodContext | undefined;

/** 文字上屏去向：显示 + 转发给 wayland 客户端 */
function imSendText(t: string) {
    imOutLine.el.textContent += t;
    for (const client of server.clients.values()) {
        client.keyboard.sendText(t, false);
    }
}

function imRender(s: ImComposeState) {
    imPreeditLine.el.textContent = s.preedit;
    const label = (i: number) => (s.candidateLabels[i] || `${i + 1}`).trim();
    imCandidateBox.clear().add(
        [
            button("◀").on("click", async () => {
                if (imCtx) imRender(await imCtx.prevPage());
            }),
            ...s.candidates.map((c, i) =>
                button(`${label(i)} ${c}`).on("click", async () => {
                    if (!imCtx) return;
                    const r = await imCtx.selectCandidate(i);
                    imStatusLine.el.textContent = `select(${i}) handled=${r.handled} committed="${r.committed}"`;
                }),
            ),
            button("▶").on("click", async () => {
                if (imCtx) imRender(await imCtx.nextPage());
            }),
        ].map((b) => b.style({ padding: "2px 6px", background: "#fff" })),
    );
}

/** DOM 按键 → X keysym；修饰键等返回 undefined */
function imKeySym(key: string): number | undefined {
    const special: Record<string, number> = {
        Backspace: 0xff08,
        Enter: 0xff0d,
        Escape: 0xff1b,
        Tab: 0xff09,
        Delete: 0xffff,
        Home: 0xff50,
        End: 0xff57,
        PageUp: 0xff55,
        PageDown: 0xff56,
        ArrowLeft: 0xff51,
        ArrowUp: 0xff52,
        ArrowRight: 0xff53,
        ArrowDown: 0xff54,
    };
    if (special[key] !== undefined) return special[key];
    if ([...key].length === 1) return key.codePointAt(0);
    return undefined;
}

if (await imSys.init()) {
    imCtx = await imSys.createContext("myde-desktop-test");
    // 路1：输入法主动上屏（合成完成/选词/标点转全角）
    imCtx.on("commit", (text) => {
        imSendText(text);
        imStatusLine.el.textContent = `commit "${text}"`;
    });
    imCtx.on("update", (s) => imRender(s));

    // 当前输入法 + 切换按钮（含键盘布局=英文模式）
    const imRefresh = async () => {
        const cur = await imSys.getCurrentIM();
        imInfoLine.el.textContent = `当前输入法: ${cur.uniqueName || "(无)"}`;
        const group = await imSys.getGroupInfo();
        imSwitchBox.clear().add(
            group.inputMethods.map((entry) =>
                button(entry.uniqueName)
                    .style({ padding: "2px 6px", background: "#fff" })
                    .on("click", async () => {
                        await imSys.setCurrentIM(entry.uniqueName);
                        imRefresh();
                    }),
            ),
        );
    };
    await imRefresh();

    imCaptureView.on("focus", () => {
        void imCtx?.focus();
    });
    imCaptureView.on("blur", () => {
        void imCtx?.blur();
    });
} else {
    imInfoLine.el.textContent = "ime: fcitx5 不可用";
}

imCaptureView.on("keydown", (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // 主机输入法漏进来的合成按键（理论上非编辑元素不会出现，防御）
    if (e.isComposing || e.key === "Process") return;
    const keysym = imKeySym(e.key);
    if (keysym === undefined) return;
    e.preventDefault();
    e.stopPropagation(); // 不走全局按键转发
    const ctx = imCtx;
    if (!ctx) return;
    void ctx.keyEvent(keysym).then((r) => {
        if (!r.handled && r.committed === "" && [...e.key].length === 1) {
            // 路2：输入法放行（如英文模式），自己插字符
            imSendText(e.key);
            imStatusLine.el.textContent = `key "${e.key}" handled=false → 直接插入`;
        } else {
            imStatusLine.el.textContent = `key "${e.key}" handled=${r.handled} committed="${r.committed}"`;
        }
    });
});

view()
    .add([
        txt("ime（点此输入）"),
        imCaptureView,
        imInfoLine,
        imSwitchBox,
        imPreeditLine,
        imCandidateBox,
        imOutLine,
        imStatusLine,
    ])
    .addInto();
