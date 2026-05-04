import { mpris } from "../mpris";
import { dbusIO } from "myde-dbus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

function newSocket() {
    const socket = new mus.USocket();
    socket.connect("/run/user/1000/bus");
    return socket;
}

async function wait(s: number) {
    return new Promise((resolve) => setTimeout(resolve, s));
}

describe("临时保持测试", async () => {
    it("list", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const player = new mpris(dbus);
        await player.init();
        const l: string[] = [];
        player.onNewPlayer(async (p) => {
            l.push(await p.identity());
        });
        await wait(3000);
        console.log(l);
    });
    it("play", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const player = new mpris(dbus);
        await player.init();
        player.onNewPlayer(async (p) => {
            p.play();
        });
        await wait(1000);
    });
    it("pause", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const player = new mpris(dbus);
        await player.init();
        player.onNewPlayer(async (p) => {
            p.pause();
        });
        await wait(1000);
    });
    it("time", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const player = new mpris(dbus);
        await player.init();
        player.onNewPlayer(async (p) => {
            const time = await p.getCurrentTime();
            const duration = await p.duration();
            console.log(time, duration);
        });
        await wait(1000);
    });
    it("media change", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const player = new mpris(dbus);
        await player.init();
        player.onNewPlayer(async (p) => {
            p.onMetaChange(() => {
                console.log("media change");
            });
        });
        await wait(3000);
    });
});

describe("mpris", () => {
    it("init", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const player = new mpris(dbus);
        await player.init();
    });
});
