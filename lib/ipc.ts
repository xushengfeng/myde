// biome-ignore format:
const { ipcRenderer, ipcMain} = require("electron") as typeof import("electron");

import type { bwin_id, cardData, setting, treeItem, view_id, viewAction } from "../src/types";

type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// biome-ignore lint/suspicious/noExplicitAny: 相信ai
type IsVoidFunction<T> = T extends (...args: any[]) => any ? Equals<ReturnType<T>, void> : false;

type VoidKeys<M> = {
    [K in keyof M]: IsVoidFunction<M[K]> extends true ? K : never;
}[keyof M];

type Message = {
    win: (pid: bwin_id, type: "mini" | "max" | "close" | "full_chrome" | "normal_chrome" | "hide_chrome") => void;
    treeGet: (vid: view_id) => treeItem;
    viewAction: (a: viewAction) => void;
    viewAdd: (url: string) => void;
    viewInspect: (vid: view_id, p: { x: number; y: number }) => void;
    download: (url: string) => void;
    viewPermission: (
        vid: view_id,
        op: { type: string; allow: boolean }, // todo
    ) => void;
    viewSAdd: (vid: view_id, pid: view_id) => void;
    viewSMove: (vid: view_id, win: bwin_id) => void;
    addOpensearch: (o: setting["searchEngine"]["engine"]) => void;
    input: (o: {
        action: "focus" | "blur";
        position?: { x: number; y: number };
        type?: string;
        value?: string;
        autocomplete?: string;
        list?: string[];
        username?: string;
        passwd?: string;
    }) => void;
    chromeState: (state: "max" | "unmax") => void;
    showMenu: (arg: Electron.ContextMenuParams) => void;
    zoom: (level: number) => void;
    chorme: () => void;
    toggleTree: () => void;
    fullScreen: (p: boolean) => void;
    siteAbout: (p: string, url: string, id: view_id) => void;
    urlTip: (url: string) => void;
};

const name = "ipc";

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
const renderOnData = new Map<string, ((data: any) => void)[]>();
const mainOnData = new Map<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    ((data: any, event: Electron.IpcMainEvent) => any)[]
>();

function mainSend<K extends keyof Message>(
    webContents: Electron.WebContents | undefined | Electron.WebContents[],
    key: K,
    data: Parameters<Message[K]>,
): void {
    if (Array.isArray(webContents)) {
        for (const wc of webContents) {
            if (!wc.isDestroyed()) wc.send(name, key, data);
        }
    } else {
        if (webContents && !webContents.isDestroyed()) webContents.send(name, key, data);
    }
}

function renderOn<K extends keyof Message>(key: K, callback: (data: Parameters<Message[K]>) => void) {
    const callbacks = renderOnData.get(key) || [];
    callbacks.push(callback);
    renderOnData.set(key, callbacks);
}

function renderSend<K extends keyof Message>(key: K, data: Parameters<Message[K]>): void {
    ipcRenderer.send(name, key, data);
}

function renderSendSync<K extends keyof Message>(key: K, data: Parameters<Message[K]>): ReturnType<Message[K]> {
    return ipcRenderer.sendSync(name, key, data);
}

function mainOn<K extends keyof Message>(
    key: K,
    callback: (
        data: Parameters<Message[K]>,
        event: Electron.IpcMainEvent,
    ) => ReturnType<Message[K]> | Promise<ReturnType<Message[K]>>,
) {
    const callbacks = mainOnData.get(key) || [];
    callbacks.push(callback);
    mainOnData.set(key, callbacks);
}

/**
 * 渲染进程之间的通信，主进程起到中转作用
 */
function mainOnReflect<K extends VoidKeys<Message>>(
    key: K,
    callback: (data: Parameters<Message[K]>, event: Electron.IpcMainEvent) => Electron.WebContents[],
) {
    // @ts-ignore 适用于无返回的函数
    mainOn(key, async (data, event) => {
        const webContents = await callback(data, event);
        if (webContents) {
            for (const wc of webContents) {
                wc.send(name, key, data);
            }
        }
    });
}

ipcRenderer?.on(name, (event, key, data) => {
    const callbacks = renderOnData.get(key);
    if (callbacks) {
        for (const callback of callbacks) {
            callback(data);
        }
    } else {
        console.log(`ipcRenderer.on: ${key} not found`);
    }
});

ipcMain?.on(name, async (event, key, data) => {
    const callbacks = mainOnData.get(key);
    if (callbacks) {
        for (const callback of callbacks) {
            const result = await callback(data, event);
            if (result !== undefined) {
                event.returnValue = result;
            }
        }
    } else {
        console.log(`ipcMain.on: ${key} not found`);
    }
});

export { mainSend, renderOn, renderSend, renderSendSync, mainOn, mainOnReflect };
