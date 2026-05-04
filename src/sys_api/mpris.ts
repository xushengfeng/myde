import { dbusClient, type dbusInterface, type dbusIO } from "myde-dbus";

export class mpris {
    private io: dbusIO;
    private onMap = new Map<string, Set<(...args: any[]) => unknown>>(); // todo 类型 提取为一个lib

    constructor(dbus: dbusIO) {
        this.io = dbus;
    }

    async init() {
        await this.io.connect();
        const client = new dbusClient({ io: this.io });
        const infc = await client.getMetaInterface();
        infc.onNameOwnerChanged((name) => {
            if (name.startsWith("org.mpris.MediaPlayer2.")) {
                this.emitNewPlayer(name);
            }
        });

        infc.ListNames().then(([m]) => {
            for (const name of m) {
                if (name.startsWith("org.mpris.MediaPlayer2.")) {
                    this.emitNewPlayer(name);
                }
            }
        });
    }
    private async emitNewPlayer(name: string) {
        const player = new mprisPlayer(this.io);
        await player.init(name);
        for (const callback of this.onMap.get("new-player") ?? []) {
            callback(player);
        }
    }
    onNewPlayer(callback: (player: mprisPlayer) => unknown) {
        const eventName = "new-player";
        if (!this.onMap.has(eventName)) {
            this.onMap.set(eventName, new Set());
        }
        this.onMap.get(eventName)?.add(callback);
    }
}

class mprisPlayer {
    private dbusClient: dbusClient;
    private root: dbusInterface | undefined;
    private player: dbusInterface | undefined;
    private name: string = "";
    constructor(dbus: dbusIO) {
        this.dbusClient = new dbusClient({ io: dbus });
    }
    async init(name: string) {
        this.name = name;
        const service = await this.dbusClient.getService(name);
        const c = await service.getObject("/org/mpris/MediaPlayer2");
        this.root = await c.getInterface("org.mpris.MediaPlayer2");
        this.player = await c.getInterface("org.mpris.MediaPlayer2.Player");
    }
    private getPlayer() {
        if (!this.player) throw new Error("init first");
        return this.player;
    }
    async identity() {
        return (await this.root?.get<"s">("Identity"))?.[0] ?? "";
    }
    getServerName() {
        return this.name;
    }
    play() {
        this.getPlayer().call("Play");
    }
    pause() {
        this.getPlayer().call("Pause");
    }
    stop() {
        this.getPlayer().call("Stop");
    }
    next() {
        this.getPlayer().call("Next");
    }
    previous() {
        this.getPlayer().call("Previous");
    }
    /** s */
    async getCurrentTime() {
        return Number((await this.getPlayer().get<"x">("Position"))[0] / BigInt(10e5));
    }
    setCurrentTime(s: number) {
        this.getPlayer().set("Position", [BigInt(s * 10e5)], "x");
    }
    private async metadata() {
        const metadata = (await this.getPlayer().get<"a{sv}">("Metadata"))?.[0];
        const nMetadata: Record<string, any> = {};
        for (const [key, value] of metadata) {
            nMetadata[key] = value.value;
        }
        return nMetadata;
    }
    async duration() {
        const metadata = await this.metadata();
        if ("mpris:length" in metadata) {
            return (metadata["mpris:length"] as number) / 10e5;
        } else {
            return Infinity;
        }
    }
    async paused() {
        const [status] = await this.getPlayer().get<"s">("PlaybackStatus");
        return status === "Paused" || status === "Stopped";
    }
    async artCover() {
        const metadata = await this.metadata();
        if ("mpris:artUrl" in metadata) {
            return metadata["mpris:artUrl"] as string;
        } else {
            return "";
        }
    }
    onMetaChange(callback: () => unknown) {
        this.getPlayer().propertiesChanged((changed) => {
            if ("Metadata" in changed) {
                callback();
            }
        });
    }
    onStatusChange(callback: () => unknown) {
        this.getPlayer().propertiesChanged((changed) => {
            if ("PlaybackStatus" in changed) {
                callback();
            }
        });
    }
    onTimeChange(callback: () => unknown) {
        this.getPlayer().propertiesChanged((changed) => {
            if ("Position" in changed) {
                callback();
            }
        });
    }
}
