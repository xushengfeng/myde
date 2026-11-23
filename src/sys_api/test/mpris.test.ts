import { dbusIO } from "myde-dbus";
import { it } from "vitest";
import { mpris } from "../mpris";
import { describeHost } from "./host_services";

const mus = require("myde-unix-socket") as typeof import("myde-unix-socket");

function newSocket() {
    const socket = new mus.USocket();
    socket.connect("/run/user/1000/bus");
    return socket;
}

async function wait(s: number) {
    return new Promise((resolve) => setTimeout(resolve, s));
}

describeHost("临时保持测试", () => {
    it("list", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const player = new mpris(dbus);
        await player.init();
        const l: string[] = [];
        player.on("new-player", async (p) => {
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
        player.on("new-player", async (p) => {
            p.play();
        });
        await wait(1000);
    });
    it("pause", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const player = new mpris(dbus);
        await player.init();
        player.on("new-player", async (p) => {
            p.pause();
        });
        await wait(1000);
    });
    it("time", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const player = new mpris(dbus);
        await player.init();
        player.on("new-player", async (p) => {
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
        player.on("new-player", async (p) => {
            p.onMetaChange(() => {
                console.log("media change");
            });
        });
        await wait(3000);
    });
});

describeHost("mpris", () => {
    it("init", async () => {
        const socket = newSocket();
        const dbus = new dbusIO({ socket });
        const player = new mpris(dbus);
        await player.init();
    });
});
